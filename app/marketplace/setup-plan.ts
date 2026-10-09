/**
 * The setup wizard's step planner, pure. One planner for every install size: a skill installed
 * into one agent yields a step or two, a whole team yields the full list. Every step is DERIVED
 * from current state (lock, secrets, provisioning, GitHub, grants), so the wizard never stores
 * progress of its own: closing the tab and coming back lands on the same next step.
 *
 * Order is the order the work can actually happen in: secrets and the ledger can be done
 * before members are published (values are held for unpublished members); a GitHub App and an
 * OAuth grant belong to a published agent; May I and wake verification need the ledger and
 * deployed members.
 */
import type { GitHubPermissions } from "./manifest";

export interface SetupSecretRequirement {
  name: string;
  description?: string;
  sandbox?: boolean;
}

export interface SetupGitHubState {
  /** Permissions the member's templates require (baseline plus template asks). */
  required: GitHubPermissions;
  /** The member's App, or null when none has been created yet. */
  app: null | {
    slug: string;
    settingsUrl: string;
    /** Every account the App is installed on, or null when GitHub couldn't be asked. */
    installations: null | Array<{
      account: string;
      /** GitHub's page for this installation: pick repositories, accept new permissions. */
      htmlUrl: string;
      repositorySelection: string;
      /** `name:access` permissions this installation has not accepted. */
      missing: string[];
    }>;
  };
}

export interface SetupMemberState {
  name: string;
  /** The agent row's id once published; null while the member exists only as saved changes. */
  agentId: string | null;
  /** Required secrets with no value, attachment or dismissal (provisioned/generated excluded). */
  missingSecrets: SetupSecretRequirement[];
  /** Null when no installed template needs a GitHub App on this member. */
  github: SetupGitHubState | null;
  /** OAuth providers the member's templates require, and whether a usable grant exists. */
  connections: Array<{ provider: string; connected: boolean }>;
}

export interface SetupInput {
  members: SetupMemberState[];
  /** Names of the project's shared secrets — a requirement with one is satisfied by attaching. */
  sharedSecretNames: string[];
  /** Saved changes not yet published (installs stage drafts). */
  hasUnpublishedChanges: boolean;
  /** Null when nothing installed needs the supabase-ledger provisioner. */
  ledger: null | {
    /** bundle_provisioning status: pending | running | activating | provisioned | ready | failed. */
    status: string;
    /** May I connection status (connected, authorizing, needs_reconnect, not_installed, …). */
    mayi: string;
  };
}

export type SetupStep =
  | {
      kind: "secret";
      id: string;
      name: string;
      description?: string;
      sandbox: boolean;
      /** Members that need it. More than one ⇒ one shared value attached to each. */
      members: string[];
      /** A shared secret of this name exists: attaching is enough, no value needed. */
      sharedExists: boolean;
      done: false;
    }
  | { kind: "ledger"; id: "ledger"; status: string; done: boolean }
  | { kind: "publish"; id: "publish"; members: string[]; done: boolean }
  | {
      kind: "github-app";
      id: string;
      member: string;
      /** create → install → permissions (accept or edit) → ready. `unknown` when GitHub was unreachable. */
      state:
        | "unpublished"
        | "create"
        | "install"
        | "permissions"
        | "ready"
        | "unknown";
      slug: string | null;
      settingsUrl: string | null;
      installations: Array<{
        account: string;
        htmlUrl: string;
        missing: string[];
      }>;
      missing: string[];
      done: boolean;
    }
  | {
      kind: "connection";
      id: string;
      member: string;
      provider: string;
      published: boolean;
      done: boolean;
    }
  | { kind: "mayi"; id: "mayi"; status: string; done: boolean }
  | { kind: "wakes"; id: "wakes"; done: boolean };

export interface SetupPlan {
  steps: SetupStep[];
  /** The first step that isn't done, or null when setup is complete. */
  next: SetupStep | null;
  done: number;
  total: number;
}

