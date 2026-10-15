select extname from pg_extension where extname in ('pgcrypto','pg_net','pg_cron');
select name from ledger.workflow_templates;
select role,kind,wake_url from ledger.actors order by role;
select jobname,schedule,active from cron.job where jobname='ledger-redelivery';
select key,value from ledger.settings where key='allow_http_wakes';
-- All must be false. Admin/actor-mint privileges stay with the operator.
select has_schema_privilege('anon','ledger','usage') as anon_private_schema,
 has_function_privilege('anon','public.ledger_mint_actor(text,text,text,text)','execute') as anon_mint,
 has_function_privilege('authenticated','public.ledger_mint_actor(text,text,text,text)','execute') as authenticated_mint;

-- Approvals: harnesst's key is registered, and requests by status.
select exists(select 1 from ledger.approval_access) as approvals_key_registered;
select status,count(*) from ledger.approval_requests group by status;
