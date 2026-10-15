-- Tickets are ledger sub-issues of a feature or bug; the parent issue carries the only approval gate.
begin;
alter table ledger.work_items add column if not exists blocked_by uuid[] not null default '{}';
create index if not exists work_items_parent on ledger.work_items(parent_id) where parent_id is not null;
create or replace function ledger.valid_spec(s jsonb) returns boolean language plpgsql immutable as $$
declare key text; c jsonb; begin
 if jsonb_typeof(s) is distinct from 'object' then return false; end if;
 foreach key in array array['problem','body'] loop
  if s ? key and jsonb_typeof(s->key) is distinct from 'string' then return false; end if;
 end loop;
 foreach key in array array['acceptance_criteria','out_of_scope','decisions','open_questions','proposed_children'] loop
  if s ? key and jsonb_typeof(s->key) is distinct from 'array' then return false; end if;
 end loop;
 for c in select value from jsonb_array_elements(coalesce(s->'acceptance_criteria','[]')) loop
  if jsonb_typeof(c)<>'string' then return false; end if;
 end loop;
 for c in select value from jsonb_array_elements(coalesce(s->'proposed_children','[]')) loop
  if jsonb_typeof(c) is distinct from 'object' or coalesce(c->>'key','')='' or coalesce(c->>'title','')='' or coalesce(c->>'kind','') not in ('feature','bug','infra') or not ledger.valid_spec(c->'spec') then return false; end if;
 end loop; return true;
end $$;
create or replace function ledger.create_item(a ledger.actors,p jsonb,parent uuid default null) returns ledger.work_items language plpgsql set search_path=pg_catalog,ledger as $$
declare i work_items; w workflows; e uuid; begin
 select * into w from workflows where project_id=(p->>'project_id')::uuid and active;
 if w.project_id is null or w.definition->'kinds'->(p->>'kind') is null then raise exception 'unknown project or kind'; end if;
 if coalesce(p->>'title','')='' or jsonb_typeof(p->'spec') is distinct from 'object' then raise exception 'title and spec required'; end if;
 insert into work_items(project_id,workflow_version,kind,title,spec,stage,created_by,parent_id,child_key,blocked_by)
 values(w.project_id,w.version,p->>'kind',p->>'title',p->'spec',w.definition->'kinds'->(p->>'kind')->'stages'->0->>'id',a.id,parent,p->>'child_key',
  array(select jsonb_array_elements_text(coalesce(p->'blocked_by','[]'))::uuid)) returning * into i;
 e:=ledger.event(i,a.id,'created',p-'spec'); perform ledger.enter(i,a.id,e); return i;
end $$;
create or replace function ledger.requirements(i ledger.work_items,edge jsonb) returns void language plpgsql set search_path=pg_catalog,ledger as $$
declare r text; found_e boolean; begin
 for r in select jsonb_array_elements_text(coalesce(edge->'requires','[]')) loop
  select exists(select 1 from events where item_id=i.id and kind='evidence' and payload->>'type'=r and spec_version=i.spec_version and head_sha is not distinct from i.head_sha
   and seq > coalesce((select max(seq) from events where item_id=i.id and kind in ('reset','spec_updated','rework')),0)) into found_e;
  if not found_e then raise exception '% missing for current binding',r; end if;
 end loop;
 for r in select jsonb_array_elements_text(coalesce(edge->'requires_artifact','[]')) loop
  if not exists(select 1 from artifacts where item_id=i.id and type=r and (r not in ('preview_url','deployment') or head_sha=i.head_sha)) then raise exception '% artifact missing for current head',r; end if;
 end loop;
 if coalesce((edge->>'requires_tickets')::boolean,false) and not exists(select 1 from work_items where parent_id=i.id and kind='ticket') then raise exception 'no tickets created'; end if;
 if coalesce((edge->>'requires_tickets_closed')::boolean,false) and exists(select 1 from work_items where parent_id=i.id and kind='ticket' and closed_at is null) then raise exception 'open tickets remain'; end if;
end $$;
create or replace function ledger.can_edit_spec(i ledger.work_items,a ledger.actors) returns boolean language sql stable set search_path=pg_catalog,ledger as $$
 select i.blocked_on is null and i.head_sha is null and i.closed_at is null
  and (a.role='intake' or (a.role in ('infra','architect') and ledger.stage(i)->>'owner'=a.role))
