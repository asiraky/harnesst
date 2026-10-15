import { describe, expect, it, vi } from "vitest";

import { SupabaseRequestError } from "~/marketplace/supabase-provisioning.server";
import {
  ServiceCredentialError,
  serviceProvider,
} from "~/service-connections/providers.server";

const supabase = serviceProvider("supabase");

function api(routes: Record<string, () => Response>) {
  return vi.fn(async (url: string | URL | Request) => {
    const path = String(url).replace("https://api.supabase.com/v1/", "");
    const route = routes[path];
    if (!route) throw new Error(`unexpected ${path}`);
    return route();
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("supabase service provider verify", () => {
  it("accepts a token that can list projects and records org names", async () => {
    const request = api({
      projects: () => json([{ id: "a" }, { id: "b" }]),
      organizations: () => json([{ name: "Acme" }, { name: "" }]),
    });
    await expect(supabase.verify(" sbp_token ", request)).resolves.toEqual({
      metadata: { organizations: ["Acme"], projectCount: 2 },
    });
    const [url, init] = request.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.supabase.com/v1/projects");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sbp_token",
    );
  });

  it("keeps a good token when the organization lookup fails", async () => {
    const request = api({
      projects: () => json([]),
      organizations: () => new Response("", { status: 500 }),
    });
    await expect(supabase.verify("sbp_token", request)).resolves.toEqual({
      metadata: { organizations: [], projectCount: 0 },
    });
  });

  it.each([401, 403])("rejects the token on %i", async (status) => {
    const request = api({ projects: () => new Response("", { status }) });
    await expect(supabase.verify("sbp_bad", request)).rejects.toBeInstanceOf(
      ServiceCredentialError,
    );
  });

  it("rejects an empty token without calling Supabase", async () => {
    const request = vi.fn();
    await expect(supabase.verify("  ", request)).rejects.toBeInstanceOf(
      ServiceCredentialError,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("treats an outage as an error that says nothing about the token", async () => {
    const request = api({ projects: () => new Response("", { status: 503 }) });
    const error = await supabase.verify("sbp_token", request).catch((e) => e);
    expect(error).toBeInstanceOf(SupabaseRequestError);
    expect(error).not.toBeInstanceOf(ServiceCredentialError);
  });

  it("rejects a malformed project list", async () => {
    const request = api({ projects: () => json({ nope: true }) });
    await expect(supabase.verify("sbp_token", request)).rejects.toThrow(
      "invalid project list",
    );
  });
});

describe("supabase unusableStatus", () => {
  it("condemns the token only on 401", () => {
    expect(supabase.unusableStatus(new SupabaseRequestError(401))).toBe(
      "invalid",
    );
    expect(supabase.unusableStatus(new SupabaseRequestError(403))).toBeNull();
    expect(supabase.unusableStatus(new SupabaseRequestError(500))).toBeNull();
    expect(supabase.unusableStatus(new Error("network"))).toBeNull();
  });
});
