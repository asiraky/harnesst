-- Gate approvals move into harnesst. The May I backend (OAuth, dispatcher, signed callbacks) is
-- retired; harnesst holds one approvals key, lists open requests, publishes each as a harnesst
-- approval and records the human decision. Agents never hold that key.
begin;
do $$ begin
 if to_regclass('cron.job') is not null then
  perform cron.unschedule(jobid) from cron.job where jobname='ledger-approval-dispatch';
 end if;
 if to_regclass('vault.secrets') is not null then
  begin delete from vault.secrets where name='ledger_dispatch_token';
  exception when insufficient_privilege then null; end;
 end if;
end $$;
drop function if exists public.ledger_approval_backend(text,jsonb);
drop function if exists public.ledger_oauth(text,jsonb);
drop table if exists ledger.oauth_attempts, ledger.oauth_registration, ledger.approval_config;
alter table ledger.approval_requests
 drop column if exists remote_id, drop column if exists callback_state,
 drop column if exists first_attempt_at, drop column if exists next_attempt_at,
 drop column if exists lease_until, drop column if exists lease_token, drop column if exists attempts,
 drop column if exists review_body, drop column if exists review_digest,
 drop column if exists supersedes_remote_id;
alter table ledger.approval_events add column if not exists approver_name text;
create table if not exists ledger.approval_access (
 singleton boolean primary key default true check(singleton),
 key_hash text not null
);
create or replace function ledger.enter(i ledger.work_items,a uuid,e uuid) returns void language plpgsql set search_path=pg_catalog,ledger,public,extensions as $$
declare s jsonb:=ledger.stage(i); role_name text; h actors; begin
 update outbox set status='done',done_at=now() where item_id=i.id and status in ('pending','claimed');
 update approval_requests set status='superseded' where item_id=i.id and status in ('pending','submitted');
 role_name:=s->>'owner';
 if s ? 'gate' or i.blocked_on is not null then role_name:=ledger.workflow(i)->>'human_proxy'; end if;
 -- At a gate the proxy is woken once harnesst has published the approval (notify_review_status).
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
    'approver_role',s->'gate'->>'role',
    'evidence',coalesce((select jsonb_agg(payload order by seq) from events where item_id=i.id and kind='evidence' and head_sha is not distinct from i.head_sha),'[]'::jsonb),
    'artifacts',coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from artifacts t where item_id=i.id),'[]'::jsonb))));
 end if;
end $$;
create or replace function ledger.view_item(i ledger.work_items,a ledger.actors) returns jsonb language sql stable set search_path=pg_catalog,ledger as $$
 select to_jsonb(i)||jsonb_build_object('allowed_actions',ledger.actions(i,a),
 'events',coalesce((select jsonb_agg(t order by seq) from (select * from events where item_id=i.id order by seq desc limit 100)t),'[]'),
 'artifacts',coalesce((select jsonb_agg(t) from artifacts t where item_id=i.id),'[]'),
 'approval', (select jsonb_build_object('status',r.status,'approval_id',r.id,'expires_at',r.expires_at,'error',r.last_error,'review_url',r.review_url) from approval_requests r where r.item_id=i.id and r.epoch=i.gate_epoch))
$$;
create or replace function ledger.decide(i ledger.work_items,a ledger.actors,p jsonb,via text) returns ledger.work_items language plpgsql set search_path=pg_catalog,ledger as $$
declare s jsonb:=ledger.stage(i); dest text; c jsonb; begin
 if p->>'decision' not in ('approve','reject') or p->>'decision' is null then raise exception 'invalid decision'; end if;
 if not(s ? 'gate') or i.blocked_on is not null then raise exception 'not an available gate'; end if;
 if p->>'binding' is distinct from ledger.binding(i,s) then raise exception 'stale_binding'; end if;
 if via <> 'harnesst' or a.kind <> 'human' or a.role <> s->'gate'->>'role' then raise exception 'forbidden'; end if;
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
-- Wake the proxy once the harnesst approval exists, or when the request lapses unanswered.
create or replace function ledger.notify_review_status() returns trigger language plpgsql set search_path=pg_catalog,ledger as $$
declare i work_items; e uuid; begin
 if new.status not in ('submitted','failed','expired') or old.status=new.status then return new; end if;
 select * into i from work_items where id=new.item_id;
 if i.gate_epoch<>new.epoch or i.stage<>new.stage or i.closed_at is not null then return new; end if;
 e:=ledger.event(i,null,'approval_'||new.status,jsonb_build_object('approval_id',new.id,'review_url',new.review_url,'error',new.last_error));
 insert into outbox(item_id,event_id,actor_id) select i.id,e,id from actors where kind='agent' and role=ledger.workflow(i)->>'human_proxy';
 return new;
