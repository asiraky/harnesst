import { describe, expect, it } from "vitest";

import { agentGitHubAppSettingsUrl } from "~/github/agent-apps.server";

describe("agentGitHubAppSettingsUrl", () => {
  it("links organization-owned Apps to organization settings", () => {
    expect(
      agentGitHubAppSettingsUrl({
        slug: "sam-harnesst",
        ownerLogin: "worksauceapp",
        ownerType: "Organization",
      }),
    ).toBe(
      "https://github.com/organizations/worksauceapp/settings/apps/sam-harnesst",
    );
  });

  it("links user-owned Apps to user settings and old unknown owners to the public page", () => {
    expect(
      agentGitHubAppSettingsUrl({
        slug: "personal-app",
        ownerLogin: "sam",
        ownerType: "User",
      }),
    ).toBe("https://github.com/settings/apps/personal-app");
    expect(
      agentGitHubAppSettingsUrl({
        slug: "legacy-app",
        ownerLogin: null,
        ownerType: null,
      }),
    ).toBe("https://github.com/apps/legacy-app");
  });
});
