import type {
  ChatInputOption,
  ChatInputOptionField,
  ChatInputOptionMedia,
  ChatInputSurface,
  ChatInputOptionSwatch,
} from "~/chat/types";

export const MAX_CHAT_INPUT_OPTIONS = 20;
export const MAX_CHAT_OPTION_TEXT_BYTES = 4_000;
const MAX_FIELDS = 8;
const MAX_FIELD_TEXT_BYTES = 2_000;
const MAX_SWATCHES = 12;

export function normalizeChatInputSurface(
  value: unknown,
): ChatInputSurface | null {
  return value === "web" || value === "mobile" || value === "native"
    ? value
    : null;
}

export function boundedChatInputString(
  value: unknown,
  maxBytes: number,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && new TextEncoder().encode(trimmed).byteLength <= maxBytes
    ? trimmed
    : null;
}

function normalizeMedia(value: unknown): ChatInputOptionMedia | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const media = value as Record<string, unknown>;
  const artifactId = boundedChatInputString(media.artifactId, 200);
  const artifactName = boundedChatInputString(media.artifactName, 200);
  const artifactVersionId = boundedChatInputString(
    media.artifactVersionId,
    200,
  );
  if (!artifactId && !artifactName) return null;
  return { artifactId, artifactName, artifactVersionId };
}

function normalizeSwatches(value: unknown): ChatInputOptionSwatch[] {
  if (!Array.isArray(value)) return [];
  const out: ChatInputOptionSwatch[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, MAX_SWATCHES)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const swatch = raw as Record<string, unknown>;
    const color =
      typeof swatch.color === "string" &&
      /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(
        swatch.color,
      )
        ? swatch.color
        : null;
    const key = color?.toLowerCase();
    if (!color || !key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      color,
      label: boundedChatInputString(swatch.label, 100),
    });
  }
  return out;
}

function normalizeFields(value: unknown): ChatInputOptionField[] {
  if (!Array.isArray(value)) return [];
  const out: ChatInputOptionField[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, MAX_FIELDS)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const field = raw as Record<string, unknown>;
    const label = boundedChatInputString(field.label, 100);
    if (
      !label ||
      typeof field.value !== "object" ||
      field.value === null ||
      Array.isArray(field.value)
    ) {
      continue;
    }
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    const value = field.value as Record<string, unknown>;
    if (value.type === "text") {
      const text = boundedChatInputString(value.text, MAX_FIELD_TEXT_BYTES);
      if (!text) continue;
      out.push({ label, value: { type: "text", text } });
      seen.add(key);
      continue;
    }
    if (value.type === "swatches") {
      const swatches = normalizeSwatches(value.swatches);
      if (swatches.length === 0) continue;
      out.push({ label, value: { type: "swatches", swatches } });
      seen.add(key);
    }
  }
  return out;
}

/**
 * Presentation is optional and additive. Invalid individual fields disappear instead of making an
 * otherwise answerable option fatal, and a wire-supplied resolved artifact is intentionally never
 * copied — only transcript projection may attach one from this conversation's stored rows.
 */
export function normalizeChatInputOptionPresentation(
  value: Record<string, unknown>,
): Pick<ChatInputOption, "description" | "style" | "media" | "fields"> {
  const style = value.style;
  return {
    description: boundedChatInputString(
      value.description,
      MAX_CHAT_OPTION_TEXT_BYTES,
    ),
    style:
      style === "danger" || style === "primary" || style === "default"
        ? style
        : null,
    media: normalizeMedia(value.media),
    fields: normalizeFields(value.fields),
  };
}
