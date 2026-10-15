import { describe, expect, it } from "vitest";
import { approvalCardData, approvalIdFromHref } from "~/approvals/view";

const row = (details: Record<string, unknown>, status = "pending") => ({
  id: "abcdefghijkl",
  title: "Ship it",
  status,
  approverRole: "engineer",
  expiresAt: null,
  decidedByName: null,
  decidedAt: null,
  feedback: null,
  details,
});

describe("approvalCardData", () => {
  it("links only artifacts for the commit under approval, plus the PR", () => {
    const card = approvalCardData(
      row({
        input: {
          head_sha: "new",
          artifacts: [
            { type: "pr", value: "https://github.com/o/r/pull/1", head_sha: "old" },
            { type: "preview_url", value: "https://old.example", head_sha: "old" },
            { type: "preview_url", value: "https://new.example", head_sha: "new" },
            { type: "branch", value: "https://github.com/o/r/tree/x", head_sha: "new" },
          ],
        },
      }),
      true,
    );
    expect(card.links).toEqual([
      { label: "Pull request", url: "https://github.com/o/r/pull/1" },
      { label: "Preview", url: "https://new.example/" },
    ]);
  });

  it("drops links that aren't http(s)", () => {
    const card = approvalCardData(
      row({
        input: {
          head_sha: "a",
          artifacts: [{ type: "pr", value: "javascript:alert(1)" }],
          evidence: [{ type: "qa_passed", url: "javascript:alert(1)" }],
        },
      }),
      true,
    );
    expect(card.links).toEqual([]);
    expect(card.evidence).toEqual([{ type: "qa_passed", summary: null, url: null }]);
  });

  it("can't be decided once closed, whatever the viewer's access", () => {
    expect(approvalCardData(row({}, "pending"), true).canDecide).toBe(true);
    expect(approvalCardData(row({}, "pending"), false).canDecide).toBe(false);
    expect(approvalCardData(row({}, "approved"), true).canDecide).toBe(false);
  });

  it("treats an unknown status as no longer needed", () => {
    const card = approvalCardData(row({}, "failed"), true);
    expect(card.status).toBe("superseded");
    expect(card.canDecide).toBe(false);
  });

  it("shows a merge only once harnesst owes or made one, dropping a stale error once merged", () => {
    expect(approvalCardData(row({}, "approved"), true).merge).toBeNull();
    expect(
      approvalCardData({ ...row({}, "approved"), mergeStatus: "bogus" }, true).merge,
    ).toBeNull();
    expect(
      approvalCardData(
        { ...row({}, "approved"), mergeStatus: "merged", mergeSha: "c1", mergeError: "old" },
        true,
      ).merge,
    ).toEqual({ status: "merged", sha: "c1", error: null });
    expect(
      approvalCardData(
        { ...row({}, "approved"), mergeStatus: "pending", mergeError: "Install the App" },
        true,
      ).merge,
    ).toEqual({ status: "pending", sha: null, error: "Install the App" });
  });

  it("survives malformed ledger details", () => {
    const card = approvalCardData(
      row({ input: { artifacts: "nope", evidence: [null], spec: [] }, project: 3 }),
      true,
    );
    expect(card.links).toEqual([]);
    expect(card.evidence).toEqual([{ type: "evidence", summary: null, url: null }]);
    expect(card.project).toBeNull();
    expect(card.acceptanceCriteria).toEqual([]);
  });
});

describe("approvalIdFromHref", () => {
  it("matches the approval path on any origin", () => {
    expect(approvalIdFromHref("https://x.trycloudflare.com/approvals/abcdefghijkl")).toBe(
      "abcdefghijkl",
    );
    expect(approvalIdFromHref("/approvals/abcdefghijkl/")).toBe("abcdefghijkl");
  });

  it("ignores other paths and malformed ids", () => {
    expect(approvalIdFromHref("/approvals/abc")).toBeNull();
    expect(approvalIdFromHref("/approvals/abcdefghijkl/edit")).toBeNull();
    expect(approvalIdFromHref("/x/approvals/abcdefghijkl")).toBeNull();
  });
});
