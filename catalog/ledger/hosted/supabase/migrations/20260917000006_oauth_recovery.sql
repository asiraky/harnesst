-- Preserve healthy grants during consent and pending gates during token expiry.
begin;
create or replace function public.ledger_approval_backend(p_op text,p_args jsonb default '{}') returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger,public,extensions as $$
declare r approval_requests; i work_items; a actors; c approval_config; result jsonb; claim uuid; evt text; begin
 if p_op='config' then
  select * into c from approval_config;
  if c.singleton is null then raise exception 'May I is not configured'; end if;
  return to_jsonb(c)-array['access_secret','refresh_secret','refresh_claim','refresh_started_at'];
 elsif p_op='token' then
  select * into c from approval_config for update;
  if c.singleton is null then raise exception 'May I is not configured'; end if;
  if c.client_id is distinct from p_args->>'client_id' then raise exception 'May I authorization changed; retry with current configuration'; end if;
  if c.connection_status<>'connected' then raise exception 'May I reconnection required'; end if;
  if c.expires_at>now()+interval '2 minutes' then return jsonb_build_object('access_token',ledger.reveal(c.access_secret)); end if;
  -- Never reuse a rotating refresh token after a crash or an uncertain HTTP response.
  if c.refresh_claim is not null then raise exception 'May I refresh in progress or uncertain; reauthorize if stalled'; end if;
  claim:=gen_random_uuid(); update approval_config set refresh_claim=claim,refresh_started_at=now();
  return jsonb_build_object('claim',claim,'refresh_token',ledger.reveal(c.refresh_secret),'client_id',c.client_id);
 elsif p_op='access_rejected' then
  update approval_config set expires_at=now(),connection_status=case when p_args->>'status'='403' then 'needs_reconnect' else connection_status end
   where encode(digest(ledger.reveal(access_secret),'sha256'),'hex')=p_args->>'token_hash';
  return '{}';
 elsif p_op='refresh_failed' then
  update approval_config set connection_status='needs_reconnect' where refresh_claim=(p_args->>'claim')::uuid;
  return '{"ok":true}';
 elsif p_op='save_token' then
  update approval_config set access_secret=ledger.secret(p_args->>'access_token'),refresh_secret=ledger.secret(p_args->>'refresh_token'),
   expires_at=now()+make_interval(secs=>(p_args->>'expires_in')::int),refresh_claim=null,refresh_started_at=null
   where refresh_claim=(p_args->>'claim')::uuid;
  if not found then raise exception 'stale refresh claim'; end if;
  return '{"ok":true}';
 elsif p_op='claim' then
  select * into c from approval_config for share;
  if c.client_id is distinct from p_args->>'client_id' then raise exception 'May I authorization changed; retry with current configuration'; end if;
  update approval_requests set status='expired' where status='pending' and first_attempt_at is null and expires_at<now();
  update approval_requests set status='failed',last_error='Submission uncertain beyond May I idempotency window; operator recovery required'
   where status='pending' and first_attempt_at<now()-interval '23 hours';
  select * into r from approval_requests where status='pending' and next_attempt_at<=now()
   and expires_at>now()+interval '60 seconds' and (lease_until is null or lease_until<now())
   order by created_at for update skip locked limit 1;
  if r.id is null then return null; end if;
  update approval_requests set expires_at=case when first_attempt_at is null then now()+interval '7 days 1 minute' else expires_at end,first_attempt_at=coalesce(first_attempt_at,now()),lease_until=now()+interval '2 minutes',lease_token=gen_random_uuid(),attempts=attempts+1
   where id=r.id returning * into r;
  return to_jsonb(r);
 elsif p_op='claim_resolution' then
  select * into c from approval_config for share;
  if c.client_id is distinct from p_args->>'client_id' then raise exception 'May I authorization changed; retry with current configuration'; end if;
  select * into r from approval_requests where status='submitted' and next_attempt_at<=now()
   and (lease_until is null or lease_until<now()) order by next_attempt_at for update skip locked limit 1;
  if r.id is null then return null; end if;
  update approval_requests set lease_until=now()+interval '2 minutes',lease_token=gen_random_uuid()
   where id=r.id returning * into r;
  return to_jsonb(r);
 elsif p_op='submitted' then
  update approval_requests set remote_id=p_args->>'remote_id',expires_at=(p_args->>'expires_at')::timestamptz,status='submitted',lease_until=null,last_error=null,next_attempt_at=now()+interval '1 minute'
   where id=(p_args->>'id')::uuid and lease_token=(p_args->>'lease_token')::uuid and status='pending';
  return '{"ok":true}';
 elsif p_op='fail' then
  update approval_requests set status='failed',last_error=p_args->>'error',lease_until=null
   where id=(p_args->>'id')::uuid and lease_token=(p_args->>'lease_token')::uuid and status='pending';
  return '{"ok":true}';
 elsif p_op='retry' then
  update approval_requests set lease_until=null,next_attempt_at=now()+interval '1 minute',last_error=p_args->>'error'
   where id=(p_args->>'id')::uuid and lease_token=(p_args->>'lease_token')::uuid and status in ('pending','submitted');
  return '{"ok":true}';
 elsif p_op='request' then
  select * into r from approval_requests where callback_state=p_args->>'state';
  if r.id is null then raise exception 'unknown callback state'; end if;
  return to_jsonb(r);
 elsif p_op='resolve' then
  -- Lock item before request: same order as all agent mutations, avoiding callback deadlocks.
  select * into r from approval_requests where callback_state=p_args->>'state';
  if r.id is null then raise exception 'unknown callback state'; end if;
  select * into i from work_items where id=r.item_id for update;
  select * into r from approval_requests where id=r.id for update;
  if exists(select 1 from approval_events where event_id=p_args->>'event_id') then return '{"duplicate":true}'; end if;
  if r.remote_id is not null and r.remote_id<>p_args->>'approval_id' then raise exception 'wrong approval'; end if;
  if p_args->>'status' not in ('approved','denied','expired','cancelled') or p_args->>'status' is null then raise exception 'invalid status'; end if;
  if p_args->>'status' in ('approved','denied') and nullif(p_args->>'approver_id','') is null then raise exception 'wrong approver'; end if;
  insert into approval_events(event_id,request_id,status,occurred_at,approver_id) values(p_args->>'event_id',r.id,p_args->>'status',(p_args->>'occurred_at')::timestamptz,p_args->>'approver_id');
  if r.status not in ('pending','submitted') or i.gate_epoch<>r.epoch or i.stage<>r.stage or i.blocked_on is not null or ledger.binding(i,ledger.stage(i)) is distinct from r.binding then return '{"stale":true}'; end if;
  if p_args->>'status' in ('approved','denied') and ((p_args->>'expires_at' is null or (p_args->>'occurred_at')::timestamptz>(p_args->>'expires_at')::timestamptz) or (p_args->>'occurred_at')::timestamptz<r.created_at-interval '1 minute') then raise exception 'decision outside request lifetime'; end if;
  update approval_requests set status=p_args->>'status',remote_id=p_args->>'approval_id',expires_at=coalesce((p_args->>'expires_at')::timestamptz,expires_at),lease_until=null,last_error=null where id=r.id;
  if p_args->>'status' in ('approved','denied') then
   select * into a from actors where id=r.actor_id;
   i:=ledger.decide(i,a,jsonb_build_object('decision',case when p_args->>'status'='approved' then 'approve' else 'reject' end,'binding',r.binding,'approval_id',p_args->>'approval_id','event_id',p_args->>'event_id'),'mayi');
  end if;
  return '{"ok":true}';
 else raise exception 'unknown backend operation'; end if;
