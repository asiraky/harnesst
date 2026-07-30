/**
 * Artifact publishing (issue #290) — the control-plane half of "the agent made an image and the
 * user should see it in the conversation".
 *
 * The transcript cannot carry assets: the wire protocol between harnesst and an instance is JSON
 * text and `textOf` flattens every event to a string, so anything that is not prose is dropped
 * before it could reach the UI. Publication is therefore a side-channel call, shaped exactly like
 * `park.server.ts`: the bearer authenticates a DEPLOYMENT and nothing more, every identity fact
 * (environment, agent, project, conversation) is re-derived server-side from that id, and every
 * business outcome is a VALUE the agent can read rather than an HTTP failure it would retry
 * forever. Collaborators are injected so the whole flow unit-tests with no docker and no disk.
 *
 * Two things the agent says are load-bearing and both are validated here, not trusted: the PATH
 * (confined to the agent's own home volume — `docker cp` would otherwise read any file in the
 * instance) and the CONTENT TYPE, which is sniffed from the bytes because the serving route is
 * same-origin and cookie-authenticated, so a mislabelled HTML payload would be stored XSS.
 *
 * The DESTINATION is derived the same way, and it is the third security decision here: an artifact
 * goes to the conversation whose turn is running on the calling deployment right now, never to "the
 * agent's most recent conversation" — one deployment serves every member's FOH sessions, and those
 * sessions are per-creator confidential, so the newest row is routinely a different person's.
 *
 * And because the caller is an agent in a loop, publishing is BUDGETED: per-conversation and daily
 * per-repo ceilings bound the disk (nothing ever deletes stored bytes) and a copy-slot gate bounds
 * the heap (each copy buffers its tar whole). Both are refusals the agent can read.
 */
import { createHash } from "node:crypto";

import { TURN_IDLE_TIMEOUT_MS } from "~/chat/turn-stream.server";
import type { DataStore } from "~/data/ports";
import {
  copyArtifactFromInstance,
  type ArtifactCopyResult,
} from "~/foh/artifact-copy.server";
import {
  ARTIFACT_MAX_BYTES,
  artifactUrl,
  resolveArtifactSource,
  sniffArtifactContentType,
} from "~/foh/artifact-media";
import {
  artifactUsage,
  insertArtifact,
  writeArtifactBytes,
  type Artifact,
} from "~/foh/artifact-store.server";
import { liveFohTurnForDeployment } from "~/playground/sessions.server";
import { getRuntime } from "~/seams/index.server";

/** Longest agent-supplied caption kept — it is one line under a card. */
const MAX_TITLE_LENGTH = 200;

/**
 * BUDGETS. The 25 MB per-artifact cap bounds one call; these bound a LOOP, which is the shape the
 * failure actually takes (a buggy or prompt-injected agent publishing near-identical screenshots).
 * Nothing ever deletes stored bytes and content addressing only dedups byte-identical files, so
 * without a ceiling an agent owns the control plane's disk — which in the single-VPS deploy is the
 * same disk Postgres writes to (deploy/vps/docker-compose.yml).
 *
 * Deliberately generous: a real conversation shows a handful of images, so these are only ever felt
 * by a runaway. Refusals are VALUES, so hitting one reads to the agent as "stop publishing", which
 * is exactly the intended feedback.
 */
export const MAX_ARTIFACTS_PER_SESSION = 100;
export const ARTIFACT_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_ARTIFACTS_PER_PROJECT_WINDOW = 500;
export const MAX_ARTIFACT_BYTES_PER_PROJECT_WINDOW = 2 * 1024 * 1024 * 1024;

/**
 * CONCURRENCY. Each copy buffers a whole tar in this process (up to `ARTIFACT_MAX_BYTES`), so the
 * heap cost of publishing is N × 25 MB and N is otherwise whatever the agents choose. The gate is a
 * refusal rather than a queue on purpose: a queued publish would hold the caller's turn open for as
 * long as the queue is deep, and "harnesst is busy, try again" is something the agent can act on.
 */
export const MAX_CONCURRENT_ARTIFACT_COPIES = 3;

let copiesInFlight = 0;

/**
 * Run `body` in one of the copy slots, or report that none was free. Exported for its own test:
 * the interesting property (the slot is released even when the copy throws) is invisible from
 * `publishArtifact`.
 */
export async function withArtifactCopySlot<T>(
  body: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  if (copiesInFlight >= MAX_CONCURRENT_ARTIFACT_COPIES) return { ok: false };
  copiesInFlight += 1;
  try {
    return { ok: true, value: await body() };
  } finally {
    copiesInFlight -= 1;
  }
}

export interface PublishArtifactDeps {
  store: DataStore;
  /** Read the file out of the publishing deployment's instance over the docker socket. */
  copyFile: (input: {
    deploymentId: string;
    path: string;
    maxBytes: number;
  }) => Promise<ArtifactCopyResult>;
  writeBytes: (sha256: string, bytes: Buffer) => Promise<string>;
  insert: typeof insertArtifact;
  /** The conversation an artifact published by this agent belongs to — the live turn's, only. */
  findSession: typeof liveFohTurnForDeployment;
  /** Consumption the publish is held against (see the budgets above). */
  usage: typeof artifactUsage;
  now: () => Date;
}

export function defaultPublishArtifactDeps(): PublishArtifactDeps {
  return {
    store: getRuntime().data,
    copyFile: copyArtifactFromInstance,
    writeBytes: writeArtifactBytes,
    insert: insertArtifact,
    findSession: liveFohTurnForDeployment,
    usage: artifactUsage,
    now: () => new Date(),
  };
}

