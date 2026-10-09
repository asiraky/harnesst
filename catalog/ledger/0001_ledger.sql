-- One database per team. Private data and helpers; only named RPCs are exposed.
begin;
create extension if not exists pgcrypto;
create schema ledger;
revoke all on schema ledger from public;
create table ledger.settings (key text primary key, value text not null);
insert into ledger.settings values ('encryption_key', encode(gen_random_bytes(32),'hex')), ('gate_origin','http://localhost:55430'), ('allow_http_wakes','true');
create table ledger.actors (
 id uuid primary key default gen_random_uuid(), role text not null unique,
 kind text not null check(kind in ('agent','human','system')), display_name text not null,
 email text, key_hash text unique, wake_hash text unique, wake_secret bytea, wake_url text
);
create table ledger.projects (
 id uuid primary key default gen_random_uuid(), slug text not null unique, name text not null,
 repo text not null, deploy_target text not null default 'cloudflare', docs jsonb not null default '{}', created_at timestamptz not null default now()
);
create unique index project_repo on ledger.projects(lower(repo));
create table ledger.workflows (
 project_id uuid references ledger.projects, version int not null, definition jsonb not null,
 active boolean not null default true, primary key(project_id,version)
);
create unique index workflow_active on ledger.workflows(project_id) where active;
create function ledger.valid_spec(s jsonb) returns boolean language plpgsql immutable as $$
declare key text; c jsonb; begin
 if jsonb_typeof(s) is distinct from 'object' then return false; end if;
 if s ? 'problem' and jsonb_typeof(s->'problem') is distinct from 'string' then return false; end if;
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
create table ledger.work_items (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references ledger.projects,
 workflow_version int not null, kind text not null, title text not null,
 parent_id uuid references ledger.work_items, child_key text, stage text not null,
 version int not null default 1, iteration int not null default 1, spec jsonb not null check(ledger.valid_spec(spec)),
 spec_version int not null default 1, head_sha text, head_sha_at timestamptz,
 blocked_on jsonb, gate_epoch int not null default 0,
 created_by uuid not null references ledger.actors, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), closed_at timestamptz,
 foreign key(project_id,workflow_version) references ledger.workflows,
 unique(parent_id,child_key)
);
create table ledger.events (
 id uuid primary key default gen_random_uuid(), seq bigint generated always as identity,
 item_id uuid not null references ledger.work_items, actor_id uuid references ledger.actors,
 kind text not null, payload jsonb not null default '{}', head_sha text, spec_version int,
 created_at timestamptz not null default now()
);
create table ledger.artifacts (
 id uuid primary key default gen_random_uuid(), item_id uuid not null references ledger.work_items,
 iteration int not null, type text not null check(type in ('branch','pr','preview_url','deployment')),
 value text not null, head_sha text, created_at timestamptz not null default now(), unique(item_id,iteration,type)
);
create table ledger.gates (
 id uuid primary key default gen_random_uuid(), item_id uuid not null references ledger.work_items,
 stage text not null, epoch int not null, binding text not null, decided_by uuid not null references ledger.actors,
 via text not null, attested_human text, decision text not null, feedback jsonb,
 created_at timestamptz not null default now(), unique(item_id,epoch)
);
create table ledger.gate_links (
 id uuid primary key default gen_random_uuid(), item_id uuid not null references ledger.work_items,
 stage text not null, epoch int not null, binding text not null, actor_id uuid not null references ledger.actors,
 token_hash text not null unique, token_secret bytea not null, expires_at timestamptz not null default now()+interval '7 days', used_at timestamptz
);
create table ledger.outbox (
 id uuid primary key default gen_random_uuid(), item_id uuid not null references ledger.work_items,
 event_id uuid not null references ledger.events, actor_id uuid not null references ledger.actors,
 kind text not null default 'wake' check(kind in ('wake','escalation')),
 status text not null default 'pending' check(status in ('pending','claimed','done','failed')),
 attempts int not null default 0, next_attempt_at timestamptz not null default now(),
 claimed_at timestamptz, lease_until timestamptz, claim_token uuid, done_at timestamptz, created_at timestamptz not null default now(),
 unique(event_id,actor_id,kind)
);
create index on ledger.work_items(project_id,stage);
create index on ledger.events(item_id,seq);
create index on ledger.outbox(status,next_attempt_at);
create function ledger.hash(t text) returns text language sql immutable strict set search_path=pg_catalog,public,extensions as $$ select encode(digest(t,'sha256'),'hex') $$;
create function ledger.secret(t text) returns bytea language sql security definer set search_path=pg_catalog,ledger,public,extensions as $$ select pgp_sym_encrypt(t,(select value from settings where key='encryption_key')) $$;
create function ledger.reveal(t bytea) returns text language sql security definer set search_path=pg_catalog,ledger,public,extensions as $$ select pgp_sym_decrypt(t,(select value from settings where key='encryption_key')) $$;
create function ledger.actor(k text) returns ledger.actors language plpgsql security definer set search_path=pg_catalog,ledger,public,extensions as $$
declare a actors; begin select * into a from actors where key_hash=ledger.hash(k); if a.id is null then raise exception 'unauthorized'; end if; return a; end $$;
create function public.ledger_mint_actor(p_role text,p_kind text,p_name text,p_email text default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger,public,extensions as $$
declare k text; w text; a actors; begin
 if p_kind <> 'human' then k:=encode(gen_random_bytes(32),'hex'); end if;
 if p_kind = 'agent' then w:=encode(gen_random_bytes(32),'hex'); end if;
 insert into actors(role,kind,display_name,email,key_hash,wake_hash,wake_secret) values(p_role,p_kind,p_name,p_email,ledger.hash(k),ledger.hash(w),ledger.secret(w))
 on conflict(role) do update set kind=excluded.kind,display_name=excluded.display_name,email=excluded.email,key_hash=excluded.key_hash,wake_hash=excluded.wake_hash,wake_secret=excluded.wake_secret returning * into a;
 return jsonb_build_object('actor_id',a.id,'actor_key',k,'wake_token',w);
end $$;
create function ledger.workflow(i ledger.work_items) returns jsonb language sql stable set search_path=pg_catalog,ledger as $$ select definition from workflows where project_id=i.project_id and version=i.workflow_version $$;
create function ledger.stage(i ledger.work_items) returns jsonb language sql stable set search_path=pg_catalog,ledger as $$ select s from jsonb_array_elements(ledger.workflow(i)->'kinds'->i.kind->'stages') s where s->>'id'=i.stage $$;
create function ledger.binding(i ledger.work_items,s jsonb) returns text language sql immutable as $$ select case when s->'gate'->>'on'='spec_version' then i.spec_version::text else i.head_sha end $$;
create function ledger.event(i ledger.work_items,a uuid,k text,p jsonb) returns uuid language plpgsql set search_path=pg_catalog,ledger as $$
declare e uuid; begin insert into events(item_id,actor_id,kind,payload,head_sha,spec_version) values(i.id,a,k,p,i.head_sha,i.spec_version) returning id into e; return e; end $$;
-- Entry effects are atomic with the item mutation. Gate tokens never enter the event log.
create function ledger.enter(i ledger.work_items,a uuid,e uuid) returns void language plpgsql set search_path=pg_catalog,ledger,public,extensions as $$
declare s jsonb:=ledger.stage(i); role_name text; h actors; token text; b text; begin
 update outbox set status='done',done_at=now() where item_id=i.id and status in ('pending','claimed');
 update gate_links set used_at=now() where item_id=i.id and used_at is null;
 role_name:=s->>'owner';
 if s ? 'gate' or i.blocked_on is not null then role_name:=ledger.workflow(i)->>'human_proxy'; end if;
 insert into outbox(item_id,event_id,actor_id) select i.id,e,id from actors where role=role_name and kind='agent' and (a is null or id<>a or i.blocked_on is not null or s ? 'gate');
 if s ? 'gate' and i.blocked_on is null then
  b:=ledger.binding(i,s); if b is null then raise exception 'missing gate binding'; end if;
  for h in select * from actors where role=s->'gate'->>'role' and kind='human' loop
   token:=encode(gen_random_bytes(32),'hex');
   insert into gate_links(item_id,stage,epoch,binding,actor_id,token_hash,token_secret) values(i.id,i.stage,i.gate_epoch,b,h.id,ledger.hash(token),ledger.secret(token));
  end loop;
 end if;
end $$;
create function ledger.move(i ledger.work_items,a uuid,destination text,k text,p jsonb) returns ledger.work_items language plpgsql set search_path=pg_catalog,ledger as $$
declare e uuid; s jsonb; begin
 select value into s from jsonb_array_elements(ledger.workflow(i)->'kinds'->i.kind->'stages') where value->>'id'=destination;
 if s is null then raise exception 'unknown stage'; end if;
 update work_items set stage=destination,version=version+1,gate_epoch=gate_epoch+1,updated_at=now(),closed_at=case when (s->>'terminal')::boolean then now() else null end where id=i.id returning * into i;
 e:=ledger.event(i,a,k,p||jsonb_build_object('to_stage',destination)); perform ledger.enter(i,a,e); return i;
end $$;
create function ledger.requirements(i ledger.work_items,edge jsonb) returns void language plpgsql set search_path=pg_catalog,ledger as $$
declare r text; found_e boolean; begin
 for r in select jsonb_array_elements_text(coalesce(edge->'requires','[]')) loop
  select exists(select 1 from events where item_id=i.id and kind='evidence' and payload->>'type'=r and spec_version=i.spec_version and head_sha is not distinct from i.head_sha
   and seq > coalesce((select max(seq) from events where item_id=i.id and kind in ('reset','spec_updated','rework')),0)) into found_e;
  if not found_e then raise exception '% missing for current binding',r; end if;
 end loop;
 for r in select jsonb_array_elements_text(coalesce(edge->'requires_artifact','[]')) loop
  if not exists(select 1 from artifacts where item_id=i.id and type=r and (r not in ('preview_url','deployment') or head_sha=i.head_sha)) then raise exception '% artifact missing for current head',r; end if;
 end loop;
end $$;
create function ledger.actions(i ledger.work_items,a ledger.actors) returns jsonb language plpgsql set search_path=pg_catalog,ledger as $$
declare s jsonb:=ledger.stage(i); edge jsonb; dest text; moves jsonb:='[]'; ev jsonb:='[]'; begin
 if i.blocked_on is null and s->>'owner'=a.role and not(i.stage='triage' and jsonb_array_length(coalesce(i.spec->'open_questions','[]'))>0) then
  for dest,edge in select key,value from jsonb_each(coalesce(s->'next','{}')) loop
   begin perform ledger.requirements(i,edge); moves:=moves||to_jsonb(dest); exception when raise_exception then null; end;
  end loop;
 end if;
 select coalesce(jsonb_agg(key),'[]') into ev from jsonb_each(coalesce(s->'evidence','{}')) where value->'by' ? a.role;
 return jsonb_build_object('transitions',moves,'evidence',case when i.blocked_on is null then ev else '[]'::jsonb end,'decide_gate',i.blocked_on is null and s ? 'gate' and a.role=ledger.workflow(i)->>'human_proxy','update_spec',i.blocked_on is null and (a.role='intake' or (a.role='infra' and s->>'owner'='infra')) and i.head_sha is null and i.closed_at is null,'block',i.blocked_on is null and i.closed_at is null and coalesce(a.role=s->>'owner' or a.role=ledger.workflow(i)->>'human_proxy',false),'resolve_block',i.blocked_on is not null and (a.role=i.blocked_on->>'role' or a.role=ledger.workflow(i)->>'human_proxy'),'attach',i.closed_at is null and ledger.workflow(i)->'artifacts'->'by' ? a.role,'set_head',i.closed_at is null and i.stage not in ('merged','deployed') and ledger.workflow(i)->'artifacts'->'by' ? a.role);
end $$;
create function ledger.view_item(i ledger.work_items,a ledger.actors) returns jsonb language sql stable set search_path=pg_catalog,ledger as $$
 select to_jsonb(i)||jsonb_build_object('allowed_actions',ledger.actions(i,a),
 'events',coalesce((select jsonb_agg(t order by seq) from (select * from events where item_id=i.id order by seq desc limit 100)t),'[]'),
 'artifacts',coalesce((select jsonb_agg(t) from artifacts t where item_id=i.id),'[]'),
 'gate_links',case when a.role=ledger.workflow(i)->>'human_proxy' then coalesce((select jsonb_agg(jsonb_build_object('role',h.role,'url',(select value from settings where key='gate_origin')||'/functions/v1/gate?t='||ledger.reveal(l.token_secret),'binding',l.binding)) from gate_links l join actors h on h.id=l.actor_id where l.item_id=i.id and l.used_at is null and l.expires_at>now()),'[]') else '[]'::jsonb end)
$$;
-- Workflow format uses per-edge requirements so failed QA can return to build.
create function ledger.validate_workflow(w jsonb) returns boolean language plpgsql immutable as $$
declare k jsonb; s jsonb; target text; ids text[]; begin
 if jsonb_typeof(w->'kinds') is distinct from 'object' or coalesce(w->>'human_proxy','')='' then return false; end if;
 for k in select value from jsonb_each(w->'kinds') loop
  if jsonb_typeof(k->'stages') is distinct from 'array' or jsonb_array_length(k->'stages')=0 then return false; end if;
  select array_agg(value->>'id') into ids from jsonb_array_elements(k->'stages');
  if cardinality(ids)<>(select count(distinct x) from unnest(ids)x) then return false; end if;
  for s in select value from jsonb_array_elements(k->'stages') loop
   if coalesce(s->>'id','')='' or (s ? 'gate')=(s ? 'owner') then return false; end if;
   if s ? 'gate' then
    if coalesce(s->'gate'->>'on','') not in ('head_sha','spec_version') or coalesce(s->'gate'->>'role','')='' then return false; end if;
    if (s->>'on_approve'=any(ids) and s->>'on_reject'=any(ids)) is not true then return false; end if;
   else
    if coalesce(s->>'owner','')='' then return false; end if;
    if jsonb_typeof(coalesce(s->'next','{}'))<>'object' then return false; end if;
    for target in select jsonb_object_keys(coalesce(s->'next','{}')) loop if not target=any(ids) then return false; end if; end loop;
   end if;
  end loop;
  if k ? 'on_new_commit' and (k->>'on_new_commit'=any(ids)) is not true then return false; end if;
 end loop; return true;
end $$;
alter table ledger.workflows add check(ledger.validate_workflow(definition));
-- Only the SQL operator can approve templates; intake selects one, never supplies executable policy.
create table ledger.workflow_templates (
 name text primary key, definition jsonb not null check(ledger.validate_workflow(definition))
);
create function ledger.create_item(a ledger.actors,p jsonb,parent uuid default null) returns ledger.work_items language plpgsql set search_path=pg_catalog,ledger as $$
declare i work_items; w workflows; e uuid; begin
 select * into w from workflows where project_id=(p->>'project_id')::uuid and active;
 if w.project_id is null or w.definition->'kinds'->(p->>'kind') is null then raise exception 'unknown project or kind'; end if;
 if coalesce(p->>'title','')='' or jsonb_typeof(p->'spec') is distinct from 'object' then raise exception 'title and spec required'; end if;
 insert into work_items(project_id,workflow_version,kind,title,spec,stage,created_by,parent_id,child_key)
 values(w.project_id,w.version,p->>'kind',p->>'title',p->'spec',w.definition->'kinds'->(p->>'kind')->'stages'->0->>'id',a.id,parent,p->>'child_key') returning * into i;
 e:=ledger.event(i,a.id,'created',p-'spec'); perform ledger.enter(i,a.id,e); return i;
end $$;
create function ledger.decide(i ledger.work_items,a ledger.actors,p jsonb,via text) returns ledger.work_items language plpgsql set search_path=pg_catalog,ledger as $$
declare s jsonb:=ledger.stage(i); dest text; c jsonb; begin
 if p->>'decision' not in ('approve','reject') or p->>'decision' is null then raise exception 'invalid decision'; end if;
 if not(s ? 'gate') or i.blocked_on is not null then raise exception 'not an available gate'; end if;
 if p->>'binding' is distinct from ledger.binding(i,s) then raise exception 'stale_binding'; end if;
 if via='proxy' then
  if a.role<>ledger.workflow(i)->>'human_proxy' then raise exception 'forbidden'; end if;
  if not exists(select 1 from actors where kind='human' and role=s->'gate'->>'role' and email=p->>'attested_human') then raise exception 'attested_human must name this gate human'; end if;
 elsif a.kind<>'human' or a.role<>s->'gate'->>'role' then raise exception 'forbidden'; end if;
 insert into gates(item_id,stage,epoch,binding,decided_by,via,attested_human,decision,feedback) values(i.id,i.stage,i.gate_epoch,p->>'binding',a.id,via,p->>'attested_human',p->>'decision',p->'feedback');
 dest:=case when p->>'decision'='approve' then s->>'on_approve' else s->>'on_reject' end;
 if p ? 'route' then
  if p->>'decision'<>'approve' or not coalesce(s->'routes','{}') ? (p->>'route') then raise exception 'invalid gate route'; end if;
  dest:=s->'routes'->>(p->>'route');
 end if;
 i:=ledger.move(i,a.id,dest,case when p->>'decision'='reject' then 'rework' else 'gate_decided' end,p-'attested_human');
 if i.kind='plan' and ledger.stage(i)->>'on_enter'='spawn_children' then
  for c in select value from jsonb_array_elements(coalesce(i.spec->'proposed_children','[]')) loop
   if coalesce(c->>'key','')='' then raise exception 'child key required'; end if;
   perform ledger.create_item(a,c||jsonb_build_object('project_id',i.project_id,'child_key',c->>'key'),i.id);
  end loop;
 end if;
 return i;
end $$;
-- A single private dispatcher shares locking/auth; public wrappers are the only API.
create function ledger.call(op text,p_key text,p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger,public,extensions as $$
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
 -- Exact decision retry is safe even after the item moved. A different request is refused.
 if op='decide_gate' and a.role=w->>'human_proxy' then
  select * into prior from gates where item_id=i.id and epoch=(p->>'gate_epoch')::int;
  if prior.id is not null and prior.via='proxy' and prior.decided_by=a.id and prior.decision=p->>'decision' and prior.binding=p->>'binding' and prior.attested_human=p->>'attested_human' then return ledger.view_item(i,a); end if;
 end if;
 if op='set_head' and (p->>'observed_at')::timestamptz>clock_timestamp()+interval '1 minute' then raise exception 'observed_at is in the future'; end if;
 if op='set_head' and (p->>'observed_at')::timestamptz<=i.head_sha_at then return ledger.view_item(i,a); end if;
 if (p->>'expected_version')::int is distinct from i.version then raise exception 'stale (item version %, sent %)',i.version,p->>'expected_version'; end if;
 if op='transition' then
  if i.blocked_on is not null then raise exception 'blocked'; end if;
  if a.role='github' and (i.head_sha is null or p->>'binding' is distinct from i.head_sha) then raise exception 'stale_binding'; end if;
  if s ? 'gate' then raise exception 'gate stage; only decide_gate leaves it'; end if;
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
   insert into artifacts(item_id,iteration,type,value,head_sha) values(i.id,i.iteration,p->>'type',p->>'value',i.head_sha) on conflict(item_id,iteration,type) do update set value=excluded.value,head_sha=excluded.head_sha;
   update work_items set version=version+1,updated_at=now() where id=i.id returning * into i; perform ledger.event(i,a.id,'artifact',p);
  else
   if coalesce(p->>'head_sha','') !~ '^[0-9a-f]{40}$' or p->>'observed_at' is null then raise exception 'full head SHA and observed_at required'; end if;
   if i.stage in ('merged','deployed') then raise exception 'cannot change merged head'; end if;
   b:=i.head_sha;
   update work_items set head_sha=p->>'head_sha',head_sha_at=least((p->>'observed_at')::timestamptz,clock_timestamp()),version=version+1,updated_at=now() where id=i.id returning * into i;
   perform ledger.event(i,a.id,'head',p);
   if b is distinct from i.head_sha then
    select n into pos from jsonb_array_elements(w->'kinds'->i.kind->'stages') with ordinality as x(v,n) where v->>'id'=i.stage;
    select n into reset_pos from jsonb_array_elements(w->'kinds'->i.kind->'stages') with ordinality as x(v,n) where v->>'id'=w->'kinds'->i.kind->>'on_new_commit';
    if pos>=reset_pos then i:=ledger.move(i,a.id,w->'kinds'->i.kind->>'on_new_commit','reset',p); end if;
   end if;
  end if;
 elsif op='decide_gate' then
  if (p->>'gate_epoch')::int is distinct from i.gate_epoch then raise exception 'stale gate'; end if;
  i:=ledger.decide(i,a,p,'proxy');
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
create function public.ledger_claim(p_key text,p_args jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger as $$
declare o outbox; a actors; i work_items; begin
 select * into a from actors where wake_hash=ledger.hash(p_key); if a.id is null then raise exception 'unauthorized'; end if;
 -- Item first: same lock order as transition, avoiding claim/transition deadlocks.
 select w.* into i from work_items w join outbox b on b.item_id=w.id where b.id=(p_args->>'outbox_id')::uuid and b.actor_id=a.id for update of w;
 if i.id is null then return '{"gone":true}'; end if;
 select * into o from outbox where id=(p_args->>'outbox_id')::uuid for update;
 if o.status in ('done','failed') then return '{"gone":true}'; end if;
 if o.status='claimed' and o.lease_until>now() then return '{"already_claimed":true}'; end if;
 update outbox set status='claimed',claimed_at=now(),lease_until=now()+interval '30 minutes',claim_token=gen_random_uuid() where id=o.id returning * into o;
 return jsonb_build_object('item',ledger.view_item(i,a),'outbox_id',o.id,'claim_token',o.claim_token,'kind',o.kind);
end $$;
create function public.ledger_gate(p_token text,p_args jsonb default '{}') returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger as $$
declare l gate_links; i work_items; a actors; s jsonb; begin
 select * into l from gate_links where token_hash=ledger.hash(p_token);
 if l.id is null then raise exception 'invalid link'; end if;
 select * into i from work_items where id=l.item_id for update;
 select * into l from gate_links where id=l.id for update;
 if l.used_at is not null or l.expires_at<=now() or l.epoch<>i.gate_epoch or i.blocked_on is not null or l.stage<>i.stage or l.binding is distinct from ledger.binding(i,ledger.stage(i)) then raise exception 'link expired, used, or binding changed'; end if;
 select * into a from actors where id=l.actor_id;
 if p_args ? 'decision' then
  i:=ledger.decide(i,a,p_args||jsonb_build_object('binding',l.binding),'link');
  return jsonb_build_object('ok',true,'stage',i.stage);
 end if;
 return jsonb_build_object('title',i.title,'spec',i.spec,'stage',i.stage,'binding',l.binding,'role',a.role,'routes',coalesce(ledger.stage(i)->'routes','{}'),'artifacts',coalesce((select jsonb_agg(t) from artifacts t where item_id=i.id and (type<>'preview_url' or head_sha=i.head_sha)),'[]'));
end $$;
-- Heartbeats are fenced by a per-claim token. An expired/replaced worker cannot renew another turn.
create function public.ledger_renew_claim(p_key text,p_args jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger as $$
declare a actors; o outbox; begin
 select * into a from actors where wake_hash=ledger.hash(p_key); if a.id is null then raise exception 'unauthorized'; end if;
 update outbox set lease_until=now()+interval '30 minutes'
 where id=(p_args->>'outbox_id')::uuid and actor_id=a.id and status='claimed' and lease_until>now() and claim_token=(p_args->>'claim_token')::uuid returning * into o;
 return jsonb_build_object('renewed',o.id is not null);
end $$;
-- Notification completion is separate from work-stage completion.
create function public.ledger_complete_wake(p_key text,p_args jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger as $$
declare a actors:=ledger.actor(p_key); o outbox; i work_items; begin
 select w.* into i from work_items w join outbox b on b.item_id=w.id where b.id=(p_args->>'outbox_id')::uuid and b.actor_id=a.id for update of w;
 if i.id is null then raise exception 'wake not found'; end if;
 select * into o from outbox where id=(p_args->>'outbox_id')::uuid for update;
 if o.status='done' then return '{"ok":true}'; end if;
 if o.status<>'claimed' or o.lease_until<=now() then raise exception 'active claim required'; end if;
 if not(o.kind='escalation' or i.closed_at is not null or i.blocked_on is not null or ledger.stage(i) ? 'gate') then raise exception 'work wakes complete when the stage changes'; end if;
 perform ledger.event(i,a.id,'notification_completed',jsonb_build_object('outbox_id',o.id,'note',p_args->>'note'));
 update outbox set status='done',done_at=now() where id=o.id;
 return '{"ok":true}';
end $$;
-- Operators/worker only. Attempts count delivery attempts, including unclaimed HTTP successes.
create function public.ledger_delivery_batch() returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger as $$
declare o outbox; i work_items; proxy uuid; result jsonb:='[]'; a actors; begin
 for o in select * from outbox where (status='pending' and next_attempt_at<=now()) or (status='claimed' and lease_until<=now()) order by created_at limit 100 for update skip locked loop
  if o.attempts>=10 then
   update outbox set status='failed' where id=o.id;
   if o.kind='wake' then
    select * into i from work_items where id=o.item_id;
    select id into proxy from actors where role=ledger.workflow(i)->>'human_proxy' and kind='agent';
    if proxy is not null then insert into outbox(item_id,event_id,actor_id,kind) values(o.item_id,o.event_id,proxy,'escalation') on conflict do nothing; end if;
   end if;
  else
   update outbox set status='pending',attempts=attempts+1,next_attempt_at=now()+make_interval(mins=>greatest(1,(attempts+1)^2)::int) where id=o.id;
   select * into a from actors where id=o.actor_id;
   if a.wake_url is not null then result:=result||jsonb_build_object('url',a.wake_url,'token',ledger.reveal(a.wake_secret),'body',jsonb_build_object('outbox_id',o.id,'item_id',o.item_id,'reason',o.kind)); end if;
  end if;
 end loop; return result;
end $$;
-- Explicit grants: helpers and minting never inherit PostgreSQL's default PUBLIC EXECUTE.
revoke all on all functions in schema ledger from public;
revoke all on all tables in schema ledger from public;
revoke all on function public.ledger_mint_actor(text,text,text,text),public.ledger_delivery_batch(),public.ledger_claim(text,jsonb),public.ledger_gate(text,jsonb),public.ledger_complete_wake(text,jsonb),public.ledger_renew_claim(text,jsonb) from public;
do $$ declare op text; begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
 revoke all on function public.ledger_mint_actor(text,text,text,text), public.ledger_delivery_batch() from anon;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on function public.ledger_mint_actor(text,text,text,text), public.ledger_delivery_batch() from authenticated; end if;
 foreach op in array array['whoami','list_projects','get_project','create_project','create_item','get_item','list_items','update_spec','transition','evidence','attach','set_head','decide_gate','block','resolve_block','set_wake_url'] loop
  execute format('create function public.ledger_%I(p_key text,p_args jsonb default ''{}'') returns jsonb language sql security definer set search_path=pg_catalog,ledger as $fn$ select ledger.call(%L,p_key,p_args) $fn$',op,op);
  execute format('revoke all on function public.ledger_%I(text,jsonb) from public',op);
  execute format('grant execute on function public.ledger_%I(text,jsonb) to anon',op);
 end loop;
end $$;
grant usage on schema public to anon;
grant execute on function public.ledger_claim(text,jsonb),public.ledger_gate(text,jsonb),public.ledger_complete_wake(text,jsonb),public.ledger_renew_claim(text,jsonb) to anon;
commit;
