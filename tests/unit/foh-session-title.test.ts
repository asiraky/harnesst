import { describe, expect, it, vi } from "vitest";

import {
  githubIssueFromMessage,
  inferFohSessionTitle,
  titleFromMessage,
} from "~/foh/session-title.server";

const PROJECT = {
  repoOwner: "asiraky",
  repoName: "harnesst",
  repoInstallationId: "grant_1",
};

describe("FOH session title inference", () => {
  it("uses the connected GitHub issue title instead of its URL or number", async () => {
    const readIssueTitle = vi.fn(async () => "Portal 404 fix");

    await expect(
      inferFohSessionTitle(
        {
          message:
            "Please work on https://github.com/asiraky/harnesst/issues/286",
          project: PROJECT,
        },
        { readIssueTitle },
      ),
    ).resolves.toBe("Portal 404 fix");
    expect(readIssueTitle).toHaveBeenCalledWith({
      installationId: "grant_1",
      owner: "asiraky",
      repo: "harnesst",
      number: 286,
    });
  });

  it("recognizes issue URLs inside surrounding text and trailing punctuation", () => {
    expect(
      githubIssueFromMessage(
        "Could you handle (https://github.com/acme/widgets/issues/42)? Thanks.",
      ),
    ).toMatchObject({ owner: "acme", repo: "widgets", number: 42 });
  });

  it("does not use one project's installation grant to probe another repository", async () => {
    const readIssueTitle = vi.fn(async () => "Private title");

    const title = await inferFohSessionTitle(
      {
        message: "https://github.com/secret/private/issues/9",
        project: PROJECT,
      },
      { readIssueTitle },
    );

    expect(title).toBe("secret/private #9");
    expect(title).not.toContain("https://");
    expect(readIssueTitle).not.toHaveBeenCalled();
  });

  it("falls back to a compact issue label when GitHub is unavailable", async () => {
    const title = await inferFohSessionTitle(
      {
        message:
          "Please implement this issue: https://github.com/asiraky/harnesst/issues/286",
        project: PROJECT,
      },
      {
        readIssueTitle: vi.fn(async () => Promise.reject(new Error("offline"))),
      },
    );

    expect(title).toBe("asiraky/harnesst #286");
  });

  it("turns an ordinary request into a short label", () => {
    expect(
      titleFromMessage(
        "Could you please fix the portal 404? It started after yesterday's deploy.",
      ),
    ).toBe("Fix the portal 404?");
  });

  it("preserves meaningful punctuation in inferred titles", () => {
    expect(titleFromMessage("Please fix the C# authentication adapter")).toBe(
      "Fix the C# authentication adapter",
    );
  });
});
