-- Review snapshots, human feedback and links. Deploy only after draining old pending approvals.
begin;
alter table ledger.approval_requests add column if not exists review_body jsonb, add column if not exists review_digest text check(review_digest ~ '^[0-9a-f]{64}$'), add column if not exists review_url text, add column if not exists supersedes_remote_id text unique;
alter table ledger.approval_events add column if not exists decision_outcome text, add column if not exists feedback text;
do $$ begin
 if exists(select 1 from ledger.approval_requests where status in ('pending','submitted') and review_digest is null)
 then raise exception 'Settle existing May I approvals before upgrading review content'; end if;
end $$;
create or replace function ledger.enter(i ledger.work_items,a uuid,e uuid) returns void language plpgsql set search_path=pg_catalog,ledger,public,extensions as $$
declare s jsonb:=ledger.stage(i); role_name text; h actors; begin
 update outbox set status='done',done_at=now() where item_id=i.id and status in ('pending','claimed');
 update approval_requests set status='superseded' where item_id=i.id and status in ('pending','submitted');
 role_name:=s->>'owner';
 if s ? 'gate' or i.blocked_on is not null then role_name:=ledger.workflow(i)->>'human_proxy'; end if;
 insert into outbox(item_id,event_id,actor_id) select i.id,e,id from actors where (not(s ? 'gate') or i.blocked_on is not null) and role=role_name and kind='agent' and (a is null or id<>a or i.blocked_on is not null or s ? 'gate');
 if s ? 'gate' and i.blocked_on is null then
  if ledger.binding(i,s) is null then raise exception 'missing gate binding'; end if;
  select * into h from actors where role=s->'gate'->>'role' and kind='human';
  if h.id is null then raise exception 'missing human approver role'; end if;
  insert into approval_requests(item_id,epoch,stage,binding,actor_id,action)
  values(i.id,i.gate_epoch,i.stage,ledger.binding(i,s),h.id,jsonb_build_object(
   'kind','ledger.stage-transition','version','1','audience','ledger:'||i.project_id,
   'resourceVersion',i.gate_epoch::text,
   'input',jsonb_build_object('item_id',i.id,'project_id',i.project_id,'title',i.title,
    'stage',i.stage,'epoch',i.gate_epoch,'binding',ledger.binding(i,s),'spec',i.spec,
    'head_sha',i.head_sha,'approve_to',s->>'on_approve','reject_to',s->>'on_reject',
    'evidence',coalesce((select jsonb_agg(payload order by seq) from events where item_id=i.id and kind='evidence' and head_sha is not distinct from i.head_sha),'[]'::jsonb),
    'artifacts',coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from artifacts t where item_id=i.id),'[]'::jsonb))));
  update approval_requests set supersedes_remote_id=(select prev.remote_id from approval_requests prev
    where prev.item_id=i.id and prev.stage=i.stage and prev.status='denied' and prev.remote_id is not null
    and not exists(select 1 from approval_requests linked where linked.supersedes_remote_id=prev.remote_id)
    order by prev.created_at desc limit 1) where item_id=i.id and epoch=i.gate_epoch;
 end if;
end $$;
create or replace function ledger.view_item(i ledger.work_items,a ledger.actors) returns jsonb language sql stable set search_path=pg_catalog,ledger as $$
 select to_jsonb(i)||jsonb_build_object('allowed_actions',ledger.actions(i,a),
 'events',coalesce((select jsonb_agg(t order by seq) from (select * from events where item_id=i.id order by seq desc limit 100)t),'[]'),
 'artifacts',coalesce((select jsonb_agg(t) from artifacts t where item_id=i.id),'[]'),
 'approval', (select jsonb_build_object('status',r.status,'approval_id',r.remote_id,'expires_at',r.expires_at,'error',r.last_error,'review_url',r.review_url,'review_digest',r.review_digest) from approval_requests r where r.item_id=i.id and r.epoch=i.gate_epoch))
