export const MODEL_RESET_TASK_LABEL = "Resetting model inheritance";

/** Restore relevant reset progress after navigation without borrowing another member's task. */
export function selectResetTask<
  T extends { label: string; originUrl: string; createdAt: string },
>(tasks: T[], pathname: string, teamSettingsPath: string): T | undefined {
  return tasks
    .filter(
      (task) =>
        task.label === MODEL_RESET_TASK_LABEL &&
        (task.originUrl === pathname || task.originUrl === teamSettingsPath),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
}
