// Copy to .github/scripts/ledger.mjs. Trusted workflow only; never execute PR code with this key.
import { readFile } from "node:fs/promises";
const {
  LEDGER_URL,
  LEDGER_ANON_KEY,
  LEDGER_ACTOR_KEY,
  GITHUB_TOKEN,
  GITHUB_REPOSITORY,
} = process.env;
async function rpc(op, args = {}) {
  const response = await fetch(`${LEDGER_URL}/rest/v1/rpc/ledger_${op}`, {
    method: "POST",
    headers: { apikey: LEDGER_ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ p_key: LEDGER_ACTOR_KEY, p_args: args }),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.message);
  return data;
}
async function gh(path, method = "GET", body) {
  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw Error(`GitHub ${response.status}: ${data.message}`);
  return data;
}
export async function handleGitHubEvent(event, eventName, { rpc, gh, repo }) {
  function idFromBranch(branch) {
    return /^ledger\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/.exec(
      branch ?? "",
    )?.[1];
  }
  async function mutate(op, item, args) {
    const binding = item.head_sha;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (
        op === "transition" &&
        item.head_sha === binding &&
        (item.stage === args.to_stage ||
          (args.to_stage === "merged" && item.stage === "deployed"))
      )
        return item;
      try {
        return await rpc(op, {
          item_id: item.id,
          expected_version: item.version,
          ...(op === "transition" ? { binding } : {}),
          ...args,
        });
      } catch (error) {
        if (attempt === 3 || !error.message.startsWith("stale (")) throw error;
        item = await rpc("get_item", { item_id: item.id });
      }
    }
  }
  async function checkRepo(item) {
    const project = await rpc("get_project", { project_id: item.project_id });
    if (!project || project.repo !== repo)
      throw Error("Item belongs to a different product repository");
  }
  if (eventName === "repository_dispatch" && event.action === "ledger-deployed") {
    const deploymentId = event.client_payload?.deployment_id;
    if (!Number.isSafeInteger(deploymentId) || deploymentId < 1)
      throw Error("Invalid deployment identity");
    const deployment = await gh(`deployments/${deploymentId}`);
    const statuses = await gh(`deployments/${deploymentId}/statuses`);
    // Read GitHub's authoritative result; the dispatch body is only an identifier.
    if (statuses[0]?.state !== "success") throw Error("Deployment is not successful");
    const payload = typeof deployment.payload === "string"
      ? JSON.parse(deployment.payload) : deployment.payload;
    if (deployment.sha !== payload?.merge_sha)
      throw Error("Deployment commit does not match its recorded merge");
    return handleGitHubEvent({ deployment, deployment_status: statuses[0] },
      "deployment_status", { rpc, gh, repo });
  }
  if (event.pull_request) {
    const pr = event.pull_request,
      id = idFromBranch(pr.head.ref);
    if (id && pr.head.repo?.full_name === repo) {
      let item = await rpc("get_item", { item_id: id });
      await checkRepo(item);
      if (!pr.merged) {
        item = await mutate("set_head", item, {
          head_sha: pr.head.sha,
          observed_at: pr.updated_at,
        });
        item = await mutate("attach", item, { type: "pr", value: pr.html_url });
        await mutate("attach", item, { type: "branch", value: pr.head.ref });
      } else if (
        item.kind === "ticket" &&
        item.stage === "open" &&
        item.head_sha === pr.head.sha
      ) {
        // A ticket closes only when its PR lands on its parent issue's branch.
        if (idFromBranch(pr.base?.ref) !== item.parent_id)
          throw Error("Ticket PR must target its parent issue branch");
        await mutate("transition", item, {
          to_stage: "merged",
          note: `GitHub confirmed ticket PR ${pr.number} merged into ${pr.base.ref}`,
        });
      } else if (
        item.stage === "ready-to-merge" &&
        item.head_sha === pr.head.sha
      ) {
        await mutate("transition", item, {
          to_stage: "merged",
          note: `GitHub confirmed PR ${pr.number} merged`,
        });
      }
    }
  } else if (event.deployment_status?.state === "success") {
    const deployment = event.deployment,
      payload =
        typeof deployment.payload === "string"
          ? JSON.parse(deployment.payload)
          : deployment.payload;
    // Deployment workflows must supply the ledger item AND original PR head. A merge SHA is not a PR head.
    const id = payload?.ledger_item_id;
    if (id) {
      let item = await rpc("get_item", { item_id: id });
      await checkRepo(item);
      if (payload.head_sha !== item.head_sha)
        throw Error("Deployment is for a stale head");
      const production = deployment.environment === "production";
      item = await mutate("attach", item, {
        type: production ? "deployment" : "preview_url",
        value:
          event.deployment_status.environment_url ||
          event.deployment_status.target_url,
        binding: payload.head_sha,
      });
      if (production && item.stage === "merged")
        await mutate("transition", item, { to_stage: "deployed" });
    }
  } else if (["schedule", "workflow_dispatch"].includes(eventName)) {
    const failures = [];
    for (let item of await rpc("list_items", { stage: "ready-to-merge" })) {
      try {
        const project = await rpc("get_project", {
          project_id: item.project_id,
        });
        if (!project || project.repo !== repo) continue;
        item = await rpc("get_item", { item_id: item.id });
        if (item.stage !== "ready-to-merge" || item.blocked_on) continue;
        const artifact = item.artifacts.find((a) => a.type === "pr");
        const match = artifact?.value.match(
          /^https:\/\/github.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/,
        );
        if (!match || match[1] !== repo) throw Error("Invalid PR artifact");
        const pr = await gh(`pulls/${match[2]}`);
        if (pr.head.sha !== item.head_sha)
          throw Error("Approved SHA is no longer PR head");
        let mergeSha = pr.merge_commit_sha;
        if (!pr.merged) {
          const result = await gh(`pulls/${pr.number}/merge`, "PUT", {
            sha: item.head_sha,
            merge_method: "squash",
          });
          if (!result.merged) throw Error(result.message);
          mergeSha = result.sha;
        }
        if (!/^[0-9a-f]{40}$/.test(mergeSha ?? ""))
          throw Error("GitHub did not return a confirmed merge commit");
        // GITHUB_TOKEN suppresses push workflows. Explicit dispatch is supported.
        // Dispatch before settling the item so a failed/uncertain delivery is retried
        // by the next sweep against the already merged PR, without another merge.
        await gh("dispatches", "POST", {
          event_type: "ledger-deploy",
          client_payload: {
            ledger_item_id: item.id,
            head_sha: item.head_sha,
            merge_sha: mergeSha,
            pull_request: pr.number,
          },
        });
        // GITHUB_TOKEN merges may not produce another Actions run. Record the confirmed result here.
        item = await rpc("get_item", { item_id: item.id });
        if (item.stage === "ready-to-merge" && item.head_sha === pr.head.sha)
          await mutate("transition", item, {
            to_stage: "merged",
            note: `GitHub API confirmed PR ${pr.number} merged`,
          });
      } catch (error) {
        failures.push(`${item.id}: ${error.message}`);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, failures.join("\n"));
  }
}
if (
  process.env.GITHUB_EVENT_PATH &&
  process.argv[1] &&
  new URL(import.meta.url).pathname === process.argv[1]
) {
  const event = JSON.parse(
    await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
  );
  await handleGitHubEvent(event, process.env.GITHUB_EVENT_NAME, {
    rpc,
    gh,
    repo: GITHUB_REPOSITORY,
  });
}
