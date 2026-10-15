import { describe, expect, it } from "vitest";

import { resolveConnectionLink, type LinkOption } from "~/provisioners/link";

const active = (id: string): LinkOption => ({
  id,
  label: id,
  status: "active",
});
const invalid = (id: string): LinkOption => ({
  id,
  label: id,
  status: "invalid",
});
const expired = (id: string): LinkOption => ({
  id,
  label: id,
  status: "expired",
});

describe("resolveConnectionLink", () => {
  it("asks for a connection when the workspace has none", () => {
    expect(resolveConnectionLink(null, [])).toEqual({ state: "none" });
  });

  it("auto-selects the only connection without marking it linked", () => {
    expect(resolveConnectionLink(null, [active("a")])).toEqual({
      state: "ready",
      connection: active("a"),
      linked: false,
    });
  });

  it("asks to choose when several exist and none is linked", () => {
    expect(resolveConnectionLink(null, [active("a"), active("b")])).toEqual({
      state: "choose",
      options: [active("a"), active("b")],
    });
  });

  it("uses the linked connection over others", () => {
    expect(resolveConnectionLink("b", [active("a"), active("b")])).toEqual({
      state: "ready",
      connection: active("b"),
      linked: true,
    });
  });

  it.each([expired("b"), invalid("b")])(
    "asks to reconnect when the linked connection is $status",
    (linked) => {
      expect(resolveConnectionLink("b", [active("a"), linked])).toEqual({
        state: "reconnect",
        connection: linked,
      });
    },
  );

  it("asks to reconnect when the only connection is unusable", () => {
    expect(resolveConnectionLink(null, [expired("a")])).toEqual({
      state: "reconnect",
      connection: expired("a"),
    });
  });

  it("falls back to auto-selection when the linked connection was removed", () => {
    expect(resolveConnectionLink("gone", [active("a")])).toMatchObject({
      state: "ready",
      linked: false,
    });
    expect(resolveConnectionLink("gone", [])).toEqual({ state: "none" });
  });
});
