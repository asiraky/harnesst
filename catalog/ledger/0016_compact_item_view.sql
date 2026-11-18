-- The item view carried the last 100 events with full payloads, and every spec_updated event a full
-- copy of the spec. A long-running issue's view reached ~225KB (~56k tokens): harnesst's model
-- gateway withholds a tool result that large, and every mutation returns the same view, so agents
-- could neither read the issue nor see their own writes succeed.
--
-- The view is now bounded whatever the history: the latest 30 events within a byte budget, each
-- with embedded spec copies replaced by a note and long strings cut at 800 characters, plus the
-- item's total event count. Full payloads come from the new get_events op (ledger-get-events):
-- filtered by kind and seq, at most 20 per call, spec copies only on request and one at a time.
-- Every other view field is unchanged. Re-runnable.
begin;
-- Cuts every string longer than n characters, at any depth, saying how to read the full text.
create or replace function ledger.clip_json(j jsonb,n int,hint text) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare t text:=jsonb_typeof(j); begin
 if t='string' then
  if length(j#>>'{}')<=n then return j; end if;
  return to_jsonb(left(j#>>'{}',n)||format('… [cut: %s of %s characters shown; full text: %s]',n,length(j#>>'{}'),hint));
 elsif t='object' then
  return coalesce((select jsonb_object_agg(k,ledger.clip_json(v,n,hint)) from jsonb_each(j) x(k,v)),'{}');
 elsif t='array' then
  return coalesce((select jsonb_agg(ledger.clip_json(v,n,hint) order by o) from jsonb_array_elements(j) with ordinality x(v,o)),'[]');
 end if;
 return j;
end $$;
-- An event's payload without the copy of the spec that spec_updated events carry.
create or replace function ledger.event_payload(e ledger.events,include_spec boolean) returns jsonb language sql stable set search_path=pg_catalog,ledger as $$
 select case when include_spec or not (e.payload ? 'spec') then e.payload
  else jsonb_set(e.payload,'{spec}',to_jsonb(format('omitted: spec_version %s; the item''s spec is the current one. ledger-get-events with include_spec=true and before_seq=%s, limit=1 returns this copy.',e.spec_version,e.seq+1))) end
$$;
-- The view's form of an event: no spec copy, strings cut at 800 characters, and a payload still
-- over 2400 bytes replaced by a note, so one event can never dominate the view.
create or replace function ledger.event_brief(e ledger.events) returns jsonb language plpgsql stable set search_path=pg_catalog,ledger as $$
declare hint text:=format('ledger-get-events with before_seq=%s, limit=1',e.seq+1); p jsonb; begin
 p:=ledger.clip_json(ledger.event_payload(e,false)-'item_id'-'expected_version',800,hint);
 if octet_length(p::text)>2400 then
  p:=jsonb_build_object('cut',format('payload of %s bytes omitted; full payload: %s',octet_length(e.payload::text),hint));
 end if;
 return to_jsonb(e)-'item_id'||jsonb_build_object('payload',p);
end $$;
create or replace function ledger.view_item(i ledger.work_items,a ledger.actors) returns jsonb language sql stable set search_path=pg_catalog,ledger as $$
 with recent as (
  select e.seq,ledger.event_brief(e) as brief from events e where e.item_id=i.id order by e.seq desc limit 30
 ), budgeted as (
  select seq,brief,sum(octet_length(brief::text)) over (order by seq desc) as running from recent
 ), shown as (
  select seq,brief from budgeted where running<=24000 or seq=(select max(seq) from recent)
 ), counts as (
  select (select count(*) from events where item_id=i.id) as total,(select count(*) from shown) as n,(select min(seq) from shown) as oldest
 )
 select to_jsonb(i)||jsonb_build_object('allowed_actions',ledger.actions(i,a),
 'events',coalesce((select jsonb_agg(brief order by seq) from shown),'[]'),
 'event_count',c.total,
 'events_note',case when c.n<c.total then format('Latest %s of %s events, long text cut. Older events and full payloads: ledger-get-events (before_seq=%s for the ones before these).',c.n,c.total,c.oldest) end,
 'artifacts',coalesce((select jsonb_agg(t) from artifacts t where item_id=i.id),'[]'),
 'approval', (select jsonb_build_object('status',r.status,'approval_id',r.id,'expires_at',r.expires_at,'error',r.last_error,'review_url',r.review_url) from approval_requests r where r.item_id=i.id and r.epoch=i.gate_epoch),
 'leases',coalesce((select jsonb_agg(jsonb_build_object('role',x.role,'held',x.held,'session_id',case when x.held then x.session_id end,'until',case when x.held then x.expires_at end) order by x.role)
  from (select ac.role,l.session_id,l.expires_at,(l.token is not null and l.expires_at>now()) as held from leases l join actors ac on ac.id=l.actor_id where l.scope_id=ledger.scope(i)) x),'[]'))
 from counts c
$$;
-- get_events: an item's events with full payloads. Filters: kinds, since_seq (after), before_seq
-- (before). Newest first unless only since_seq is given (then oldest first, to page forward); the
-- page is returned in seq order. At most 20 events and ~40KB per call (always at least one). Spec
-- copies only with include_spec, and then one event per call.
create or replace function ledger.item_events(i ledger.work_items,p jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog,ledger as $$
declare
 with_spec boolean:=coalesce((p->>'include_spec')::boolean,false);
 n int:=least(greatest(coalesce((p->>'limit')::int,10),1),case when with_spec then 1 else 20 end);
 since bigint:=(p->>'since_seq')::bigint; before bigint:=(p->>'before_seq')::bigint;
 forward boolean:=since is not null and before is null;
 kinds text[]; picked jsonb:='[]'; used int:=0; more boolean:=false; e events; r jsonb;
begin
 if p ? 'kinds' and jsonb_typeof(p->'kinds') is distinct from 'array' then raise exception 'kinds must be an array of event kinds'; end if;
 kinds:=case when p ? 'kinds' then array(select jsonb_array_elements_text(p->'kinds')) end;
 for e in select * from events where item_id=i.id and (since is null or seq>since) and (before is null or seq<before) and (kinds is null or kind=any(kinds))
  order by case when forward then seq end asc,case when not forward then seq end desc
 loop
  if jsonb_array_length(picked)>=n then more:=true; exit; end if;
  r:=to_jsonb(e)-'item_id'||jsonb_build_object('payload',ledger.event_payload(e,with_spec));
  if jsonb_array_length(picked)>0 and used+octet_length(r::text)>40000 then more:=true; exit; end if;
  used:=used+octet_length(r::text); picked:=picked||jsonb_build_array(r);
 end loop;
 return jsonb_build_object('item_id',i.id,'event_count',(select count(*) from events where item_id=i.id),
  'events',coalesce((select jsonb_agg(x order by (x->>'seq')::bigint) from jsonb_array_elements(picked) x),'[]'),
  'has_more',more);
end $$;
-- Writes are dispatched by ledger.call_unleased; this wrapper adds leases (0010) and now get_events.
-- get_events reads like get_item: any actor, any existing item.
create or replace function ledger.call(op text,p_key text,p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger,public,extensions as $$
declare a actors:=ledger.actor(p_key); i work_items; begin
 if op='get_events' then
  select * into i from work_items where id=(p->>'item_id')::uuid;
  if i.id is null then raise exception 'item not found'; end if;
  return ledger.item_events(i,p);
 end if;
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
create or replace function public.ledger_get_events(p_key text,p_args jsonb default '{}') returns jsonb language sql security definer set search_path=pg_catalog,ledger as $$ select ledger.call('get_events',p_key,p_args) $$;
revoke all on function ledger.clip_json(jsonb,int,text),ledger.event_payload(ledger.events,boolean),ledger.event_brief(ledger.events),ledger.item_events(ledger.work_items,jsonb) from public;
revoke all on function public.ledger_get_events(text,jsonb) from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on function public.ledger_get_events(text,jsonb) from authenticated; end if;
end $$;
grant execute on function public.ledger_get_events(text,jsonb) to anon;
notify pgrst, 'reload schema';
commit;
