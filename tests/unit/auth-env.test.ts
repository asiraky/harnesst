import { describe, expect, it } from "vitest";

import { assertProductionAuthEnvironment } from "~/lib/auth-env.server";

const validProductionEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: "0123456789abcdefghijklmnopqrstuv",
  BETTER_AUTH_URL: "https://harnesst.example.com",
  POSTMARK_SERVER_TOKEN: "postmark-token",
  FROM_EMAIL: "harnesst <noreply@example.com>",
};

describe("production auth and email environment", () => {
  it("accepts a complete production configuration", () => {
    expect(() =>
      assertProductionAuthEnvironment(validProductionEnvironment),
    ).not.toThrow();

    expect(() =>
      assertProductionAuthEnvironment({
        ...validProductionEnvironment,
        FROM_EMAIL: "noreply@example.com",
      }),
    ).not.toThrow();
  });

  it("requires at least 32 JavaScript characters", () => {
    expect(() =>
      assertProductionAuthEnvironment({
        ...validProductionEnvironment,
        BETTER_AUTH_SECRET: "🔐".repeat(8),
      }),
    ).toThrow("BETTER_AUTH_SECRET must be at least 32 characters");
  });

  it.each(["a".repeat(128), "🔐".repeat(32)])(
    "rejects a long but repetitive auth secret",
    (secret) => {
      expect(() =>
        assertProductionAuthEnvironment({
          ...validProductionEnvironment,
          BETTER_AUTH_SECRET: secret,
        }),
      ).toThrow("at least 120 bits of estimated entropy");
    },
  );

  it("enforces the entropy floor independently of length", () => {
    expect(() =>
      assertProductionAuthEnvironment({
        ...validProductionEnvironment,
        BETTER_AUTH_SECRET: "abcdefghi".repeat(4),
      }),
    ).toThrow("at least 120 bits of estimated entropy");
  });

  it.each([
    "http://harnesst.example.com",
    "https://user:password@harnesst.example.com",
    "https://@harnesst.example.com",
    "https://harnesst.example.com/auth",
    "https://harnesst.example.com/.",
    "https://harnesst.example.com?source=test",
    "https://harnesst.example.com#auth",
    "/relative",
  ])("rejects a non-origin BETTER_AUTH_URL: %s", (betterAuthUrl) => {
    expect(() =>
      assertProductionAuthEnvironment({
        ...validProductionEnvironment,
        BETTER_AUTH_URL: betterAuthUrl,
      }),
    ).toThrow("BETTER_AUTH_URL must be an absolute HTTPS origin");
  });

  it.each([
    "noreply",
    "noreply@",
    "@example.com",
    "harnesst <noreply>",
    "harnesst <no..reply@example.com>",
    "harnesst <noreply@example..com>",
    "harnesst <noreply@-example.com>",
    "harnesst <noreply@example.com>, Other <other@example.com>",
  ])("rejects an implausible FROM_EMAIL: %s", (fromEmail) => {
    expect(() =>
      assertProductionAuthEnvironment({
        ...validProductionEnvironment,
        FROM_EMAIL: fromEmail,
      }),
    ).toThrow("FROM_EMAIL must be a mailbox");
  });

  it("accepts a valid optional MARKETING_HOST and no MARKETING_HOST at all", () => {
    expect(() =>
      assertProductionAuthEnvironment({
        ...validProductionEnvironment,
        MARKETING_HOST: "www.harnesst.example.com",
      }),
    ).not.toThrow();
    expect(() =>
      assertProductionAuthEnvironment({
        ...validProductionEnvironment,
        MARKETING_HOST: "  ",
      }),
    ).not.toThrow();
  });

  it.each([
    "https://www.harnesst.example.com",
    "www.harnesst.example.com/landing",
    "www.harnesst.example.com:443",
    "user@www.harnesst.example.com",
    "-bad-.example.com",
  ])("rejects a non-bare-host MARKETING_HOST: %s", (marketingHost) => {
    expect(() =>
      assertProductionAuthEnvironment({
        ...validProductionEnvironment,
        MARKETING_HOST: marketingHost,
      }),
    ).toThrow("MARKETING_HOST must be a bare host");
  });

  it("rejects a MARKETING_HOST equal to the app host (redirects would loop)", () => {
    expect(() =>
      assertProductionAuthEnvironment({
        ...validProductionEnvironment,
        MARKETING_HOST: "harnesst.example.com",
      }),
    ).toThrow("MARKETING_HOST must differ from the BETTER_AUTH_URL host");
  });

  it("accepts a valid optional PREVIEW_ORIGIN and no PREVIEW_ORIGIN at all", () => {
    expect(() =>
      assertProductionAuthEnvironment({
        ...validProductionEnvironment,
        PREVIEW_ORIGIN: "https://preview.harnesst.example.com",
      }),
    ).not.toThrow();
    expect(() =>
      assertProductionAuthEnvironment({
        ...validProductionEnvironment,
        PREVIEW_ORIGIN: "  ",
      }),
    ).not.toThrow();
  });

  it.each([
    "preview.harnesst.example.com",
    "http://preview.harnesst.example.com",
    "https://preview.harnesst.example.com/previews",
    "https://user:pw@preview.harnesst.example.com",
  ])("rejects a PREVIEW_ORIGIN that is not a bare HTTPS origin: %s", (origin) => {
    expect(() =>
      assertProductionAuthEnvironment({
        ...validProductionEnvironment,
        PREVIEW_ORIGIN: origin,
      }),
    ).toThrow("PREVIEW_ORIGIN must be an absolute HTTPS origin");
  });

  it.each([
    // The same origin outright: there would be no sandbox at all.
    "https://harnesst.example.com/",
    // A different origin, but the same host on another port — cookies ignore ports, so the session
    // cookie would still reach the "sandbox".
    "https://harnesst.example.com:8443",
  ])("rejects a PREVIEW_ORIGIN on the app's own host: %s", (origin) => {
    expect(() =>
      assertProductionAuthEnvironment({
        ...validProductionEnvironment,
        PREVIEW_ORIGIN: origin,
      }),
    ).toThrow("PREVIEW_ORIGIN must be a different host from BETTER_AUTH_URL");
  });

  it("reports every missing production value without exposing values", () => {
    expect(() =>
      assertProductionAuthEnvironment({ NODE_ENV: "production" }),
    ).toThrowError(
      /BETTER_AUTH_SECRET[\s\S]*BETTER_AUTH_URL[\s\S]*POSTMARK_SERVER_TOKEN[\s\S]*FROM_EMAIL/,
    );
  });

  it("does not enforce production providers in development or test", () => {
    expect(() =>
      assertProductionAuthEnvironment({ NODE_ENV: "development" }),
    ).not.toThrow();
    expect(() =>
      assertProductionAuthEnvironment({ NODE_ENV: "test" }),
    ).not.toThrow();
  });
});
