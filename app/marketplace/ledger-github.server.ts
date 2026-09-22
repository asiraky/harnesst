import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sodium from "libsodium-wrappers";
import { createAppJwt } from "~/github/app-manifest.server";
import { getRuntime } from "~/seams/index.server";
import { listAgents } from "~/db/queries.server";
import { getProvisioning, privateState } from "./provisioning.server";

/** Called by an authenticated installation action, never exposes the system actor to an agent. */
export async function installLedgerGitHub(
  projectId: string,
  repository: string,
) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("Enter a GitHub repository as organization/name.");
  const row = await getProvisioning(projectId);
  if (!row || !["provisioned", "ready"].includes(row.status))
    throw new Error("Install the ledger first.");
  const state = privateState(row);
  const infra = (await listAgents(projectId)).find(
    (a) => a.name === state.members?.infra,
  );
  if (!infra) throw new Error("Publish the infra member first.");
  const credentials = await getRuntime().secrets.resolve({
    projectId,
    agentId: infra.id,
    environmentId: null,
  });
  if (!credentials.GITHUB_APP_ID || !credentials.GITHUB_APP_PRIVATE_KEY)
    throw new Error("Connect GitHub on infra first.");
  const jwt = createAppJwt(
    credentials.GITHUB_APP_ID,
    credentials.GITHUB_APP_PRIVATE_KEY,
  );
  const request = async (
    path: string,
    token: string,
    method = "GET",
    body?: unknown,
    allow404 = false,
  ) => {
    const response = await fetch(`https://api.github.com/${path}`, {
      method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 404 && allow404) return null;
    if (!response.ok)
      throw new Error(
        `GitHub setup failed (HTTP ${response.status}). Infra needs access to this repository and Contents, Workflows, Secrets and Variables write permissions.`,
      );
    return response.status === 204 ? null : response.json();
  };
  const installation = await request(`repos/${repository}/installation`, jwt);
  const grant = await request(
    `app/installations/${installation.id}/access_tokens`,
    jwt,
    "POST",
    {
      repositories: [repository.split("/")[1]],
      permissions: {
        contents: "write",
        workflows: "write",
        secrets: "write",
        actions_variables: "write",
      },
    },
  );
  const token = grant.token;
  const repo = await request(`repos/${repository}`, token);
  const files: { path: string; content: string }[] = [];
  for (const [path, source] of [
    [".github/scripts/ledger.mjs", "github-ledger.mjs"],
    [".github/workflows/ledger.yml", "ledger.yml"],
  ]) {
    const content = await readFile(
      resolve("catalog/ledger/examples", source),
      "utf8",
    );
    const existing = await request(
      `repos/${repository}/contents/${path}?ref=${encodeURIComponent(repo.default_branch)}`,
      token,
      "GET",
      undefined,
      true,
    );
    if (
      existing &&
      Buffer.from(existing.content ?? "", "base64").toString("utf8") !== content
    )
      throw new Error(
        `Installation stopped: ${path} already exists with different content.`,
      );
    if (!existing) files.push({ path, content });
  }
  // Disable while changing secrets; a failed attempt stays disabled and is safe to retry.
  const variable = await request(
    `repos/${repository}/actions/variables/LEDGER_ENABLED`,
    token,
    "GET",
    undefined,
    true,
  );
  await request(
    `repos/${repository}/actions/variables${variable ? "/LEDGER_ENABLED" : ""}`,
    token,
    variable ? "PATCH" : "POST",
    { name: "LEDGER_ENABLED", value: "false" },
  );
  const publicKey = await request(
    `repos/${repository}/actions/secrets/public-key`,
    token,
  );
  await sodium.ready;
  for (const [name, value] of Object.entries({
    LEDGER_URL: `https://${row.projectRef}.supabase.co`,
    LEDGER_ANON_KEY: state.publishableKey!,
    LEDGER_ACTOR_KEY: state.actors!.github.actorKey,
  })) {
    const encrypted = sodium.to_base64(
      sodium.crypto_box_seal(
        sodium.from_string(value),
        sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL),
      ),
      sodium.base64_variants.ORIGINAL,
    );
    await request(`repos/${repository}/actions/secrets/${name}`, token, "PUT", {
      encrypted_value: encrypted,
      key_id: publicKey.key_id,
    });
  }
  // Only create absent files. GitHub rejects concurrent creation rather than overwriting changes.
  for (const file of files)
    await request(`repos/${repository}/contents/${file.path}`, token, "PUT", {
      message: "Install harnesst ledger automation",
      content: Buffer.from(file.content).toString("base64"),
      branch: repo.default_branch,
    });
  await request(
    `repos/${repository}/actions/variables/LEDGER_ENABLED`,
    token,
    "PATCH",
    { name: "LEDGER_ENABLED", value: "true" },
  );
  return repository;
}
