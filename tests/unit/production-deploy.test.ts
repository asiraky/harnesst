import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const nginx = read("deploy/vps/nginx-harnesst.conf");
const stack = read("docker-stack.production.yml");
const workflow = read(".github/workflows/deploy.yml");
const script = read("deploy/production/deploy.sh");
const dockerignore = read(".dockerignore");
const gitignore = read(".gitignore");

describe("production deployment workflow", () => {
  it("runs checks after main pushes and by manual dispatch", () => {
    const checks = workflow.slice(
      workflow.indexOf("  checks:\n"),
      workflow.indexOf("\n  build:\n"),
    );

    expect(workflow).toMatch(/push:\s*\n\s+branches:\s*\n\s+- main/);
    expect(workflow).toMatch(/^\s{2}workflow_dispatch:\s*$/m);
    expect(workflow).toContain("cancel-in-progress: false");
    expect(checks).not.toMatch(/^\s+if:/m);
  });

  it("keeps image publication and deployment canonical-main only", () => {
    expect(
      workflow.match(
        /if: github\.repository == 'asiraky\/harnesst' && github\.ref == 'refs\/heads\/main'/g,
      ),
    ).toHaveLength(2);
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("environment: production");
  });

  it("publishes runtime and migration images under the short commit SHA", () => {
    expect(workflow).toContain("type=sha,format=short,prefix=");
    expect(workflow).toContain("type=raw,value=latest");
    expect(workflow).toContain("target: build-env");
    expect(workflow).toContain(
      "ghcr.io/asiraky/harnesst:${{ steps.image.outputs.tag }}-migrate",
    );
    expect(dockerignore).toMatch(/^\.git$/m);
    expect(dockerignore).toMatch(/^\.env\.\*$/m);
    expect(dockerignore).toMatch(/^\*\.env$/m);
    expect(dockerignore).toMatch(/^\*\.log$/m);
    expect(gitignore).toMatch(/^\/production\.env$/m);
  });

  it("uses only the four production VPS Environment secrets", () => {
    const secretNames = [
      ...workflow.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g),
    ].map((match) => match[1]);

    expect(new Set(secretNames)).toEqual(
      new Set([
        "PROD_VPS_HOST",
        "PROD_VPS_USER",
        "PROD_VPS_SSH_KEY",
        "PROD_VPS_KNOWN_HOSTS",
      ]),
    );
    expect(workflow).toContain("GHCR_TOKEN: ${{ github.token }}");
  });

  it("pins the trusted SSH host identity without live key discovery", () => {
    expect(workflow).toContain('test -n "$PROD_VPS_KNOWN_HOSTS"');
    expect(workflow).toContain(
      'printf \'%s\\n\' "$PROD_VPS_KNOWN_HOSTS" > "$HOME/.ssh/known_hosts"',
    );
    expect(workflow).toContain(
      'ssh-keygen -F "$PROD_VPS_HOST" -f "$HOME/.ssh/known_hosts" >/dev/null',
    );
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).not.toContain("ssh-keyscan");
  });
});

