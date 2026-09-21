/**
 * Connect an OpenAI Codex ChatGPT subscription via device-code OAuth (issue #28, Phase 1).
 *
 * The Org-settings "Connect OpenAI Codex" dialog drives this resource route with a `useFetcher`:
 *   - `start`  → request a device code; returns the user code + verification URL to show the human.
 *   - `poll`   → poll the device-token endpoint once; `{ pending }` until the user authorizes, then
 *                exchange for tokens, read the account identity, and persist a sealed connection.
 *
 * Every outcome the dialog should render (device-login-disabled, still-pending, upstream failure)
 * is a 200 JSON body with an `error`/`pending` field, not an HTTP error — only auth/permission
 * failures throw. Write-only: tokens are sealed by `createCodexConnection` and never returned.
 */
import { and, eq, gt, lt, or, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "~/db/client.server";
import {
  auditLog,
  modelConnectionLogins,
  modelProviderConnections,
} from "~/db/schema";
import { data, redirect, type ActionFunctionArgs } from "react-router";

import { getSessionAuth } from "~/auth/session.server";
import { resolveActiveWorkspace } from "~/auth/workspace.server";
import {
  DeviceLoginDisabledError,
  exchangeDeviceCode,
  extractAccountIdentity,
  extractAccountIds,
  extractOrganizationIds,
  type CodexTokens,
  pollDeviceToken,
  requestDeviceCode,
} from "~/connections/codex.server";
import { auth as betterAuth } from "~/lib/auth.server";
import { decodeKey, open, seal } from "~/seams/oss/secretbox";
import { createCodexConnection } from "~/models/provider-connections.server";

async function canManageWorkspace(
  organizationId: string,
  headers: Headers,
): Promise<boolean> {
  const permission = await betterAuth.api.hasPermission({
    headers,
    body: { organizationId, permissions: { organization: ["update"] } },
  });
  return permission.success;
}

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const active = await resolveActiveWorkspace(auth);
  const org = active?.org;
  if (!org) return data({ error: "No organization." }, { status: 400 });
  if (!(await canManageWorkspace(org.id, auth.requestHeaders))) {
    throw new Response("Forbidden", { status: 403 });
  }

  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "start") {
    try {
      const connectionId = String(form.get("connectionId") ?? "");
      const connections = await db
        .select({
          id: modelProviderConnections.id,
          authorizationVersion: modelProviderConnections.authorizationVersion,
        })
        .from(modelProviderConnections)
        .where(
          and(
            eq(modelProviderConnections.orgId, org.id),
            eq(modelProviderConnections.provider, "codex"),
          ),
        );
      const target = connectionId
        ? connections.find((row) => row.id === connectionId)
        : undefined;
      if (connectionId && !target)
        return data({
          error: "This Codex connection is unavailable in this workspace.",
        });
      const authorizationVersion = target?.authorizationVersion ?? null;
      const connectionVersions = Object.fromEntries(
        connections.map((row) => [row.id, row.authorizationVersion]),
      );
      const device = await requestDeviceCode();
      await db
        .delete(modelConnectionLogins)
        .where(lt(modelConnectionLogins.expiresAt, new Date()));
      const attemptId = randomUUID();
      await db.insert(modelConnectionLogins).values({
        id: attemptId,
        orgId: org.id,
        userId: auth.user.id,
        connectionId: connectionId || null,
        authorizationVersion,
        connectionVersions,
        deviceAuthId: device.deviceAuthId,
        userCode: device.userCode,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });
      return data({
        attemptId,
        userCode: device.userCode,
        interval: device.interval,
        verificationUrl: device.verificationUrl,
      });
    } catch (error) {
      return data({
        error:
          error instanceof DeviceLoginDisabledError
            ? error.message
            : "Couldn't start Codex device login. Try again.",
      });
    }
  }

  const attemptId = String(form.get("attemptId") ?? "");
  const ownedAttempt = and(
    eq(modelConnectionLogins.id, attemptId),
    eq(modelConnectionLogins.orgId, org.id),
    eq(modelConnectionLogins.userId, auth.user.id),
  );
  if (intent === "cancel") {
    await db.delete(modelConnectionLogins).where(ownedAttempt);
    return data({ cancelled: true });
  }

  if (intent === "poll" || intent === "confirm") {
    const processingId = randomUUID();
    const [attempt] = await db
      .update(modelConnectionLogins)
      .set({ processing: true, processingId, processingStartedAt: new Date() })
      .where(
        and(
          ownedAttempt,
          or(
            eq(modelConnectionLogins.processing, false),
            lt(
              modelConnectionLogins.processingStartedAt,
              new Date(Date.now() - 60_000),
            ),
            isNull(modelConnectionLogins.processingStartedAt),
          ),
          gt(modelConnectionLogins.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!attempt)
      return data({
        error:
          "This sign-in expired, was cancelled, or is already being completed. Try again.",
      });
    const claimedAttempt = and(
      ownedAttempt,
      eq(modelConnectionLogins.processingId, processingId),
    );
    const release = () =>
      db
        .update(modelConnectionLogins)
        .set({
          processing: false,
          processingId: null,
          processingStartedAt: null,
        })
        .where(claimedAttempt);
    let exchangeStarted = false;
    try {
      let tokens: CodexTokens & { expiresAt: number };
      if (attempt.pendingGrant) {
        tokens = JSON.parse(
          open(
            decodeKey(process.env.HARNESST_SECRETS_KEY),
            attempt.pendingGrant,
          ),
        ) as CodexTokens & { expiresAt: number };
      } else {
        const result = await pollDeviceToken(attempt);
        if (result === "pending") {
          await release();
          return data({ pending: true });
        }
        // Renew the lease before spending the provider code. A reclaimed attempt cannot save later.
        const claimed = await db
          .update(modelConnectionLogins)
          .set({ processingStartedAt: new Date() })
          .where(claimedAttempt)
          .returning({ id: modelConnectionLogins.id });
        if (!claimed.length)
          throw new Error(
            "Sign-in was cancelled or expired. Existing credentials were preserved.",
          );
        exchangeStarted = true;
        const exchanged = await exchangeDeviceCode({
          authorizationCode: result.authorizationCode,
          codeVerifier: result.codeVerifier,
        });
        tokens = {
          ...exchanged,
          expiresAt: Date.now() + exchanged.expiresIn * 1000,
        };
      }
      if (!tokens.accessToken || !tokens.refreshToken)
        throw new Error(
          "OpenAI did not return a complete grant. Existing credentials were preserved; try signing in again.",
        );
      const identity = extractAccountIdentity(tokens);
      const accountIds = extractAccountIds(tokens);
      const organizationIds = extractOrganizationIds(tokens);
      const [target] = attempt.connectionId
        ? await db
            .select()
            .from(modelProviderConnections)
            .where(
              and(
                eq(modelProviderConnections.id, attempt.connectionId),
                eq(modelProviderConnections.orgId, org.id),
              ),
            )
        : [];
      if (attempt.connectionId && !target)
        throw new Error(
          "This Codex connection is unavailable in this workspace.",
        );
      if (!accountIds.length)
        throw new Error(
          "OpenAI did not return a provider account ID. Existing credentials were preserved; try signing in again.",
        );
      // A known, different identity is never recoverable through the confirmation checkbox.
      if (
        target?.accountId &&
        !accountIds.includes(target.accountId) &&
        !organizationIds.includes(target.accountId)
      ) {
        throw new Error(
          "Sign in to the same OpenAI account as this connection. No credentials or selections were changed.",
        );
      }
      const verificationRequired =
        accountIds.length > 1 ||
        (target && target.accountId !== identity.accountId);
      const verified =
        intent === "confirm" && form.get("verifiedAccount") === "yes";
      const selectedAccountId = String(form.get("accountId") ?? "");
      if (
        verificationRequired &&
        (!verified || !accountIds.includes(selectedAccountId))
      ) {
        await db
          .update(modelConnectionLogins)
          .set({
            pendingGrant:
              attempt.pendingGrant ??
              seal(
                decodeKey(process.env.HARNESST_SECRETS_KEY),
                JSON.stringify(tokens),
              ),
            processing: false,
            processingId: null,
            processingStartedAt: null,
          })
          .where(claimedAttempt);
        return data({
          verificationRequired: true,
          accountEmail: identity.email,
          accountIds,
        });
      }
      const accountId = verificationRequired
        ? selectedAccountId
        : identity.accountId;
      await db.transaction(async (tx) => {
        const [consumed] = await tx
          .delete(modelConnectionLogins)
          .where(
            and(
              claimedAttempt,
              gt(modelConnectionLogins.expiresAt, new Date()),
            ),
          )
          .returning();
        if (!consumed)
          throw new Error(
            "Sign-in was cancelled or expired. Existing credentials were preserved.",
          );
        const connection = await createCodexConnection(
          {
            orgId: org.id,
            label: identity.email ?? "Codex",
            accountEmail: identity.email,
            accountId,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: new Date(tokens.expiresAt),
            createdBy: auth.user!.id,
            connectionId: attempt.connectionId ?? undefined,
            authorizationVersion: attempt.authorizationVersion ?? undefined,
            connectionVersions: attempt.connectionVersions,
            verifiedAccount: !!verificationRequired && verified,
            accountIdAliases: organizationIds,
          },
          tx,
        );
        await tx.insert(auditLog).values({
          orgId: org.id,
          actorUserId: auth.user!.id,
          action: attempt.connectionId
            ? "model_provider_reauthenticated"
            : "model_provider_connected",
          target: connection.id,
          meta: verificationRequired
            ? { legacyAccountVerified: true, accountId }
            : undefined,
        });
      });
      return data({ done: true });
    } catch (error) {
      const retryable = !exchangeStarted && !attempt.pendingGrant;
      if (retryable) await release();
      else await db.delete(modelConnectionLogins).where(claimedAttempt);
      // Provider responses can contain credentials. Expose only our own lifecycle validation errors.
      const message = error instanceof Error ? error.message : "";
      const safe =
        /^(Sign in to|Several connections|This connection changed|This Codex connection|OpenAI did not return|Sign-in was)/.test(
          message,
        );
      return data({
        retryable,
        error: safe
          ? message
          : retryable
            ? "Couldn't check Codex sign-in. Try again to continue this sign-in."
            : "Couldn't complete Codex sign-in. Existing credentials and selections were preserved. Try again.",
      });
    }
  }
  return data({ error: "Unknown action." }, { status: 400 });
}
