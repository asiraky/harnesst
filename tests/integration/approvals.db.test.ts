/** harnesst approvals against Postgres, with a fake ledger standing in for Supabase. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { LedgerApprovalView } from "~/approvals/ledger-client.server";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

const view = (over: Partial<LedgerApprovalView> = {}): LedgerApprovalView => ({
  id: "11111111-1111-1111-1111-111111111111",
  item_id: "item",
  epoch: 1,
  stage: "merge-approval",
  binding: "sha1",
  status: "pending",
  action: { input: { title: "Merge #1", approver_role: "engineer", head_sha: "sha1" } },
  review_url: null,
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  project: { id: "p", slug: "app", name: "App", repo: "o/app" },
  decision: null,
  ...over,
});

function fakeLedger(views: LedgerApprovalView[], resolved?: Partial<LedgerApprovalView>) {
  const published: Array<{ id: string; url: string }> = [];
  const resolves: unknown[] = [];
  return {
    published,
    resolves,
    ledger: {
      list: async () => views,
      publish: async (id: string, url: string) => {
        published.push({ id, url });
        return view({ id, status: "submitted", review_url: url });
      },
      resolve: async (input: unknown) => {
        resolves.push(input);
        return view({ ...resolved });
      },
    },
  };
}

describe.runIf(LIVE)("approvals against Postgres", () => {
  async function setup() {
    const { db } = await import("~/db/client.server");
    const { organization } = await import("~/db/auth-schema");
    const { projects } = await import("~/db/schema");
    const orgId = `org_approvals_${crypto.randomUUID()}`;
    await db.insert(organization).values({ id: orgId, name: "Approvals", slug: orgId, createdAt: new Date() });
    const [project] = await db.insert(projects).values({ orgId, name: "team", slug: orgId }).returning();
    return {
      projectId: project.id,
      cleanup: () => db.delete(organization).where(eq(organization.id, orgId)),
    };
  }

  async function decider() {
    const { db } = await import("~/db/client.server");
    const { user } = await import("~/db/auth-schema");
    const id = `u_${crypto.randomUUID()}`;
    await db.insert(user).values({
      id,
      name: "Ann",
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { user: { id, name: "Ann" }, remove: () => db.delete(user).where(eq(user.id, id)) };
  }

  it("publishes a link only for requests the ledger hasn't published", async () => {
    const { syncProjectApprovals, getApproval } = await import("~/approvals/approvals.server");
    const { db } = await import("~/db/client.server");
    const { approvals } = await import("~/db/schema");
    const { projectId, cleanup } = await setup();
    try {
      const fake = fakeLedger([
        view(),
        view({ id: "22222222-2222-2222-2222-222222222222", status: "submitted" }),
      ]);
      const result = await syncProjectApprovals(projectId, "https://h.example", {
        ledgerFor: async () => fake.ledger,
      });
      expect(result).toEqual({ seen: 2, published: 1 });
      const rows = await db.select().from(approvals).where(eq(approvals.projectId, projectId));
      const first = rows.find((r) => r.externalId === view().id)!;
      expect(fake.published).toEqual([
        { id: view().id, url: `https://h.example/approvals/${first.id}` },
      ]);
      expect(rows.every((r) => r.status === "pending")).toBe(true);
      expect((await getApproval(first.id))?.title).toBe("Merge #1");
    } finally {
      await cleanup();
    }
  });

  it("records the harnesst decider and keeps them when the ledger later syncs", async () => {
    const { syncProjectApprovals, decideApproval } = await import("~/approvals/approvals.server");
    const { db } = await import("~/db/client.server");
    const { approvals } = await import("~/db/schema");
    const { user } = await import("~/db/auth-schema");
    const { projectId, cleanup } = await setup();
    const userId = `u_${crypto.randomUUID()}`;
    await db.insert(user).values({
      id: userId,
      name: "Ann",
      email: `${userId}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    try {
      const decision = {
        status: "approved",
        approver_id: userId,
        approver_name: "Ann (ledger copy)",
        feedback: null,
        occurred_at: new Date().toISOString(),
      };
      await syncProjectApprovals(projectId, "https://h.example", {
        ledgerFor: async () => fakeLedger([view({ status: "submitted" })]).ledger,
      });
      const [row] = await db.select().from(approvals).where(eq(approvals.projectId, projectId));
      const fake = fakeLedger([], { status: "approved", outcome: "decided", decision });
      const result = await decideApproval(
        { approval: row, decision: "approve", user: { id: userId, name: "Ann" } },
        { ledgerFor: async () => fake.ledger },
      );
      expect(result.outcome).toBe("decided");
      expect(result.approval).toMatchObject({ status: "approved", decidedBy: userId, decidedByName: "Ann" });

      await syncProjectApprovals(projectId, "https://h.example", {
        ledgerFor: async () => fakeLedger([view({ status: "approved", decision })]).ledger,
      });
      const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
      expect(after.decidedByName).toBe("Ann");
    } finally {
      await cleanup();
      await db.delete(user).where(eq(user.id, userId));
    }
  });

  it("records no decider when the ledger refuses a stale decision", async () => {
    const { syncProjectApprovals, decideApproval } = await import("~/approvals/approvals.server");
    const { db } = await import("~/db/client.server");
    const { approvals } = await import("~/db/schema");
    const { projectId, cleanup } = await setup();
    try {
      await syncProjectApprovals(projectId, "https://h.example", {
        ledgerFor: async () => fakeLedger([view({ status: "submitted" })]).ledger,
      });
      const [row] = await db.select().from(approvals).where(eq(approvals.projectId, projectId));
      const fake = fakeLedger([], { status: "superseded", outcome: "stale" });
      const result = await decideApproval(
        { approval: row, decision: "approve", user: { id: "nobody", name: "X" } },
        { ledgerFor: async () => fake.ledger },
      );
      expect(result.outcome).toBe("stale");
      expect(result.approval).toMatchObject({ status: "superseded", decidedBy: null, decidedByName: null });
    } finally {
      await cleanup();
    }
  });

  it("refuses a rejection without feedback before asking the ledger", async () => {
    const { syncProjectApprovals, decideApproval, ApprovalDecisionError } = await import(
      "~/approvals/approvals.server"
    );
    const { db } = await import("~/db/client.server");
    const { approvals } = await import("~/db/schema");
    const { projectId, cleanup } = await setup();
    try {
      await syncProjectApprovals(projectId, "https://h.example", {
        ledgerFor: async () => fakeLedger([view({ status: "submitted" })]).ledger,
      });
      const [row] = await db.select().from(approvals).where(eq(approvals.projectId, projectId));
      const fake = fakeLedger([]);
      await expect(
        decideApproval(
          { approval: row, decision: "reject", feedback: "  ", user: { id: "u", name: "U" } },
          { ledgerFor: async () => fake.ledger },
        ),
      ).rejects.toBeInstanceOf(ApprovalDecisionError);
      expect(fake.resolves).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  const HEAD = "a".repeat(40);
  const mergeGate = (over: Partial<LedgerApprovalView> = {}) =>
    view({
      binding: HEAD,
      action: {
        input: {
          title: "Merge #7",
          head_sha: HEAD,
          approve_to: "ready-to-merge",
          artifacts: [{ type: "pr", value: "https://github.com/o/app/pull/7" }],
        },
      },
      ...over,
    });
  const approvedDecision = {
    status: "approved",
    approver_id: null,
    approver_name: "Ann",
    feedback: null,
    occurred_at: new Date().toISOString(),
  };

  /** GitHub standing in: the PR as it is, and every merge asked for. */
  function fakeGitHub(pr: Record<string, unknown>, mergeStatus = 200) {
    const merges: unknown[] = [];
    const request = (async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        merges.push(JSON.parse(String(init.body)));
        return Response.json(
          mergeStatus === 200 ? { merged: true, sha: "c".repeat(40) } : { message: "Required status check is pending" },
          { status: mergeStatus },
        );
      }
      expect(url).toBe("https://api.github.com/repos/o/app/pulls/7");
      return Response.json(pr);
    }) as typeof fetch;
    return { merges, fetch: request };
  }
  const openPr = {
    number: 7,
    state: "open",
    merged: false,
    merge_commit_sha: null,
    head: { sha: HEAD, repo: { full_name: "o/app" } },
    base: { ref: "main", repo: { full_name: "o/app", default_branch: "main" } },
  };

  it("merges an approved merge gate at the approved commit straight after the decision", async () => {
    const { syncProjectApprovals, decideApproval } = await import("~/approvals/approvals.server");
    const { db } = await import("~/db/client.server");
    const { approvals } = await import("~/db/schema");
    const { projectId, cleanup } = await setup();
    const ann = await decider();
    try {
      await syncProjectApprovals(projectId, "https://h.example", {
        ledgerFor: async () => fakeLedger([mergeGate({ status: "submitted" })]).ledger,
      });
      const [row] = await db.select().from(approvals).where(eq(approvals.projectId, projectId));
      const github = fakeGitHub(openPr);
      const result = await decideApproval(
        { approval: row, decision: "approve", user: ann.user },
        {
          ledgerFor: async () =>
            fakeLedger([], { ...mergeGate(), status: "approved", outcome: "decided", decision: approvedDecision }).ledger,
          merge: { tokenFor: async () => "t", fetch: github.fetch },
        },
      );
      expect(github.merges).toEqual([{ sha: HEAD, merge_method: "squash" }]);
      expect(result.approval).toMatchObject({ mergeStatus: "merged", mergeSha: "c".repeat(40), mergeError: null });
    } finally {
      await cleanup();
      await ann.remove();
    }
  });

  it("keeps a merge GitHub isn't ready for pending, and the decision stands", async () => {
    const { syncProjectApprovals, decideApproval } = await import("~/approvals/approvals.server");
    const { db } = await import("~/db/client.server");
    const { approvals } = await import("~/db/schema");
    const { projectId, cleanup } = await setup();
    const ann = await decider();
    try {
      await syncProjectApprovals(projectId, "https://h.example", {
        ledgerFor: async () => fakeLedger([mergeGate({ status: "submitted" })]).ledger,
      });
      const [row] = await db.select().from(approvals).where(eq(approvals.projectId, projectId));
      const result = await decideApproval(
        { approval: row, decision: "approve", user: ann.user },
        {
          ledgerFor: async () =>
            fakeLedger([], { ...mergeGate(), status: "approved", outcome: "decided", decision: approvedDecision }).ledger,
          merge: { tokenFor: async () => "t", fetch: fakeGitHub(openPr, 405).fetch },
        },
      );
      expect(result.outcome).toBe("decided");
      expect(result.approval).toMatchObject({
        status: "approved",
        mergeStatus: "pending",
        mergeError: expect.stringMatching(/status check is pending/),
      });
    } finally {
      await cleanup();
      await ann.remove();
    }
  });

  it("picks up merge gates approved elsewhere, and leaves other gates alone", async () => {
    const { syncProjectApprovals } = await import("~/approvals/approvals.server");
    const { syncApprovedMerges } = await import("~/approvals/merge.server");
    const { db } = await import("~/db/client.server");
    const { approvals } = await import("~/db/schema");
    const { projectId, cleanup } = await setup();
    try {
      await syncProjectApprovals(projectId, "https://h.example", {
        ledgerFor: async () =>
          fakeLedger([
            mergeGate({ status: "approved", decision: approvedDecision }),
            view({ id: "44444444-4444-4444-4444-444444444444", status: "approved", decision: approvedDecision }),
          ]).ledger,
      });
      // No installation covers the repo yet: owed, with the fix.
      await syncApprovedMerges({ tokenFor: async () => null }, { projectId });
      let rows = await db.select().from(approvals).where(eq(approvals.projectId, projectId));
      const gate = () => rows.find((r) => r.externalId === mergeGate().id)!;
      expect(gate()).toMatchObject({
        mergeStatus: "pending",
        mergeError: expect.stringMatching(/Install harnesst's GitHub App on o\/app/),
      });
      expect(rows.find((r) => r.externalId !== mergeGate().id)!.mergeStatus).toBeNull();

      // Next retry, after the backoff: the PR is already merged at the approved commit.
      await db
        .update(approvals)
        .set({ updatedAt: new Date(Date.now() - 120_000) })
        .where(eq(approvals.id, gate().id));
      const github = fakeGitHub({ ...openPr, state: "closed", merged: true, merge_commit_sha: "d".repeat(40) });
      await syncApprovedMerges({ tokenFor: async () => "t", fetch: github.fetch }, { projectId });
      rows = await db.select().from(approvals).where(eq(approvals.projectId, projectId));
      expect(github.merges).toEqual([]);
      expect(gate()).toMatchObject({ mergeStatus: "merged", mergeSha: "d".repeat(40), mergeError: null });
    } finally {
      await cleanup();
    }
  });

  it("asks only viewers who can decide, and only about open requests", async () => {
    const { syncProjectApprovals } = await import("~/approvals/approvals.server");
    const { listApprovalInboxItems } = await import("~/approvals/inbox.server");
    const { projectId, cleanup } = await setup();
    try {
      await syncProjectApprovals(projectId, "https://h.example", {
        ledgerFor: async () =>
          fakeLedger([
            view({ status: "submitted" }),
            view({ id: "33333333-3333-3333-3333-333333333333", status: "expired" }),
          ]).ledger,
      });
      const items = await listApprovalInboxItems([{ projectId, role: "write" }]);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: "approval", agentName: "team", prompt: "Merge #1" });
      expect(items[0].href).toMatch(/^\/approvals\/[a-z]{12}$/);
      expect(await listApprovalInboxItems([{ projectId, role: "read" }])).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
