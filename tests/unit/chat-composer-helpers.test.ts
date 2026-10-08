/**
 * Pure logic behind the chat composer and transcript: attachment admission, draft persistence,
 * ↑-history, scheduled sends, image downscale sizing, scroll distance, code-fence languages.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  admitAttachments,
  resolveAttachmentMediaType,
} from "~/chat/attachment-rules";
import { fitWithin } from "~/components/chat/attachments-client";
import { languageFromClassName, normalizeLanguage } from "~/components/chat/code-block";
import {
  type DraftStorage,
  loadDraftAttachments,
  loadDraftText,
  loadQueue,
  moveDraft,
  pushHistory,
  saveDraftAttachments,
  saveQueue,
  saveDraftText,
  touchIndex,
} from "~/components/chat/drafts";
import {
  formatCountdown,
  insertScheduled,
  loadScheduled,
  moveScheduled,
  partitionDue,
  saveScheduled,
  schedulePresets,
  type ScheduledMessage,
} from "~/components/chat/scheduled";
import { distanceFromBottom, scrollIntent } from "~/components/chat/use-auto-scroll";

function memoryStorage(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const file = (name: string, type: string, size: number) => ({ name, type, size });

describe("resolveAttachmentMediaType", () => {
  it("passes images and pdf through and normalises image/jpg", () => {
    expect(resolveAttachmentMediaType("a.png", "image/png")).toBe("image/png");
    expect(resolveAttachmentMediaType("a.jpg", "image/jpg")).toBe("image/jpeg");
    expect(resolveAttachmentMediaType("a.pdf", "application/pdf")).toBe("application/pdf");
  });

  it("falls back to the extension when the browser reports nothing useful", () => {
    expect(resolveAttachmentMediaType("shot.webp", "")).toBe("image/webp");
    expect(resolveAttachmentMediaType("main.rs", "application/octet-stream")).toBe("text/plain");
    expect(resolveAttachmentMediaType("Dockerfile", "")).toBe("text/plain");
  });

  it("maps text-ish types to text/plain and refuses binaries", () => {
    expect(resolveAttachmentMediaType("x.json", "application/json")).toBe("text/plain");
    expect(resolveAttachmentMediaType("x.zip", "application/zip")).toBeNull();
    expect(resolveAttachmentMediaType("x.exe", "")).toBeNull();
  });
});

describe("admitAttachments", () => {
  it("accepts supported files and names the reason for each rejection", () => {
    const { accepted, rejected } = admitAttachments(
      [],
      [
        file("ok.png", "image/png", 10),
        file("empty.txt", "text/plain", 0),
        file("huge.png", "image/png", MAX_ATTACHMENT_BYTES + 1),
        file("x.zip", "application/zip", 10),
      ],
    );
    expect(accepted.map((f) => f.name)).toEqual(["ok.png"]);
    expect(rejected.map((r) => r.name)).toEqual(["empty.txt", "huge.png", "x.zip"]);
  });

  it("counts existing attachments against the count cap", () => {
    const existing = Array.from({ length: MAX_ATTACHMENTS - 1 }, (_, i) =>
      file(`e${i}.png`, "image/png", 1),
    );
    const { accepted, rejected } = admitAttachments(existing, [
      file("a.png", "image/png", 1),
      file("b.png", "image/png", 1),
    ]);
    expect(accepted.map((f) => f.name)).toEqual(["a.png"]);
    expect(rejected.map((r) => r.name)).toEqual(["b.png"]);
  });

  it("enforces the total size cap across existing and incoming", () => {
    const big = MAX_ATTACHMENT_BYTES;
    const existing = [file("e.png", "image/png", MAX_TOTAL_ATTACHMENT_BYTES - big)];
    const { accepted, rejected } = admitAttachments(existing, [
      file("fits.png", "image/png", big),
      file("over.png", "image/png", 1),
    ]);
    expect(accepted.map((f) => f.name)).toEqual(["fits.png"]);
    expect(rejected.map((r) => r.name)).toEqual(["over.png"]);
  });
});

describe("drafts", () => {
  it("touchIndex moves the key to the front and evicts past the cap", () => {
    expect(touchIndex(["a", "b", "c"], "c", true, 3)).toEqual({
      index: ["c", "a", "b"],
      evicted: [],
    });
    expect(touchIndex(["a", "b", "c"], "d", true, 3)).toEqual({
      index: ["d", "a", "b"],
      evicted: ["c"],
    });
    expect(touchIndex(["a", "b"], "a", false, 3)).toEqual({ index: ["b"], evicted: [] });
  });

  it("round-trips per-key text, isolates keys, and removes blank drafts", () => {
    const store = memoryStorage();
    saveDraftText("foh:s1", "hello", store);
    saveDraftText("foh:s2", "other", store);
    expect(loadDraftText("foh:s1", store)).toBe("hello");
    expect(loadDraftText("foh:s2", store)).toBe("other");
    saveDraftText("foh:s1", "   ", store);
    expect(loadDraftText("foh:s1", store)).toBe("");
    expect([...store.data.keys()].some((k) => k.endsWith("foh:s1"))).toBe(false);
  });

  it("prunes the oldest drafts once past the cap", () => {
    const store = memoryStorage();
    for (let i = 0; i < 55; i++) saveDraftText(`k${i}`, `t${i}`, store);
    expect(loadDraftText("k0", store)).toBe("");
    expect(loadDraftText("k54", store)).toBe("t54");
  });

  it("survives a storage that throws", () => {
    const broken: DraftStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
    };
    expect(() => saveDraftText("k", "x", broken)).not.toThrow();
    expect(loadDraftText("k", broken)).toBe("");
  });
});

describe("moveDraft (placeholder key -> real conversation id)", () => {
  const att = (id: string) => ({
    id,
    file: new File(["x"], `${id}.png`, { type: "image/png" }),
    name: `${id}.png`,
    mediaType: "image/png",
    size: 1,
    previewUrl: null,
  });

  it("moves text, attachments and queued messages, leaving the placeholder empty", () => {
    const store = memoryStorage();
    saveDraftText("p:new", "typed during first turn", store);
    saveDraftAttachments("p:new", [att("a")]);
    saveQueue("p:new", [{ id: "q1", text: "follow-up", attachments: [] }]);
    moveDraft("p:new", "p:s1", store);
    expect(loadDraftText("p:s1", store)).toBe("typed during first turn");
    expect(loadDraftAttachments("p:s1").map((a) => a.id)).toEqual(["a"]);
    expect(loadQueue("p:s1").map((q) => q.text)).toEqual(["follow-up"]);
    expect(loadDraftText("p:new", store)).toBe("");
    expect(loadDraftAttachments("p:new")).toEqual([]);
    expect(loadQueue("p:new")).toEqual([]);
  });

  it("keeps existing text at the destination and appends queued work after it", () => {
    const store = memoryStorage();
    saveDraftText("p:new", "placeholder text", store);
    saveDraftText("p:s2", "already here", store);
    saveQueue("p:s2", [{ id: "old", text: "old", attachments: [] }]);
    saveQueue("p:new", [{ id: "new", text: "new", attachments: [] }]);
    moveDraft("p:new", "p:s2", store);
    expect(loadDraftText("p:s2", store)).toBe("already here");
    expect(loadQueue("p:s2").map((q) => q.id)).toEqual(["old", "new"]);
    saveQueue("p:s2", []);
  });

  it("is a no-op for identical or blank keys", () => {
    const store = memoryStorage();
    saveDraftText("k", "stay", store);
    moveDraft("k", "k", store);
    moveDraft("", "k", store);
    expect(loadDraftText("k", store)).toBe("stay");
  });
});

describe("pushHistory", () => {
  it("appends trimmed messages newest-last, dedupes, ignores blanks, caps", () => {
    let h = pushHistory([], " one ");
    h = pushHistory(h, "two");
    h = pushHistory(h, "one");
    h = pushHistory(h, "   ");
    expect(h).toEqual(["two", "one"]);
    expect(pushHistory(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
  });
});

describe("scheduled sends", () => {
  const msg = (id: string, dueAt: number): ScheduledMessage => ({
    id,
    text: id,
    dueAt,
    attachmentNames: [],
  });

  it("keeps the list ordered by due time and replaces by id", () => {
    let list = insertScheduled([], msg("b", 200));
    list = insertScheduled(list, msg("a", 100));
    list = insertScheduled(list, { ...msg("b", 50) });
    expect(list.map((m) => [m.id, m.dueAt])).toEqual([
      ["b", 50],
      ["a", 100],
    ]);
  });

  it("splits due from pending at the boundary", () => {
    const { due, pending } = partitionDue([msg("late", 300), msg("x", 100), msg("y", 200)], 200);
    expect(due.map((m) => m.id)).toEqual(["x", "y"]);
    expect(pending.map((m) => m.id)).toEqual(["late"]);
  });

  it("persists per key and drops malformed rows", () => {
    const store = memoryStorage();
    saveScheduled("k", [msg("a", 1)], store);
    expect(loadScheduled("k", store)).toEqual([msg("a", 1)]);
    store.data.set("harnesst:scheduled:bad", JSON.stringify([{ id: 1 }, msg("ok", 2)]));
    expect(loadScheduled("bad", store).map((m) => m.id)).toEqual(["ok"]);
    saveScheduled("k", [], store);
    expect(loadScheduled("k", store)).toEqual([]);
  });

  it("offers only future presets, including an evening slot only when it's far enough off", () => {
    const morning = new Date(2026, 0, 5, 9, 0).getTime();
    const late = new Date(2026, 0, 5, 17, 45).getTime();
    const early = schedulePresets(morning);
    expect(early.every((p) => p.dueAt > morning)).toBe(true);
    expect(early.some((p) => p.label.startsWith("This evening"))).toBe(true);
    expect(schedulePresets(late).some((p) => p.label.startsWith("This evening"))).toBe(false);
    const tomorrow = early.find((p) => p.label.startsWith("Tomorrow"))!;
    expect(new Date(tomorrow.dueAt).getDate()).toBe(6);
    expect(new Date(tomorrow.dueAt).getHours()).toBe(9);
  });

  it("moveScheduled merges into the destination in due order and clears the source", () => {
    const store = memoryStorage();
    saveScheduled("p:new", [msg("late", 300), msg("early", 100)], store);
    saveScheduled("p:s1", [msg("mid", 200)], store);
    moveScheduled("p:new", "p:s1", store);
    expect(loadScheduled("p:s1", store).map((m) => m.id)).toEqual(["early", "mid", "late"]);
    expect(loadScheduled("p:new", store)).toEqual([]);
  });

  it("formats countdowns", () => {
    expect(formatCountdown(0, 10)).toBe("due now");
    expect(formatCountdown(90_000, 0)).toBe("in 2m");
    expect(formatCountdown(2 * 3_600_000 + 10 * 60_000, 0)).toBe("in 2h 10m");
    expect(formatCountdown(3_600_000, 0)).toBe("in 1h");
    expect(formatCountdown(26 * 3_600_000, 0)).toBe("in 1d 2h");
  });
});

describe("fitWithin", () => {
  it("returns null when already small enough", () => {
    expect(fitWithin(2048, 1000)).toBeNull();
    expect(fitWithin(0, 0)).toBeNull();
  });
  it("scales the long edge down, keeping aspect", () => {
    expect(fitWithin(4096, 2048)).toEqual({ width: 2048, height: 1024 });
    expect(fitWithin(1000, 3000, 1500)).toEqual({ width: 500, height: 1500 });
  });
});

describe("distanceFromBottom", () => {
  it("measures the gap and never goes negative", () => {
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 })).toBe(100);
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 400 })).toBe(0);
  });
});

describe("code fence languages", () => {
  it("normalises aliases and blanks", () => {
    expect(normalizeLanguage("TS")).toBe("typescript");
    expect(normalizeLanguage("sh")).toBe("bash");
    expect(normalizeLanguage("")).toBe("text");
    expect(normalizeLanguage(undefined)).toBe("text");
    expect(normalizeLanguage("haskell")).toBe("haskell");
  });
  it("reads the language from hast or string classNames", () => {
    expect(languageFromClassName(["language-py", "x"])).toBe("py");
    expect(languageFromClassName("foo language-go")).toBe("go");
    expect(languageFromClassName(undefined)).toBeNull();
  });
});

describe("formatRelative", () => {
  it("buckets recent times and falls back to a clock time", async () => {
    const { formatRelative } = await import("~/components/chat");
    const now = new Date(2026, 3, 10, 15, 0).getTime();
    expect(formatRelative(new Date(now - 10_000), now)).toBe("just now");
    expect(formatRelative(new Date(now - 5 * 60_000), now)).toBe("5m ago");
    expect(formatRelative(new Date(now - 3 * 3_600_000), now)).not.toMatch(/ago|just/);
  });
});

describe("scrollIntent", () => {
  const at = (scrollTop: number, scrollHeight = 2000, clientHeight = 500) => ({ scrollTop, scrollHeight, clientHeight });

  it("detaches on any upward movement, even a few px inside the bottom band", () => {
    expect(scrollIntent(at(1500), at(1490))).toBe("detach");
    expect(scrollIntent(at(1500), at(800))).toBe("detach");
  });

  it("ignores upward movement the browser caused by clamping", () => {
    // content shrank
    expect(scrollIntent(at(1500), at(1400, 1900))).toBeNull();
    // viewport grew (composer shrank)
    expect(scrollIntent(at(1500), at(1450, 2000, 550))).toBeNull();
  });

  it("re-arms only when moving down into the bottom band", () => {
    expect(scrollIntent(at(1400), at(1480))).toBe("rearm");
    expect(scrollIntent(at(800), at(1000))).toBeNull();
  });

  it("treats sub-pixel jitter as no movement", () => {
    expect(scrollIntent(at(1500), at(1499.5))).toBeNull();
  });
});
