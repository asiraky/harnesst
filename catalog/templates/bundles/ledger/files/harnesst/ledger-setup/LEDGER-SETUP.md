# Ledger team installation and approvals

HARNESST runs the agents, manages installation and hosts human approvals. Supabase stores the ledger. Cloudflare hosts the product the team builds.

## Installation

Use a dedicated Supabase project with Data API enabled. Add a Supabase connection once in Settings → Connections (a Supabase access token, labelled; HARNESST checks it with Supabase before saving) and link it to the team in Setup (it opens right after the team is installed, and from the team's Setup link). With a single Supabase connection in the workspace, Setup uses it automatically. Then install the ledger. HARNESST keeps the connection encrypted, uses it only for its own calls to the Supabase Management API, and applies future ledger migrations automatically. The install applies the journaled migrations, mints the team's actor keys and registers the approvals key. Agents never receive the Supabase token or the approvals key.

If Supabase rejects the token (it expired or was revoked), Setup shows "Reconnect Supabase": replace the token in Settings → Connections, or link another connection.

## Approvals

When an item reaches a gate (merge approval), the ledger opens an approval request bound to the gate's revision (for merge approval, the PR head SHA). HARNESST checks the ledger every few seconds, records each open request as a HARNESST approval and publishes its link (`HARNESST_PUBLIC_ORIGIN/approvals/ID`) back to the ledger. Publishing wakes the team's human proxy (intake), which posts the link in its conversation. HARNESST shows the link as an approval card with Approve and Reject, and lists open approvals in the inbox.

Anyone with write access to the team's project can decide. HARNESST records who decided. The ledger accepts the decision only while the item is still at the same gate with the same revision: a new commit supersedes the old request and opens a new one. Approval moves the item to the gate's fixed destination (`ready-to-merge`); rejection returns it to build with the feedback. Requests expire after seven days. Expiry wakes the proxy so it can tell the requester.

## Merging

HARNESST merges. After approval it squash-merges the issue PR with its own GitHub App, at the exact approved head SHA; a PR whose head has moved is not merged. The product repository's ledger workflow only observes the merge, dispatches `ledger-deploy` and moves the item to merged. No agent merges into or pushes to the default branch. HARNESST's GitHub App must be installed on every product repository.

Recommended GitHub settings, applied by an org admin:

- an org ruleset on the default branch: require a pull request, block force pushes, restrict deletions, no bypass list. Leave required approvals at 0: the approval happens in HARNESST, and a required GitHub review holds HARNESST's merge (it retries) until someone also approves on GitHub;
- per-repository branch protection with "Restrict who can push" allowing only your developers (a team) and HARNESST's App. Never add the agents' Apps or GitHub Actions;
- auto-merge disabled on these repositories: it lets later agent commits land under a person's merge.

Administrators always get past the push allowlist, which is why no agent App has the Administration permission.

## Product repositories

The ledger holds one project per product repository and the team works across all of them. No repository is chosen at installation. A person creates each new repository under the organization (no agent can) and installs the team's GitHub Apps and HARNESST's App on it. Intake registers a project when a requester first names a repository; infra connects that repository to the ledger with `gh` (the `LEDGER_URL`, `LEDGER_ANON_KEY` and GitHub-actor `LEDGER_ACTOR_KEY` Actions secrets, plus a PR adding the `ledger.yml` workflow and helper, which a developer merges), using the ledger-repo-onboarding skill. Only infra's GitHub App can write workflows and Actions secrets, and only infra holds the GitHub actor key.

## Credentials

The approvals key authorizes only `public.ledger_approvals` (list, publish, resolve). The ledger stores its hash; HARNESST stores the key encrypted. Each agent holds only its own actor key and wake token. All other ledger tables and functions are denied to public, anon and authenticated roles.

For backend updates, regenerate assets using `node catalog/ledger/prepare-hosted.mjs`. Preserve migration checksums: migrations 1–4 were previously deployed; migration 5 adds hosted authorization; migrations 6–7 preserve grants during reconnect and scope writes for Supabase REST protection; migration 8 adds review content; migration 9 adds tickets and the architect design stage and moves projects on the previous default workflow to a new version. Migration 10 adds single-writer leases: only the session holding an issue's lease can change it. Apply it together with the Ledger bundle 0.2.0 tools and wake channel; older tools are refused with LEASE_REQUIRED. Migration 11 moves approvals into HARNESST: it removes the May I backend (OAuth, dispatcher, functions, scheduler) and reissues any gate that was waiting on May I. After each publish, HARNESST applies any new migrations to installed ledgers through the team's linked Supabase connection and registers the approvals key if missing; already-applied versions are skipped. "Update ledger" in Setup runs the same update on demand. Do not replay original schema creation on an existing database.

## Agent wakes and testing

Configure the ordinary `HARNESST_PUBLIC_ORIGIN` on the HARNESST host before deploying agents. Production uses a stable HTTPS origin; local dev uses a tunnel. The setup wizard registers and verifies each member's wake URL.

Take a feature through breakdown and build until the implementer moves it to merge approval. Intake should post the approval within a minute. Approve it; the ledger should advance once and queue the next agent. Repeat with a rejection. Push a new commit while a request is open; deciding the old request must not advance the changed item.

## Failure and recovery

Read `ledger.approval_requests` and `ledger.approval_events` as an operator. Agents see a status summary and the approval link via `ledger-get-item`.

Database enforcement protects ledger transitions. It cannot prevent someone with independent GitHub/Cloudflare administrative credentials from deploying outside the ledger. Production deployment credentials must remain in protected CI if deployment itself requires a mandatory approval gate.

To reissue an expired gate, an operator can run this transaction with the item UUID. This changes the epoch; a late decision on the old request is refused as stale.

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

Each gate has one fixed approval destination shown in the request; approval cannot select an alternate route.
