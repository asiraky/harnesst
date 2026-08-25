/**
 * Pure workspace-role predicates. Kept dependency-free so both the Better Auth instance
 * (auth.server) and the modules that call it can share them without an import cycle.
 */
function hasRole(role: string, ...names: string[]): boolean {
  return role.split(",").some((part) => names.includes(part.trim()));
}

/**
 * Workspace-level powers. `owner` and `admin` manage people, invitations, workspace settings,
 * GitHub installations and create repos. Only `owner` implicitly reaches every repo — an admin
 * sees a repo only when granted it (project-access.server), which is what lets a workspace hold
 * repos its own admins must not see. Better Auth stores multi-role grants comma-separated.
 */
export function isWorkspaceAdmin(role: string): boolean {
  return hasRole(role, "owner", "admin");
}

export function isWorkspaceOwner(role: string): boolean {
  return hasRole(role, "owner");
}
