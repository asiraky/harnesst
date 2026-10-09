-- Single writer per (issue, role). An agent session may change an item only while it holds the
-- lease for the item's issue (a ticket shares its parent's lease). Writes carry the eve session id.
-- A free lease is taken by the first writing session; a live one refuses every other session.
-- The lease ends on facts: release at turn end, or expiry when nothing renews it (process gone).
-- After expiry the same session may continue until another session takes over; a session that was
-- taken over is fenced out of that issue for good. Human and system actors are not leased.
-- Apply together with ledger-tools 0.4.0 and ledger-wake 0.2.0: older tools send no session id.
begin;
create table if not exists ledger.leases (
 scope_id uuid not null references ledger.work_items, actor_id uuid not null references ledger.actors,
 fence bigint not null default 0, token uuid, session_id text, outbox_id uuid,
 expires_at timestamptz not null default now(), acquired_at timestamptz, renewed_at timestamptz,
 primary key(scope_id,actor_id)
);
create unique index if not exists leases_token on ledger.leases(token);
create table if not exists ledger.lease_fenced (
 scope_id uuid not null, actor_id uuid not null, session_id text not null, fenced_at timestamptz not null default now(),
 primary key(scope_id,actor_id,session_id)
);
insert into ledger.settings values ('lease_ttl_seconds','600'),('require_leases','true') on conflict(key) do nothing;
create or replace function ledger.lease_ttl() returns interval language sql stable set search_path=pg_catalog,ledger as $$
 select make_interval(secs=>coalesce((select value from settings where key='lease_ttl_seconds')::int,600))
$$;
create or replace function ledger.scope(i ledger.work_items) returns uuid language sql immutable as $$ select coalesce(i.parent_id,i.id) $$;
-- Returns the locked lease row, creating an empty one on first use.
create or replace function ledger.lock_lease(scope uuid,actor uuid) returns ledger.leases language plpgsql set search_path=pg_catalog,ledger as $$
declare l leases; begin
 insert into leases(scope_id,actor_id) values(scope,actor) on conflict do nothing;
 select * into l from leases where scope_id=scope and actor_id=actor for update; return l;
end $$;
-- New holder, new token, fence+1. An unreleased previous holder is being taken over: fence it out.
create or replace function ledger.grant_lease(l ledger.leases,session text,outbox uuid) returns ledger.leases language plpgsql set search_path=pg_catalog,ledger as $$
begin
 if l.token is not null and l.session_id is not null and l.session_id is distinct from session then
  insert into lease_fenced(scope_id,actor_id,session_id) values(l.scope_id,l.actor_id,l.session_id) on conflict do nothing;
 end if;
 update leases set fence=fence+1,token=gen_random_uuid(),session_id=session,outbox_id=outbox,expires_at=now()+ledger.lease_ttl(),acquired_at=now(),renewed_at=now()
 where scope_id=l.scope_id and actor_id=l.actor_id returning * into l; return l;
end $$;
-- Called before every agent write on an existing item.
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
  update leases set expires_at=greatest(expires_at,now()+ledger.lease_ttl()),renewed_at=now() where scope_id=scope and actor_id=a.id; return;
 end if;
 if l.token is not null and l.expires_at>now() then
  raise exception 'LEASE_HELD: another % session (%) is working on this issue until at least %. Do not change it; end your turn or tell the human.',a.role,coalesce(l.session_id,'starting'),l.expires_at;
 end if;
 perform ledger.grant_lease(l,sid,null);
end $$;
-- Writes are dispatched by ledger.call_unleased (the pre-lease dispatcher). Replace that, not this wrapper.
do $$ begin
 if to_regprocedure('ledger.call_unleased(text,text,jsonb)') is null then alter function ledger.call(text,text,jsonb) rename to call_unleased; end if;
