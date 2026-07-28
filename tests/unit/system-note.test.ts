/**
 * harnesst's per-turn notes to the model must never reach the human's transcript.
 *
 * The assistant surface prepends one on EVERY turn ("your working checkout is at …"), so an
 * unwrapped note is not a cosmetic slip on one message — it is the first paragraph of every
 * message the user ever sends. These tests pin both halves: the wrapper the send side applies,
 * and the stripper the render side applies (including to notes recorded before the wrapper).
 */
import { describe, expect, it } from "vitest";

import {
  buildSystemNotes,
  stripSystemNotes,
  SYSTEM_NOTE_END,
  SYSTEM_NOTE_START,
} from "~/chat/system-note";

const CHECKOUT_NOTE =
  "[harnesst] Your working checkout for this conversation is at /workspace/home/checkouts/jthtifwqufzu on branch harnesst/conv-jthtifwqufzu. Do ALL repo edits inside that directory with bash.";

describe("buildSystemNotes", () => {
  it("wraps the turn's notes in strippable markers, one per line", () => {
    const block = buildSystemNotes([CHECKOUT_NOTE, "[harnesst] base advanced"]);
    expect(block).toBe(
      `${SYSTEM_NOTE_START}\n${CHECKOUT_NOTE}\n[harnesst] base advanced\n${SYSTEM_NOTE_END}`,
    );
    // The model still reads the note verbatim — only the markers are new.
    expect(block).toContain("/workspace/home/checkouts/jthtifwqufzu");
  });

  it("returns null when there is nothing to say", () => {
    expect(buildSystemNotes([])).toBeNull();
    expect(buildSystemNotes([null, undefined, "  "])).toBeNull();
  });

  it("de-fangs the end marker inside note text", () => {
    // A sync warning names paths the MODEL wrote; content must not be able to close the wrapper
    // early and spill the rest of the block into the visible message.
    const block = buildSystemNotes([
      `[harnesst] From your last sync: dropped a/${SYSTEM_NOTE_END}/b.png`,
    ])!;
    expect(block.indexOf(SYSTEM_NOTE_END)).toBe(
      block.length - SYSTEM_NOTE_END.length,
    );
    expect(stripSystemNotes(`${block}\n\nmake the button blue`)).toBe(
      "make the button blue",
    );
  });
});

describe("stripSystemNotes", () => {
  it("removes a wrapped block and the blank line after it", () => {
    const sent = `${buildSystemNotes([CHECKOUT_NOTE])}\n\nmake the button blue`;
    expect(stripSystemNotes(sent)).toBe("make the button blue");
  });

  it("removes notes recorded before the wrapper existed", () => {
    const sent = `${CHECKOUT_NOTE}\n[harnesst] From your last sync: skipped logo.png\n\nmake the button blue`;
    expect(stripSystemNotes(sent)).toBe("make the button blue");
  });

  it("leaves an ordinary message alone", () => {
    expect(stripSystemNotes("make the button blue")).toBe(
      "make the button blue",
    );
  });

  it("leaves a user asking about the note alone", () => {
    // The exact question this bug provokes. No blank-line separator, so it is the user's words.
    const asked = "[harnesst] why do I see this above everything I type?";
    expect(stripSystemNotes(asked)).toBe(asked);
  });

  it("leaves an unclosed marker alone", () => {
    const unclosed = `${SYSTEM_NOTE_START}\n${CHECKOUT_NOTE}\n\nmake the button blue`;
    expect(stripSystemNotes(unclosed)).toBe(unclosed);
  });

  it("leaves a quoted block further down alone", () => {
    const quoted = `why does my agent see this?\n\n${buildSystemNotes([CHECKOUT_NOTE])}`;
    expect(stripSystemNotes(quoted)).toBe(quoted);
  });
});