describe("production Swarm stack", () => {
  it("deploys one immutable harnesst replica with stop-first rollback", () => {
    expect(stack).toContain(
      "image: ghcr.io/asiraky/harnesst:${IMAGE_TAG:?set IMAGE_TAG}",
    );
    expect(stack).toContain("replicas: ${HARNESST_REPLICAS:-1}");
    expect(stack.match(/order: stop-first/g)).toHaveLength(4);
    expect(stack).toMatch(/failure_action: rollback/);
    expect(stack).toContain("node.role == manager");
  });

  it("fails harnesst health on non-2xx responses within the update monitor", () => {
    const harnesst = stack.slice(stack.indexOf("  harnesst:\n"));

    expect(harnesst).toContain("process.exit(response.ok ? 0 : 1)");
    expect(harnesst).not.toContain(".then(() => process.exit(0))");
    expect(harnesst).toMatch(
      /interval: 10s\n\s+timeout: 5s\n\s+retries: 3\n\s+start_period: 20s/,
    );
    expect(harnesst.match(/monitor: 60s/g)).toHaveLength(2);
  });

  it("detects persistent Postgres health failure within its update monitor", () => {
    const postgres = stack.slice(
      stack.indexOf("  postgres:\n"),
      stack.indexOf("\n  harnesst:\n"),
    );

    expect(postgres).toMatch(
      /interval: 5s\n\s+timeout: 5s\n\s+retries: 5\n\s+start_period: 10s/,
    );
    expect(postgres.match(/monitor: 60s/g)).toHaveLength(2);
  });

  it("keeps Postgres on its fixed data path and exact host addresses", () => {
    expect(stack).toContain(
      "/opt/harnesst/volumes/postgres:/var/lib/postgresql/data",
    );
    expect(stack).toContain("listen_addresses=127.0.0.1,172.17.0.1");
    expect(stack).toContain("external: true");
    expect(stack).toMatch(/\n\s+name: host\s*$/m);
    expect(stack).not.toMatch(/^\s+ports:/m);
    expect(stack).not.toContain("0.0.0.0");
  });

  it("contains only the harnesst and Postgres services", () => {
    const services = stack.slice(
      stack.indexOf("services:\n"),
      stack.indexOf("\nnetworks:\n"),
    );
    const serviceNames = [
      ...services.matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm),
    ].map((match) => match[1]);
    expect(serviceNames).toEqual(["postgres", "harnesst"]);
    expect(stack).not.toMatch(/^\s{2}(nginx|certbot):/m);
    expect(stack).not.toMatch(/^\s+build:/m);
  });
});

describe("production nginx site", () => {
  const locations = [
    ...nginx.matchAll(
      /^ {4}location\s+(?:(=|\^~)\s+)?(\S+)\s*\{\n([\s\S]*?)^ {4}\}$/gm,
    ),
  ].map(([, modifier, prefix, body]) => ({ modifier, prefix, body }));

  it("keeps proxied prefix locations clear of nginx's trailing-slash 301", () => {
    // Nginx answers a request for a proxy_pass prefix location's exact string *without* its
    // trailing slash with a 301 to the slashed form. Browsers re-issue a 301'd POST as a bodyless
    // GET, so any such location silently breaks the endpoint sitting at its bare path — which is
    // how `POST /api/auth/reset-password` turned into a 404 and every password reset failed.
    // `/e/` is the one safe case: nothing serves `/e`, and unslashing it would swallow unrelated
    // routes beginning with "e".
    const proxied = locations.filter(
      (location) =>
        location.modifier !== "=" &&
        location.body.includes("proxy_pass") &&
        // The catch-all cannot be reached without its slash, so it is unaffected.
        location.prefix !== "/",
    );

    expect(proxied.length).toBeGreaterThan(1);
    expect(
      proxied
        .map((location) => location.prefix)
        .filter((prefix) => prefix.endsWith("/")),
    ).toEqual(["/e/"]);
  });

  it("routes the reset-password submit and token callback to harnesst unlogged", () => {
    const reset = locations.filter((location) =>
      location.prefix.startsWith("/api/auth/reset-password"),
    );

    // One per vhost: the port-80 upgrade and the app's proxy_pass.
    expect(reset).toHaveLength(2);
    for (const location of reset) {
      expect(location.prefix).toBe("/api/auth/reset-password");
      expect(location.modifier).toBe("^~");
      expect(location.body).toContain("access_log off;");
    }
  });
});

