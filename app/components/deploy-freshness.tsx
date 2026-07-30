import { ArrowUp, Check } from "lucide-react";

import { Badge } from "~/components/ui/badge";

/**
 * Is the version an environment is running the newest one available? Callers pass
 * the running deployment's `releaseId` and that agent's releases (newest-first, as
 * every loader returns them). A deployment on the top release is "latest"; anything
 * older is behind, and we surface the newest version label so the user knows what's
 * available. Returns null when there are no releases at all (nothing to compare).
 */
export function releaseFreshness(
  runningReleaseId: string | null | undefined,
  releasesNewestFirst: readonly { id: string; version: string }[],
): { isLatest: boolean; latestVersion: string } | null {
  const latest = releasesNewestFirst[0];
  if (!latest) return null;
  return {
    isLatest: runningReleaseId === latest.id,
    latestVersion: latest.version,
  };
}

/**
 * A colour-coded pill telling the user, at a glance, whether what's running is the
 * latest version: green "Latest" when it is, amber "vN available" when a newer
 * release exists. Reused wherever a running version is shown — the agent status
 * line and the deployment pipeline — so the signal reads the same everywhere.
 */
export function FreshnessBadge({
  isLatest,
  latestVersion,
  behindLabel,
  className,
}: {
  isLatest: boolean;
  latestVersion: string;
  /**
   * Override the amber label. Defaults to "vN available", which reads well next to
   * the running version; pass e.g. "Behind" where the badge sits next to the latest
   * version instead (the team rollup), so it isn't "v5" next to "v5 available".
   */
  behindLabel?: string;
  className?: string;
}) {
  return isLatest ? (
    <Badge variant="success" className={className}>
      <Check /> Latest
    </Badge>
  ) : (
    <Badge variant="warning" className={className}>
      <ArrowUp /> {behindLabel ?? `${latestVersion} available`}
    </Badge>
  );
}
