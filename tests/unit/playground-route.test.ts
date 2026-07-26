import { describe, expect, it } from "vitest";

import { newPlaygroundSessionPath } from "~/playground/url";

describe("newPlaygroundSessionPath", () => {
  it("removes React Router data request details from the redirect target", () => {
    const url = new URL(
      "https://harnesst.test/repos/proj_1/playground.data?_routes=root&index&deployment=dep_1&session=old",
    );

    expect(newPlaygroundSessionPath(url, "sess_new")).toBe(
      "/repos/proj_1/playground?deployment=dep_1&session=sess_new",
    );
  });

  it("preserves team member playground paths", () => {
    const url = new URL(
      "https://harnesst.test/repos/proj_1/agents/deployer/playground/_.data?deployment=dep_2",
    );

    expect(newPlaygroundSessionPath(url, "sess_new")).toBe(
      "/repos/proj_1/agents/deployer/playground?deployment=dep_2&session=sess_new",
    );
  });
});
