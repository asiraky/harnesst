-- Remove capability links and agent-attested decisions. No legacy approval API remains.
begin;
drop function public.ledger_gate(text,jsonb);
drop function public.ledger_decide_gate(text,jsonb);
drop table ledger.gate_links;
alter table ledger.gates drop column attested_human;
delete from ledger.settings where key='gate_origin';
-- Each request has one immutable approval destination; remove obsolete alternate routes.
update ledger.workflow_templates t set definition=jsonb_set(t.definition,'{kinds}',(
 select jsonb_object_agg(k.key,k.value||jsonb_build_object('stages',(
  select jsonb_agg(s.value-'routes' order by s.ordinality) from jsonb_array_elements(k.value->'stages') with ordinality s
 ))) from jsonb_each(t.definition->'kinds') k
));
update ledger.workflows t set definition=jsonb_set(t.definition,'{kinds}',(
 select jsonb_object_agg(k.key,k.value||jsonb_build_object('stages',(
  select jsonb_agg(s.value-'routes' order by s.ordinality) from jsonb_array_elements(k.value->'stages') with ordinality s
 ))) from jsonb_each(t.definition->'kinds') k
));
create table ledger.approval_config (
 singleton boolean primary key default true check(singleton),
 origin text not null check(origin ~ '^https://[^/]+$'),
 callback_url text not null check(callback_url ~ '^https://'),
 workspace_id text not null, client_id text not null,
 access_secret bytea not null, refresh_secret bytea not null,
 expires_at timestamptz not null, refresh_claim uuid,
 refresh_started_at timestamptz
);
create table ledger.approvers (
 actor_id uuid primary key references ledger.actors,
 mayi_user_id text not null
);
create table ledger.approval_requests (
 id uuid primary key default gen_random_uuid(), item_id uuid not null references ledger.work_items,
 epoch int not null, stage text not null, binding text not null,
 actor_id uuid not null references ledger.actors, mayi_user_id text,
 action jsonb not null, status text not null default 'pending'
 check(status in ('pending','submitted','approved','denied','expired','cancelled','superseded','failed')),
 remote_id text unique, callback_state text not null unique default encode(gen_random_bytes(32),'hex'),
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '7 days',
 first_attempt_at timestamptz, next_attempt_at timestamptz not null default now(),
 lease_until timestamptz, lease_token uuid, attempts int not null default 0, last_error text,
 unique(item_id,epoch)
);
create table ledger.approval_events (
 event_id text primary key, request_id uuid not null references ledger.approval_requests,
 status text not null, occurred_at timestamptz not null, received_at timestamptz not null default now()
);
create or replace function ledger.enter(i ledger.work_items,a uuid,e uuid) returns void language plpgsql set search_path=pg_catalog,ledger,public,extensions as $$
declare s jsonb:=ledger.stage(i); role_name text; h actors; begin
 update outbox set status='done',done_at=now() where item_id=i.id and status in ('pending','claimed');
 update approval_requests set status='superseded' where item_id=i.id and status in ('pending','submitted');
 role_name:=s->>'owner';
 if s ? 'gate' or i.blocked_on is not null then role_name:=ledger.workflow(i)->>'human_proxy'; end if;
 insert into outbox(item_id,event_id,actor_id) select i.id,e,id from actors where role=role_name and kind='agent' and (a is null or id<>a or i.blocked_on is not null or s ? 'gate');
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
    'artifacts',coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from artifacts t where item_id=i.id),'[]'::jsonb))));
 end if;
