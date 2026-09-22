-- Hosted Supabase adapter. Run after 0001. Local lab uses its Node delivery worker instead.
begin;
update ledger.settings set value='false' where key='allow_http_wakes';
create extension if not exists pg_net;
create extension if not exists pg_cron;
create extension if not exists supabase_vault;
-- Move the encryption key out of the application tables into Supabase Vault.
select vault.create_secret(value,'ledger_encryption_key','Ledger wake and gate token encryption') from ledger.settings where key='encryption_key';
create or replace function ledger.secret(t text) returns bytea language sql security definer set search_path=pg_catalog,public,extensions as $$
 select pgp_sym_encrypt(t,(select decrypted_secret from vault.decrypted_secrets where name='ledger_encryption_key'))
$$;
create or replace function ledger.reveal(t bytea) returns text language sql security definer set search_path=pg_catalog,public,extensions as $$
 select pgp_sym_decrypt(t,(select decrypted_secret from vault.decrypted_secrets where name='ledger_encryption_key'))
$$;
delete from ledger.settings where key='encryption_key';
create function ledger.dispatch() returns void language plpgsql security definer set search_path=pg_catalog,ledger as $$
declare d jsonb; begin
 for d in select value from jsonb_array_elements(public.ledger_delivery_batch()) loop
  perform net.http_post(url:=d->>'url',headers:=jsonb_build_object('Authorization','Bearer '||(d->>'token'),'Content-Type','application/json'),body:=d->'body');
 end loop;
end $$;
create function ledger.deliver_insert() returns trigger language plpgsql security definer set search_path=pg_catalog,ledger as $$
declare a actors; begin
 select * into a from actors where id=new.actor_id;
 if a.wake_url is not null then
  perform net.http_post(url:=a.wake_url,headers:=jsonb_build_object('Authorization','Bearer '||ledger.reveal(a.wake_secret),'Content-Type','application/json'),body:=jsonb_build_object('outbox_id',new.id,'item_id',new.item_id,'reason',new.kind));
  update outbox set attempts=1,next_attempt_at=now()+interval '1 minute' where id=new.id;
 end if; return new;
end $$;
create trigger ledger_deliver after insert on ledger.outbox for each row execute function ledger.deliver_insert();
revoke all on function ledger.dispatch(),ledger.deliver_insert(),ledger.secret(text),ledger.reveal(bytea) from public;
select cron.schedule('ledger-redelivery','* * * * *','select ledger.dispatch()');
commit;
