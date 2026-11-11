-- A heartbeat proves the agent process is alive, not that its session is getting anywhere. A turn
-- stuck on a shell command that never exits kept renewing its issue lease for a day: every wake
-- for the issue was deferred to the holder, deferral never counts toward escalation, and the
-- issue sat still with nobody told.
-- Ledger writes are the progress signal. A heartbeat extends a lease only while its session has
-- written to that issue (or claimed it) within `lease_max_idle_seconds`, 3 hours by default.
-- After that the lease lapses at its normal expiry and the waiting wake takes the issue over,
-- fencing the stuck session out. A write still extends the lease, so a session that is moving
-- the issue forward never loses it to the cap. Re-runnable.
begin;
alter table ledger.leases add column if not exists progressed_at timestamptz;
insert into ledger.settings values ('lease_max_idle_seconds','10800') on conflict(key) do nothing;
create or replace function ledger.lease_max_idle() returns interval language sql stable set search_path=pg_catalog,ledger as $$
 select make_interval(secs=>coalesce((select value from settings where key='lease_max_idle_seconds')::int,10800))
$$;
-- A lease is idle when nothing has claimed or written its issue for longer than the cap.
create or replace function ledger.lease_idle(l ledger.leases) returns boolean language sql stable set search_path=pg_catalog,ledger as $$
 select coalesce(l.progressed_at,l.acquired_at,now())<now()-ledger.lease_max_idle()
$$;
-- As 0010, and a grant counts as progress.
create or replace function ledger.grant_lease(l ledger.leases,session text,outbox uuid) returns ledger.leases language plpgsql set search_path=pg_catalog,ledger as $$
begin
 if l.token is not null and l.outbox_id is not null and l.session_id is not null and l.session_id is distinct from session then
  insert into lease_fenced(scope_id,actor_id,session_id) values(l.scope_id,l.actor_id,l.session_id) on conflict do nothing;
 end if;
 update leases set fence=fence+1,token=gen_random_uuid(),session_id=session,outbox_id=outbox,expires_at=now()+ledger.lease_ttl(),acquired_at=now(),renewed_at=now(),progressed_at=now()
 where scope_id=l.scope_id and actor_id=l.actor_id returning * into l; return l;
end $$;
-- As 0010, and the holder's write counts as progress.
create or replace function ledger.require_lease(scope uuid,a ledger.actors,p jsonb) returns void language plpgsql set search_path=pg_catalog,ledger as $$
declare l leases; sid text:=nullif(p->>'session_id',''); begin
 if a.kind<>'agent' then return; end if;
 if sid is null then
  if (select value from settings where key='require_leases') is distinct from 'false' then raise exception 'LEASE_REQUIRED: ledger writes must carry session_id (update the ledger-tools bundle)'; end if;
  return;
 end if;
 if exists(select 1 from lease_fenced where scope_id=scope and actor_id=a.id and session_id=sid) then
  raise exception 'LEASE_LOST: another session took over this work. Stop working on it and end your turn; do not push or change anything else for it.';
 end if;
 l:=ledger.lock_lease(scope,a.id);
 if l.token is not null and l.session_id=sid then
  update leases set expires_at=greatest(expires_at,now()+ledger.lease_ttl()),renewed_at=now(),progressed_at=now() where scope_id=scope and actor_id=a.id; return;
 end if;
 if l.token is not null and l.expires_at>now() then
  raise exception 'LEASE_HELD: another % session (%) is working on this issue until at least %. Do not change it; end your turn or tell the human.',a.role,coalesce(l.session_id,'starting'),l.expires_at;
 end if;
 perform ledger.grant_lease(l,sid,null);
end $$;
-- As 0010, but an idle lease is not extended. The heartbeat is told `idle` and stops; the lease
-- runs out at its current expiry. The session's other, still-active leases keep renewing.
create or replace function public.ledger_renew_lease(p_key text,p_args jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger as $$
declare a actors; l leases; sid text:=nullif(p_args->>'session_id',''); tokens uuid[]; begin
 select * into a from actors where wake_hash=ledger.hash(p_key); if a.id is null then raise exception 'unauthorized'; end if;
 select * into l from leases where actor_id=a.id and token=(p_args->>'lease_token')::uuid for update;
 if l.scope_id is null or (sid is not null and l.session_id is not null and l.session_id<>sid) then return '{"renewed":false}'; end if;
 if sid is not null and exists(select 1 from lease_fenced where scope_id=l.scope_id and actor_id=a.id and session_id=sid) then return '{"renewed":false}'; end if;
 if ledger.lease_idle(l) then return '{"renewed":false,"idle":true}'; end if;
 select array_agg(token) into tokens from leases x where actor_id=a.id and token is not null and (token=l.token or session_id=coalesce(l.session_id,sid)) and not ledger.lease_idle(x);
 update leases set session_id=coalesce(session_id,sid),expires_at=now()+ledger.lease_ttl(),renewed_at=now() where actor_id=a.id and token=any(tokens);
 update outbox set lease_until=now()+ledger.lease_ttl() where actor_id=a.id and status='claimed' and claim_token=any(tokens);
 return jsonb_build_object('renewed',true,'fence',l.fence);
end $$;
revoke all on function ledger.lease_max_idle(),ledger.lease_idle(ledger.leases),ledger.grant_lease(ledger.leases,text,uuid),ledger.require_lease(uuid,ledger.actors,jsonb) from public;
revoke all on function public.ledger_renew_lease(text,jsonb) from public;
grant execute on function public.ledger_renew_lease(text,jsonb) to anon;
commit;
