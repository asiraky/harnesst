-- Supabase supplies these roles. The diagnostic vanilla-Postgres cluster does not.
do $$ declare role_name text; begin
 foreach role_name in array array['anon','authenticated','service_role'] loop
  begin execute format('create role %I nologin',role_name);
  exception when duplicate_object or unique_violation then null;
  end;
 end loop;
end $$;
