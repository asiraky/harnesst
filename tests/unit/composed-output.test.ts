import { describe, expect, it } from "vitest";

import { typecheckComposedProjects } from "../../scripts/typecheck-composed";

describe("composed agent output", () => {
  it("typechecks every catalog entry and generated publish fixture under NodeNext", async () => {
    const fixtureCount = await typecheckComposedProjects();
    expect(fixtureCount).toBeGreaterThan(2);
  }, 60_000);
});