end $$;
create or replace function ledger.actions(i ledger.work_items,a ledger.actors) returns jsonb language plpgsql set search_path=pg_catalog,ledger as $$
declare s jsonb:=ledger.stage(i); edge jsonb; dest text; moves jsonb:='[]'; ev jsonb:='[]'; begin
 if i.blocked_on is null and s->>'owner'=a.role and not(i.stage='triage' and jsonb_array_length(coalesce(i.spec->'open_questions','[]'))>0) then
  for dest,edge in select key,value from jsonb_each(coalesce(s->'next','{}')) loop
   begin perform ledger.requirements(i,edge); moves:=moves||to_jsonb(dest); exception when raise_exception then null; end;
  end loop;
 end if;
 select coalesce(jsonb_agg(key),'[]') into ev from jsonb_each(coalesce(s->'evidence','{}')) where value->'by' ? a.role;
 return jsonb_build_object('transitions',moves,'evidence',case when i.blocked_on is null then ev else '[]'::jsonb end,'update_spec',i.blocked_on is null and (a.role='intake' or (a.role='infra' and s->>'owner'='infra')) and i.head_sha is null and i.closed_at is null,'block',i.blocked_on is null and i.closed_at is null and coalesce(a.role=s->>'owner' or a.role=ledger.workflow(i)->>'human_proxy',false),'resolve_block',i.blocked_on is not null and (a.role=i.blocked_on->>'role' or a.role=ledger.workflow(i)->>'human_proxy'),'attach',i.closed_at is null and ledger.workflow(i)->'artifacts'->'by' ? a.role,'set_head',i.closed_at is null and i.stage not in ('merged','deployed') and ledger.workflow(i)->'artifacts'->'by' ? a.role);
