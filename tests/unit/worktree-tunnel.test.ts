import { describe, expect, test } from "vitest";

import {
  cloudflaredEnvironment,
  deriveTunnelHost,
  enrichPortEntry,
  generateTunnelShortId,
  parseQuickTunnelUrl,
  renderTunnelConfig,
  resolveTunnelDomain,
  sanitizeDnsLabel,
} from "../../scripts/worktree-tunnel.mjs";

const metadata = {
  tunnelId: "11111111-2222-3333-4444-555555555555",
  tunnelName: "harnesst-dev",
  credentialsFile: "/tmp/cloudflared/credentials.json",
  domain: "dev.zero8.ai",
};

describe("worktree tunnel identity", () => {
  test("generates lowercase cryptographic-id-shaped values", () => {
    const values = new Set(
      Array.from({ length: 64 }, () => generateTunnelShortId()),
    );
    expect(values.size).toBe(64);
    for (const value of values) expect(value).toMatch(/^[a-f0-9]{8}$/);
  });

  test("adds an identity once and preserves it", () => {
    const legacy = { dev: 5273, splitter: 8887, instance: 3100 };
    const enriched = enrichPortEntry(legacy, "Issue 46 / Tunnel!");
    expect(enriched.tunnelHost).toBe(
      `issue-46-tunnel-${enriched.tunnelShortId}.dev.zero8.ai`,
    );
    expect(enrichPortEntry(enriched, "renamed")).toBe(enriched);
    expect(enriched).toMatchObject(legacy);
  });

  test("sanitizes and bounds the DNS label", () => {
    expect(sanitizeDnsLabel("---Hello, Wörld___Again---")).toBe(
      "hello-w-rld-again",
    );
    const host = deriveTunnelHost("x".repeat(200), "abcdef12");
    expect(host.split(".")[0]).toHaveLength(63);
    expect(host).toMatch(/^x+-abcdef12\.dev\.zero8\.ai$/);
  });

  test("resolves domain from metadata, environment, then default", () => {
    expect(
      resolveTunnelDomain(
        { domain: "dev.persisted.example" },
        { HARNESST_TUNNEL_DOMAIN: "dev.environment.example" },
      ),
    ).toBe("dev.persisted.example");
    expect(
      resolveTunnelDomain(null, {
        HARNESST_TUNNEL_DOMAIN: "dev.environment.example",
      }),
    ).toBe("dev.environment.example");
    expect(resolveTunnelDomain(null, {})).toBe("dev.zero8.ai");
  });

  test("rejects an invalid persisted domain with a clear source", () => {
    expect(() =>
      resolveTunnelDomain({ domain: "https://not-a-domain.example" }, {}),
    ).toThrow(/invalid domain from persisted tunnel metadata/);
    expect(() => resolveTunnelDomain({ domain: "" }, {})).toThrow(
      /invalid domain from persisted tunnel metadata/,
    );
  });
});

describe("Cloudflare config rendering", () => {
  test("is deterministic, sorted, and ends with the required 404 rule", () => {
    const registry = {
      z: {
        dev: 5274,
        splitter: 8888,
        instance: 3200,
        tunnelHost: "z-abcdef12.dev.zero8.ai",
      },
      a: {
        dev: 5273,
        splitter: 8887,
        instance: 3100,
        tunnelHost: "a-abcdef12.dev.zero8.ai",
      },
    };
    const config = renderTunnelConfig(metadata, registry);
    expect(config.indexOf("a-abcdef12")).toBeLessThan(
      config.indexOf("z-abcdef12"),
    );
    expect(config).toContain('service: "http://localhost:5273"');
    expect(config).toContain('service: "http://localhost:5274"');
    expect(config.trimEnd().endsWith("- service: http_status:404")).toBe(true);
    expect(renderTunnelConfig(metadata, { a: registry.a, z: registry.z })).toBe(
      config,
    );
  });

  test("rejects duplicate and unsafe hosts", () => {
    const entry = {
      dev: 5273,
      splitter: 8887,
      instance: 3100,
      tunnelHost: "same-abcdef12.dev.zero8.ai",
    };
    expect(() =>
      renderTunnelConfig(metadata, { a: entry, b: { ...entry, dev: 5274 } }),
    ).toThrow(/duplicate/);
    expect(() =>
      renderTunnelConfig(metadata, {
        bad: { ...entry, tunnelHost: "bad/host" },
      }),
    ).toThrow(/invalid/);
  });

  test("regenerating after teardown removes the host and keeps the 404 fallback", () => {
    const removed = {
      dev: 5273,
      splitter: 8887,
      instance: 3100,
      tunnelHost: "removed-abcdef12.dev.zero8.ai",
    };
    expect(renderTunnelConfig(metadata, { removed })).toContain(
      removed.tunnelHost,
    );
    const regenerated = renderTunnelConfig(metadata, {});
    expect(regenerated).not.toContain(removed.tunnelHost);
    expect(regenerated.trimEnd().endsWith("- service: http_status:404")).toBe(
      true,
    );
  });
});

describe("quick tunnel URL parsing", () => {
  test("extracts a realistic URL from mixed stdout/stderr", () => {
    expect(
      parseQuickTunnelUrl(
        "2026-07-10 INF Requesting new quick Tunnel\nYour quick Tunnel has been created! Visit it at https://Silver-Bird-42.trycloudflare.com\n",
      ),
    ).toBe("https://silver-bird-42.trycloudflare.com");
  });

  test("rejects absent and unsafe URLs", () => {
    expect(() => parseQuickTunnelUrl("connected, but URL pending")).toThrow();
    expect(() =>
      parseQuickTunnelUrl(
        "http://plain.trycloudflare.com https://trycloudflare.com.evil.test",
      ),
    ).toThrow();
  });
});

describe("subprocess environment safety", () => {
  test("does not expose app secrets to cloudflared", () => {
    const filtered = cloudflaredEnvironment({
      PATH: "/bin",
      HOME: "/tmp/home",
      BETTER_AUTH_SECRET: "secret",
      SMTP_URL: "smtps://user:password@smtp.example.com",
      DATABASE_URL: "postgres://secret",
      TUNNEL_ORIGIN_CERT: "/tmp/cert.pem",
    });
    expect(filtered).toEqual({
      PATH: "/bin",
      HOME: "/tmp/home",
      TUNNEL_ORIGIN_CERT: "/tmp/cert.pem",
    });
  });
});
