/**
 * Smoke: the jadendigital/agent-team damage case, end to end against the REAL agentmail template.
 *
 * The bookkeeping agent installed the agentmail connection at its member root; the assistant then
 * moved 3 of the 4 tools into `subagents/reader/tools/` and hand-rewrote the lock's `files`. Because
 * the planner recomputed every path from the MEMBER root, the next agentmail version bump planned
 * deletions for all three subagent paths and re-created them at the member root — silently
 * stripping the subagent's mail tools.
 *
 * Run: npx tsx scripts/smoke-subagent-install.ts
 */
import { fixtureCatalog } from "~/seams/oss/catalog.fixture.server";
import { resolveTemplate } from "~/marketplace/compose.server";
import { planInstall, planUninstall } from "~/marketplace/install.server";
import {
  findInstall,
  parseLock,
  reconcileSubagentScopes,
  serializeLock,
  type HarnesstLock,
} from "~/marketplace/lock";

const MEMBER_ROOT = "agents/bookkeeping/agent";
const READER_ROOT = `${MEMBER_ROOT}/subagents/reader`;
const MEMBER_ROOTS = new Map<string | null, string>([
  ["bookkeeping", MEMBER_ROOT],
]);

/** The lock as commit 5ce11787 left it: subagent paths, no `subagent` scope field. */
const LEGACY_LOCK: HarnesstLock = {
  version: 1,
  installs: [
    {
      id: "agentmail",
      type: "connection",
      name: "AgentMail",
      version: "0.1.0",
      hash: "stale",
      registry: "fixture",
      member: "bookkeeping",
      files: [
        `${READER_ROOT}/tools/agentmail-get-message.ts`,
        `${READER_ROOT}/tools/agentmail-list-inboxes.ts`,
        `${READER_ROOT}/tools/agentmail-list-messages.ts`,
      ],
    },
  ],
};

const problems: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
  if (!ok) problems.push(label);
};

const template = await resolveTemplate(fixtureCatalog, "connection", "agentmail");
const repoPaths = [
  `${MEMBER_ROOT}/agent.ts`,
  `${MEMBER_ROOT}/instructions.md`,
  `${READER_ROOT}/agent.ts`,
  `${READER_ROOT}/instructions.md`,
  ...LEGACY_LOCK.installs[0].files,
  "agents/bookkeeping/package.json",
];
const packageJson = JSON.stringify({ name: "bookkeeping", dependencies: {} });
const base = {
  template,
  registry: "fixture",
  repoPaths,
  drafts: [],
  packageJson,
  rosterNames: ["bookkeeping"],
} as const;

console.log("\n1. The bug: planning the update at the MEMBER scope relocates the subagent's tools");
const naive = planInstall({
  ...base,
  lock: LEGACY_LOCK,
  target: { kind: "member", memberName: "bookkeeping", root: MEMBER_ROOT },
});
const relocated = naive.deletions.filter((p) => p.startsWith(`${READER_ROOT}/`));
check(
  relocated.length === 3,
  `member-scope plan deletes the subagent's 3 tools (${relocated.length} deletions) — the damage this fix prevents`,
);
check(
  naive.writes.some((w) => w.path === `${MEMBER_ROOT}/tools/agentmail-get-message.ts`),
  "member-scope plan re-creates them at the member root",
);

console.log("\n2. Reconciliation recovers the scope the hand-edit destroyed");
const { lock: fixed, changed } = reconcileSubagentScopes(LEGACY_LOCK, MEMBER_ROOTS);
check(changed, "reconcileSubagentScopes reports a change");
check(
  findInstall(fixed, "agentmail", "bookkeeping", "reader") !== undefined,
  'the entry is now scoped to the "reader" subagent',
);
check(
  findInstall(fixed, "agentmail", "bookkeeping") === undefined,
  "and no longer answers as a member-level install",
);
check(
  serializeLock(fixed).includes('"subagent": "reader"'),
  "the correction lands in the serialized lock, reviewable in the PR",
);

console.log("\n3. The fix: planning the update at the subagent scope keeps the tools in place");
const scoped = planInstall({
  ...base,
  lock: fixed,
  target: {
    kind: "member",
    memberName: "bookkeeping",
    root: READER_ROOT,
    deploymentRoot: MEMBER_ROOT,
    subagentPath: "reader",
  },
});
check(scoped.conflicts.length === 0, `no conflicts (${scoped.conflicts.join("; ")})`);
check(
  !scoped.deletions.some((p) => p.startsWith(`${READER_ROOT}/tools/`)),
  "NO deletions relocating the subagent's tools",
);
const written = scoped.writes.map((w) => w.path);
check(
  template.manifest.files.every((f) => written.includes(`${READER_ROOT}/${f}`)),
  `all ${template.manifest.files.length} template tools land under the subagent root`,
);
check(
  !written.some((p) => p.startsWith(`${MEMBER_ROOT}/tools/agentmail-`)),
  "and none leak back into the member's tools/",
);
check(
  written.includes("agents/bookkeeping/package.json"),
  "the zod dependency still merges into the MEMBER's package.json",
);
const staged = parseLock(
  JSON.parse(scoped.writes.find((w) => w.path === "harnesst-lock.json")!.content),
);
const entry = findInstall(staged, "agentmail", "bookkeeping", "reader")!;
check(entry.version === template.manifest.version, `lock records v${entry.version}`);
check(
  entry.files.every((f) => f.startsWith(`${READER_ROOT}/`)),
  "and owns only subagent-root paths",
);

console.log("\n4. The scopes are independent: the member can hold its own copy");
const alsoMember = planInstall({
  ...base,
  lock: staged,
  repoPaths: [...repoPaths, ...entry.files],
  target: { kind: "member", memberName: "bookkeeping", root: MEMBER_ROOT },
});
const bothLock = parseLock(
  JSON.parse(alsoMember.writes.find((w) => w.path === "harnesst-lock.json")!.content),
);
check(bothLock.installs.length === 2, `two independent rows (${bothLock.installs.length})`);
check(
  !alsoMember.deletions.some((p) => p.startsWith(`${READER_ROOT}/`)),
  "installing on the member touches none of the subagent's files",
);
const removed = planUninstall({
  lock: bothLock,
  id: "agentmail",
  memberName: "bookkeeping",
  subagentPath: "reader",
  repoPaths: [...repoPaths, ...entry.files],
});
check(
  removed.deletions.every((p) => p.startsWith(`${READER_ROOT}/`)),
  "uninstalling the subagent scope deletes only its own files",
);
check(
  findInstall(parseLock(JSON.parse(removed.lockWrite.content)), "agentmail", "bookkeeping") !==
    undefined,
  "and leaves the member's install standing",
);

console.log("\n5. Channels stay root-only in eve");
const channel = await resolveTemplate(fixtureCatalog, "channel", "discord");
const refused = planInstall({
  ...base,
  template: channel,
  lock: { version: 1, installs: [] },
  target: {
    kind: "member",
    memberName: "bookkeeping",
    root: READER_ROOT,
    deploymentRoot: MEMBER_ROOT,
    subagentPath: "reader",
  },
});
check(refused.writes.length === 0, "a channel at a subagent target stages nothing");
check(
  refused.conflicts.some((c) => c.startsWith("Channels and schedules are root-only in eve")),
  `and says why: ${refused.conflicts[0] ?? "(no conflict!)"}`,
);

console.log(
  problems.length === 0
    ? "\nAll checks passed.\n"
    : `\n${problems.length} FAILED:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`,
);
process.exit(problems.length === 0 ? 0 : 1);
