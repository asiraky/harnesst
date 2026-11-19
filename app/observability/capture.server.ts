/**
 * Capture-layer helpers for the Observe pillar: size caps + secret redaction applied to the
 * rich per-step `data` we now persist (full tool input/output, assistant/user messages,
 * reasoning). These exist so transcripts stay useful without letting a single run balloon the
 * DB or leak credentials that happened to flow through a tool call.
 *
 * Two concerns, kept pure (no DB, no request context) so they're unit-testable:
 *   - Caps (`capField`): bound any one serialized field at ~16 KB and a whole step's data at
 *     ~64 KB, keeping the HEAD of oversized strings — that's where commands, args, and the
 *     first lines of output live — and marking `truncated` so the UI can say so.
 *   - Redaction (`redactSecrets`): a conservative pass that masks obvious credentials
 *     (bearer tokens, provider keys, cloud keys, long secret-keyed blobs) with `[redacted]`.
 *     Applied at ingest (`store.server.ts`) so BOTH producers — playground record + BYO
 *     ingest — get it. Deliberately conservative: it must not shred normal prose.
 */

/** Cap a single string field at ~16 KB. */
export const FIELD_CAP = 16 * 1024;
/** Cap a whole step's serialized `data` at ~64 KB. */
export const STEP_CAP = 64 * 1024;

/** Cap a string, keeping the head (commands/args/first output lines live there). */
export function capString(
  value: string,
  cap = FIELD_CAP,
): { text: string; truncated: boolean } {
  if (value.length <= cap) return { text: value, truncated: false };
  return { text: value.slice(0, cap), truncated: true };
}

/**
 * Cap an arbitrary value destined for a step's `data`: string leaves are capped at
 * `FIELD_CAP` (head kept); if the whole thing still serializes past `STEP_CAP` it collapses
 * to a truncated JSON string. Returns the capped value and whether anything was cut, so the
 * caller can set `data.truncated`.
 */
export function capField(value: unknown): {
  value: unknown;
  truncated: boolean;
} {
  let truncated = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const capped = capString(v);
      if (capped.truncated) truncated = true;
      return capped.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  let capped = walk(value);
  try {
    const serialized = JSON.stringify(capped);
    if (serialized && serialized.length > STEP_CAP) {
      capped = `${serialized.slice(0, STEP_CAP)}…`;
      truncated = true;
    }
  } catch {
    // circular / non-serializable — leave the walked value as-is
  }
  return { value: capped, truncated };
}

// Credential shapes we mask wholesale wherever they appear in a string. Ordered so the more
// specific provider keys win before the generic long-blob check keys off field names.
const SECRET_PATTERNS: { re: RegExp; replace: string }[] = [
  // Token part requires a credential-ish length (16+) so prose like "the Bearer of this
  // message" survives — real bearer tokens are far longer.
  { re: /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, replace: "Bearer [redacted]" },
  { re: /Basic\s+[A-Za-z0-9+/]{16,}=*/g, replace: "Basic [redacted]" },
  // harnesst tokens: API (edn_), assistant (edna_), gateway (edng_), eval (edne_).
  { re: /edn[age]?_[A-Za-z0-9._-]{16,}/g, replace: "[redacted]" },
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/g, replace: "[redacted]" },
  { re: /sk-[A-Za-z0-9]{20,}/g, replace: "[redacted]" },
  { re: /AKIA[0-9A-Z]{16}/g, replace: "[redacted]" },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, replace: "[redacted]" },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, replace: "[redacted]" },
  // Slack bot/user/app/refresh tokens.
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: "[redacted]" },
];

/** Field names whose long opaque values we assume are secrets. */
const SECRET_KEY_RE = /secret|token|password|passwd|api[-_]?key|authorization/i;
/** A long, opaque, secret-shaped blob (base64/hex/JWT-ish), no whitespace. */
const SECRET_BLOB_RE = /^[A-Za-z0-9._~+/=-]{24,}$/;

function redactString(value: string): string {
  let out = value;
  for (const { re, replace } of SECRET_PATTERNS) out = out.replace(re, replace);
  return out;
}

/**
 * Walk a value and mask obvious secrets. Conservative by design: known credential patterns
 * are masked anywhere; a long opaque blob is masked only when its KEY looks secret (so normal
 * prose and ordinary long strings survive). Returns a new value; never mutates the input.
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (
        typeof val === "string" &&
        SECRET_KEY_RE.test(key) &&
        SECRET_BLOB_RE.test(val.trim())
      ) {
        out[key] = "[redacted]";
      } else {
        out[key] = redactSecrets(val);
      }
    }
    return out;
  }
  return value;
}

/** Key names whose value is a secret whatever its shape. The key must END in the word, so
 * `tokenizer` and `tokens` survive. */
const SECRET_KEY_WORDS =
  "(?:password|passwd|secret|token|api[-_]?key|apikey|authorization|credentials?|private[-_]?key)";
/**
 * A secret-named key in serialized JSON (`"refresh_token": "..."`), its string value, and the
 * closing quote, which a cut excerpt may have lost.
 */
const SECRET_JSON_FIELD_RE = new RegExp(
  `("[A-Za-z0-9_.-]*${SECRET_KEY_WORDS}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*("|$)`,
  "gi",
);
/** The same inside a JSON string that itself holds JSON: `\\"token\\": \\"...\\"`. */
const SECRET_ESCAPED_FIELD_RE = new RegExp(
  `(\\\\"[A-Za-z0-9_.-]*${SECRET_KEY_WORDS}\\\\"\\s*:\\s*)\\\\"(?:(?!\\\\").)*(\\\\"|$)`,
  "gi",
);
/** The same in a query string or env line: `password=...`, `API_KEY=...`. */
const SECRET_ASSIGN_RE =
  /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[-_]?key|apikey)=)(["']?)[^\s&"',;]{4,}\2/gi;
/** The password in a connection URI: `postgres://user:pass@host`. */
const URI_CREDENTIAL_RE = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

/**
 * Mask secrets in text that is serialized JSON, an excerpt of it, or a log line: the credential
 * patterns above, plus the value of any secret-named JSON field or `key=value` pair whatever
 * its shape. Stricter than `redactSecrets` because it runs where a reader sees raw text (the
 * assistant's debugging tools), not where a transcript must stay readable.
 */
export function redactText(value: string): string {
  return redactString(value)
    .replace(SECRET_JSON_FIELD_RE, (_m, head: string, close: string) => `${head}"[redacted]${close}`)
    .replace(SECRET_ESCAPED_FIELD_RE, (_m, head: string, close: string) => `${head}\\"[redacted]${close}`)
    .replace(SECRET_ASSIGN_RE, "$1$2[redacted]$2")
    .replace(URI_CREDENTIAL_RE, "$1[redacted]@");
}