end $$;
create or replace function ledger.approval_view(r ledger.approval_requests) returns jsonb language sql stable set search_path=pg_catalog,ledger as $$
 select jsonb_build_object('id',r.id,'item_id',r.item_id,'epoch',r.epoch,'stage',r.stage,'binding',r.binding,
  'status',r.status,'action',r.action,'review_url',r.review_url,'created_at',r.created_at,'expires_at',r.expires_at,
  'project',(select jsonb_build_object('id',p.id,'slug',p.slug,'name',p.name,'repo',p.repo) from work_items w join projects p on p.id=w.project_id where w.id=r.item_id),
  'decision',(select jsonb_build_object('status',e.status,'approver_id',e.approver_id,'approver_name',e.approver_name,'feedback',e.feedback,'occurred_at',e.occurred_at)
   from approval_events e where e.request_id=r.id order by e.received_at desc limit 1))
$$;
-- The harnesst control plane's API. Only the holder of the approvals key may call it.
create or replace function public.ledger_approvals(p_key text,p_op text,p_args jsonb default '{}') returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger,public,extensions as $$
declare r approval_requests; i work_items; a actors; ids uuid[]; begin
 if not exists(select 1 from approval_access where key_hash=ledger.hash(p_key)) then raise exception 'forbidden'; end if;
 if p_op='list' then
  update approval_requests set status='expired' where status in ('pending','submitted') and expires_at<now();
  select coalesce(array_agg(x::uuid),'{}') into ids from jsonb_array_elements_text(coalesce(p_args->'ids','[]')) x;
  return coalesce((select jsonb_agg(ledger.approval_view(t) order by t.created_at) from approval_requests t
   where t.status in ('pending','submitted') or t.id=any(ids)),'[]');
 end if;
 select * into r from approval_requests where id=(p_args->>'id')::uuid;
 if r.id is null then raise exception 'approval not found'; end if;
 if p_op='publish' then
  if coalesce(p_args->>'review_url','') !~ '^https?://[^ /]+/' then raise exception 'review URL required'; end if;
  update approval_requests set status='submitted',review_url=p_args->>'review_url' where id=r.id and status='pending' returning * into r;
  if r.id is null then select * into r from approval_requests where id=(p_args->>'id')::uuid; end if;
  return ledger.approval_view(r);
 elsif p_op='resolve' then
  if p_args->>'decision' not in ('approve','reject') or p_args->>'decision' is null then raise exception 'invalid decision'; end if;
  if nullif(p_args->>'approver_id','') is null then raise exception 'approver required'; end if;
  -- Lock item before request: the same order as agent mutations.
  select * into i from work_items where id=r.item_id for update;
  select * into r from approval_requests where id=r.id for update;
  if r.status in ('approved','denied') then return ledger.approval_view(r)||'{"outcome":"already_decided"}'; end if;
  if r.status not in ('pending','submitted') then return ledger.approval_view(r)||'{"outcome":"closed"}'; end if;
  if r.expires_at<now() then
   update approval_requests set status='expired' where id=r.id returning * into r;
   return ledger.approval_view(r)||'{"outcome":"expired"}';
  end if;
  if i.gate_epoch<>r.epoch or i.stage<>r.stage or i.blocked_on is not null or ledger.binding(i,ledger.stage(i)) is distinct from r.binding then
   update approval_requests set status='superseded' where id=r.id returning * into r;
   return ledger.approval_view(r)||'{"outcome":"stale"}';
  end if;
  insert into approval_events(event_id,request_id,status,occurred_at,approver_id,approver_name,decision_outcome,feedback)
   values('harnesst:'||r.id,r.id,case when p_args->>'decision'='approve' then 'approved' else 'denied' end,now(),
    p_args->>'approver_id',nullif(p_args->>'approver_name',''),upper(p_args->>'decision'),nullif(p_args->>'feedback',''));
  update approval_requests set status=case when p_args->>'decision'='approve' then 'approved' else 'denied' end,last_error=null where id=r.id returning * into r;
  select * into a from actors where id=r.actor_id;
  i:=ledger.decide(i,a,jsonb_build_object('decision',p_args->>'decision','binding',r.binding,'approval_id',r.id,
   'approver_id',p_args->>'approver_id','approver_name',p_args->>'approver_name','feedback',nullif(p_args->>'feedback','')),'harnesst');
  return ledger.approval_view(r)||jsonb_build_object('outcome','decided','item_stage',i.stage);
 end if;
 raise exception 'unknown approvals operation';
end $$;
revoke all on all tables in schema ledger from public,anon,authenticated;
revoke all on all functions in schema ledger from public,anon,authenticated;
revoke all on function public.ledger_approvals(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.ledger_approvals(text,text,jsonb) to anon;
-- Gates waiting on May I are reissued with fresh epochs for harnesst, never carried over.
do $$ declare i ledger.work_items; e uuid; begin
 for i in select * from ledger.work_items where ledger.stage(work_items) ? 'gate' and blocked_on is null and closed_at is null for update loop
  update ledger.work_items set gate_epoch=gate_epoch+1,version=version+1 where id=i.id returning * into i;
  e:=ledger.event(i,null,'approval_backend_changed','{}'); perform ledger.enter(i,null,e);
 end loop;
end $$;
notify pgrst, 'reload schema';
commit;
