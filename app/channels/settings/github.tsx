/**
 * GitHub channel settings (issue #254) — the three answers that decide when a GitHub-homed agent
 * WAKES, and the reason the channel is inert until someone gives them.
 *
 * Before this the wake rule lived in the customer's copy of `agent/channels/github.ts`, which is
 * how a marketplace update silently overwrote the only mechanism waking two live agents. The rule
 * is now platform code that reads its configuration from env, and this panel is where that
 * configuration is written: into `harnesst-lock.json` (so it travels with the repo and is
 * reviewable in the PR that changes it), out again as `HARNESST_CHANNEL_GITHUB_*` at deploy time.
 *
 * Repositories ARE picked — off the agent's own App installations, which is the same credential
 * the agent works with, so a repo it can't see is a repo it couldn't act on. The picker is an
 * addition to the typed field, never a replacement: a repo GitHub didn't return (unreachable, a
 * second installation, added a minute ago) must still be enterable, so both encodings post the same
 * `repos` field and `parseGitHubChannelForm` reads them together.
 *
 * Labels are deliberately FREE TEXT, not a picker off the repository. A picker can only offer
 * labels that already exist, and these are labels the workflow is meant to ESTABLISH — an empty
 * repository would offer an empty list and the operator would conclude the feature was broken.
 */
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import type { ChannelSettings } from "~/marketplace/lock";
import type { ChannelSettingsPanelProps } from "./registry";

/**
 * What an unconfigured channel's label field is PREFILLED with — a starting workflow, not a
 * stored default. Nothing is written to the lock until the operator saves, so a repo that never
 * opens this panel keeps waking on nothing at all.
 */
export const DEFAULT_WAKE_LABELS = ["ready", "changes-requested"];

/** A stored settings value read back as a list — a lone string counts as a one-entry list. */
function asList(value: ChannelSettings[string] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value !== "") return [value];
  return [];
}

/**
 * Split one comma/newline separated free-text field into trimmed, deduped, non-empty entries.
 * Chips are typed, not picked, so the parse has to be forgiving about the separators and spacing
 * a person actually produces — and strict about what lands in the lock, where duplicates and
 * blanks would be pure diff noise.
 */
