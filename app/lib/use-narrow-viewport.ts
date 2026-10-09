import { useSyncExternalStore } from "react";

/** Below Tailwind's `md` breakpoint — where the sidebars become drawers or full-page panes. */
const NARROW_QUERY = "(max-width: 767.98px)";

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(NARROW_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/**
 * True on phone-width viewports. The server snapshot is `false` (desktop), so only read it for
 * UI that never renders during SSR — e.g. the contents of a closed popover.
 */
export function useNarrowViewport(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}
