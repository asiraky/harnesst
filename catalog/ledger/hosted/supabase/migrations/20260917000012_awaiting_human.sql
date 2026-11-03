-- A stage owner that has asked a human for something (an engineer to reply in a design
-- conversation) is waiting, not stuck. Before this it could not complete its work wake, so the
-- ledger redelivered it every 30 minutes, the agent asked again each time, and after ten
-- deliveries the wake failed and escalated as if the owner were unreachable.
-- `awaiting` lets the owner close its work wake with who it is waiting on and what they must do.
-- The `awaiting_human` event is the durable record: the owner reads it on a later wake instead of
-- asking again, and intake reports it as the human action outstanding. Unlike a block, it routes
-- nothing to intake and does not stop the owner from updating the spec or moving the item.
-- Re-runnable.
begin;
create or replace function public.ledger_complete_wake(p_key text,p_args jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ledger as $$
declare a actors:=ledger.actor(p_key); o outbox; i work_items; s jsonb; w jsonb:=p_args->'awaiting'; begin
 select w2.* into i from work_items w2 join outbox b on b.item_id=w2.id where b.id=(p_args->>'outbox_id')::uuid and b.actor_id=a.id for update of w2;
 if i.id is null then raise exception 'wake not found'; end if;
 select * into o from outbox where id=(p_args->>'outbox_id')::uuid for update;
 if o.status='done' then return '{"ok":true}'; end if;
 perform ledger.require_lease(ledger.scope(i),a,p_args);
 if o.status<>'claimed' or o.lease_until<=now() then raise exception 'active claim required'; end if;
 s:=ledger.stage(i);
 if w is not null and jsonb_typeof(w)<>'null' then
  if o.kind<>'wake' or i.closed_at is not null or i.blocked_on is not null or s ? 'gate' or a.role is distinct from s->>'owner' then
   raise exception 'only the stage owner can wait on a human for its own work';
  end if;
  if coalesce(btrim(w->>'role'),'')='' or coalesce(btrim(w->>'request'),'')='' then raise exception 'awaiting needs a role and a request'; end if;
  perform ledger.event(i,a.id,'awaiting_human',jsonb_build_object('outbox_id',o.id,'role',w->>'role','request',w->>'request','note',p_args->>'note'));
  -- Every outstanding wake this owner has on the item is answered by the same wait.
  update outbox set status='done',done_at=now() where item_id=i.id and actor_id=a.id and status in ('pending','claimed');
  return '{"ok":true}';
 end if;
 if not(o.kind='escalation' or i.closed_at is not null or i.blocked_on is not null or s ? 'gate') then raise exception 'work wakes complete when the stage changes, or with awaiting when you are waiting on a human'; end if;
 perform ledger.event(i,a.id,'notification_completed',jsonb_build_object('outbox_id',o.id,'note',p_args->>'note'));
 update outbox set status='done',done_at=now() where id=o.id;
 return '{"ok":true}';
end $$;
notify pgrst, 'reload schema';
commit;