end $$;
create or replace function ledger.call(op text,p_key text,p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger,public,extensions as $$
declare a actors:=ledger.actor(p_key); i work_items; s jsonb; w jsonb; result jsonb; e uuid; b text; pos int; reset_pos int; prior gates; begin
 if op='whoami' then return to_jsonb(a)-array['key_hash','wake_hash','wake_secret']; end if;
 if op='set_wake_url' then
  if a.kind<>'agent' or coalesce(p->>'url','') !~ '^https?://[^ /]+/' then raise exception 'invalid wake URL'; end if;
  if (select value from settings where key='allow_http_wakes') is distinct from 'true' and p->>'url' !~ '^https://' then raise exception 'HTTPS wake URL required'; end if;
  update actors set wake_url=p->>'url' where id=a.id; return '{"ok":true}';
 end if;
 if op='list_projects' then return coalesce((select jsonb_agg(t) from projects t),'[]'); end if;
 if op='get_project' then
  select to_jsonb(t)||jsonb_build_object('workflow',(select definition from workflows where project_id=t.id and active)) into result from projects t where id=(p->>'project_id')::uuid;
  if result is null then raise exception 'project not found'; end if; return result;
 end if;
 if op='create_project' then
  if a.role<>'intake' then raise exception 'forbidden'; end if;
  if p ? 'workflow' then raise exception 'workflows require operator approval; select workflow_template'; end if;
  select definition into w from workflow_templates where name=coalesce(p->>'workflow_template','default');
  if w is null then raise exception 'unknown operator-approved workflow template'; end if;
  insert into projects(slug,name,repo,docs) values(p->>'slug',p->>'name',p->>'repo',coalesce(p->'docs','{}')) returning to_jsonb(projects.*) into result;
  insert into workflows(project_id,version,definition) values((result->>'id')::uuid,1,w); return result;
 end if;
 if op='create_item' then
  if a.role<>'intake' then raise exception 'forbidden'; end if;
  i:=ledger.create_item(a,p); return ledger.view_item(i,a);
 end if;
 if op='list_items' then
  return coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('allowed_actions',ledger.actions(t,a))) from work_items t where (p->>'project_id' is null or t.project_id=(p->>'project_id')::uuid) and (p->>'stage' is null or t.stage=p->>'stage') and (not coalesce((p->>'mine')::boolean,false) or ledger.stage(t)->>'owner'=a.role or ((ledger.stage(t) ? 'gate' or t.blocked_on is not null) and ledger.workflow(t)->>'human_proxy'=a.role))),'[]');
 end if;
 select * into i from work_items where id=(p->>'item_id')::uuid for update;
 if i.id is null then raise exception 'item not found'; end if;
 if op='get_item' then return ledger.view_item(i,a); end if;
 s:=ledger.stage(i); w:=ledger.workflow(i);
 if op='set_head' and (p->>'observed_at')::timestamptz>clock_timestamp()+interval '1 minute' then raise exception 'observed_at is in the future'; end if;
 if op='set_head' and (p->>'observed_at')::timestamptz<=i.head_sha_at then return ledger.view_item(i,a); end if;
 if (p->>'expected_version')::int is distinct from i.version then raise exception 'stale (item version %, sent %)',i.version,p->>'expected_version'; end if;
 if op='transition' then
  if i.blocked_on is not null then raise exception 'blocked'; end if;
  if a.role='github' and (i.head_sha is null or p->>'binding' is distinct from i.head_sha) then raise exception 'stale_binding'; end if;
  if s ? 'gate' then raise exception 'gate stage; verified approval required'; end if;
  if s->>'owner'<>a.role then raise exception 'forbidden: stage owner is %',s->>'owner'; end if;
  if not coalesce(s->'next','{}') ? (p->>'to_stage') then raise exception 'invalid transition'; end if;
  if i.stage='triage' and jsonb_array_length(coalesce(i.spec->'open_questions','[]'))>0 then raise exception 'unresolved spec questions'; end if;
  perform ledger.requirements(i,s->'next'->(p->>'to_stage')); 
  i:=ledger.move(i,a.id,p->>'to_stage',case when p->>'to_stage'='build' and i.stage in ('qa','review') then 'rework' else 'transition' end,p);
 elsif op='update_spec' then
  if i.blocked_on is not null then raise exception 'blocked'; end if;
  if (a.role='intake' or (a.role='infra' and s->>'owner'='infra')) is not true or i.head_sha is not null or i.closed_at is not null then raise exception 'spec edits require intake or the owning infra role before code'; end if;
  if coalesce(p->>'note','')='' or jsonb_typeof(p->'spec') is distinct from 'object' then raise exception 'spec and note required'; end if;
  update work_items set spec=p->'spec',spec_version=spec_version+1,version=version+1,updated_at=now() where id=i.id returning * into i;
  e:=ledger.event(i,a.id,'spec_updated',p);
  i:=ledger.move(i,a.id,w->'kinds'->i.kind->'stages'->0->>'id','reset',jsonb_build_object('reason','spec changed'));
 elsif op='evidence' then
  if not coalesce(s->'evidence'->(p->>'type')->'by','[]') ? a.role or i.blocked_on is not null then raise exception 'forbidden evidence'; end if;
  if coalesce(p->>'binding','')<>coalesce(i.head_sha,i.spec_version::text) then raise exception 'stale_binding'; end if;
  update work_items set version=version+1,updated_at=now() where id=i.id returning * into i;
  perform ledger.event(i,a.id,'evidence',p);
  if p->>'type' in ('qa_failed','review_changes') then perform ledger.event(i,a.id,'rework',p); end if;
 elsif op in ('attach','set_head') then
  if not w->'artifacts'->'by' ? a.role then raise exception 'forbidden'; end if;
  if i.closed_at is not null then raise exception 'item closed'; end if;
  if op='attach' then
   if coalesce(p->>'value','')='' then raise exception 'artifact value required'; end if;
   if p->>'type' in ('preview_url','deployment') and (i.head_sha is null or p->>'binding' is distinct from i.head_sha) then raise exception 'stale_binding'; end if;
   if p->>'type' in ('branch','pr') and exists(select 1 from artifacts where item_id=i.id and type=p->>'type' and value<>p->>'value') then raise exception 'duplicate branch or PR'; end if;
   if exists(select 1 from artifacts where item_id=i.id and iteration=i.iteration and type=p->>'type' and value=p->>'value' and head_sha is not distinct from i.head_sha) then return ledger.view_item(i,a); end if;
   insert into artifacts(item_id,iteration,type,value,head_sha) values(i.id,i.iteration,p->>'type',p->>'value',i.head_sha) on conflict(item_id,iteration,type) do update set value=excluded.value,head_sha=excluded.head_sha;
   update work_items set version=version+1,updated_at=now() where id=i.id returning * into i; perform ledger.event(i,a.id,'artifact',p);
   if s ? 'gate' then
    update work_items set gate_epoch=gate_epoch+1 where id=i.id returning * into i;
    e:=ledger.event(i,a.id,'approval_invalidated',p); perform ledger.enter(i,a.id,e);
   end if;
  else
   if coalesce(p->>'head_sha','') !~ '^[0-9a-f]{40}$' or p->>'observed_at' is null then raise exception 'full head SHA and observed_at required'; end if;
   if i.stage in ('merged','deployed') then raise exception 'cannot change merged head'; end if;
   b:=i.head_sha;
   update work_items set head_sha=p->>'head_sha',head_sha_at=least((p->>'observed_at')::timestamptz,clock_timestamp()),version=version+1,updated_at=now() where id=i.id returning * into i;
   perform ledger.event(i,a.id,'head',p);
   if b is distinct from i.head_sha then
    select n into pos from jsonb_array_elements(w->'kinds'->i.kind->'stages') with ordinality as x(v,n) where v->>'id'=i.stage;
    select n into reset_pos from jsonb_array_elements(w->'kinds'->i.kind->'stages') with ordinality as x(v,n) where v->>'id'=w->'kinds'->i.kind->>'on_new_commit';
    if pos>=reset_pos then i:=ledger.move(i,a.id,w->'kinds'->i.kind->>'on_new_commit','reset',p);
    elsif s ? 'gate' then i:=ledger.move(i,a.id,i.stage,'approval_invalidated',p); end if;
   end if;
  end if;
 elsif op='block' then
  if i.blocked_on is not null or i.closed_at is not null or (a.role=s->>'owner' or a.role=w->>'human_proxy') is not true then raise exception 'forbidden block'; end if;
  if not exists(select 1 from actors where role=p->>'role' and kind='human') or coalesce(p->>'question','')='' then raise exception 'human role and question required'; end if;
  update work_items set blocked_on=jsonb_build_object('role',p->>'role','question',p->>'question','options',p->'options'),version=version+1,updated_at=now() where id=i.id returning * into i;
  e:=ledger.event(i,a.id,'blocked',p); perform ledger.enter(i,a.id,e);
 elsif op='resolve_block' then
  if i.blocked_on is null or not(a.role=i.blocked_on->>'role' or a.role=w->>'human_proxy') or coalesce(p->>'answer','')='' then raise exception 'forbidden resolve'; end if;
  update work_items set blocked_on=null,version=version+1,gate_epoch=gate_epoch+1,updated_at=now() where id=i.id returning * into i;
  e:=ledger.event(i,a.id,'resolved',p); perform ledger.enter(i,null,e);
 else raise exception 'unknown operation'; end if;
 return ledger.view_item(i,a);
