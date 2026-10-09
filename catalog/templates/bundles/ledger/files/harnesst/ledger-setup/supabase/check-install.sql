select extname from pg_extension where extname in ('pgcrypto','pg_net','pg_cron','supabase_vault');
select name from ledger.workflow_templates;
select role,kind,wake_url from ledger.actors order by role;
select jobname,schedule,active from cron.job where jobname in ('ledger-redelivery','ledger-approval-dispatch');
select key,value from ledger.settings where key='allow_http_wakes';
-- All must be false. Admin/actor-mint privileges stay with the operator.
select has_schema_privilege('anon','ledger','usage') as anon_private_schema,
 has_function_privilege('anon','public.ledger_mint_actor(text,text,text,text)','execute') as anon_mint,
 has_function_privilege('authenticated','public.ledger_mint_actor(text,text,text,text)','execute') as authenticated_mint;

-- Backend status only: never print encrypted or decrypted OAuth credentials.
select origin,callback_url,agent_id,label,connection_status,expires_at,refresh_started_at from ledger.approval_config;
select status,count(*) from ledger.approval_requests group by status;
select has_function_privilege('anon','public.ledger_approval_backend(text,jsonb)','execute') as anon_approval_backend,
 has_function_privilege('authenticated','public.ledger_approval_backend(text,jsonb)','execute') as authenticated_approval_backend;

select has_function_privilege('anon','public.ledger_oauth(text,jsonb)','execute') as anon_oauth, has_function_privilege('authenticated','public.ledger_oauth(text,jsonb)','execute') as authenticated_oauth;
