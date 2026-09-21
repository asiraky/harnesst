import { describe, expect, it } from "vitest";
import {
  MODEL_RESET_TASK_LABEL,
  selectResetTask,
} from "~/models/reset-progress";
const task = (
  id: string,
  originUrl: string,
  createdAt: string,
  label = MODEL_RESET_TASK_LABEL,
) => ({ id, originUrl, createdAt, label });
describe("reset progress after navigation", () => {
  it("restores a team's latest reset on a member page without borrowing a sibling's or ordinary publish", () => {
    const team = task("team", "/repos/p/settings", "2026-09-19T03:00:00Z");
    const items = [
      task("own", "/repos/p/agents/a/settings", "2026-09-19T02:00:00Z"),
      team,
      task("sibling", "/repos/p/agents/b/settings", "2026-09-19T04:00:00Z"),
      task(
        "ordinary",
        "/repos/p/settings",
        "2026-09-19T05:00:00Z",
        "Publishing changes",
      ),
    ];
    expect(
      selectResetTask(items, "/repos/p/agents/a/settings", "/repos/p/settings"),
    ).toBe(team);
  });
  it("uses a newer member reset instead of the previous team reset", () => {
    const own = task(
      "own",
      "/repos/p/agents/a/settings",
      "2026-09-19T04:00:00Z",
    );
    expect(
      selectResetTask(
        [own, task("team", "/repos/p/settings", "2026-09-19T03:00:00Z")],
        own.originUrl,
        "/repos/p/settings",
      ),
    ).toBe(own);
  });
  it("does not restore a member-only reset on the team page", () => {
    expect(
      selectResetTask(
        [task("own", "/repos/p/agents/a/settings", "2026-09-19T04:00:00Z")],
        "/repos/p/settings",
        "/repos/p/settings",
      ),
    ).toBeUndefined();
  });
});
