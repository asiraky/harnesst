-- 0013 counts only the lease holder's own ledger writes as progress. An implementer mostly makes
-- progress on GitHub: it pushes ticket branches and opens and merges PRs, and the GitHub actor
-- records that work as head, artifact and transition events. A dev turn that shipped two tickets
-- in three hours without calling the ledger itself went idle, lost its lease mid-work, and the
-- waiting wake started a second session on the same issue while the first was still pushing.
-- GitHub activity on an issue (or any of its tickets) now counts as progress for the lease of the
-- agent that owns the issue's current stage. A session stuck on a command produces no GitHub
-- activity, so the idle cap still catches it. Re-runnable.
begin;
create or replace function ledger.credit_github_progress() returns trigger language plpgsql set search_path=pg_catalog,ledger as $$
declare root work_items; owner text; begin
 if not exists(select 1 from actors where id=new.actor_id and kind='system' and role='github') then return null; end if;
 select r.* into root from work_items w join work_items r on r.id=ledger.scope(w) where w.id=new.item_id;
 owner:=ledger.stage(root)->>'owner';
 if owner is null then return null; end if;
 update leases l set progressed_at=now() from actors a
  where l.scope_id=root.id and l.actor_id=a.id and a.kind='agent' and a.role=owner and l.token is not null;
 return null;
end $$;
drop trigger if exists ledger_github_progress on ledger.events;
create trigger ledger_github_progress after insert on ledger.events for each row execute function ledger.credit_github_progress();
revoke all on function ledger.credit_github_progress() from public;
commit;
