import { describe, expect, it } from "vitest";

import { assertProductionAuthEnvironment } from "~/lib/auth-env.server";

const validProductionEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: "0123456789abcdefghijklmnopqrstuv",
  BETTER_AUTH_URL: "https://eden.example.com",
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
    "http://eden.example.com",
    "https://user:password@eden.example.com",
    "https://@eden.example.com",
    "https://eden.example.com/auth",
    "https://eden.example.com/.",
    "https://eden.example.com?source=test",
    "https://eden.example.com#auth",
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
        MARKETING_HOST: "www.eden.example.com",
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
    "https://www.eden.example.com",
    "www.eden.example.com/landing",
    "www.eden.example.com:443",
    "user@www.eden.example.com",
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
        MARKETING_HOST: "eden.example.com",
      }),
    ).toThrow("MARKETING_HOST must differ from the BETTER_AUTH_URL host");
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
