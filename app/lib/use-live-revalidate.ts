import { useEffect } from "react";
import { useRevalidator } from "react-router";

interface LiveRevalidateOptions {
  /**
   * Poll at the faster `activeIntervalMs` cadence while something is known to be
   * in-flight (e.g. a deploy is pending/building in the loader data). The baseline
   * poll still runs when this is false, so the transition into an in-flight state
   * is picked up on its own.
   */
  active?: boolean;
  /** Cadence while `active` (default 3s — matches the deploy pipeline's steps). */
  activeIntervalMs?: number;
  /** Baseline cadence while idle (default 10s — catches externally-started work). */
  idleIntervalMs?: number;
}

/**
 * Revalidate the current route's loader on an interval so screens that display
 * live status (deploys, environments, versions) stay fresh without a manual
 * browser refresh.
 *
 * Crucially the baseline poll is NOT gated on the initial in-flight state: a
 * deploy that STARTS after the page has loaded — a publish, a teammate's
 * deploy, a Discord/GitHub-triggered one — is still picked up, and the in-flight
 * state clearing at the tail end can't be missed either (issue #41). Pass
 * `active` to speed the cadence up while a deploy is known to be in progress.
 *
 * Polling pauses while the tab is hidden, since a background tab can't show the
 * update anyway — it revalidates once on the next tick after it regains focus.
 */
export function useLiveRevalidate({
  active = false,
  activeIntervalMs = 3000,
  idleIntervalMs = 10000,
}: LiveRevalidateOptions = {}) {
  const revalidator = useRevalidator();
  useEffect(() => {
    const intervalMs = active ? activeIntervalMs : idleIntervalMs;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (revalidator.state === "idle") revalidator.revalidate();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, activeIntervalMs, idleIntervalMs, revalidator]);
}
