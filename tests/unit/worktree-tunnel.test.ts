import { describe, expect, test } from "vitest";

import {
  DEFAULT_TUNNEL_DOMAIN,
  cloudflaredEnvironment,
  deriveTunnelHost,
  enrichPortEntry,
  findWorktreeEntry,
  generateTunnelShortId,
  hostInZone,
  parseOriginCert,
  parseQuickTunnelUrl,
  parseRouteDnsHost,
  rehomeRegistry,
  renderTunnelConfig,
  resolveCloudflaredBin,
  resolveTunnelDomain,
  sanitizeDnsLabel,
} from "../../scripts/worktree-tunnel.mjs";

const metadata = {
  tunnelId: "11111111-2222-3333-4444-555555555555",
  tunnelName: "harnesst-dev",
  credentialsFile: "/tmp/cloudflared/credentials.json",
  domain: "dev.example.test",
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
      `issue-46-tunnel-${enriched.tunnelShortId}.${DEFAULT_TUNNEL_DOMAIN}`,
    );
    expect(enrichPortEntry(enriched, "renamed")).toBe(enriched);
    expect(enriched).toMatchObject(legacy);
  });

  test("sanitizes and bounds the DNS label", () => {
    expect(sanitizeDnsLabel("---Hello, Wörld___Again---")).toBe(
      "hello-w-rld-again",
    );
    const host = deriveTunnelHost("x".repeat(200), "abcdef12", "dev.example");
    expect(host.split(".")[0]).toHaveLength(63);
    expect(host).toMatch(/^x+-abcdef12\.dev\.example$/);
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
    expect(resolveTunnelDomain(null, {})).toBe(DEFAULT_TUNNEL_DOMAIN);
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
        tunnelHost: "z-abcdef12.dev.example.test",
      },
      a: {
        dev: 5273,
        splitter: 8887,
        instance: 3100,
        tunnelHost: "a-abcdef12.dev.example.test",
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
      tunnelHost: "same-abcdef12.dev.example.test",
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
      tunnelHost: "removed-abcdef12.dev.example.test",
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

describe("finding cloudflared", () => {
  test("prefers the explicit override, then PATH, then ~/.local/bin", () => {
    const at = (...present: string[]) => (path: string) =>
      present.includes(path);
    expect(
      resolveCloudflaredBin(
        { HARNESST_CLOUDFLARED_BIN: "/opt/cf", PATH: "/bin" },
        at("/bin/cloudflared"),
      ),
    ).toBe("/opt/cf");
    expect(
      resolveCloudflaredBin(
        { PATH: "/usr/bin:/bin", HOME: "/home/u" },
        at("/bin/cloudflared", "/home/u/.local/bin/cloudflared"),
      ),
    ).toBe("/bin/cloudflared");
    // Non-interactive shells often lack ~/.local/bin on PATH.
    expect(
      resolveCloudflaredBin(
        { PATH: "/usr/bin", HOME: "/home/u" },
        at("/home/u/.local/bin/cloudflared"),
      ),
    ).toBe("/home/u/.local/bin/cloudflared");
    expect(resolveCloudflaredBin({ PATH: "", HOME: "/h" }, at())).toBe(
      "cloudflared",
    );
  });
});

describe("moving hosts onto a new tunnel domain", () => {
  const registry = {
    a: {
      dev: 5273,
      splitter: 8887,
      instance: 3100,
      tunnelShortId: "04290446",
      tunnelHost: "wt-a-04290446.dev.old.example",
    },
    b: {
      dev: 5274,
      splitter: 8888,
      instance: 3200,
      tunnelShortId: "abcdef12",
      tunnelHost: "wt-b-abcdef12.new.example",
    },
    c: { dev: 5275, splitter: 8889, instance: 3300 },
  };

  test("keeps each label and swaps only the domain", () => {
    const moved = rehomeRegistry(registry, "new.example");
    expect(moved.a.tunnelHost).toBe("wt-a-04290446.new.example");
    expect(moved.a.tunnelShortId).toBe("04290446");
    expect(moved.b).toBe(registry.b);
    expect(moved.c).toBe(registry.c);
    expect(registry.a.tunnelHost).toBe("wt-a-04290446.dev.old.example");
  });

  test("returns the same registry when nothing moved", () => {
    const settled = rehomeRegistry(registry, "new.example");
    expect(rehomeRegistry(settled, "new.example")).toBe(settled);
  });

  test("does not treat a domain suffix inside a label as a match", () => {
    const moved = rehomeRegistry(
      { x: { ...registry.b, tunnelHost: "wt-new.example.other" } },
      "example.other",
    );
    expect(moved.x.tunnelHost).toBe("wt-new.example.other");
    const notSuffix = rehomeRegistry(
      { x: { ...registry.b, tunnelHost: "x-abcdef12.notnew.example" } },
      "new.example",
    );
    expect(notSuffix.x.tunnelHost).toBe("x-abcdef12.new.example");
  });

  test("finds this worktree by key, else by its dev port", () => {
    expect(findWorktreeEntry(registry, "b", 1)?.key).toBe("b");
    expect(findWorktreeEntry(registry, "renamed", 5273)?.key).toBe("a");
    expect(findWorktreeEntry(registry, "renamed", 1)).toBeNull();
  });
});

describe("DNS route verification", () => {
  test("reads the routed host from either cloudflared outcome", () => {
    expect(
      parseRouteDnsHost(
        "2026-10-15T01:03:35Z INF wt-a.harnesst.dev is already configured to route to your tunnel tunnelID=x",
      ),
    ).toBe("wt-a.harnesst.dev");
    expect(
      parseRouteDnsHost(
        "INF Added CNAME wt-a.dev.example.test.harnesst.dev which will route to this tunnel tunnelID=x",
      ),
    ).toBe("wt-a.dev.example.test.harnesst.dev");
    expect(parseRouteDnsHost("ERR something else")).toBeNull();
  });

  test("matches hosts to a zone on label boundaries", () => {
    expect(hostInZone("wt.harnesst.dev", "harnesst.dev")).toBe(true);
    expect(hostInZone("WT.Harnesst.dev", "harnesst.dev")).toBe(true);
    expect(hostInZone("wt.notharnesst.dev", "harnesst.dev")).toBe(false);
    expect(hostInZone("wt.dev.example.test", "harnesst.dev")).toBe(false);
  });

  test("decodes the origin cert token and rejects malformed certs", () => {
    const token = { zoneID: "z1", accountID: "a1", apiToken: "t1" };
    const body = Buffer.from(JSON.stringify(token)).toString("base64");
    const pem = `-----BEGIN ARGO TUNNEL TOKEN-----\n${body.slice(0, 10)}\n${body.slice(10)}\n-----END ARGO TUNNEL TOKEN-----\n`;
    expect(parseOriginCert(pem)).toEqual(token);
    expect(parseOriginCert("not a cert")).toBeNull();
    expect(
      parseOriginCert(
        "-----BEGIN ARGO TUNNEL TOKEN-----\nbm90IGpzb24=\n-----END ARGO TUNNEL TOKEN-----",
      ),
    ).toBeNull();
  });
});
