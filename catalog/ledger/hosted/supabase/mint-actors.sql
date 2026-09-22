-- Run once in Supabase SQL Editor after migrations. Save the results privately.
-- Replace these emails if requester and engineer are different people.
begin;
do $$ begin
  if exists(select 1 from ledger.actors) then
    raise exception 'Actors already exist. Initial setup refused to rotate existing keys.';
  end if;
end $$;
select public.ledger_mint_actor('engineer','human','Engineer','asiraky@gmail.com');
select public.ledger_mint_actor('requester','human','Requester','asiraky@gmail.com');
select role, result->>'actor_key' as actor_key, result->>'wake_token' as wake_token
from (values
  ('intake',public.ledger_mint_actor('intake','agent','Intake')),
  ('infra',public.ledger_mint_actor('infra','agent','Infra')),
  ('implementer',public.ledger_mint_actor('implementer','agent','Implementer')),
  ('github',public.ledger_mint_actor('github','system','GitHub'))
) as minted(role,result);
commit;
