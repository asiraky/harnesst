# Ledger team installation and May I authorization

HARNESST runs agents and manages installation. Supabase stores the ledger, OAuth credentials and approval requests, and verifies decisions. May I hosts human approval. Cloudflare hosts the product the team builds. HARNESST has no ledger approval page, proxy or approval callback route.

## Installation

Use a dedicated Supabase project with Data API enabled. In the team's HARNESST setup wizard (it opens right after the team is installed, and from the team's Setup link), authorize Supabase and install the ledger. Then click **Connect May I**. HARNESST installs the approval functions and scheduler using that temporary Supabase authorization, then removes the authorization after the first successful May I connection. A separate encrypted installation credential allows subsequent connection management; it is never injected into agents.

May I opens in another tab. Sign in and authorize the intended workspace. Close the confirmation tab and click **Check connection** in HARNESST. No workspace IDs, human IDs, API keys or operator OAuth script are required. May I's workspace policy determines who can approve. The ledger records the deciding human and verifies signatures, the authoritative approval, immutable action and current gate revision.

May I must support the agreed `label`, `connection` and token-response `agent_id` contract. A missing identity fails explicitly; it never silently creates a replacement connection for an existing installation.

## Product repositories

The ledger holds one project per product repository and the team works across all of them. No repository is chosen at installation. Intake registers a project when a requester first names a repository; infra connects that repository to the ledger with `gh` (the `ledger.yml` workflow and helper plus the `LEDGER_URL`, `LEDGER_ANON_KEY` and GitHub-actor `LEDGER_ACTOR_KEY` Actions secrets), using the ledger-repo-onboarding skill. Only infra's GitHub App can write workflows and Actions secrets, and only infra holds the GitHub actor key.

## Fixed addresses and credentials

Each dedicated Supabase installation registers one client, once, with these exact addresses:

- OAuth redirect: `https://PROJECT_REF.supabase.co/functions/v1/approval-oauth`
- Approval callback: `https://PROJECT_REF.supabase.co/functions/v1/approval-callback`

These work from mobile and local HARNESST without an OAuth tunnel. The callback uses opaque state to find its request. OAuth state is random, hashed at rest, expires after ten minutes and is consumed once. PKCE verifiers and access/refresh tokens are encrypted in the ledger database. The registration client ID and connected agent ID are reused on reconnect. OAuth registration interrupted before its client ID is saved requires operator inspection; it does not automatically register another client.

The label is `HARNESST — TEAM_NAME`. Separate environments should use distinct installation/team names and Supabase projects. This backend supports one installation per database.

`LEDGER_SETUP_TOKEN` authorizes only installation status and beginning authorization. `LEDGER_DISPATCH_TOKEN` authorizes scheduled dispatch. Neither is entered by users or given to agents. Supabase provides the functions' service-role credential. All privileged database RPCs are denied to public, anon and authenticated roles.

For backend updates, regenerate assets using `node catalog/ledger/prepare-hosted.mjs`. Preserve migration checksums: migrations 1–4 were previously deployed; migration 5 removes manual identity mappings and adds hosted authorization; migrations 6–7 preserve grants during reconnect and scope writes for Supabase REST protection; migration 8 adds review content; migration 9 adds tickets and the architect design stage and moves projects on the previous default workflow to a new version. Migration 10 adds single-writer leases: only the session holding an issue's lease can change it. Apply it together with the Ledger bundle 0.2.0 tools and wake channel; older tools are refused with LEASE_REQUIRED. The installation Management API applies journaled migrations and deploys the bundled functions. Do not replay original schema creation on an existing database.

## Agent wakes and testing

Configure the ordinary `HARNESST_PUBLIC_ORIGIN` on the HARNESST host before deploying agents. Production uses a stable HTTPS origin; local dev uses a tunnel. Register each deployed channel URL with `ledger_set_wake_url`. The setup wizard registers and verifies these wake targets. May I callbacks always go directly to Supabase, including during local HARNESST testing.

Publish the updated Ledger tools and skills to all team members: the removed decision tool must not remain in their deployed bundle.

