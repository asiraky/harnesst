/**
 * Which workspace connection a team's provisioner uses. Pure: Setup renders the result, and the
 * server resolves the same way before every install or upgrade.
 *
 * A team links one connection explicitly. Until it does, a workspace with exactly one connection
 * for the provider uses that one (and the link is saved on first use); with several, the user
 * chooses. A linked connection that is expired or invalid, or the only candidate being so, needs
 * reconnecting in Settings before anything can run.
 */
import type { ServiceConnectionStatus } from "~/service-connections/providers";

export interface LinkOption {
  id: string;
  label: string;
  status: ServiceConnectionStatus;
}

export type ConnectionLink =
  /** No connection for this provider in the workspace. */
  | { state: "none" }
  /** Several connections, none linked. */
  | { state: "choose"; options: LinkOption[] }
  /** Usable. `linked` is false when auto-selected and not yet saved on the team. */
  | { state: "ready"; connection: LinkOption; linked: boolean }
  /** The connection that would be used is expired or invalid. */
  | { state: "reconnect"; connection: LinkOption };

export function resolveConnectionLink(
  linkedId: string | null,
  options: LinkOption[],
): ConnectionLink {
  const linked = linkedId ? options.find((o) => o.id === linkedId) : undefined;
  if (linked)
    return linked.status === "active"
      ? { state: "ready", connection: linked, linked: true }
      : { state: "reconnect", connection: linked };
  // A link to a connection outside this list (another workspace's, or a stale id) is ignored.
  if (options.length === 0) return { state: "none" };
  if (options.length === 1)
    return options[0].status === "active"
      ? { state: "ready", connection: options[0], linked: false }
      : { state: "reconnect", connection: options[0] };
  return { state: "choose", options };
}