describe("remote deployment transaction", () => {
  it("is executable Bash with strict error handling", () => {
    expect(script).toMatch(/^#!\/usr\/bin\/env bash\n/);
    expect(script).toContain("set -Eeuo pipefail");
    expect(
      statSync(resolve(root, "deploy/production/deploy.sh")).mode & 0o111,
    ).not.toBe(0);
  });

  it("bootstraps Postgres, migrates, then performs the full rollout", () => {
    const transaction = script.slice(script.lastIndexOf("\nvalidate_inputs\n"));
    const bootstrap = transaction.indexOf("deploy_stack 0");
    const migration = transaction.indexOf("run_migrations");
    const rollout = transaction.indexOf("deploy_stack 1");
    const postgresRollout = transaction.indexOf("wait_for_postgres_rollout");
    const harnesstRollout = transaction.indexOf("wait_for_harnesst");

    expect(bootstrap).toBeGreaterThan(-1);
    expect(migration).toBeGreaterThan(bootstrap);
    expect(rollout).toBeGreaterThan(migration);
    expect(postgresRollout).toBeGreaterThan(rollout);
    expect(harnesstRollout).toBeGreaterThan(postgresRollout);
    expect(transaction).toContain(
      'postgres_version_before="$(service_version "$POSTGRES_SERVICE")"',
    );
    expect(transaction).toContain(
      'postgres_version_after="$(service_version "$POSTGRES_SERVICE")"',
    );
    expect(transaction).toContain(
      'postgres_task_template_before="$(service_task_template "$POSTGRES_SERVICE")"',
    );
    expect(transaction).toContain(
      'postgres_update_started_before="$(service_update_started_at "$POSTGRES_SERVICE")"',
    );
  });

  it("verifies a first-bootstrap stack reapply by health", () => {
    const transaction = script.slice(script.lastIndexOf("\nvalidate_inputs\n"));
    const bootstrapDefault = transaction.indexOf("postgres_bootstrapped=false");
    const absenceCheck = transaction.indexOf(
      'if ! docker service inspect "$POSTGRES_SERVICE"',
    );
    const bootstrap = transaction.indexOf("deploy_stack 0");
    const bootstrapRecorded = transaction.indexOf("postgres_bootstrapped=true");
    const bootstrapEnd = transaction.indexOf(
      "\nfi\n\nwait_for_postgres",
      bootstrapRecorded,
    );
    const migration = transaction.indexOf("run_migrations");
    const rollout = transaction.indexOf("deploy_stack 1");
    const steadyStateSnapshot = transaction.indexOf(
      'if [[ "$postgres_bootstrapped" == false ]]; then',
    );
    const steadyStateSnapshotEnd = transaction.indexOf(
      "\nfi\ndeploy_stack 1",
      steadyStateSnapshot,
    );
    const bootstrapVerification = transaction.indexOf(
      'if [[ "$postgres_bootstrapped" == true ]]; then',
      rollout,
    );
    const healthWait = transaction.indexOf(
      "wait_for_postgres\n",
      bootstrapVerification,
    );
    const steadyStateBranch = transaction.indexOf("else\n", healthWait);
    const metadataComparison = transaction.indexOf(
      'if [[ "$postgres_task_template_after" != "$postgres_task_template_before" ]]; then',
      steadyStateBranch,
    );
    const rolloutWait = transaction.indexOf(
      "wait_for_postgres_rollout \\\n",
      metadataComparison,
    );
    const bootstrapBranchEnd = transaction.indexOf(
      "\nfi\nwait_for_harnesst",
      rolloutWait,
    );

    expect(transaction.match(/^postgres_bootstrapped=false$/gm)).toHaveLength(
      1,
    );
    expect(transaction.match(/^\s*postgres_bootstrapped=true$/gm)).toHaveLength(
      1,
    );
    expect(bootstrapDefault).toBeGreaterThan(-1);
    expect(absenceCheck).toBeGreaterThan(bootstrapDefault);
    expect(bootstrap).toBeGreaterThan(absenceCheck);
    expect(bootstrapRecorded).toBeGreaterThan(bootstrap);
    expect(bootstrapEnd).toBeGreaterThan(bootstrapRecorded);
    expect(migration).toBeGreaterThan(bootstrapEnd);
    expect(steadyStateSnapshot).toBeGreaterThan(migration);
    expect(steadyStateSnapshotEnd).toBeGreaterThan(steadyStateSnapshot);
    expect(rollout).toBeGreaterThan(steadyStateSnapshotEnd);
    expect(bootstrapVerification).toBeGreaterThan(rollout);
    expect(healthWait).toBeGreaterThan(bootstrapVerification);
    expect(steadyStateBranch).toBeGreaterThan(healthWait);
    expect(metadataComparison).toBeGreaterThan(steadyStateBranch);
    expect(rolloutWait).toBeGreaterThan(metadataComparison);
    expect(bootstrapBranchEnd).toBeGreaterThan(rolloutWait);
    expect(
      transaction.slice(bootstrapVerification, steadyStateBranch),
    ).toContain(
      "Swarm may advance service metadata without starting a task update",
    );
  });

  it("resolves mutable images only when their stack image changes", () => {
    expect(script).toContain("--resolve-image changed");
    expect(script).not.toContain("--resolve-image always");
  });

  it("ignores historical Postgres rollback metadata but monitors a current update", () => {
    const readiness = script.slice(
      script.indexOf("wait_for_postgres() {"),
      script.indexOf("wait_for_postgres_rollout() {"),
    );
    const rollout = script.slice(
      script.indexOf("wait_for_postgres_rollout() {"),
      script.indexOf("run_migrations() {"),
    );

    expect(readiness).not.toContain("assert_update_not_failed");
    expect(rollout).toContain('if [[ "$update_is_current" == true ]]');
    expect(rollout).toContain(
      'update_started="$(service_update_started_at "$POSTGRES_SERVICE")"',
    );
    expect(rollout).toContain('"$update_started" == "$update_started_before"');
    expect(rollout).toContain('assert_update_not_failed "$POSTGRES_SERVICE"');
    expect(rollout).toContain('[[ "$update_state" == "completed" ]]');
  });

  it("requires the requested harnesst task container to be Docker-healthy", () => {
    const helper = script.slice(
      script.indexOf("service_has_one_healthy_container() {"),
      script.indexOf("wait_for_postgres() {"),
    );
    const harnesstWait = script.slice(
      script.indexOf("wait_for_harnesst() {"),
      script.lastIndexOf("\nvalidate_inputs\n"),
    );

    expect(helper).toContain(".State.Health.Status");
    expect(helper).toContain("com.docker.swarm.task.id");
    expect(helper).toContain("docker inspect --type task");
    expect(harnesstWait).toContain(
      'service_has_one_healthy_container "$HARNESST_SERVICE" "$RUNTIME_IMAGE"',
    );
  });

  it("does not execute the production env file as shell code", () => {
    expect(script).toContain('--env-file "$ENV_FILE"');
    expect(script).not.toMatch(/(?:^|\n)\s*(?:source|\.)\s+["']?\$?ENV_FILE/);
  });

  it("allows Docker bridge access to Postgres through ufw on every deploy", () => {
    const transaction = script.slice(script.lastIndexOf("\nvalidate_inputs\n"));

    expect(script).toContain("require_command sudo");
    expect(script).toContain(
      "sudo -n ufw allow in on docker0 to 172.17.0.1 port 5442 proto tcp",
    );
    expect(transaction).toMatch(
      /validate_inputs\nconfigure_postgres_firewall\ndiagnostics_enabled=true/,
    );
  });

  it("diagnoses failed rollouts and only prunes old dangling images", () => {
    expect(script).toContain(
      "paused|rollback_started|rollback_paused|rollback_completed",
    );
    expect(script).toContain('docker service ps --no-trunc "$service"');
    expect(script).toContain('docker logs --tail 100 "$container_id"');
    expect(script).toContain(
      "docker image prune --force --filter 'until=168h'",
    );
    expect(script).not.toMatch(/docker\s+(?:system|volume)\s+prune/);
    expect(script).not.toMatch(
      /docker\s+image\s+prune[^\n]*(?:--all|-a(?:\s|$))/,
    );
  });
});
