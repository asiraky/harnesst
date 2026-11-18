-- Agents inferred who owned an issue from the prose of earlier events. A resolution saying "return
-- the work to the existing implementer" outlived that implementer: its session died on a model
-- usage limit, and every later wake read the resolution, decided it was a duplicate, and did
-- nothing until the wake escalated. The lease is the only record of who is working on an issue,
-- so the item view now shows it: per role, whether a session holds the issue's lease (tickets
-- share their parent's), which session, and until when. Re-runnable.
begin;
create or replace function ledger.view_item(i ledger.work_items,a ledger.actors) returns jsonb language sql stable set search_path=pg_catalog,ledger as $$
 select to_jsonb(i)||jsonb_build_object('allowed_actions',ledger.actions(i,a),
 'events',coalesce((select jsonb_agg(t order by seq) from (select * from events where item_id=i.id order by seq desc limit 100)t),'[]'),
 'artifacts',coalesce((select jsonb_agg(t) from artifacts t where item_id=i.id),'[]'),
 'approval', (select jsonb_build_object('status',r.status,'approval_id',r.id,'expires_at',r.expires_at,'error',r.last_error,'review_url',r.review_url) from approval_requests r where r.item_id=i.id and r.epoch=i.gate_epoch),
 'leases',coalesce((select jsonb_agg(jsonb_build_object('role',x.role,'held',x.held,'session_id',case when x.held then x.session_id end,'until',case when x.held then x.expires_at end) order by x.role)
  from (select ac.role,l.session_id,l.expires_at,(l.token is not null and l.expires_at>now()) as held from leases l join actors ac on ac.id=l.actor_id where l.scope_id=ledger.scope(i)) x),'[]'))
$$;
commit;