Take a feature through breakdown and build until the implementer moves it to merge approval. A May I request should appear within a minute. Approve there; the ledger should advance once and queue the next agent. Repeat with a denial. Push a new commit while a request is pending; deciding the old request must not advance the changed item.

## Failure and recovery

Read `ledger.approval_requests` and `ledger.approval_events` as an operator. Agents see a safe status/error summary via `ledger-get-item`; they cannot read OAuth tokens or callback state. Pending work survives dispatcher downtime. Callback retries are idempotent. Decision time, rather than callback delivery time, determines expiry, using May I’s actual expiresAt. Signatures are accepted for May I’s seven-day manual replay window. Automatic callback retries are finite (about 45 minutes); the dispatcher also polls submitted requests every minute, so a lost callback does not strand an approved item. Polling uses the OAuth-owned May I resource and the same action, callback/remote decision consistency, expiry and database revision checks.

Permanent 4xx submission errors fail immediately with a specific error. Transient or uncertain submission retries reuse one idempotency key and stop after 23 hours if the HTTP outcome remains uncertain (May I retains keys for 24 hours). Recover the remote request as an operator; do not blindly create another. Superseded requests can remain visible in May I, but cannot advance the ledger.

OAuth refreshes are serialized in Postgres. Rotated credentials are committed before use. A refresh HTTP 400 marks the connection as requiring reconnect and is never retried. An uncertain rotation retains its durable claim; after 30 seconds the UI reports reconnect required rather than risking token reuse. Reconnect uses the same client and agent identity, keeping existing approvals readable for callbacks and polling. A response containing a different identity is refused. An unfinished authorization expires after ten minutes and can be restarted from installation.

Existing manually authorized installations without a registered hosted redirect require an explicit cutover with no pending approvals. Do not silently replace their client. This prototype had no May I grant when the hosted flow was introduced.

Database enforcement protects ledger transitions. It cannot prevent someone with independent GitHub/Cloudflare administrative credentials from deploying outside the ledger. Production deployment credentials must remain in protected CI if deployment itself requires a mandatory approval gate.

To reissue a failed/expired gate after correcting configuration, an operator can run this transaction with the item UUID. Cancel the old request in May I first when it is still visible. This changes the epoch; a late callback for the old request becomes a harmless stale event.

```sql
begin;
do $$
declare i ledger.work_items; e uuid;
begin
  select * into i from ledger.work_items where id='ITEM_UUID'::uuid for update;
  if i.id is null or not (ledger.stage(i) ? 'gate') or i.blocked_on is not null then
    raise exception 'Item is not waiting at an approval gate';
  end if;
  update ledger.work_items set gate_epoch=gate_epoch+1,version=version+1,updated_at=now()
    where id=i.id returning * into i;
  e := ledger.event(i,null,'approval_reissued','{}');
  perform ledger.enter(i,null,e);
end $$;
commit;
```

For grant replacement, temporarily unschedule `ledger-approval-dispatch`, reissue affected gates, run the OAuth helper, then restore the schedule. Inspect May I for any request whose submission outcome was uncertain. Replacement never imports an old approval as a new decision.

Each gate has one fixed approval destination shown in the request; approval cannot secretly select an alternate route.

## Exceptional connection recovery

A deliberately deleted May I connection cannot be silently replaced. An administrator must first account for every attempted/submitted approval (cancel or explicitly supersede/reissue it), then clear the installation's agent identity and credentials while retaining its registered client and URLs. The next connection is intentionally new. Routine reauthentication must use **Reconnect May I** and never take this path.

Registration rejected with a definite HTTP 4xx (other than timeout) releases its registration claim and may be retried. A lost registration response retains the claim: inspect May I's registered client before recovering it, so retry cannot silently create another client. No credentials are emitted in browser errors.

HTTP 401 while reading/submitting an approval expires that access token and schedules retry without failing the gate. HTTP 403 marks the same credential as requiring reconnect. Late failures from a superseded token cannot invalidate its replacement. Any uncertain refresh result is fail-closed; retrying a possibly consumed refresh token can revoke the grant. A healthy existing grant remains usable while a reconnect tab is open or abandoned.
