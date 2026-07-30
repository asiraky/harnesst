import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  FohRelativeTime,
  relativeTimeLabel,
} from "~/components/foh/relative-time";

describe("relativeTimeLabel", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");

  it.each([
    ["2026-07-30T11:59:30.000Z", "now"],
    ["2026-07-30T11:58:00.000Z", "2m"],
    ["2026-07-30T10:00:00.000Z", "2h"],
  ])("formats %s as %s", (value, expected) => {
    expect(relativeTimeLabel(value, now)).toBe(expected);
  });

  it("returns an empty label for an invalid date", () => {
    expect(relativeTimeLabel("not-a-date", now)).toBe("");
  });
});

describe("FohRelativeTime", () => {
  it("keeps a compact label visible in the server output", () => {
    const html = renderToString(
      <FohRelativeTime value={new Date().toISOString()} />,
    );

    expect(html).toBe("<span>now</span>");
  });
});