end $$;

create or replace function public.ledger_oauth(p_op text,p_args jsonb default '{}') returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger,public,extensions as $$
declare c approval_config; a oauth_attempts; result jsonb; begin
 if p_op='status' then
  select * into c from approval_config;
  return jsonb_build_object('status',case when c.singleton is null then 'disconnected' when c.refresh_claim is not null and c.refresh_started_at<now()-interval '30 seconds' then 'needs_reconnect' when c.connection_status='authorizing' and not exists(select 1 from oauth_attempts where id=c.authorization_id and expires_at>now()) then 'needs_reconnect' else c.connection_status end,'agent_id',c.agent_id,'label',c.label);
 elsif p_op='registration' then
  perform pg_advisory_xact_lock(hashtext('ledger.oauth'));
  select * into c from approval_config;
  if c.singleton is not null then
   if c.redirect_url is distinct from p_args->>'redirect_url' then raise exception 'Registered redirect differs; explicit installation cutover required'; end if;
   return jsonb_build_object('client_id',c.client_id);
  end if;
  insert into oauth_registration(singleton,claim) values(true,(p_args->>'claim')::uuid);
  return '{}';
 elsif p_op='registration_failed' then
  delete from oauth_registration where claim=(p_args->>'claim')::uuid;
  return '{}';
 elsif p_op='registered' then
  perform pg_advisory_xact_lock(hashtext('ledger.oauth'));
  delete from oauth_registration where claim=(p_args->>'claim')::uuid;
  if not found then raise exception 'Registration claim missing'; end if;
  insert into approval_config(origin,callback_url,client_id,redirect_url,label,connection_status) values(p_args->>'origin',p_args->>'callback_url',p_args->>'client_id',p_args->>'redirect_url',p_args->>'label','disconnected');
  return '{}';
 elsif p_op='begin' then
  select * into c from approval_config for update;
  if c.singleton is null then raise exception 'Client not registered'; end if;
  if c.agent_id is null and c.access_secret is not null then raise exception 'Existing grant has no agent identity; explicit cutover required'; end if;
  if c.agent_id is null and exists(select 1 from approval_requests where first_attempt_at is not null and status in ('pending','submitted')) then raise exception 'Pending approvals prevent fresh connection'; end if;
  delete from oauth_attempts;
  insert into oauth_attempts values((p_args->>'id')::uuid,p_args->>'state_hash',ledger.secret(p_args->>'verifier'),now()+interval '10 minutes',false);
  update approval_config set authorization_id=(p_args->>'id')::uuid,connection_status=case when connection_status='connected' then 'connected' else 'authorizing' end,label=p_args->>'label';
  return jsonb_build_object('client_id',c.client_id,'agent_id',c.agent_id,'redirect_url',c.redirect_url,'origin',c.origin);
 elsif p_op='consume' then
  select * into c from approval_config for update;
  update oauth_attempts set consumed=true where state_hash=p_args->>'state_hash' and not consumed and expires_at>now() and id=c.authorization_id returning * into a;
  if a.id is null then raise exception 'Authorization expired or already used'; end if;
  return jsonb_build_object('id',a.id,'verifier',ledger.reveal(a.verifier),'client_id',c.client_id,'agent_id',c.agent_id,'redirect_url',c.redirect_url,'origin',c.origin);
 elsif p_op='save' then
  select * into c from approval_config for update;
  if c.authorization_id is distinct from (p_args->>'id')::uuid then raise exception 'Authorization superseded'; end if;
  if nullif(p_args->>'agent_id','') is null or (c.agent_id is not null and c.agent_id<>p_args->>'agent_id') then raise exception 'May I returned a different connection'; end if;
  update approval_config set agent_id=p_args->>'agent_id',access_secret=ledger.secret(p_args->>'access_token'),refresh_secret=ledger.secret(p_args->>'refresh_token'),expires_at=now()+make_interval(secs=>(p_args->>'expires_in')::int),connection_status='connected',refresh_claim=null,refresh_started_at=null,authorization_id=null;
  delete from oauth_attempts;
  -- Scheduler is provisioned separately; connecting activates it.
  if to_regclass('cron.job') is not null then
   perform cron.alter_job(jobid,active:=true) from cron.job where jobname='ledger-approval-dispatch';
  end if;
  return '{}';
 elsif p_op='failed' then
  update approval_config set connection_status=case when connection_status='connected' then 'connected' else 'needs_reconnect' end,authorization_id=null where authorization_id=(p_args->>'id')::uuid;
  return '{}';
 end if;
 raise exception 'Unknown OAuth operation';
end $$;

commit;
