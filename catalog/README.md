# Marketplace — the first-party catalog

This directory is the Recruit marketplace catalog (PRD §7.8): a curated set of **templates** — pre-built tools, skills, subagents, channels, connections, bundles, and whole agents a customer instantiates instead of authoring from scratch. A template is just **files + a manifest**; installing one materializes those files into the customer's repo as a normal reviewable change-set. There is no build step — templates are source.

A template can also **include** other templates by reference (see [Composition](#composition)): a channel like Discord is authored once and bundled into an agent, resolved to materialized files at install time.

**Authoring an agent?** Its `instructions.md` system prompt must follow [`CONSTITUTION.md`](./CONSTITUTION.md) — how we ground agents without over-specifying them. It's also the checklist for reviewing one.

**This directory's destiny is the eve OSS repo.** The owner decision (PRD §7.8, Distribution) is that the v1 catalog lives inside `github.com/vercel/eve` as `marketplace/`, not a separate repo. It's authored here in harnesst and copied there. That's why `scripts/` imports **nothing** from harnesst's `app/` — the whole directory must validate and index itself standing alone.

(Inside harnesst's repo it is named `catalog/` only because Vite's dev server would serve `marketplace/index.json` over the app's `/marketplace` route on a hard reload; the copy into eve renames it to `marketplace/`.)

## Layout

```
marketplace/
  index.json                     # generated browse projection (do not hand-edit)
  scripts/
    build-index.mjs              # regenerate index.json (deterministic)
    validate.mjs                 # CI gate: format + structure + index sync
  templates/
    tools/<id>/                  # a Tool template
      template.json              # the manifest
      files/tools/<id>.ts        # the file(s) it ships (paths relative to the install root)
    skills/<id>/
    subagents/<id>/
    channels/<id>/
    connections/<id>/
    bundles/<id>/
    agents/<id>/
```

Note the plural: a template of `type: "tool"` lives under `templates/tools/`.

## Authoring a template

1. Create `templates/<type>s/<id>/` where `<id>` is a kebab-case slug that **equals the directory name**.
2. Write `template.json` (the manifest). The contract:

   | field                 | required | notes                                                                                                                |
   | --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
   | `id`                  | yes      | kebab-case slug, matches the directory name                                                                          |
   | `type`                | yes      | `tool` \| `skill` \| `subagent` \| `channel` \| `connection` \| `bundle` \| `agent`                                  |
   | `name`, `description` | yes      | non-empty                                                                                                            |
   | `version`             | yes      | semver `x.y.z`                                                                                                       |
   | `eve`                 | yes      | semver _range_ the template targets, e.g. `">=0.1.0"`                                                                |
   | `files`               | yes      | list of install-relative paths — **no absolute paths, no `..`, no backslashes**; non-empty for every type except `bundle` (a bundle may be pure composition) |
   | `dependencies`        | no       | npm name → version range; JSON-merged into the target's `package.json`                                               |
   | `secrets`             | no       | `[{ name: UPPER_SNAKE, description?, provisioned?, generated? }]` — the install wizard makes placeholders; `provisioned` (a guided harnesst flow sets it) and `generated` (harnesst mints it — see [Connection providers](#connection-providers)) are never prompted and mutually exclusive |
   | `sandbox`             | no       | sandbox setup merged into the target agent, e.g. `bootstrap` shell commands, `env` defaults, and a `revalidationKey` |
   | `auth`                | no       | `{ provider, kind: "oauth2", scopes?, scopeGroups? }` — brokered OAuth descriptor, `connection` templates only; at least one of `scopes` (always-requested baseline) / `scopeGroups` (user-selectable permission levels) required (see [Connection providers](#connection-providers)) |
   | `capability`          | no       | `{ groups }` — operation-group enablement for a brokered-capability provider (issue #166); only valid alongside `auth` on a `connection` template. Group ids must exist in harnesst's capability registry (see [Brokered capabilities](#brokered-capabilities-issue-166)) |
   | `connections`         | no       | declared for future use                                                                                              |
   | `model`               | no       | suggested model (agent-type templates)                                                                               |
   | `setup`               | no       | Markdown, shown on the detail page before install — provider-side steps a secret description can't hold (create an app, point a webhook at the agent's endpoint, grant scopes). Mainly channels |
   | `includes`            | no       | `[{ type, id }]` — other catalog templates bundled by reference; `type` is any type except `agent` (see Composition) |

3. Put the shipped files under `files/`, mirroring the install-relative paths — a tool at `files/tools/<id>.ts` installs to the target agent's `tools/<id>.ts`.
4. Run `npm run catalog:index` (regenerates `index.json`) then `npm run catalog:validate`.

The manifest format is also encoded as a Zod schema in harnesst at `app/marketplace/manifest.ts`. The two are deliberate duplicates — one contract, two homes (this directory ships to eve; harnesst keeps the schema its loaders parse against).

## How CI gates it

`scripts/validate.mjs` (run via `npm run catalog:validate`) fails the build unless:

- every `template.json` matches the format above;
- each template's `files` list matches its `files/` subtree **exactly**, both directions;
- every `id` is unique across the catalog and equals its directory name;
- `index.json` is present, lists every template exactly once, and every content hash matches a fresh recomputation (so a stale index — or a drifted file — is a hard failure);
- every `includes` reference resolves to a template in the catalog, there are no include cycles, and no template's **resolved** (flattened) file set has a duplicate final path.

The content hash is `sha1(hex)` over the canonicalized manifest plus every file's content in sorted path order; `build-index.mjs` is the source of that rule. A template's own hash does **not** depend on what it `includes` — includes are flattened at install time, not folded into the hash.

## Composition

A template may bundle other templates by reference with `includes: [{ type, id }]`. `type` is any template type except `agent` (an agent is a whole team member — it installs as its own root and can't flatten into a parent). Includes may nest (a skill may include a tool); cycles are an error.

The `bundle` type is composition made first-class (issue #42): a named group of includable assets that installs **into an existing member** as one unit, with no (or few) files of its own. An `agent` is conceptually a bundle that also seeds a new member. Installing a composite onto a member that already has one of its includes installed standalone *absorbs* that install — the composite takes ownership of its files and lock entry instead of refusing on a path conflict.

At install (and update) time harnesst's resolver flattens each reference into the parent, so:

- **installed repos get materialized files** — never a live reference. The included channel/tool lands as ordinary files under the target agent's root.
- **the same catalog snapshot** the parent came from resolves its includes — there is no per-include version pin. The **parent's own version bump** is what delivers newer included artifacts to an existing install (update detection compares the parent's version, unchanged).
- **the parent wins collisions**: on a duplicated dependency range or sandbox `env` key the parent's value wins; secrets union by name (first occurrence keeps its description, `sandbox` flags OR); `model` and the `eve` range are the parent's only.
- **file-path collisions and cycles are CI failures** (above), caught before publish.

## Connection providers

A `connection` template with an `auth` block rides harnesst's auth-brokered OAuth flow (issues
#30, #163): the Deployment tab's Connections card shows a Connect button (connecting is a
deployment concern — the install wizard collects no credentials), harnesst runs the consent flow
against its operator-registered OAuth app, stores the grant, and injects the credentials at
deploy. The contract:

- **`auth.provider` must name a registered provider.** The registry lives in harnesst at
  `app/connections/providers.server.ts` — one object per provider carrying its endpoints,
  PKCE flag, authorize params, and env prefix. A template naming an unregistered provider
  renders on the Deployment tab as "not supported by this harnesst installation"; supporting a
  new provider is a registry addition in harnesst, not a template concern.
- **The template's `setup` text carries the operator instructions** (following the
  google-sheets template's pattern): create the OAuth app with the provider, set
  `HARNESST_<PREFIX>_CLIENT_ID` / `HARNESST_<PREFIX>_CLIENT_SECRET` on the harnesst control plane, and
  register the redirect URI `<origin>/connections/<provider>/callback` (Google alone keeps
  the legacy `<origin>/google/callback`). Providers whose registry entry declares
  `clientRegistration` (below) need **no** operator OAuth app at all.
- **At deploy harnesst injects `<PREFIX>_OAUTH_CLIENT_ID` / `<PREFIX>_OAUTH_CLIENT_SECRET` /
  `<PREFIX>_OAUTH_REFRESH_TOKEN`** for every provider the agent holds an active grant for;
  the shipped connection file refreshes its own access tokens from those at runtime. It also
  injects **`<PREFIX>_OAUTH_SCOPES`** — the scopes the account actually *granted*,
  space-joined — so agent code can read its own permission level (don't offer to send mail
  when only read was granted; the gmail template's connection file shows the pattern).

### Provider capabilities beyond the Google shape (issue #167)

Registry entries can declare three orthogonal capabilities for OAuth hosts that don't behave
like Google. The mayi template (`templates/connections/mayi/`) is the first consumer of all
three; template authors only need to know which delivery their provider uses (it decides what
the shipped credential code looks like):

- **Public clients** — `tokenEndpointAuth: "none"` (RFC 8414
  `token_endpoint_auth_methods_supported: ["none"]`): no client secret exists, PKCE is the
  code-exchange proof, and only `HARNESST_<PREFIX>_CLIENT_ID` is required operator config.
- **Access-token-broker delivery** — `credentialDelivery: "access-token-broker"` for
  providers that **rotate the refresh token on every refresh** (and revoke the whole token
  family on reuse). The refresh token never ships to the instance; harnesst stays the grant's
  single writer, and the shipped credential file fetches short-lived access tokens from
  harnesst's token broker (`POST <HARNESST_API_URL>/api/connections/token`, authenticated with the
  deployment's injected `HARNESST_TEAM_TOKEN`) instead of self-refreshing — see the mayi
  template's `credentials.server.ts` for the caching pattern (~one call per token lifetime).
  The default `"refresh-token"` delivery keeps the `<PREFIX>_OAUTH_*` trio exactly as before.
- **Per-grant dynamic client registration** — `clientRegistration: { endpoint }` (RFC
  7591-shaped) for providers whose OAuth clients are register-once/immutable with exact-match
  callback URIs: Connect registers a fresh client per grant covering the exact instance
  callback URL of every environment the agent has, so there is no operator OAuth-app step
  (the operator only needs a publicly reachable `HARNESST_PUBLIC_ORIGIN`). An environment created
  **after** Connect isn't covered by the immutable client — the Connections card flips to
  "reconnect needed" and one reconnect registers a fresh client (same UX as a scope change).

### Brokered capabilities (issue #166)

For high-risk systems (money, destructive writes) a broad connector is the wrong shape:
shipping the OAuth grant to the instance hands the model the whole vendor API. Providers whose
registry entry declares `credentialDelivery: "capability"` (Xero is the first) invert that —
**no credential material of any kind reaches the container**, and the deploy injects no
`<PREFIX>_OAUTH_*` vars at all. harnesst holds the grant and exposes a fixed, code-defined
whitelist of operations (`app/capabilities/` in harnesst), grouped into operation groups; the
agent's shipped tools are thin: each POSTs its typed input to
`POST <HARNESST_API_URL>/api/capabilities/<provider>/<operation>` with the deployment's injected
`HARNESST_TEAM_TOKEN`, and harnesst validates the request server-side (e.g. "bills are always DRAFT")
and performs the one blessed operation itself. Anything not in the whitelist does not exist —
regardless of what the consented OAuth scopes would allow (the `auth.scopes` set is a fixed
superset; the operation whitelist, not the token scope, is the enforcement plane). Every call
— allowed or refused — is audit-logged control-plane-side.

What a template author declares:

- **`capability: { groups: [...] }`** — the operation-group ids this template offers the
  installer, only valid alongside `auth` on a `connection` template. The ids must exist in the
  provider's capability definition in harnesst's registry (labels, descriptions, risk, and the
  validation logic are code there, not template data — harnesst's unit tests cross-check the
  catalog against the registry). The installer ticks groups on the install wizard's Operations
  card (`default`-flagged read groups pre-ticked; write groups are opt-in and render with a
  "write" badge), and the selection stays editable on the agent's Deployment tab. Because harnesst
  enforces the selection **per call** — never baked into a token — edits take effect at the
  agent's very next call: no reconnect, no redeploy.
- **One thin tool file per operation** (see `templates/connections/xero/files/tools/`): a zod
  schema mirroring the operation's input, one POST, return the response body. No credential
  handling, no vendor SDK.
- **`setup` text carrying the operator app registration** as usual (Xero: a harnesst-owned app at
  developer.xero.com, `HARNESST_XERO_CLIENT_ID` / `HARNESST_XERO_CLIENT_SECRET`, redirect
  `<origin>/connections/xero/callback`).

Providers whose capability declares a **resource binding** (Xero: the tenant/organisation)
bind it at Connect time: exactly one resource binds silently; several send the user to a
picker page before the connection is usable. A second capability provider is a capability
definition + provider registry entry in harnesst plus a catalog template here — no new routes,
schema, or UI.

### Permission levels: `scopes` vs `scopeGroups`

The `auth` block requests permissions two ways (issue #165), and the rule is **one template
per system — permission levels are a user choice, never template variants**. Never publish
"`foo` read-only" and "`foo` full" as two catalog entries: the wrong pick caps the install
forever, and every level doubles the catalog.

- **`scopes`** — the always-requested baseline. Use it alone when the connector is
  single-purpose and there is exactly one sensible permission set (google-sheets: one
  `spreadsheets` scope). This is also the back-compat shape: templates with only `scopes`
  behave exactly as before scope groups existed.
- **`scopeGroups`** — named, user-selectable levels
  (`{ id, label, description, scopes, default? }`). Use it whenever the system has separable
  capabilities a cautious installer would want to withhold (gmail: *Read mail* / *Manage
  labels* / *Send mail*). The installer ticks groups in the install wizard (`default: true`
  groups pre-ticked), the OAuth consent requests baseline ∪ selected groups, and the
  selection stays editable on the agent's Deployment tab — widening asks for one reconnect,
  narrowing takes effect on reconnect. Overlapping groups are fine (gmail's `gmail.modify` ⊃
  `gmail.readonly`): the union is what's requested, so keep each group's meaning simple
  rather than carving disjoint scope sets. Group ids are **provider-level identities**: when
  two composed templates (a bundle's includes) declare the same group id for the same
  provider, they define ONE level — the checkbox keeps the first occurrence's
  label/description, the scopes union, and `default` pre-ticks if either side says so. Reuse
  an id (`read`, `send`) only when the levels genuinely coincide; otherwise pick distinct ids.
  Catalog CI enforces this: two templates declaring the same group id for the same provider
  with **different** scope sets fail validation (one checkbox silently authorizing both sets
  is exactly the least-privilege leak the ids-as-identities rule exists to prevent) — either
  make the scopes identical or namespace the ids (`gmail-read` / `calendar-read`).

At least one of the two must be present; declaring both means "always this baseline, plus
whatever levels the installer picks". Write group `description`s as plain-words capability
statements ("send messages as the connected account") — they render as checkbox help text in
the install wizard and the Deployment tab's Permissions editor.

Two adjacent capabilities connection/channel templates can rely on:

- **Generated secrets** — a secrets entry with `generated: true` is a value nobody types
  (e.g. a random state-encryption key). It is never prompted in the install wizard; harnesst
  mints a random value once per agent + environment at first deploy and keeps it stable
  across redeploys (mutually exclusive with `provisioned`).
- **`EVE_PUBLIC_ORIGIN`** — when the operator configures `HARNESST_PUBLIC_ORIGIN`, every deployed
  instance receives `EVE_PUBLIC_ORIGIN`, its per-environment public ingress URL, so adapters
  that take inbound webhooks can build callback URLs. Treat it as optional at runtime — it is
  unset in local dev and on installations without a public origin.