export function splitChips(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const value = part.trim();
    if (value !== "" && !out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * Read this panel's fields back off the submitted form. It lives beside the panel because the two
 * are one contract — a renamed input here is a silently-dropped setting there — and it is pure so
 * the route action can call it without touching React.
 *
 * Values that mean "not configured" are passed through as-is: `setChannelSettings` prunes them, so
 * clearing every field leaves the entry byte-identical to one that was never configured.
 */
export function parseGitHubChannelForm(form: FormData): ChannelSettings {
  return {
    // `repos` arrives as MANY entries when the picker rendered — one per ticked checkbox, plus the
    // free-text box for repositories the picker couldn't offer. Joining before the split keeps one
    // parse for both shapes, and `splitChips` dedupes across them (a name in both wins once).
    repos: splitChips(form.getAll("repos").map(String).join(",")),
    wakeLabels: splitChips(String(form.get("wakeLabels") ?? "")),
    wakeOnNewIssues: form.get("wakeOnNewIssues") === "1",
  };
}

/** The collapsed summary line: the shape of the current configuration in one clause. */
export function gitHubChannelSummary(settings: ChannelSettings): string {
  const repos = asList(settings.repos);
  const labels = asList(settings.wakeLabels);
  if (repos.length === 0 && labels.length === 0 && settings.wakeOnNewIssues !== true) {
    return "not configured — answers @mentions only";
  }
  const parts = [
    repos.length === 1 ? repos[0] : `${repos.length} repositories`,
    labels.length > 0 ? `wakes on ${labels.join(", ")}` : null,
    settings.wakeOnNewIssues === true ? "and on new issues" : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/**
 * The fields themselves. The enclosing `<Form>`, the `channel-settings` intent and the submit
 * button belong to the mount site (the Deployment tab's GitHub channel row) — this component owns
 * only what is specific to GitHub, which is what makes the registry one map of one component type.
 */
export function GitHubChannelSettings({
  settings,
  githubInstallations,
  githubRepositories,
}: ChannelSettingsPanelProps) {
  const repos = asList(settings.repos);
  const labels = asList(settings.wakeLabels);
  const configured = repos.length > 0 || labels.length > 0;
  // The accounts the agent's own App is installed on. GitHub's App-installations API reports the
  // account and whether the grant covers all or selected repositories — not which ones — so this
  // is guidance for the typed field, never a source the field could be picked from.
  const accounts = (githubInstallations ?? []).map((i) =>
    i.repositorySelection === "all"
      ? `${i.account} (all repositories)`
      : `${i.account} (selected repositories)`,
  );
  const options = githubRepositories ?? [];
  // Saved repositories the picker can't offer: a second installation that failed to read, a repo
  // added since this page loaded, a >100-repo installation's tail. They keep the typed field so
  // rendering a picker never silently drops a setting that is already live.
  const typed = repos.filter((r) => !options.includes(r));
  // Every field here is uncontrolled, so `defaultValue` is read once per mount and a save that
  // normalises what was typed (trimming, dropping a repeated repo) would leave the raw text sitting
  // in the box while the summary above it already reports the stored value — the panel stating two
  // different things about one setting, and the operator trusting the wrong one. Keying the fields
  // on what was actually saved remounts them when, and only when, that changes.
  const savedKey = JSON.stringify([repos, labels, settings.wakeOnNewIssues === true]);

  return (
    <div key={savedKey} className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor="github-channel-repos">Repositories</Label>
        {options.length > 0 && (
          <div className="grid max-h-48 gap-1 overflow-y-auto rounded-md border px-2 py-1.5">
            {options.map((full) => (
              <Label
                key={full}
                className="flex items-center gap-2 text-sm font-normal"
              >
                <input
                  type="checkbox"
                  name="repos"
                  value={full}
                  defaultChecked={repos.includes(full)}
                  className="size-4 accent-primary"
                />
                <span>{full}</span>
              </Label>
            ))}
          </div>
        )}
        <Input
          id="github-channel-repos"
          name="repos"
          defaultValue={typed.join(", ")}
          placeholder={
            options.length > 0
              ? "another/repo"
              : "acme/marketing-site, acme/api"
          }
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          {options.length > 0 ? (
            <>
              Tick the repositories this agent watches. Anything the App
              can&rsquo;t see yet goes in the box as <code>owner/repo</code>,
              comma separated.
            </>
          ) : (
            <>
              <code>owner/repo</code>, comma separated.
            </>
          )}{" "}
          Events from anywhere else are ignored, and an empty list wakes the
          agent nowhere — the channel still answers @mentions.
          {options.length === 0 && accounts.length > 0 && (
            <> The App is installed on {accounts.join(", ")}.</>
          )}
        </p>
      </div>

      <div className="grid gap-1">
        <Label htmlFor="github-channel-wake-labels">Wake labels</Label>
        <Input
          id="github-channel-wake-labels"
          name="wakeLabels"
          defaultValue={(configured ? labels : DEFAULT_WAKE_LABELS).join(", ")}
          placeholder="ready, changes-requested"
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          Applying one of these to an issue or pull request starts a turn. Only
          the label just applied counts, so one edit means one turn. They
          don&rsquo;t have to exist in the repository yet — these are the labels
          your workflow establishes.
        </p>
      </div>

      <Label className="flex items-start gap-2 text-sm font-normal">
        <input
          type="checkbox"
          name="wakeOnNewIssues"
          value="1"
          defaultChecked={settings.wakeOnNewIssues === true}
          className="mt-0.5 size-4 accent-primary"
        />
        <span className="grid gap-0.5">
          <span className="font-medium">Wake on new issues</span>
          <span className="text-xs text-muted-foreground">
            Every issue opened or reopened in the repositories above starts a
            turn. Leave it off for an agent that should only pick up work
            somebody has labelled for it.
          </span>
        </span>
      </Label>
    </div>
  );
}