export interface PublishArtifactInput {
  /** The caller deployment id the route's bearer authenticated. Never from the body. */
  deploymentId: string;
  path: string;
  title?: string | null;
  /** v1 publishes images only; anything else is refused before a byte is read. */
  kind?: string | null;
}

export type PublishArtifactResult =
  | {
      ok: true;
      artifactId: string;
      /** App path the image is served at — what the agent quotes back to the user. */
      url: string;
      name: string;
      contentType: string;
      byteSize: number;
    }
  | { ok: false; error: string };

function deny(error: string): PublishArtifactResult {
  return { ok: false, error };
}

export async function publishArtifact(
  input: PublishArtifactInput,
  deps: PublishArtifactDeps,
): Promise<PublishArtifactResult> {
  const { store } = deps;

  // Cheap refusals first: nothing below should run for a payload that can never be accepted.
  if (input.kind && input.kind !== "image") {
    return deny(
      `harnesst can only publish images right now, not "${input.kind}".`,
    );
  }
  const source = resolveArtifactSource(input.path);
  if (!source) {
    return deny(
      "Publish a file inside /workspace/home (for example /workspace/home/artifacts/chart.png) — that is the only tree harnesst can read.",
    );
  }

  // Caller resolution — deployment → environment → agent → project, all from the token's
  // deployment id (the park/`runAsk` rule: nothing about identity comes off the wire).
  const deployment = await store.deployments.findById(input.deploymentId);
  if (!deployment) return deny("Your deployment is no longer known to harnesst.");
  const environment = await store.environments.findById(deployment.environmentId);
  if (!environment) return deny("Your environment is no longer known to harnesst.");
  const agent = await store.agents.findById(environment.agentId);
  if (!agent) return deny("Your agent is no longer part of this repository.");
  const project = await store.projects.findById(agent.projectId);
  if (!project) return deny("This repository is no longer connected.");

  // The DESTINATION is derived from the live turn, never from "the agent's newest conversation":
  // one deployment serves every member's conversation with this agent, so the newest row is
  // routinely someone else's and publishing into it would show one member's image to another
  // (and let them download the bytes). See `liveFohTurnForDeployment`.
  const found = await deps.findSession({
    projectId: project.id,
    agentId: agent.id,
    environmentId: deployment.environmentId,
    staleAfterMs: TURN_IDLE_TIMEOUT_MS,
    now: deps.now(),
  });
  if (!found.ok) {
    return deny(
      found.reason === "ambiguous"
        ? "You are working on more than one Front of House conversation at once, so harnesst cannot tell which one this file belongs to. Publish it when only this conversation is running."
        : "There is no Front of House conversation waiting on you right now, so there is nowhere to show the file. Publish it while you are answering someone in harnesst.",
    );
  }
  const session = found.session;

  const usage = await deps.usage({
    projectId: project.id,
    sessionId: session.id,
    since: new Date(deps.now().getTime() - ARTIFACT_BUDGET_WINDOW_MS),
  });
  if (usage.sessionCount >= MAX_ARTIFACTS_PER_SESSION) {
    return deny(
      `This conversation already holds ${MAX_ARTIFACTS_PER_SESSION} published files, which is the limit. Describe the file instead, or start a new conversation.`,
    );
  }
  if (
    usage.projectCount >= MAX_ARTIFACTS_PER_PROJECT_WINDOW ||
    usage.projectBytes >= MAX_ARTIFACT_BYTES_PER_PROJECT_WINDOW
  ) {
    return deny(
      "This repository has hit its daily limit for published files. Describe the file instead; publishing works again tomorrow.",
    );
  }

  // Budget-checked and destination-resolved before a single byte is read: everything above is a
  // couple of indexed queries, while the copy below holds up to 25 MB of this process's heap.
  const slot = await withArtifactCopySlot(() =>
    deps.copyFile({
      deploymentId: deployment.id,
      path: source.path,
      maxBytes: ARTIFACT_MAX_BYTES,
    }),
  );
  if (!slot.ok) {
    return deny(
      "harnesst is already copying as many files as it can at once. Try publishing again in a moment.",
    );
  }
  const copied = slot.value;
  if (!copied.ok) return deny(copied.error);

  const contentType = sniffArtifactContentType(copied.bytes, source.name);
  if (!contentType) {
    return deny(
      `${source.name} is not a PNG, JPEG, WebP or SVG image. harnesst reads the file's own bytes, so renaming it does not help.`,
    );
  }

  const sha256 = createHash("sha256").update(copied.bytes).digest("hex");
  const storagePath = await deps.writeBytes(sha256, copied.bytes);
  // The position the conversation had reached WHEN the publish landed, so the card renders inside
  // the turn that produced it rather than at the end of the transcript forever after. With the
  // durable cache gone (#288) the row's eve-space cursor IS that position — the live drain's
  // progress saves keep it within the in-flight turn.
  const streamIndex = session.streamIndex;
  const title = input.title?.trim() ? input.title.trim().slice(0, MAX_TITLE_LENGTH) : null;

  let row: Artifact;
  try {
    row = await deps.insert({
      projectId: project.id,
      agentId: agent.id,
      sessionId: session.id,
      deploymentId: deployment.id,
      name: source.name,
      title,
      contentType,
      byteSize: copied.bytes.length,
      sha256,
      storagePath,
      streamIndex,
    });
  } catch (error) {
    console.error("[foh] artifact publish failed to record:", error);
    return deny("harnesst could not record the artifact. Try publishing again.");
  }
  if (!row) {
    return deny("harnesst could not record the artifact. Try publishing again.");
  }

  return {
    ok: true,
    artifactId: row.id,
    url: artifactUrl(row.projectId, row.id),
    name: row.name,
    contentType: row.contentType,
    byteSize: row.byteSize,
  };
}
