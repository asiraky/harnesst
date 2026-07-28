/**
 * Channel settings panel contract (issue #254) — the parse half of the form the Deployment tab
 * renders. The fields and this parser are ONE contract (a renamed input is a silently-dropped
 * setting), and the keys it produces are the other end of the deploy's
 * `HARNESST_CHANNEL_GITHUB_*` projection, so both halves are pinned here.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_WAKE_LABELS,
  gitHubChannelSummary,
  parseGitHubChannelForm,
  splitChips,
} from "~/channels/settings/github";
import { channelSettingsDefinition } from "~/channels/settings/registry";
import { setChannelSettings, type HarnesstLock } from "~/marketplace/lock";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describe("splitChips", () => {
  it("trims, drops blanks, and dedupes", () => {
    expect(splitChips(" ready ,, changes-requested,ready ")).toEqual([
      "ready",
      "changes-requested",
    ]);
  });

  it("accepts newlines as separators (a pasted list is the common case)", () => {
    expect(splitChips("acme/site\nacme/api")).toEqual([
      "acme/site",
      "acme/api",
    ]);
  });

  it("reads an empty field as no entries, not one empty entry", () => {
    expect(splitChips("   ")).toEqual([]);
  });
});

describe("parseGitHubChannelForm", () => {
  it("produces exactly the keys the deploy projects into env", () => {
    // These key names are the contract with the channel code: `repos` → HARNESST_CHANNEL_GITHUB_REPOS,
    // `wakeLabels` → …_WAKE_LABELS, `wakeOnNewIssues` → …_WAKE_ON_NEW_ISSUES.
    const settings = parseGitHubChannelForm(
      form({
        repos: "acme/site, acme/api",
        wakeLabels: "ready",
        wakeOnNewIssues: "1",
      }),
    );

    expect(settings).toEqual({
      repos: ["acme/site", "acme/api"],
      wakeLabels: ["ready"],
      wakeOnNewIssues: true,
    });
  });

  it("merges the repository picker's ticks with the typed field", () => {
    // The picker posts one `repos` entry per ticked checkbox; the box beside it carries repos the
    // picker couldn't offer. Both are the same field, and a name in both counts once.
    const data = new FormData();
    data.append("repos", "acme/site");
    data.append("repos", "acme/api");
    data.append("repos", "other/private, acme/site");

    expect(parseGitHubChannelForm(data).repos).toEqual([
      "acme/site",
      "acme/api",
      "other/private",
    ]);
  });

  it("reads an absent checkbox as off (a browser omits it entirely)", () => {
    const settings = parseGitHubChannelForm(form({ repos: "acme/site" }));

    expect(settings.wakeOnNewIssues).toBe(false);
  });

  it("round-trips an emptied form back to an unconfigured install", () => {
    // Clearing every field must leave the entry byte-identical to one nobody ever configured —
    // absent settings are what makes the channel inert.
    const lock: HarnesstLock = {
      version: 1,
      installs: [
        {
          id: "github-bundle",
          type: "bundle",
          name: "github",
          version: "0.4.0",
          hash: "h",
          registry: "fixture",
          member: null,
          files: ["agent/channels/github.ts"],
          includes: [
            { id: "github", type: "channel", name: "github", version: "0.6.0", hash: "h2" },
          ],
          settings: { repos: ["acme/site"], wakeOnNewIssues: true },
        },
      ],
    };

    const { lock: next, changed } = setChannelSettings(
      lock,
      "github",
      null,
      parseGitHubChannelForm(form({ repos: "", wakeLabels: "" })),
    );

    expect(changed).toBe(true);
    expect(next.installs[0]).not.toHaveProperty("settings");
  });
});

describe("gitHubChannelSummary", () => {
  it("says a never-configured channel only answers mentions", () => {
    expect(gitHubChannelSummary({})).toBe(
      "not configured — answers @mentions only",
    );
  });

  it("names a single repository rather than counting it", () => {
    expect(
      gitHubChannelSummary({ repos: ["acme/site"], wakeLabels: ["ready"] }),
    ).toBe("acme/site · wakes on ready");
  });
});

describe("channelSettingsDefinition", () => {
  it("resolves the github panel", () => {
    expect(channelSettingsDefinition("github")?.label).toBe("GitHub");
  });

  it("returns null for a channel with nothing to configure", () => {
    // The action refuses these rather than writing a blob nothing reads.
    expect(channelSettingsDefinition("discord")).toBeNull();
  });

  it("prefills labels the workflow is meant to establish, not ones fetched from the repo", () => {
    expect(DEFAULT_WAKE_LABELS).toEqual(["ready", "changes-requested"]);
  });
});
