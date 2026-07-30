/**
 * Artifact preview capabilities (#291). The token IS the authentication on the preview route — no
 * cookie is read there — so everything this file asserts is the boundary itself: a capability works
 * for one artifact, for one viewer, for ten minutes, and for nobody who cannot produce the HMAC.
 *
 * The route still re-runs the per-conversation visibility check per request; what the token decides
 * is which user that check runs AS, which is exactly why forging `userId` has to be impossible.
 */
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_PREVIEW_TTL_MS,
  mintArtifactPreviewToken,
  verifyArtifactPreviewToken,
} from "~/foh/artifact-preview.server";
import { nextPreviewRemintDelayMs } from "~/foh/use-artifact-preview";
import { signState } from "~/lib/signed-state.server";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const NOW = 1_700_000_000_000;

const mint = (over: Partial<Parameters<typeof mintArtifactPreviewToken>[0]> = {}) =>
  mintArtifactPreviewToken(
    {
      artifactId: "art_1",
      versionId: "ver_1",
      projectId: "proj_1",
      userId: "user_1",
      backOfHouse: false,
      now: NOW,
      ...over,
    },
    KEY,
  );

describe("artifact preview tokens", () => {
  it("round-trips the claim the mint was authorized with", () => {
    const { token, expiresAt } = mint({ backOfHouse: true });

    expect(expiresAt).toBe(NOW + ARTIFACT_PREVIEW_TTL_MS);
    expect(verifyArtifactPreviewToken(token, "art_1", KEY, NOW + 1_000)).toEqual({
      projectId: "proj_1",
      userId: "user_1",
      backOfHouse: true,
      versionId: "ver_1",
    });
  });

  it("refuses a token minted for a different artifact", () => {
    // The replay this closes: a page the viewer may see, re-aimed at one they may not.
    const { token } = mint();
    expect(verifyArtifactPreviewToken(token, "art_2", KEY, NOW)).toBeNull();
  });

  it("names the version it was minted for, so a capability cannot follow a republish", () => {
    // The scope is (artifact, version) since #292: the panel mints per selection, and the serving
    // route reads the version off the CLAIM. A v1 capability therefore keeps showing v1 after the
    // agent republishes, and a user parked on an old version cannot be swapped forward silently.
    const first = verifyArtifactPreviewToken(mint().token, "art_1", KEY, NOW);
    const second = verifyArtifactPreviewToken(
      mint({ versionId: "ver_2" }).token,
      "art_1",
      KEY,
      NOW,
    );
    expect(first?.versionId).toBe("ver_1");
    expect(second?.versionId).toBe("ver_2");
  });

  it("reads a token minted before versions existed as 'the newest version'", () => {
    // Ten minutes of in-flight capabilities survive the deploy that adds the claim rather than
    // turning into dead panels; the route resolves a null version to the artifact's latest.
    const legacy = signState(
      {
        purpose: "foh-artifact-preview",
        artifactId: "art_1",
        projectId: "proj_1",
        userId: "user_1",
        backOfHouse: false,
        exp: NOW + 60_000,
      },
      KEY,
    );
    expect(verifyArtifactPreviewToken(legacy, "art_1", KEY, NOW)).toMatchObject({
      versionId: null,
    });
  });

  it("refuses the token once it expires, at the boundary", () => {
    const { token, expiresAt } = mint();
    expect(verifyArtifactPreviewToken(token, "art_1", KEY, expiresAt - 1)).not.toBeNull();
    expect(verifyArtifactPreviewToken(token, "art_1", KEY, expiresAt)).toBeNull();
    expect(verifyArtifactPreviewToken(token, "art_1", KEY, expiresAt + 1)).toBeNull();
  });

  it("honours a shorter ttl than the default", () => {
    const { token, expiresAt } = mint({ ttlMs: 1_000 });
    expect(expiresAt).toBe(NOW + 1_000);
    expect(verifyArtifactPreviewToken(token, "art_1", KEY, NOW + 1_001)).toBeNull();
  });

  it("refuses a payload swapped under a valid signature", () => {
    const { token } = mint();
    const signature = token.slice(token.indexOf(".") + 1);
    const forged = Buffer.from(
      JSON.stringify({
        purpose: "foh-artifact-preview",
        artifactId: "art_1",
        projectId: "proj_1",
        // The escalation the signature exists to stop: previewing as someone else.
        userId: "user_2",
        backOfHouse: true,
        exp: NOW + ARTIFACT_PREVIEW_TTL_MS,
      }),
      "utf8",
    ).toString("base64url");
    expect(
      verifyArtifactPreviewToken(`${forged}.${signature}`, "art_1", KEY, NOW),
    ).toBeNull();
  });

  it("refuses another key's signature, and a token signed for another purpose", () => {
    const { token } = mint();
    expect(verifyArtifactPreviewToken(token, "art_1", OTHER_KEY, NOW)).toBeNull();

    // A well-formed, in-date, correctly signed token from a DIFFERENT flow must not be a preview
    // capability: the purpose tag is what keeps the shared secrets key from making every signed
    // state interchangeable.
    const elsewhere = signState(
      {
        purpose: "org-invitation-delivery",
        artifactId: "art_1",
        projectId: "proj_1",
        userId: "user_1",
        exp: NOW + 60_000,
      },
      KEY,
    );
    expect(verifyArtifactPreviewToken(elsewhere, "art_1", KEY, NOW)).toBeNull();
  });

  it("refuses garbled input without throwing, however it is broken", () => {
    const { token } = mint();
    for (const bad of [
      "",
      "not-a-token",
      token.slice(0, -4),
      token.replace(".", ""),
      `${token}extra`,
      token.split(".")[0],
      "%%%.%%%",
    ]) {
      expect(verifyArtifactPreviewToken(bad, "art_1", KEY, NOW)).toBeNull();
    }
  });

  it("refuses a correctly signed claim that is missing its fields", () => {
    const thin = signState(
      { purpose: "foh-artifact-preview", artifactId: "art_1", exp: NOW + 60_000 },
      KEY,
    );
    expect(verifyArtifactPreviewToken(thin, "art_1", KEY, NOW)).toBeNull();
  });

  it("treats a non-boolean back-of-house claim as false", () => {
    const sneaky = signState(
      {
        purpose: "foh-artifact-preview",
        artifactId: "art_1",
        projectId: "proj_1",
        userId: "user_1",
        backOfHouse: "yes",
        exp: NOW + 60_000,
      },
      KEY,
    );
    expect(verifyArtifactPreviewToken(sneaky, "art_1", KEY, NOW)).toMatchObject({
      backOfHouse: false,
    });
  });
});

describe("nextPreviewRemintDelayMs", () => {
  it("re-mints a minute before expiry", () => {
    expect(nextPreviewRemintDelayMs(NOW + 600_000, NOW)).toBe(540_000);
  });

  it("never returns a delay short enough to become a mint loop", () => {
    // A token already expired, or one from a clock-skewed server, must not schedule at 0.
    expect(nextPreviewRemintDelayMs(NOW - 60_000, NOW)).toBe(30_000);
    expect(nextPreviewRemintDelayMs(NOW + 61_000, NOW)).toBe(30_000);
  });

  it("falls back to a fixed delay when the server sent no usable expiry", () => {
    for (const bad of [undefined, null, "soon", NaN, {}]) {
      expect(nextPreviewRemintDelayMs(bad, NOW)).toBe(60_000);
    }
  });
});