end $$;
create or replace function ledger.decide(i ledger.work_items,a ledger.actors,p jsonb,via text) returns ledger.work_items language plpgsql set search_path=pg_catalog,ledger as $$
declare s jsonb:=ledger.stage(i); dest text; c jsonb; begin
 if p->>'decision' not in ('approve','reject') or p->>'decision' is null then raise exception 'invalid decision'; end if;
 if not(s ? 'gate') or i.blocked_on is not null then raise exception 'not an available gate'; end if;
 if p->>'binding' is distinct from ledger.binding(i,s) then raise exception 'stale_binding'; end if;
 if via <> 'mayi' or a.kind <> 'human' or a.role <> s->'gate'->>'role' then raise exception 'forbidden'; end if;
 insert into gates(item_id,stage,epoch,binding,decided_by,via,decision,feedback) values(i.id,i.stage,i.gate_epoch,p->>'binding',a.id,via,p->>'decision',p->'feedback');
 dest:=case when p->>'decision'='approve' then s->>'on_approve' else s->>'on_reject' end;
 i:=ledger.move(i,a.id,dest,case when p->>'decision'='reject' then 'rework' else 'gate_decided' end,p);
 if i.kind='plan' and ledger.stage(i)->>'on_enter'='spawn_children' then
  for c in select value from jsonb_array_elements(coalesce(i.spec->'proposed_children','[]')) loop
   if coalesce(c->>'key','')='' then raise exception 'child key required'; end if;
   perform ledger.create_item(a,c||jsonb_build_object('project_id',i.project_id,'child_key',c->>'key'),i.id);
  end loop;
 end if;
 return i;