$$;
create or replace function ledger.actions(i ledger.work_items,a ledger.actors) returns jsonb language plpgsql set search_path=pg_catalog,ledger as $$
declare s jsonb:=ledger.stage(i); edge jsonb; dest text; moves jsonb:='[]'; ev jsonb:='[]'; begin
 if i.blocked_on is null and s->>'owner'=a.role and not(i.stage='triage' and jsonb_array_length(coalesce(i.spec->'open_questions','[]'))>0) then
  for dest,edge in select key,value from jsonb_each(coalesce(s->'next','{}')) loop
   begin perform ledger.requirements(i,edge); moves:=moves||to_jsonb(dest); exception when raise_exception then null; end;
  end loop;
 end if;
 select coalesce(jsonb_agg(key),'[]') into ev from jsonb_each(coalesce(s->'evidence','{}')) where value->'by' ? a.role;
 return jsonb_build_object('transitions',moves,'evidence',case when i.blocked_on is null then ev else '[]'::jsonb end,'update_spec',ledger.can_edit_spec(i,a),'create_tickets',a.role='intake' and i.closed_at is null and i.stage='breakdown' and ledger.workflow(i)->'kinds' ? 'ticket','block',i.blocked_on is null and i.closed_at is null and coalesce(a.role=s->>'owner' or a.role=ledger.workflow(i)->>'human_proxy',false),'resolve_block',i.blocked_on is not null and (a.role=i.blocked_on->>'role' or a.role=ledger.workflow(i)->>'human_proxy'),'attach',i.closed_at is null and ledger.workflow(i)->'artifacts'->'by' ? a.role,'set_head',i.closed_at is null and i.stage not in ('merged','deployed') and ledger.workflow(i)->'artifacts'->'by' ? a.role);
