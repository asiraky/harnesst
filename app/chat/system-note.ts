/**
 * harnesst's own per-turn notes to the model — and how they stay out of the human's transcript.
 *
 * eve's session API has no per-turn system field, so anything harnesst needs the model to know
 * about THIS turn travels as text prepended to the sent message (`messagePrefix` in
 * `streamTurnResponse`). The assistant surface leans on that: every turn tells the model which
 * checkout directory it must edit, plus whatever the last sync dropped.
 *
 * The sent message is what eve records in `message.received`, and the transcript is replayed from
 * those events — so an unwrapped note is shown to the user as the first paragraph of their OWN
 * message, on every single turn:
 *
 *     [harnesst] Your working checkout for this conversation is at /workspace/home/checkouts/…
 *
 *     make the button blue
 *
 * The two prefixes that predate this one (the model directive and the seed-context block) each solved
 * that with strippable markers; this is the same trick for the free-text notes, in one place any
 * surface can reach. Wrapping is at SEND, stripping is at RENDER: the recorded event keeps the note
 * (it is genuinely what the model was given, and the observability record should not lie about it),
 * and stripping on read also cleans up conversations recorded before this existed.
 *
 * Client-safe: pure string work, imported by server projections and React components alike.
 */

export const SYSTEM_NOTE_START = "<!-- harnesst:note-start -->";
export const SYSTEM_NOTE_END = "<!-- harnesst:note-end -->";

/**
 * Wrap this turn's notes into one strippable block, or null when there are none. Notes are joined
 * one per line and the end marker is de-fanged inside them — note text carries repo paths the model
 * wrote (a sync warning names the files harnesst dropped), so content must not be able to close the
 * wrapper early and spill the rest into the visible message.
 */
export function buildSystemNotes(
  notes: ReadonlyArray<string | null | undefined>,
): string | null {
  const lines = notes
    .filter((note): note is string => Boolean(note && note.trim()))
    .map((note) => note.replaceAll(SYSTEM_NOTE_END, "").trim());
  if (lines.length === 0) return null;
  return [SYSTEM_NOTE_START, ...lines, SYSTEM_NOTE_END].join("\n");
}

/** A leading wrapped block plus the blank line after it. */
const LEADING_NOTE_BLOCK = new RegExp(
  `^${SYSTEM_NOTE_START}\\n[\\s\\S]*?\\n${SYSTEM_NOTE_END}\\n*`,
);

/**
 * Notes recorded before the wrapper existed: a run of `[harnesst] …` lines at the very start,
 * separated from the user's words by a blank line. That separator is what keeps this honest — a
 * person who types "[harnesst] why do I see this?" (exactly the question this bug provokes) has no
 * blank line after it, so their message is left as written.
 */
const LEADING_LEGACY_NOTES = /^(?:\[harnesst\] [^\n]*\n)+\n+/;

/**
 * Remove harnesst's note block(s) from the front of a sent message. Loops because a surface may
 * prepend more than one block, and because a legacy note can sit next to a wrapped one in a
 * conversation that spans the fix.
 */
export function stripSystemNotes(text: string): string {
  let out = text;
  for (;;) {
    const next = out
      .replace(LEADING_NOTE_BLOCK, "")
      .replace(LEADING_LEGACY_NOTES, "");
    if (next === out) return out;
    out = next;
  }
}
