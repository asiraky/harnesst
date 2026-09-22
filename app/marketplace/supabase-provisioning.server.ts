/** Fixed-origin API client: operator credentials never go to user-supplied hosts or agents. */
export class SupabaseManagement {
  constructor(
    private token: string,
    private request: typeof fetch = fetch,
  ) {}
  async call(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<any> {
    const response = await this.request(`https://api.supabase.com/v1/${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(90_000),
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });
    // Never return upstream errors: SQL errors can contain the credential-bearing query.
    if (!response.ok)
      throw new Error(
        `Supabase request failed (HTTP ${response.status}). Check project access and retry installation.`,
      );
    const text = await response.text();
    return text.trim() ? JSON.parse(text) : null;
  }
  query(ref: string, query: string) {
    return this.call(`projects/${projectRef(ref)}/database/query`, { query });
  }
}
export function projectRef(value: string): string {
  if (!/^[a-z]{20}$/.test(value))
    throw new Error("Select a valid Supabase project.");
  return value;
}
export function refFromUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname.endsWith(".supabase.co")
  )
    throw new Error("Use the Supabase project HTTPS URL.");
  return projectRef(url.hostname.slice(0, -".supabase.co".length));
}
export function sqlLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}
/** Own journal + transaction lock: a lost HTTP response can be retried without replaying DDL. */
export function migrationQuery(
  owner: string,
  version: string,
  hash: string,
  source: string,
): string {
  const ddl = source
    .replace(/^\s*begin\s*;\s*$/gim, "")
    .replace(/^\s*commit\s*;\s*$/gim, "");
  const delimiter = "$harnesst_migration$";
  if (ddl.includes(delimiter)) throw new Error("Invalid migration delimiter.");
  return `begin;
select pg_advisory_xact_lock(hashtext('harnesst-ledger-install'));
create schema if not exists harnesst_install;
revoke all on schema harnesst_install from public;
create table if not exists harnesst_install.owner (id boolean primary key default true check(id), project_id text not null);
insert into harnesst_install.owner values(true,${sqlLiteral(owner)}) on conflict do nothing;
create table if not exists harnesst_install.migrations(version text primary key, hash text not null);
do $install$ begin
if (select project_id from harnesst_install.owner) <> ${sqlLiteral(owner)} then raise exception 'Project belongs to another team'; end if;
if exists(select 1 from harnesst_install.migrations where version=${sqlLiteral(version)} and hash<>${sqlLiteral(hash)}) then raise exception 'Migration checksum changed'; end if;
if not exists(select 1 from harnesst_install.migrations where version=${sqlLiteral(version)}) then
execute ${delimiter}${ddl}${delimiter};
insert into harnesst_install.migrations values(${sqlLiteral(version)},${sqlLiteral(hash)});
end if;
end $install$;
commit;`;
}
export type ActorCredentials = { actorKey: string; wakeToken: string };
/** Persist keys in encrypted control-plane state BEFORE issuing this query. Never rotate on retry. */
export function actorsQuery(
  actors: Record<string, ActorCredentials>,
  email: string,
): string {
  const entries = Object.entries(actors)
    .map(
      ([role, keys]) => `
insert into ledger.actors(role,kind,display_name,key_hash,wake_hash,wake_secret)
values(${sqlLiteral(role)},${sqlLiteral(role === "github" ? "system" : "agent")},${sqlLiteral(role)},ledger.hash(${sqlLiteral(keys.actorKey)}),${role === "github" ? "null,null" : `ledger.hash(${sqlLiteral(keys.wakeToken)}),ledger.secret(${sqlLiteral(keys.wakeToken)})`})
on conflict(role) do nothing;
do $check$ begin
if not exists(select 1 from ledger.actors where role=${sqlLiteral(role)} and key_hash=ledger.hash(${sqlLiteral(keys.actorKey)})) then raise exception 'Existing actor credentials differ; refusing rotation'; end if;
end $check$;`,
    )
    .join("\n");
  return `begin; select pg_advisory_xact_lock(hashtext('harnesst-ledger-install'));
${entries}
insert into ledger.actors(role,kind,display_name,email) values('engineer','human','Engineer',${sqlLiteral(email)}),('requester','human','Requester',${sqlLiteral(email)}) on conflict(role) do nothing;
notify pgrst, 'reload schema'; commit;`;
}

export function validatePublishableKey(key: string): void {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return;
  try {
    const parts = key.split(".");
    if (
      parts.length === 3 &&
      JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).role ===
        "anon"
    )
      return;
  } catch {
    /* Reject unrecognized keys and privileged legacy keys. */
  }
  throw new Error(
    "Use a Supabase publishable key or legacy anon key, never a secret or service_role key.",
  );
}
