/** Installation only. OAuth credentials and approval execution stay in Supabase. */
import { randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.server";
import { bundleProvisioning } from "~/db/schema";
import { encrypt, getProvisioning, privateState } from "./provisioning.server";
import {
  SupabaseManagement,
  projectRef,
  migrationQuery,
  sqlLiteral,
} from "./supabase-provisioning.server";

export async function prepareLedgerAuthorization(projectId: string) {
  // Persist shared installation secrets once, before any remote writes. Retries reuse them.
  const row = await db.transaction(async (tx) => {
    const [r] = await tx
      .select()
      .from(bundleProvisioning)
      .where(eq(bundleProvisioning.projectId, projectId))
      .for("update");
    if (!r?.projectRef) throw new Error("Install the ledger first.");
    if (["running", "activating"].includes(r.status))
      throw new Error("Wait for ledger installation to finish.");
    const state = privateState(r);
    if (!state.token)
      throw new Error(
        "Authorize Supabase above to install the May I connection components.",
      );
    state.mayiSetupToken ??= randomBytes(32).toString("hex");
    state.dispatchToken ??= randomBytes(32).toString("hex");
    const [saved] = await tx
      .update(bundleProvisioning)
      .set({ encryptedState: encrypt(state) })
      .where(eq(bundleProvisioning.projectId, projectId))
      .returning();
    return saved;
  });
  const state = privateState(row),
    ref = projectRef(row.projectRef!);
  const api = new SupabaseManagement(state.token!);
  for (const file of [
    "20260917000005_hosted_authorization.sql",
    "20260917000006_oauth_recovery.sql",
    "20260917000007_scoped_oauth_writes.sql",
    "20260917000008_review_content.sql",
    "20260917000009_tickets.sql",
    "20260917000010_leases.sql",
  ]) {
    const source = await readFile(
      `catalog/ledger/hosted/supabase/migrations/${file}`,
      "utf8",
    );
    await api.query(
      ref,
      migrationQuery(
        projectId,
        file,
        createHash("sha256").update(source).digest("hex"),
        source,
      ),
    );
  }
  await api.call(`projects/${ref}/secrets`, [
    { name: "LEDGER_SETUP_TOKEN", value: state.mayiSetupToken },
    { name: "LEDGER_DISPATCH_TOKEN", value: state.dispatchToken },
  ]);
  for (const slug of [
    "approval-oauth",
    "approval-callback",
    "approval-dispatch",
  ]) {
    const form = new FormData();
    form.set(
      "metadata",
      JSON.stringify({
        name: slug,
        entrypoint_path: "index.ts",
        verify_jwt: false,
      }),
    );
    form.append(
      "file",
      new Blob(
        [await readFile(`catalog/ledger/hosted/deploy/${slug}.js`, "utf8")],
        { type: "application/javascript" },
      ),
      "index.ts",
    );
    await api.call(`projects/${ref}/functions/deploy?slug=${slug}`, form);
  }
  await api.query(
    ref,
    `do $v$ declare existing uuid; begin select id into existing from vault.secrets where name='ledger_dispatch_token'; if existing is null then perform vault.create_secret(${sqlLiteral(state.dispatchToken!)},'ledger_dispatch_token'); else perform vault.update_secret(existing,${sqlLiteral(state.dispatchToken!)}); end if; end $v$;
select cron.schedule('ledger-approval-dispatch','* * * * *',$job$select net.http_post(url:='https://${ref}.supabase.co/functions/v1/approval-dispatch',headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='ledger_dispatch_token')),body:='{}'::jsonb);$job$);
select cron.alter_job(jobid,active:=coalesce((select connection_status='connected' from ledger.approval_config),false)) from cron.job where jobname='ledger-approval-dispatch';`,
  );
  // Keep operator authorization until the first real OAuth grant is saved, so
  // interrupted registration/deployment remains recoverable from installation.
  await db.transaction(async (tx) => {
    const [r] = await tx
      .select()
      .from(bundleProvisioning)
      .where(eq(bundleProvisioning.projectId, projectId))
      .for("update");
    const latest = privateState(r);
    latest.mayiComponentsReady = true;
    if (latest.token === state.token) latest.supabaseAuthorizationPending = false;
    await tx
      .update(bundleProvisioning)
      .set({ encryptedState: encrypt(latest) })
      .where(eq(bundleProvisioning.projectId, projectId));
  });
}
export async function ledgerAuthorization(
  projectId: string,
  operation: "start" | "status",
  label?: string,
) {
  const row = await getProvisioning(projectId);
  const state = row ? privateState(row) : {};
  if (!row?.projectRef || !state.mayiSetupToken || !state.mayiComponentsReady) {
    if (operation === "status") return { status: "not_installed" };
    throw new Error("Install May I connection components first.");
  }
  const response = await fetch(
    `https://${projectRef(row.projectRef)}.supabase.co/functions/v1/approval-oauth`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${state.mayiSetupToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operation, label }),
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      message.startsWith("May I ") ||
        message.startsWith("Authorization unavailable")
        ? message.slice(0, 600)
        : "May I connection unavailable. Check installation components or retry authorization.",
    );
  }
  const result = await response.json();
  if (operation === "status" && result.status === "connected" && state.token && !state.supabaseAuthorizationPending) {
    await db.transaction(async (tx) => {
      const [r] = await tx
        .select()
        .from(bundleProvisioning)
        .where(eq(bundleProvisioning.projectId, projectId))
        .for("update");
      const latest = privateState(r);
      if (latest.token === state.token) delete latest.token;
      await tx
        .update(bundleProvisioning)
        .set({ encryptedState: encrypt(latest) })
        .where(eq(bundleProvisioning.projectId, projectId));
    });
  }
  if (operation === "start") {
    const url = new URL(result.url);
    if (
      url.origin !== "https://app.mayi.sh" ||
      url.pathname !== "/api/oauth/authorize"
    )
      throw new Error("Invalid authorization destination.");
  }
  return result;
}
