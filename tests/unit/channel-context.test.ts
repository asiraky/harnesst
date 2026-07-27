/**
 * The `<github_context>` envelope, and why it must not reach a human surface.
 *
 * eve's `githubChannel` prepends a machine-readable addressing block to the user message of every
 * channel-triggered turn — repository, numeric repository id, issue number, sender, comment URL,
 * webhook delivery id. It is written for the model. Rendered verbatim (which is what harnesst did
 * on the first working production run, 2026-07-27) it is the FIRST thing a human sees when they
 * open a parked GitHub question from the inbox, above the sentence they were sent there to answer.
 *
 * Stripping is display-only and conservative: only a block at the very start, with a matching
 * closing tag. Anything else survives untouched — a user pasting an example of one of these blocks
 * must still see what they wrote.
 */
import { describe, expect, it } from "vitest";

import { stripChannelContext } from "~/chat/channel-context";

/** The exact shape observed in production. */
const ENVELOPE = [
  "<github_context>",
  "repository: jadendigital/stonesoultions-web",
  "repository_id: 1310524517",
  "issue_number: 1",
  "sender: asiraky",
  "sender_type: User",
  "comment_url: https://github.com/jadendigital/stonesoultions-web/issues/1#issuecomment-5087204072",
  "delivery_id: 2e430fe0-8972-11f1-8ac8-62b2f0968769",
  "</github_context>",
].join("\n");

const PROMPT =
  "I need a .gitignore for this repo, but you must first ask me — via your built-in question mechanism (the ask_question tool), not as an issue comment — which language toolchain to target.";

describe("stripChannelContext", () => {
  it("removes the envelope and the blank line under it", () => {
    expect(stripChannelContext(`${ENVELOPE}\n\n${PROMPT}`)).toBe(PROMPT);
  });

  it("leaves a message with no envelope exactly as written", () => {
    expect(stripChannelContext(PROMPT)).toBe(PROMPT);
  });

  it("strips any channel's envelope, not just GitHub's", () => {
    const discord = "<discord_context>\nguild: 42\n</discord_context>\n\nhi";
    expect(stripChannelContext(discord)).toBe("hi");
  });

  it("strips several stacked envelopes", () => {
    const stacked = `${ENVELOPE}\n\n<trigger_context>\nkind: mention\n</trigger_context>\n\n${PROMPT}`;
    expect(stripChannelContext(stacked)).toBe(PROMPT);
  });

  it("keeps an envelope the user quoted mid-message", () => {
    // Someone asking "why does my agent see this?" must still see what they pasted.
    const quoted = `why does my agent get this:\n\n${ENVELOPE}\n\nis that normal?`;
    expect(stripChannelContext(quoted)).toBe(quoted);
  });

  it("keeps text that opens with an unclosed or mismatched tag", () => {
    // The backreference is what makes this safe: no matching close, no strip.
    const unclosed = "<github_context>\nrepository: acme/widgets\n\nwhere did my tag go?";
    expect(stripChannelContext(unclosed)).toBe(unclosed);

    const mismatched = "<github_context>\nx: 1\n</gitlab_context>\n\nhello";
    expect(stripChannelContext(mismatched)).toBe(mismatched);
  });

  it("returns empty for a message that is nothing but envelope", () => {
    // Callers render no bubble for empty text, which beats rendering a wall of delivery ids.
    expect(stripChannelContext(ENVELOPE)).toBe("");
  });

  it("does not treat an ordinary XML-ish tag as a context envelope", () => {
    const other = "<thinking>\nnope\n</thinking>\n\nkeep me";
    expect(stripChannelContext(other)).toBe(other);
  });
});