$$;
create or replace function public.ledger_approval_backend(p_op text,p_args jsonb default '{}') returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger,public,extensions as $$
declare r approval_requests; i work_items; a actors; c approval_config; result jsonb; claim uuid; evt text; begin
 if p_op in ('claim','claim_resolution','prepare_review','submitted','resolve') and (p_args->>'review_protocol') is distinct from '2' then
  raise exception 'Approval worker upgrade required';
 end if;
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
  claim:=gen_random_uuid(); update approval_config set refresh_claim=claim,refresh_started_at=now() where singleton;
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
 elsif p_op='prepare_review' then
  update approval_requests set review_body=coalesce(review_body,p_args->'review_body'),review_digest=coalesce(review_digest,p_args->>'review_digest')
   where id=(p_args->>'id')::uuid and lease_token=(p_args->>'lease_token')::uuid and status='pending' returning * into r;
  if r.id is null then raise exception 'stale review preparation'; end if;
  return to_jsonb(r);
 elsif p_op='submitted' then
  update approval_requests set remote_id=p_args->>'remote_id',expires_at=(p_args->>'expires_at')::timestamptz,status='submitted',review_url=p_args->>'review_url',lease_until=null,last_error=null,next_attempt_at=now()+interval '1 minute'
   where id=(p_args->>'id')::uuid and lease_token=(p_args->>'lease_token')::uuid and status='pending' returning * into r;
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
  insert into approval_events(event_id,request_id,status,occurred_at,approver_id,decision_outcome,feedback) values(p_args->>'event_id',r.id,p_args->>'status',(p_args->>'occurred_at')::timestamptz,p_args->>'approver_id',p_args->>'decision_outcome',p_args->>'feedback');
  if r.status not in ('pending','submitted') or i.gate_epoch<>r.epoch or i.stage<>r.stage or i.blocked_on is not null or ledger.binding(i,ledger.stage(i)) is distinct from r.binding then return '{"stale":true}'; end if;
  if p_args->>'status' in ('approved','denied') and ((p_args->>'expires_at' is null or (p_args->>'occurred_at')::timestamptz>(p_args->>'expires_at')::timestamptz) or (p_args->>'occurred_at')::timestamptz<r.created_at-interval '1 minute') then raise exception 'decision outside request lifetime'; end if;
  update approval_requests set status=p_args->>'status',remote_id=p_args->>'approval_id',expires_at=coalesce((p_args->>'expires_at')::timestamptz,expires_at),lease_until=null,last_error=null where id=r.id;
  if p_args->>'status' in ('approved','denied') then
   select * into a from actors where id=r.actor_id;
   i:=ledger.decide(i,a,jsonb_build_object('decision',case when p_args->>'status'='approved' then 'approve' else 'reject' end,'binding',r.binding,'approval_id',p_args->>'approval_id','event_id',p_args->>'event_id','decision_outcome',p_args->>'decision_outcome','feedback',p_args->>'feedback'),'mayi');
  end if;
  return '{"ok":true}';
 else raise exception 'unknown backend operation'; end if;
end $$;


-- Notify only once the link exists, or when submission needs operator attention.
create or replace function ledger.notify_review_status() returns trigger language plpgsql set search_path=pg_catalog,ledger as $$
declare i work_items; e uuid; begin
 if new.status not in ('submitted','failed','expired') or old.status=new.status then return new; end if;
 select * into i from work_items where id=new.item_id;
 if i.gate_epoch<>new.epoch or i.stage<>new.stage or i.closed_at is not null then return new; end if;
 e:=ledger.event(i,null,'approval_'||new.status,jsonb_build_object('approval_id',new.remote_id,'review_url',new.review_url,'error',new.last_error));
 insert into outbox(item_id,event_id,actor_id) select i.id,e,id from actors where kind='agent' and role=ledger.workflow(i)->>'human_proxy';
 return new;
end $$;
drop trigger if exists review_status_notification on ledger.approval_requests;
create trigger review_status_notification after update of status on ledger.approval_requests for each row execute function ledger.notify_review_status();
commit;
