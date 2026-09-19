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
import { and, eq, gt, lt } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "~/db/client.server";
import { modelConnectionLogins, modelProviderConnections } from "~/db/schema";
import { data, redirect, type ActionFunctionArgs } from "react-router";

import { getSessionAuth } from "~/auth/session.server";
import { resolveActiveWorkspace } from "~/auth/workspace.server";
import {
  DeviceLoginDisabledError,
  exchangeDeviceCode,
  extractAccountIdentity,
  pollDeviceToken,
  requestDeviceCode,
} from "~/connections/codex.server";
import { auth as betterAuth } from "~/lib/auth.server";
import { recordAudit } from "~/managed/audit.server";
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
      let credentialVersion: number | null = null;
      if (connectionId) {
        const [target] = await db
          .select()
          .from(modelProviderConnections)
          .where(
            and(
              eq(modelProviderConnections.id, connectionId),
              eq(modelProviderConnections.orgId, org.id),
              eq(modelProviderConnections.provider, "codex"),
            ),
          );
        if (!target)
          return data({
            error: "This Codex connection is unavailable in this workspace.",
          });
        credentialVersion = target.credentialVersion;
      }
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
        credentialVersion,
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

  if (intent === "poll") {
    const [attempt] = await db
      .update(modelConnectionLogins)
      .set({ processing: true })
      .where(
        and(
          ownedAttempt,
          eq(modelConnectionLogins.processing, false),
          gt(modelConnectionLogins.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!attempt)
      return data({
        error:
          "This sign-in expired, was cancelled, or is already being completed. Close the dialog and try again.",
      });
    try {
      const result = await pollDeviceToken(attempt);
      if (result === "pending") {
        await db
          .update(modelConnectionLogins)
          .set({ processing: false })
          .where(ownedAttempt);
        return data({ pending: true });
      }
      const tokens = await exchangeDeviceCode({
        authorizationCode: result.authorizationCode,
        codeVerifier: result.codeVerifier,
      });
      const identity = extractAccountIdentity({
        idToken: tokens.idToken,
        accessToken: tokens.accessToken,
      });
      const connection = await db.transaction(async (tx) => {
        const [consumed] = await tx
          .delete(modelConnectionLogins)
          .where(
            and(ownedAttempt, gt(modelConnectionLogins.expiresAt, new Date())),
          )
          .returning();
        if (!consumed)
          throw new Error(
            "Sign-in was cancelled or expired. Existing credentials were preserved.",
          );
        return createCodexConnection(
          {
            orgId: org.id,
            label: identity.email ?? "Codex",
            accountEmail: identity.email,
            accountId: identity.accountId,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
            createdBy: auth.user!.id,
            connectionId: attempt.connectionId ?? undefined,
            credentialVersion: attempt.credentialVersion ?? undefined,
          },
          tx,
        );
      });
      await recordAudit({
        orgId: org.id,
        actorUserId: auth.user.id,
        action: attempt.connectionId
          ? "model_provider_reauthenticated"
          : "model_provider_connected",
        target: connection.id,
      });
      return data({ done: true });
    } catch (error) {
      await db.delete(modelConnectionLogins).where(ownedAttempt);
      // Provider responses may contain credentials; only expose our own lifecycle validation errors.
      const message = error instanceof Error ? error.message : "";
      const safe =
        /^(Sign in to|Several connections|This connection changed|This Codex connection|OpenAI did not return|Sign-in was)/.test(
          message,
        );
      return data({
        error: safe
          ? message
          : "Couldn't complete Codex sign-in. Existing credentials and selections were preserved. Try again.",
      });
    }
  }
  return data({ error: "Unknown action." }, { status: 400 });
}
