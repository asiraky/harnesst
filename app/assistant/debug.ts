/**
 * Pure helpers behind the assistant's read-only debugging actions (issue #432): reading a run
 * reference, cutting excerpts, and keeping every response under the gateway's tool-result limit.
 *
 * Size: the gateway withholds any tool result over 10% of the model's window (12.8k tokens when
 * the window is unknown, about 51KB at its bytes/4 estimate; see `~/gateway/tool-result-limit`).
 * A debugging tool whose own answer gets withheld is useless, so every response is fitted to
 * `RESPONSE_BUDGET_BYTES` of serialized JSON, dropping list items from the end and saying where
 * the next page starts.
 */

/** Serialized size every debugging response stays under. */
export const RESPONSE_BUDGET_BYTES = 36_000;

export type RunRef = { ok: true; runId: string } | { ok: false; error: string };

/** A usage run link, `/usage/repos/<p>/runs/<r>...`, or a transcript link, `/repos/<p>[/agents/<a>]/runs/<r>`. */
const RUN_PATH_RE = /^\/(?:usage\/)?repos\/([^/]+)\/(?:agents\/[^/]+\/)?runs\/([^/?#]+)/;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The run id in what the model passed: a bare run id, or a pasted run link (absolute or
 * relative, with or without `/calls/<seq>` and a query). A link naming another repository is
 * refused here; a bare id is checked against the repository when the run is read.
 */
export function parseRunRef(raw: unknown, projectId: string): RunRef {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { ok: false, error: "Pass a run id or a /usage/repos/.../runs/<runId> link." };
  if (!value.includes("/")) {
    return RUN_ID_RE.test(value)
      ? { ok: true, runId: value }
      : { ok: false, error: `"${value.slice(0, 80)}" is not a run id.` };
  }
  let path: string;
  try {
    path = new URL(value, "http://relative.invalid").pathname;
  } catch {
    return { ok: false, error: "That run link could not be read." };
  }
  const match = RUN_PATH_RE.exec(path);
  if (!match) {
    return {
      ok: false,
      error: "That link is not a run link. Expected /usage/repos/<repo>/runs/<runId>.",
    };
  }
  const [, linkProject, runId] = match.map((part) => decodeURIComponent(part ?? ""));
  if (linkProject !== projectId) {
    return {
      ok: false,
      error: "That run belongs to another repository. You can only read runs from your own repository.",
    };
  }
  if (!RUN_ID_RE.test(runId)) return { ok: false, error: "That run link has no valid run id." };
  return { ok: true, runId };
}

/** How far back a list reads: an ISO time, or `<n>h` / `<n>d`. Clamped to 90 days. */
export function parseSince(raw: unknown, now: Date, defaultDays: number): Date {
  const maxBack = 90 * 86_400_000;
  const floor = new Date(now.getTime() - maxBack);
  const fallback = new Date(now.getTime() - defaultDays * 86_400_000);
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const value = raw.trim();
  const rel = /^(\d+(?:\.\d+)?)\s*([hd])$/i.exec(value);
  let at: Date;
  if (rel) {
    const unit = rel[2].toLowerCase() === "h" ? 3_600_000 : 86_400_000;
    at = new Date(now.getTime() - Number(rel[1]) * unit);
  } else {
    at = new Date(value);
    if (Number.isNaN(at.getTime())) return fallback;
  }
  return at < floor ? floor : at > now ? now : at;
}

/** A whole number from the body, clamped; the default when absent or not a number. */
export function intParam(raw: unknown, def: number, min: number, max: number): number {
  const v = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/** The head of a text, marked when cut. Callers redact BEFORE cutting. */
export function cut(text: string | null | undefined, max: number): string | null {
  if (text == null) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/**
 * The largest prefix of `items` whose response, as `build` shapes it, fits the budget. `build`
 * receives the kept items and sets its own paging fields from their count. At least one item is
 * kept: callers bound each item's size, so one always fits.
 */
export function fitItems<T>(
  items: T[],
  build: (kept: T[]) => Record<string, unknown>,
  budget = RESPONSE_BUDGET_BYTES,
): { body: Record<string, unknown>; kept: number } {
  const full = build(items);
  if (items.length === 0 || byteSize(full) <= budget) return { body: full, kept: items.length };
  let lo = 1;
  let hi = items.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteSize(build(items.slice(0, mid))) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return { body: build(items.slice(0, lo)), kept: lo };
}

/**
 * One chunk of a long text, from `offset`, at most `max` characters, shrunk until the response
 * `build` makes from it fits the budget (JSON escaping can grow a chunk well past its length).
 */
export function fitChunk(
  text: string,
  offset: number,
  max: number,
  build: (chunk: string, nextOffset: number | null) => Record<string, unknown>,
  budget = RESPONSE_BUDGET_BYTES,
): Record<string, unknown> {
  const start = Math.min(Math.max(0, offset), text.length);
  let len = Math.min(max, text.length - start);
  for (;;) {
    const end = start + len;
    const body = build(text.slice(start, end), end < text.length ? end : null);
    if (len <= 256 || byteSize(body) <= budget) return body;
    len = Math.floor(len / 2);
  }
}
