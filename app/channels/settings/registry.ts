/**
 * Channel settings registry (issue #254): marketplace channel id → the panel that configures it.
 *
 * The same code/data split the lock draws for permissions (`lock.ts`: scope-group DEFINITIONS are
 * template-authored data, capability LABELS are harnesst code). A channel's settings VALUES are data
 * — they live in `harnesst-lock.json` under the install that provides the channel, travel with the
 * repo, and are projected into deploy env. The FORM is code: it needs harnesst's own context (where
 * the agent's GitHub App is installed), its own copy, and a parser that agrees with its fields
 * byte-for-byte. A template can't author that, so this map is the surface's, not the catalog's.
 *
 * A channel with no entry here simply has no settings panel: the row renders as it always did, and
 * the `channel-settings` action refuses an id it doesn't know rather than writing a blob nothing
 * reads.
 */
import type { ReactElement } from "react";

import type { ChannelSettings } from "~/marketplace/lock";
import {
  GitHubChannelSettings,
  gitHubChannelSummary,
  parseGitHubChannelForm,
} from "./github";

/**
 * The GitHub App installation facts a panel may render. Structurally the loader's
 * `AppInstallation`, restated here so a client component never imports a `.server` module.
 */
export interface ChannelSettingsInstallation {
  /** The account's login (user or organization name). */
  account: string;
  /** GitHub's grant shape: "all" repositories, or "selected" ones. */
  repositorySelection: string;
}

/**
 * One props shape for every panel. Channel-specific context is an optional field here rather than
 * a per-channel props type, so the registry stays a map of ONE component type and the mount site
 * renders any channel without a switch.
 */
export interface ChannelSettingsPanelProps {
  /** The channel's stored settings — `{}` when it has never been configured, which means inert. */
  settings: ChannelSettings;
  /** GitHub: where the agent's own App is installed; null when GitHub couldn't be reached. */
  githubInstallations: ChannelSettingsInstallation[] | null;
  /**
   * GitHub: the `owner/repo` names that App can actually see — the repository picker's options.
   * Null whenever they couldn't be established (no credentials, no installation, GitHub down), and
   * the panel degrades to a typed field, which stays available beside the picker regardless.
   */
  githubRepositories: string[] | null;
}

export interface ChannelSettingsDefinition {
  /** How the channel is spelled in the panel's copy. */
  label: string;
  /** The fields. The enclosing form, the intent and the submit button belong to the mount site. */
  Panel: (props: ChannelSettingsPanelProps) => ReactElement;
  /** The collapsed `<summary>` line for the current settings. */
  summary: (settings: ChannelSettings) => string;
  /** Read the panel's fields back off the submitted form — the parse half of the same contract. */
  parseForm: (form: FormData) => ChannelSettings;
}

const CHANNEL_SETTINGS: Record<string, ChannelSettingsDefinition> = {
  github: {
    label: "GitHub",
    Panel: GitHubChannelSettings,
    summary: gitHubChannelSummary,
    parseForm: parseGitHubChannelForm,
  },
};

/** The settings panel for a channel id, or null when that channel has nothing to configure. */
export function channelSettingsDefinition(
  id: string,
): ChannelSettingsDefinition | null {
  return CHANNEL_SETTINGS[id] ?? null;
}
