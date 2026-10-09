import { describe, it, expect, vi } from "vitest";
import {
  SupabaseManagement,
  refFromUrl,
  validatePublishableKey,
} from "../../app/marketplace/supabase-provisioning.server";

describe("Supabase installation API boundary", () => {
  it("accepts empty successful responses from secret creation", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    await expect(new SupabaseManagement("admin", request).call("projects/abcdefghijklmnopqrst/secrets", [{name:"EXAMPLE",value:"value"}])).resolves.toBeNull();
  });
  it("rejects privileged legacy and modern keys while accepting runtime keys", () => {
    const jwt = (role: string) =>
      "header." +
      Buffer.from(JSON.stringify({ role })).toString("base64url") +
      ".signature";
    expect(() => validatePublishableKey(jwt("service_role"))).toThrow();
    expect(() => validatePublishableKey("sb_secret_private")).toThrow();
    expect(() => validatePublishableKey("garbage")).toThrow();
    expect(() => validatePublishableKey(jwt("anon"))).not.toThrow();
    expect(() => validatePublishableKey("sb_publishable_public")).not.toThrow();
  });
  it("rejects alternate hosts and URL credentials before using project credentials", () => {
    for (const url of [
      "http://abcdefghijklmnopqrst.supabase.co",
      "https://example.com",
      "https://abcdefghijklmnopqrst.supabase.co.evil.com",
      "https://user@abcdefghijklmnopqrst.supabase.co",
      "https://abcdefghijklmnopqrst.supabase.co/path",
    ])
      expect(() => refFromUrl(url)).toThrow();
    expect(refFromUrl("https://abcdefghijklmnopqrst.supabase.co")).toBe(
      "abcdefghijklmnopqrst",
    );
  });
  it("does not leak upstream SQL errors into UI errors", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ message: "SQL contained SECRET_ACTOR_KEY" }),
          { status: 403 },
        ),
      );
    await expect(
      new SupabaseManagement("admin", request).query(
        "abcdefghijklmnopqrst",
        "select secret",
      ),
    ).rejects.toThrow("HTTP 403");
    await expect(
      new SupabaseManagement("admin", request).query(
        "abcdefghijklmnopqrst",
        "select secret",
      ),
    ).rejects.not.toThrow("SECRET_ACTOR_KEY");
  });
  it("returns the selected project data on successful authorization", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        Response.json([{ id: "abcdefghijklmnopqrst", name: "Team" }]),
      );
    expect(
      await new SupabaseManagement("admin", request).call("projects"),
    ).toEqual([{ id: "abcdefghijklmnopqrst", name: "Team" }]);
  });
});