end $$;
create or replace function ledger.view_item(i ledger.work_items,a ledger.actors) returns jsonb language sql stable set search_path=pg_catalog,ledger as $$
 select to_jsonb(i)||jsonb_build_object('allowed_actions',ledger.actions(i,a),
 'events',coalesce((select jsonb_agg(t order by seq) from (select * from events where item_id=i.id order by seq desc limit 100)t),'[]'),
 'artifacts',coalesce((select jsonb_agg(t) from artifacts t where item_id=i.id),'[]'),
 'approval', (select jsonb_build_object('status',r.status,'approval_id',r.remote_id,'expires_at',r.expires_at,'error',r.last_error) from approval_requests r where r.item_id=i.id and r.epoch=i.gate_epoch))
$$;
-- Only the trusted Supabase functions can call this API; agent actor keys never authorize it.
create function public.ledger_approval_backend(p_op text,p_args jsonb default '{}') returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger,public,extensions as $$
declare r approval_requests; i work_items; a actors; c approval_config; result jsonb; claim uuid; evt text; begin
 if p_op='config' then
  select * into c from approval_config;
  if c.singleton is null then raise exception 'May I is not configured'; end if;
  return to_jsonb(c)-array['access_secret','refresh_secret','refresh_claim','refresh_started_at'];
 elsif p_op='token' then
  select * into c from approval_config for update;
  if c.singleton is null then raise exception 'May I is not configured'; end if;
  if c.client_id is distinct from p_args->>'client_id' then raise exception 'May I authorization changed; retry with current configuration'; end if;
  if c.expires_at>now()+interval '2 minutes' then return jsonb_build_object('access_token',ledger.reveal(c.access_secret)); end if;
  -- Never reuse a rotating refresh token after a crash or an uncertain HTTP response.
  if c.refresh_claim is not null then raise exception 'May I refresh in progress or uncertain; reauthorize if stalled'; end if;
  claim:=gen_random_uuid(); update approval_config set refresh_claim=claim,refresh_started_at=now();
  return jsonb_build_object('claim',claim,'refresh_token',ledger.reveal(c.refresh_secret),'client_id',c.client_id);
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
  update approval_requests set mayi_user_id=coalesce(mayi_user_id,(select mayi_user_id from approvers where actor_id=r.actor_id)),expires_at=case when first_attempt_at is null then now()+interval '7 days 1 minute' else expires_at end,first_attempt_at=coalesce(first_attempt_at,now()),lease_until=now()+interval '2 minutes',lease_token=gen_random_uuid(),attempts=attempts+1
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
  if p_args->>'status' in ('approved','denied') and (p_args->>'approver_id' is null or (p_args->>'approver_id') is distinct from r.mayi_user_id) then raise exception 'wrong approver'; end if;
  insert into approval_events(event_id,request_id,status,occurred_at) values(p_args->>'event_id',r.id,p_args->>'status',(p_args->>'occurred_at')::timestamptz);
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
revoke all on all tables in schema ledger from public,anon,authenticated;
revoke all on all functions in schema ledger from public,anon,authenticated;
revoke all on function public.ledger_approval_backend(text,jsonb) from public,anon,authenticated;
grant execute on function public.ledger_approval_backend(text,jsonb) to service_role;
-- Existing waiting gates are reissued with fresh epochs, never grandfathered in.
do $$ declare i ledger.work_items; e uuid; begin
 for i in select * from ledger.work_items where ledger.stage(work_items) ? 'gate' and blocked_on is null for update loop
  update ledger.work_items set gate_epoch=gate_epoch+1,version=version+1 where id=i.id returning * into i;
  e:=ledger.event(i,null,'approval_backend_changed','{}'); perform ledger.enter(i,null,e);
 end loop;
end $$;
commit;
