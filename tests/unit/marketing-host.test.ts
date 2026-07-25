/**
 * Host split helpers (app/lib/marketing-host.server.ts, FOH D11): env parsing, host
 * matching (forwarded Host semantics — the request URL's host is what nginx/dev give us),
 * origin derivation, and the full redirect matrix the root middleware applies. All reads
 * happen at call time, so plain env mutation per test is enough — no module resets.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appOrigin,
  isMarketingHost,
  isMarketingPath,
  marketingHost,
  marketingHostRedirect,
  marketingOrigin,
} from "~/lib/marketing-host.server";

const SAVED = {
  MARKETING_HOST: process.env.MARKETING_HOST,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
};

function setEnv(name: keyof typeof SAVED, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  setEnv("MARKETING_HOST", undefined);
  setEnv("BETTER_AUTH_URL", "https://harnesst.example.com");
});

afterEach(() => {
  setEnv("MARKETING_HOST", SAVED.MARKETING_HOST);
  setEnv("BETTER_AUTH_URL", SAVED.BETTER_AUTH_URL);
});

function get(url: string, method = "GET") {
  return new Request(url, { method });
}

function location(response: Response | null): string | null {
  return response?.headers.get("location") ?? null;
}

describe("marketingHost", () => {
  it("is null when unset or blank (self-host default)", () => {
    expect(marketingHost()).toBeNull();
    setEnv("MARKETING_HOST", "   ");
    expect(marketingHost()).toBeNull();
  });

  it("normalizes to a lowercased bare host", () => {
    setEnv("MARKETING_HOST", "  WWW.harnesst.Example.com ");
    expect(marketingHost()).toBe("www.harnesst.example.com");
  });

  it("rejects values with a scheme, path, credentials, or whitespace", () => {
    for (const bad of [
      "https://www.harnesst.example.com",
      "www.harnesst.example.com/landing",
      "user@www.harnesst.example.com",
      "www harnesst",
    ]) {
      setEnv("MARKETING_HOST", bad);
      expect(marketingHost()).toBeNull();
    }
  });

  it("treats a marketing host equal to the app host as unset (loop guard)", () => {
    setEnv("MARKETING_HOST", "harnesst.example.com");
    expect(marketingHost()).toBeNull();
    // With a port in BETTER_AUTH_URL, both the host and hostname forms are refused.
    setEnv("BETTER_AUTH_URL", "http://localhost:5284");
    setEnv("MARKETING_HOST", "localhost:5284");
    expect(marketingHost()).toBeNull();
    setEnv("MARKETING_HOST", "localhost");
    expect(marketingHost()).toBeNull();
  });
});

describe("appOrigin", () => {
  it("derives the origin from BETTER_AUTH_URL (tolerating trailing slash)", () => {
    setEnv("BETTER_AUTH_URL", "https://harnesst.example.com/");
    expect(appOrigin()).toBe("https://harnesst.example.com");
    setEnv("BETTER_AUTH_URL", "http://localhost:5284");
    expect(appOrigin()).toBe("http://localhost:5284");
  });

  it("is null when unset or unparsable", () => {
    setEnv("BETTER_AUTH_URL", undefined);
    expect(appOrigin()).toBeNull();
    setEnv("BETTER_AUTH_URL", "not a url");
    expect(appOrigin()).toBeNull();
  });
});

describe("marketingOrigin", () => {
  it("uses the app origin's scheme, https in prod", () => {
    setEnv("MARKETING_HOST", "www.harnesst.example.com");
    expect(marketingOrigin()).toBe("https://www.harnesst.example.com");
  });

  it("inherits the app origin's port for a port-less dev host", () => {
    setEnv("BETTER_AUTH_URL", "http://localhost:5284");
    setEnv("MARKETING_HOST", "marketing.localhost");
    expect(marketingOrigin()).toBe("http://marketing.localhost:5284");
  });

  it("keeps an explicit port on MARKETING_HOST as-is", () => {
    setEnv("BETTER_AUTH_URL", "http://localhost:5284");
    setEnv("MARKETING_HOST", "marketing.localhost:8080");
    expect(marketingOrigin()).toBe("http://marketing.localhost:8080");
  });

  it("is null when no marketing host is configured", () => {
    expect(marketingOrigin()).toBeNull();
  });
});

describe("isMarketingHost", () => {
  it("is always false when unset", () => {
    expect(isMarketingHost(get("https://www.harnesst.example.com/"))).toBe(false);
  });

  it("matches the forwarded host on any port when MARKETING_HOST has none", () => {
    setEnv("MARKETING_HOST", "marketing.localhost");
    setEnv("BETTER_AUTH_URL", "http://localhost:5284");
    expect(isMarketingHost(get("http://marketing.localhost:5284/"))).toBe(true);
    expect(isMarketingHost(get("http://marketing.localhost/"))).toBe(true);
    expect(isMarketingHost(get("http://localhost:5284/"))).toBe(false);
  });

  it("matches host:port exactly when MARKETING_HOST carries a port", () => {
    setEnv("BETTER_AUTH_URL", "http://localhost:5284");
    setEnv("MARKETING_HOST", "marketing.localhost:8080");
    expect(isMarketingHost(get("http://marketing.localhost:8080/x"))).toBe(
      true,
    );
    expect(isMarketingHost(get("http://marketing.localhost:9999/x"))).toBe(
      false,
    );
  });
});

describe("isMarketingPath", () => {
  it("covers the landing, case studies, sitemap, and robots", () => {
    expect(isMarketingPath("/")).toBe(true);
    expect(isMarketingPath("/case-studies")).toBe(true);
    expect(isMarketingPath("/case-studies/agency")).toBe(true);
    expect(isMarketingPath("/sitemap.xml")).toBe(true);
    expect(isMarketingPath("/robots.txt")).toBe(true);
    expect(isMarketingPath("/login")).toBe(false);
    expect(isMarketingPath("/t/proj/agent")).toBe(false);
    expect(isMarketingPath("/case-studiesX")).toBe(false);
  });
});

describe("marketingHostRedirect", () => {
  it("is a no-op everywhere when MARKETING_HOST is unset (self-host)", () => {
    expect(marketingHostRedirect(get("https://harnesst.example.com/"))).toBeNull();
    expect(
      marketingHostRedirect(get("https://harnesst.example.com/case-studies")),
    ).toBeNull();
    expect(
      marketingHostRedirect(get("https://harnesst.example.com/sitemap.xml")),
    ).toBeNull();
  });

  describe("with a marketing host configured", () => {
    beforeEach(() => {
      setEnv("MARKETING_HOST", "www.harnesst.example.com");
    });

    it("serves marketing paths on the marketing host", () => {
      for (const path of [
        "/",
        "/case-studies",
        "/case-studies/agency",
        "/sitemap.xml",
        "/robots.txt",
      ]) {
        expect(
          marketingHostRedirect(get(`https://www.harnesst.example.com${path}`)),
        ).toBeNull();
      }
    });

    it("bounces every other GET on the marketing host to the app origin, preserving path + query", () => {
      const res = marketingHostRedirect(
        get("https://www.harnesst.example.com/login?returnTo=%2F"),
      );
      expect(res?.status).toBe(302);
      expect(location(res)).toBe(
        "https://harnesst.example.com/login?returnTo=%2F",
      );
      expect(
        location(
          marketingHostRedirect(
            get("https://www.harnesst.example.com/t/proj/agent"),
          ),
        ),
      ).toBe("https://harnesst.example.com/t/proj/agent");
      expect(
        location(
          marketingHostRedirect(get("https://www.harnesst.example.com/repos/p1")),
        ),
      ).toBe("https://harnesst.example.com/repos/p1");
    });

    it("bounces marketing-only paths on the app host to the marketing origin", () => {
      expect(
        location(
          marketingHostRedirect(get("https://harnesst.example.com/case-studies")),
        ),
      ).toBe("https://www.harnesst.example.com/case-studies");
      expect(
        location(
          marketingHostRedirect(get("https://harnesst.example.com/sitemap.xml")),
        ),
      ).toBe("https://www.harnesst.example.com/sitemap.xml");
    });

    it("leaves `/` and robots.txt alone on the app host (dual/per-host paths)", () => {
      expect(
        marketingHostRedirect(get("https://harnesst.example.com/")),
      ).toBeNull();
      expect(
        marketingHostRedirect(get("https://harnesst.example.com/robots.txt")),
      ).toBeNull();
    });

    it("never redirects mutations (the marketing host stays GET-only by the origin check)", () => {
      expect(
        marketingHostRedirect(
          get("https://www.harnesst.example.com/api/auth/sign-in", "POST"),
        ),
      ).toBeNull();
    });

    it("redirects HEAD like GET", () => {
      expect(
        location(
          marketingHostRedirect(
            get("https://www.harnesst.example.com/dashboard", "HEAD"),
          ),
        ),
      ).toBe("https://harnesst.example.com/dashboard");
    });
  });

  it("works with dev hosts and ports (marketing.localhost pattern)", () => {
    setEnv("BETTER_AUTH_URL", "http://localhost:5284");
    setEnv("MARKETING_HOST", "marketing.localhost");
    expect(
      marketingHostRedirect(get("http://marketing.localhost:5284/")),
    ).toBeNull();
    expect(
      location(marketingHostRedirect(get("http://marketing.localhost:5284/login"))),
    ).toBe("http://localhost:5284/login");
    expect(
      location(
        marketingHostRedirect(get("http://localhost:5284/case-studies")),
      ),
    ).toBe("http://marketing.localhost:5284/case-studies");
  });
});
