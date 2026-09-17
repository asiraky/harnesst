/**
 * "Back" from Settings. Settings is not a third surface: it borrows the sidebar of whichever
 * surface you were on, swaps the body for its own sections, and its Back row returns you to
 * the exact page you left — Chat or Build. The last non-settings location lives in a
 * module-level variable (not React state, not storage): the sidebar's Back row and the
 * Escape shortcut mount in different subtrees and must agree, and a fresh tab opened straight
 * on a settings URL has nowhere to go back to but Build's root.
 */
import { SURFACE_LABEL, SURFACE_ROOT, surfaceOf, type Surface } from "~/lib/surfaces";

export function isSettingsPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

export interface BackTarget {
  href: string;
  surface: Surface;
  label: string;
}

/** Where Back goes given the last workspace location (null: nothing visited yet). */
export function backTarget(lastWorkspacePath: string | null): BackTarget {
  const href = lastWorkspacePath ?? SURFACE_ROOT.build;
  const surface = surfaceOf(href);
  return { href, surface, label: `Back to ${SURFACE_LABEL[surface]}` };
}

let lastWorkspacePath: string | null = null;

/** Record a location as the last one outside Settings; settings URLs are ignored. */
export function rememberWorkspacePath(pathname: string, search: string): void {
  if (isSettingsPath(pathname)) return;
  lastWorkspacePath = `${pathname}${search}`;
}

export function lastWorkspaceLocation(): string | null {
  return lastWorkspacePath;
}

/** Test seam. */
export function resetWorkspaceLocation(): void {
  lastWorkspacePath = null;
}
