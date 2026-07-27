/**
 * Strip the machine-readable context envelope eve's channel adapters prepend to a user message.
 *
 * A turn triggered from a channel does not arrive as the human's words alone. eve's `githubChannel`
 * hands the model an envelope first, so it knows which thread it is answering:
 *
 *     <github_context>
 *     repository: acme/widgets
 *     repository_id: 1310524517
 *     issue_number: 1
 *     sender: octocat
 *     …
 *     </github_context>
 *
 *     I need a .gitignore for this repo, but you must first ask me …
 *
 * That is addressed to the model, not to a person. Rendered verbatim it is the FIRST thing a human
 * sees when they open a parked GitHub question from the inbox — delivery ids and numeric repository
 * ids above the sentence they actually care about. The same envelope reaches the run transcript and
 * the activity feed's "Message" field.
 *
 * Stripping is deliberately conservative and DISPLAY-ONLY: the stored event keeps the envelope
 * (it is what the model was given, and the observability record should not lie about that), and
 * only a block at the very START of the message, whose tag looks like `<something_context>` and
 * which closes with the matching tag, is removed. A message that merely quotes such a tag further
 * down — a user pasting an example, say — is left exactly as written.
 *
 * Client-safe: pure string work, imported by server projections and React components alike. It is
 * applied at render, not at ingest, so transcripts recorded before this existed clean up too.
 */

/**
 * A leading `<x_context> … </x_context>` block plus the blank line after it. The backreference is
 * what keeps this honest: an unclosed or mismatched tag matches nothing and the text is untouched.
 */
const LEADING_CONTEXT_BLOCK = /^<([a-z][a-z0-9-]*_context)>\n[\s\S]*?\n<\/\1>\n*/u;

/**
 * Remove any channel context envelopes from the front of a message. Loops because adapters may
 * stack more than one block (channel context plus a trigger context, for instance); a message
 * that is NOTHING but envelope is returned empty, and callers render no bubble for empty text.
 */
export function stripChannelContext(text: string): string {
  let out = text;
  for (;;) {
    const next = out.replace(LEADING_CONTEXT_BLOCK, "");
    if (next === out) return out;
    out = next;
  }
}
