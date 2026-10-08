import { describe, expect, it, vi } from "vitest";

import { filesForResend } from "~/components/chat/live-attachments";

const att = (over: Record<string, unknown> = {}) => ({
  id: "x",
  name: "invoice.pdf",
  mediaType: "application/pdf",
  size: 4,
  url: "/api/chat/uploads/p/s/abc",
  ...over,
});

describe("filesForResend", () => {
  it("resends nothing for a text-only turn", async () => {
    expect(await filesForResend(undefined)).toEqual([]);
    expect(await filesForResend([])).toEqual([]);
  });

  it("reuses a live turn's File without fetching", async () => {
    const file = new File(["%PDF"], "invoice.pdf", { type: "application/pdf" });
    const fetchImpl = vi.fn();
    const out = await filesForResend([att({ url: null, file })], fetchImpl as never);
    expect(out).toEqual([file]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-fetches a persisted upload as a File with its name and type", async () => {
    const fetchImpl = vi.fn(async () => new Response("%PDF"));
    const [file] = (await filesForResend([att()], fetchImpl as never))!;
    expect(fetchImpl).toHaveBeenCalledWith("/api/chat/uploads/p/s/abc", expect.anything());
    expect(file!.name).toBe("invoice.pdf");
    expect(file!.type).toBe("application/pdf");
    expect(await file!.text()).toBe("%PDF");
  });

  it("refuses (null) when any file can't be recovered, rather than dropping it", async () => {
    const ok = vi.fn(async () => new Response("%PDF"));
    expect(await filesForResend([att(), att({ url: null })], ok as never)).toBeNull();
    const gone = vi.fn(async () => new Response("", { status: 404 }));
    expect(await filesForResend([att()], gone as never)).toBeNull();
  });
});
