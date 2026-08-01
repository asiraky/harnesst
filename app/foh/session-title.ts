const MAX_INFERRED_TITLE_LENGTH = 80;

function truncateTitle(value: string): string {
  if (value.length <= MAX_INFERRED_TITLE_LENGTH) return value;
  const prefix = value.slice(0, MAX_INFERRED_TITLE_LENGTH - 1);
  const lastSpace = prefix.lastIndexOf(" ");
  const clipped = lastSpace >= 48 ? prefix.slice(0, lastSpace) : prefix;
  return `${clipped.trimEnd()}…`;
}

export function cleanInferredTitle(value: string): string {
  return truncateTitle(
    value
      .replace(/^\s*(?:#{1,6}|[-*])\s+/, "")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/**
 * A concise local fallback for messages that do not carry resolvable external metadata. It
 * removes conversational request boilerplate and keeps the first sentence instead of copying an
 * arbitrarily long prompt into the list.
 */
export function titleFromMessage(message: string): string {
  const firstSentence = message
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/, 1)[0]
    .replace(
      /^(?:(?:can|could|would|will) you(?: please)?|please|i need you to)\s+/i,
      "",
    );
  const cleaned = cleanInferredTitle(firstSentence);
  if (!cleaned) return "New conversation";
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
}