end $$;
create or replace function ledger.call(op text,p_key text,p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger,public,extensions as $$
declare a actors:=ledger.actor(p_key); i work_items; begin
 if op in ('update_spec','transition','evidence','attach','set_head','block','resolve_block') then
  -- Item lock before lease lock: the same order as claim.
  select * into i from work_items where id=(p->>'item_id')::uuid for update;
  if i.id is not null then perform ledger.require_lease(ledger.scope(i),a,p); end if;
 elsif op='create_item' and p->>'kind'='ticket' then
  select * into i from work_items where id=(p->>'parent_id')::uuid for update;
  if i.id is not null then perform ledger.require_lease(ledger.scope(i),a,p); end if;
 end if;
 return ledger.call_unleased(op,p_key,p);
end $$;
-- A wake for leased work waits for the holder instead of starting a second session.
create or replace function public.ledger_claim(p_key text,p_args jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger as $$
declare o outbox; a actors; i work_items; l leases; begin
 select * into a from actors where wake_hash=ledger.hash(p_key); if a.id is null then raise exception 'unauthorized'; end if;
 select w.* into i from work_items w join outbox b on b.item_id=w.id where b.id=(p_args->>'outbox_id')::uuid and b.actor_id=a.id for update of w;
 if i.id is null then return '{"gone":true}'; end if;
 select * into o from outbox where id=(p_args->>'outbox_id')::uuid for update;
 if o.status in ('done','failed') then return '{"gone":true}'; end if;
 if o.status='claimed' and o.lease_until>now() then return '{"already_claimed":true}'; end if;
 l:=ledger.lock_lease(ledger.scope(i),a.id);
 if l.token is not null and l.expires_at>now() then
  -- Reaching the agent is not a delivery failure, so waiting does not count toward escalation.
  update outbox set status='pending',attempts=0,next_attempt_at=l.expires_at,claim_token=null,lease_until=null where id=o.id;
  return jsonb_build_object('deferred',true,'until',l.expires_at,'holder_session',l.session_id);
 end if;
 -- The channel binds its session on first renewal; a manual claim names its session now.
 l:=ledger.grant_lease(l,nullif(p_args->>'session_id',''),o.id);
 update outbox set status='claimed',claimed_at=now(),lease_until=l.expires_at,claim_token=l.token where id=o.id returning * into o;
 return jsonb_build_object('item',ledger.view_item(i,a),'outbox_id',o.id,'claim_token',o.claim_token,'lease_token',l.token,'fence',l.fence,'kind',o.kind);
end $$;
-- Channel heartbeat. Binds the claimed lease to its session on first use, then extends every lease
-- that session holds. A token that was taken over or released is refused.
create or replace function public.ledger_renew_lease(p_key text,p_args jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger as $$
declare a actors; l leases; sid text:=nullif(p_args->>'session_id',''); begin
 select * into a from actors where wake_hash=ledger.hash(p_key); if a.id is null then raise exception 'unauthorized'; end if;
 select * into l from leases where actor_id=a.id and token=(p_args->>'lease_token')::uuid for update;
 if l.scope_id is null or (sid is not null and l.session_id is not null and l.session_id<>sid) then return '{"renewed":false}'; end if;
 if sid is not null and exists(select 1 from lease_fenced where scope_id=l.scope_id and actor_id=a.id and session_id=sid) then return '{"renewed":false}'; end if;
 update leases set session_id=coalesce(session_id,sid),expires_at=now()+ledger.lease_ttl(),renewed_at=now()
 where actor_id=a.id and token is not null and (token=l.token or session_id=coalesce(l.session_id,sid));
 update outbox set lease_until=now()+ledger.lease_ttl() where actor_id=a.id and status='claimed' and claim_token in (select token from leases where actor_id=a.id and token is not null and (token=l.token or session_id=coalesce(l.session_id,sid)));
 return jsonb_build_object('renewed',true,'fence',l.fence);
end $$;
-- Turn ended. Releases every lease of that session and lets waiting wakes for those issues go now.
-- A claimed wake whose stage did not move is redelivered after 30 minutes, as before leases.
create or replace function public.ledger_release_lease(p_key text,p_args jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger as $$
declare a actors; l leases; scopes uuid[]; tokens uuid[]; begin
 select * into a from actors where wake_hash=ledger.hash(p_key); if a.id is null then raise exception 'unauthorized'; end if;
 select * into l from leases where actor_id=a.id and token=(p_args->>'lease_token')::uuid for update;
 if l.scope_id is null then return '{"released":false}'; end if;
 select array_agg(scope_id),array_agg(token) into scopes,tokens from leases where actor_id=a.id and token is not null and (token=l.token or session_id=l.session_id);
 update leases set token=null,expires_at=now() where actor_id=a.id and token=any(tokens);
 update outbox set lease_until=now()+interval '30 minutes' where actor_id=a.id and status='claimed' and claim_token=any(tokens);
 update outbox set next_attempt_at=now() where actor_id=a.id and status='pending' and next_attempt_at>now()
  and item_id in (select id from work_items where coalesce(parent_id,id)=any(scopes));
 return '{"released":true}';
end $$;
revoke all on table ledger.leases,ledger.lease_fenced from public;
revoke all on function ledger.lease_ttl(),ledger.scope(ledger.work_items),ledger.lock_lease(uuid,uuid),ledger.grant_lease(ledger.leases,text,uuid),ledger.require_lease(uuid,ledger.actors,jsonb),ledger.call(text,text,jsonb),ledger.call_unleased(text,text,jsonb) from public;
revoke all on function public.ledger_renew_lease(text,jsonb),public.ledger_release_lease(text,jsonb) from public;
grant execute on function public.ledger_renew_lease(text,jsonb),public.ledger_release_lease(text,jsonb) to anon;
commit;
