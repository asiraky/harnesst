/**
 * Staged OAuth callback — the generic mechanism behind scrubbing one-time provider credentials
 * out of callback URLs (issue #30's Google hardening, extended to the GitHub manifest flow).
 *
 * A provider redirect lands with `?code=`/`?state=` in the raw URL, where the credential would
 * survive in history, request logs, referrer headers, and rendered error documents. Staging
 * encrypts the query into a short-lived HttpOnly cookie scoped to the callback path and
 * immediately redirects to the clean URL; session/database work happens only on the follow-up
 * request. The session middleware clears the cookie on every callback response.
 */
import { redirect } from "react-router";

import { decodeKey, open, seal } from "~/seams/oss/secretbox";

const COOKIE_MAX_AGE_SECONDS = 5 * 60;
const MAX_STAGED_VALUE_LENGTH = 3_500;

export interface OAuthCallbackPayload {
  code: string | null;
  error: string | null;
  state: string | null;
}

interface StagedCallback {
  payload: OAuthCallbackPayload;
  issuedAt: number;
  expiresAt: number;
}

export interface OAuthCallbackStaging {
  /** True when the request carries provider query params that must be scrubbed. */
  isStagingRequest(request: Request): boolean;
  /** Encrypt the provider response into the cookie and redirect to the clean callback URL. */
  stage(request: Request, now?: number): Response;
  /** Decrypt and validate the staged payload on the clean follow-up request. */
  readStaged(request: Request, now?: number): OAuthCallbackPayload | null;
  /** A Set-Cookie value that deletes the staging cookie. */
  clearCookie(request: Request): string;
}

function callbackKey(): Buffer {
  return decodeKey(process.env.HARNESST_SECRETS_KEY);
}

function secureRequest(request: Request): boolean {
  const configured = process.env.BETTER_AUTH_URL?.trim();
  try {
    const url = configured ? new URL(configured) : new URL(request.url);
    return url.protocol === "https:";
  } catch {
    // Staging must still leave the credential-bearing URL when development configuration is bad.
    return new URL(request.url).protocol === "https:";
  }
}

export function createOAuthCallbackStaging(config: {
  cookieName: string;
  path: string;
}): OAuthCallbackStaging {
  const { cookieName, path } = config;

  function cookieValue(
    request: Request,
    value: string,
    maxAge: number,
  ): string {
    return [
      `${cookieName}=${encodeURIComponent(value)}`,
      `Path=${path}`,
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAge}`,
      ...(maxAge === 0 ? ["Expires=Thu, 01 Jan 1970 00:00:00 GMT"] : []),
      ...(secureRequest(request) ? ["Secure"] : []),
    ].join("; ");
  }

  function readCookie(request: Request): string | null {
    const header = request.headers.get("cookie");
    if (!header) return null;
    for (const part of header.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0) continue;
      if (part.slice(0, separator).trim() !== cookieName) continue;
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return null;
      }
    }
    return null;
  }

  function clearCookie(request: Request): string {
    return cookieValue(request, "", 0);
  }

  return {
    isStagingRequest(request) {
      const url = new URL(request.url);
      return (
        url.pathname === path &&
        ["code", "state", "error"].some((name) => url.searchParams.has(name))
      );
    },

    stage(request, now = Date.now()) {
      const url = new URL(request.url);
      const payload: OAuthCallbackPayload = {
        code: url.searchParams.get("code"),
        error: url.searchParams.get("error"),
        state: url.searchParams.get("state"),
      };

      try {
        const staged: StagedCallback = {
          payload,
          issuedAt: now,
          expiresAt: now + COOKIE_MAX_AGE_SECONDS * 1000,
        };
        const encrypted = seal(callbackKey(), JSON.stringify(staged));
        const value = Buffer.from(JSON.stringify(encrypted)).toString(
          "base64url",
        );
        if (value.length > MAX_STAGED_VALUE_LENGTH) throw new Error("Too large");
        return redirect(path, {
          headers: {
            "Set-Cookie": cookieValue(request, value, COOKIE_MAX_AGE_SECONDS),
          },
        });
      } catch {
        // Never render an error on the provider URL: even misconfiguration must leave it
        // immediately.
        return redirect(`${path}?failure=invalid`, {
          headers: { "Set-Cookie": clearCookie(request) },
        });
      }
    },

    readStaged(request, now = Date.now()) {
      const value = readCookie(request);
      if (!value) return null;
      try {
        const sealed = JSON.parse(
          Buffer.from(value, "base64url").toString(),
        ) as {
          authTag: string;
          ciphertext: string;
          iv: string;
        };
        const staged = JSON.parse(
          open(callbackKey(), sealed),
        ) as Partial<StagedCallback>;
        const parsed = staged.payload as
          | Partial<Record<keyof OAuthCallbackPayload, unknown>>
          | undefined;
        if (
          !parsed ||
          typeof staged.issuedAt !== "number" ||
          typeof staged.expiresAt !== "number" ||
          staged.expiresAt - staged.issuedAt !==
            COOKIE_MAX_AGE_SECONDS * 1000 ||
          staged.issuedAt > now + 60_000 ||
          staged.expiresAt <= now ||
          ![parsed.code, parsed.error, parsed.state].every(
            (item) => item === null || typeof item === "string",
          )
        ) {
          return null;
        }
        return {
          code: parsed.code as string | null,
          error: parsed.error as string | null,
          state: parsed.state as string | null,
        };
      } catch {
        return null;
      }
    },

    clearCookie,
  };
}
