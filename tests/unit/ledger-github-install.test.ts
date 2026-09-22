import { afterEach, describe, expect, it, vi } from "vitest";
import sodium from "libsodium-wrappers";
vi.mock("~/marketplace/provisioning.server", () => ({
  getProvisioning: async () => ({
    status: "ready",
    projectRef: "abcdefghijklmnopqrst",
  }),
  privateState: () => ({
    members: { infra: "infra" },
    publishableKey: "public-key",
    actors: { github: { actorKey: "system-only-key" } },
  }),
}));
vi.mock("~/db/queries.server", () => ({
  listAgents: async () => [{ id: "infra-id", name: "infra" }],
}));
vi.mock("~/seams/index.server", () => ({
  getRuntime: () => ({
    secrets: {
      resolve: async () => ({
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "private-key",
      }),
    },
  }),
}));
vi.mock("~/github/app-manifest.server", () => ({
  createAppJwt: () => "signed-app-jwt",
}));
import { installLedgerGitHub } from "../../app/marketplace/ledger-github.server";
afterEach(() => vi.unstubAllGlobals());
describe("GitHub ledger installation", () => {
  it("encrypts the system identity for GitHub and enables automation only after files are installed", async () => {
    await sodium.ready;
    const pair = sodium.crypto_box_keypair();
    const written: { path: string; body: any }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        const path = new URL(url).pathname;
        const method = init.method;
        const body = init.body ? JSON.parse(init.body) : null;
        if (method !== "GET") written.push({ path, body });
        if (path.endsWith("/installation")) return Response.json({ id: 7 });
        if (path.endsWith("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (path === "/repos/org/product")
          return Response.json({ default_branch: "main" });
        if (path.includes("/contents/") && method === "GET")
          return new Response("", { status: 404 });
        if (path.endsWith("/public-key"))
          return Response.json({
            key_id: "key-id",
            key: sodium.to_base64(
              pair.publicKey,
              sodium.base64_variants.ORIGINAL,
            ),
          });
        if (path.endsWith("/LEDGER_ENABLED") && method === "GET")
          return new Response("", { status: 404 });
        return new Response(null, { status: 204 });
      }),
    );
    await installLedgerGitHub("team", "org/product");
    const secret = written.find((x) =>
      x.path.endsWith("/secrets/LEDGER_ACTOR_KEY"),
    )!;
    const plaintext = sodium.to_string(
      sodium.crypto_box_seal_open(
        sodium.from_base64(
          secret.body.encrypted_value,
          sodium.base64_variants.ORIGINAL,
        ),
        pair.publicKey,
        pair.privateKey,
      ),
    );
    expect(plaintext).toBe("system-only-key");
    expect(JSON.stringify(written)).not.toContain("system-only-key");
    expect(written.at(-1)?.body.value).toBe("true");
    expect(written.filter((x) => x.path.includes("/contents/"))).toHaveLength(
      2,
    );
  });
  it("does not change repository credentials or files when an existing file conflicts", async () => {
    const mutations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/installation")) return Response.json({ id: 7 });
        if (path.endsWith("/access_tokens"))
          return Response.json({ token: "token" });
        if (init.method !== "GET") mutations.push(path);
        if (path === "/repos/org/product")
          return Response.json({ default_branch: "main" });
        return Response.json({
          content: Buffer.from("unrelated existing script").toString("base64"),
        });
      }),
    );
    await expect(installLedgerGitHub("team", "org/product")).rejects.toThrow(
      "different content",
    );
    expect(mutations).toEqual([]);
  });
});