const LEDGER_INSTALLED = ["provisioned", "ready"];

function githubStep(member: SetupMemberState): SetupStep | null {
  const github = member.github;
  if (!github) return null;
  const base = {
    kind: "github-app" as const,
    id: `github:${member.name}`,
    member: member.name,
    slug: github.app?.slug ?? null,
    settingsUrl: github.app?.settingsUrl ?? null,
  };
  if (!member.agentId)
    return {
      ...base,
      state: "unpublished",
      installations: [],
      missing: [],
      done: false,
    };
  if (!github.app)
    return {
      ...base,
      state: "create",
      installations: [],
      missing: [],
      done: false,
    };
  const installs = github.app.installations;
  if (installs === null)
    return {
      ...base,
      state: "unknown",
      installations: [],
      missing: [],
      done: false,
    };
  if (installs.length === 0)
    return {
      ...base,
      state: "install",
      installations: [],
      missing: [],
      done: false,
    };
  const missing = [...new Set(installs.flatMap((i) => i.missing))].sort();
  return {
    ...base,
    state: missing.length > 0 ? "permissions" : "ready",
    installations: installs.map((i) => ({
      account: i.account,
      htmlUrl: i.htmlUrl,
      missing: i.missing,
    })),
    missing,
    done: missing.length === 0,
  };
}

export function planSetup(input: SetupInput): SetupPlan {
  const steps: SetupStep[] = [];
  const shared = new Set(input.sharedSecretNames);

  // 1. Secrets — one step per NAME across every member: four members needing the same Cloudflare
  // token is one question, answered once as a shared secret.
  const byName = new Map<string, Extract<SetupStep, { kind: "secret" }>>();
  for (const member of input.members) {
    for (const s of member.missingSecrets) {
      const existing = byName.get(s.name);
      if (existing) {
        if (!existing.members.includes(member.name))
          existing.members.push(member.name);
        if (s.sandbox) existing.sandbox = true;
        if (!existing.description && s.description)
          existing.description = s.description;
      } else {
        byName.set(s.name, {
          kind: "secret",
          id: `secret:${s.name}`,
          name: s.name,
          description: s.description,
          sandbox: s.sandbox ?? false,
          members: [member.name],
          sharedExists: shared.has(s.name),
          done: false,
        });
      }
    }
  }
  steps.push(
    ...[...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  );

  // 2. Ledger database + team identities (can run before publish; values are held).
  if (input.ledger) {
    steps.push({
      kind: "ledger",
      id: "ledger",
      status: input.ledger.status,
      done: LEDGER_INSTALLED.includes(input.ledger.status),
    });
  }

  // 3. Publish — members become agents; everything after needs an agent row.
  const unpublished = input.members
    .filter((m) => !m.agentId)
    .map((m) => m.name);
  if (input.hasUnpublishedChanges || unpublished.length > 0) {
    steps.push({
      kind: "publish",
      id: "publish",
      members: unpublished,
      done: false,
    });
  }

  // 4. One GitHub App per member, then 5. OAuth connections.
  for (const member of input.members) {
    const step = githubStep(member);
    if (step) steps.push(step);
  }
  for (const member of input.members) {
    for (const c of member.connections) {
      steps.push({
        kind: "connection",
        id: `connection:${member.name}:${c.provider}`,
        member: member.name,
        provider: c.provider,
        published: member.agentId !== null,
        done: c.connected,
      });
    }
  }

  // 6. May I approvals and 7. wake verification, once the ledger exists.
  if (input.ledger) {
    steps.push({
      kind: "mayi",
      id: "mayi",
      status: input.ledger.mayi,
      done: input.ledger.mayi === "connected",
    });
    steps.push({
      kind: "wakes",
      id: "wakes",
      done: input.ledger.status === "ready",
    });
  }

  const done = steps.filter((s) => s.done).length;
  return {
    steps,
    next: steps.find((s) => !s.done) ?? null,
    done,
    total: steps.length,
  };
}