end $$;
create or replace function ledger.call(op text,p_key text,p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger,public,extensions as $$
declare a actors:=ledger.actor(p_key); i work_items; parent work_items; s jsonb; w jsonb; result jsonb; e uuid; b text; pos int; reset_pos int; prior gates; begin
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
  if p->>'kind'='ticket' then
   select * into parent from work_items where id=(p->>'parent_id')::uuid for update;
   if parent.id is null or parent.kind not in ('feature','bug') or parent.project_id is distinct from (p->>'project_id')::uuid then raise exception 'ticket parent must be a feature or bug in this project'; end if;
   if parent.closed_at is not null or parent.stage<>'breakdown' then raise exception 'tickets are created while the parent is in breakdown'; end if;
   if jsonb_typeof(coalesce(p->'blocked_by','[]')) is distinct from 'array' then raise exception 'blocked_by must be an array of ticket ids'; end if;
   if exists(select 1 from jsonb_array_elements_text(coalesce(p->'blocked_by','[]')) x(id)
    where x.id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or not exists(select 1 from work_items t where t.id=x.id::uuid and t.parent_id=parent.id and t.kind='ticket'))
   then raise exception 'blocked_by must name sibling tickets'; end if;
   i:=ledger.create_item(a,p,parent.id);
  else
   if p ? 'parent_id' or p ? 'blocked_by' then raise exception 'only tickets take parent_id or blocked_by'; end if;
   i:=ledger.create_item(a,p);
  end if;
  return ledger.view_item(i,a);
 end if;
 if op='list_items' then
  return coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('allowed_actions',ledger.actions(t,a))) from work_items t where (p->>'project_id' is null or t.project_id=(p->>'project_id')::uuid) and (p->>'parent_id' is null or t.parent_id=(p->>'parent_id')::uuid) and (p->>'stage' is null or t.stage=p->>'stage') and (not coalesce((p->>'mine')::boolean,false) or ledger.stage(t)->>'owner'=a.role or ((ledger.stage(t) ? 'gate' or t.blocked_on is not null) and ledger.workflow(t)->>'human_proxy'=a.role))),'[]');
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
  if not ledger.can_edit_spec(i,a) then raise exception 'spec edits require intake or the owning infra or architect role before code'; end if;
  if coalesce(p->>'note','')='' or jsonb_typeof(p->'spec') is distinct from 'object' then raise exception 'spec and note required'; end if;
  update work_items set spec=p->'spec',spec_version=spec_version+1,version=version+1,updated_at=now() where id=i.id returning * into i;
  e:=ledger.event(i,a.id,'spec_updated',p);
  -- The stage owner refining its own stage keeps the item where it is; anyone else restarts it.
  if s->>'owner' is distinct from a.role then
   i:=ledger.move(i,a.id,w->'kinds'->i.kind->'stages'->0->>'id','reset',jsonb_build_object('reason','spec changed'));
  end if;
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
revoke all on function ledger.can_edit_spec(ledger.work_items,ledger.actors) from public;
-- Move projects still on the previous operator default to the ticket workflow. In-flight items keep their version.
do $$ declare old jsonb; nxt jsonb:='{"version":2,"human_proxy":"intake","artifacts":{"by":["github","implementer"]},"kinds":{"feature":{"on_new_commit":"qa","stages":[{"id":"triage","owner":"intake","next":{"design":{},"infra":{},"breakdown":{}}},{"id":"design","owner":"architect","next":{"breakdown":{},"infra":{},"triage":{}}},{"id":"infra","owner":"infra","next":{"breakdown":{"requires":["infra_provisioned"]}},"evidence":{"infra_provisioned":{"by":["infra"]}}},{"id":"breakdown","owner":"intake","next":{"build":{"requires_tickets":true}}},{"id":"build","owner":"implementer","next":{"qa":{"requires_tickets_closed":true,"requires_artifact":["pr","preview_url"]}}},{"id":"qa","owner":"implementer","next":{"review":{"requires":["qa_passed"],"requires_artifact":["pr","preview_url"]},"build":{}},"evidence":{"qa_passed":{"by":["implementer"]},"qa_failed":{"by":["implementer"]}}},{"id":"review","owner":"implementer","next":{"merge-approval":{"requires":["review_approved"]},"build":{}},"evidence":{"review_approved":{"by":["implementer"]},"review_changes":{"by":["implementer"]}}},{"id":"merge-approval","gate":{"role":"engineer","on":"head_sha"},"on_approve":"ready-to-merge","on_reject":"build"},{"id":"ready-to-merge","owner":"github","next":{"merged":{}}},{"id":"merged","owner":"github","next":{"deployed":{"requires_artifact":["deployment"]}}},{"id":"deployed","owner":"intake","next":{},"terminal":true}]},"bug":{"on_new_commit":"qa","stages":[{"id":"triage","owner":"intake","next":{"design":{},"infra":{},"breakdown":{}}},{"id":"design","owner":"architect","next":{"breakdown":{},"infra":{},"triage":{}}},{"id":"infra","owner":"infra","next":{"breakdown":{"requires":["infra_provisioned"]}},"evidence":{"infra_provisioned":{"by":["infra"]}}},{"id":"breakdown","owner":"intake","next":{"build":{"requires_tickets":true}}},{"id":"build","owner":"implementer","next":{"qa":{"requires_tickets_closed":true,"requires_artifact":["pr","preview_url"]}}},{"id":"qa","owner":"implementer","next":{"review":{"requires":["qa_passed"],"requires_artifact":["pr","preview_url"]},"build":{}},"evidence":{"qa_passed":{"by":["implementer"]},"qa_failed":{"by":["implementer"]}}},{"id":"review","owner":"implementer","next":{"merge-approval":{"requires":["review_approved"]},"build":{}},"evidence":{"review_approved":{"by":["implementer"]},"review_changes":{"by":["implementer"]}}},{"id":"merge-approval","gate":{"role":"engineer","on":"head_sha"},"on_approve":"ready-to-merge","on_reject":"build"},{"id":"ready-to-merge","owner":"github","next":{"merged":{}}},{"id":"merged","owner":"github","next":{"deployed":{"requires_artifact":["deployment"]}}},{"id":"deployed","owner":"intake","next":{},"terminal":true}]},"ticket":{"stages":[{"id":"open","owner":"github","next":{"merged":{}}},{"id":"merged","owner":"github","next":{},"terminal":true}]},"infra":{"stages":[{"id":"triage","owner":"intake","next":{"infra":{}}},{"id":"infra","owner":"infra","next":{"done":{"requires":["infra_provisioned"]}},"evidence":{"infra_provisioned":{"by":["infra"]}}},{"id":"done","owner":"intake","next":{},"terminal":true}]}}}'::jsonb; r record; begin
 select definition into old from ledger.workflow_templates where name='default';
 insert into ledger.workflow_templates(name,definition) values('default',nxt) on conflict(name) do update set definition=excluded.definition;
 if old is null or old=nxt then return; end if;
 for r in select project_id,version from ledger.workflows where active and definition=old loop
  update ledger.workflows set active=false where project_id=r.project_id and version=r.version;
  insert into ledger.workflows(project_id,version,definition) values(r.project_id,(select max(version)+1 from ledger.workflows where project_id=r.project_id),nxt);
 end loop;
end $$;
commit;
