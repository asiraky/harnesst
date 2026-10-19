-- Run once in Supabase SQL Editor after migrations. Save the results privately.
-- Replace ENGINEER_EMAIL and REQUESTER_EMAIL first (they can be the same person).
begin;
do $$ begin
  if exists(select 1 from ledger.actors) then
    raise exception 'Actors already exist. Initial setup refused to rotate existing keys.';
  end if;
end $$;
select public.ledger_mint_actor('engineer','human','Engineer','ENGINEER_EMAIL');
select public.ledger_mint_actor('requester','human','Requester','REQUESTER_EMAIL');
select role, result->>'actor_key' as actor_key, result->>'wake_token' as wake_token
from (values
  ('intake',public.ledger_mint_actor('intake','agent','Intake')),
  ('infra',public.ledger_mint_actor('infra','agent','Infra')),
  ('implementer',public.ledger_mint_actor('implementer','agent','Implementer')),
  ('architect',public.ledger_mint_actor('architect','agent','Architect')),
  ('github',public.ledger_mint_actor('github','system','GitHub'))
) as minted(role,result);
commit;
