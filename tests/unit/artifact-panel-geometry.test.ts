import { describe, expect, it } from "vitest";

import {
  clampPanelWidth,
  CONVERSATION_MIN_WIDTH,
  defaultPanelWidth,
  frameFit,
  PANEL_DEFAULT_WIDTH,
  PANEL_KEY_STEP,
  PANEL_KEY_STEP_LARGE,
  PANEL_MIN_WIDTH,
  panelMaxWidth,
  panelWidthForKey,
  parseStoredPanelWidth,
} from "~/components/artifacts/panel-geometry";

describe("clampPanelWidth", () => {
  it("keeps a width that fits", () => {
    expect(clampPanelWidth({ viewport: 1600, requested: 700 })).toBe(700);
  });

  it("never goes below the panel minimum", () => {
    expect(clampPanelWidth({ viewport: 1600, requested: 100 })).toBe(
      PANEL_MIN_WIDTH,
    );
  });

  it("leaves the conversation its minimum beside the reserved chrome", () => {
    expect(
      clampPanelWidth({ viewport: 1600, requested: 5000, reservedLeft: 256 }),
    ).toBe(1600 - 256 - CONVERSATION_MIN_WIDTH);
  });

  it("lets the panel minimum win when the window cannot fit both", () => {
    expect(
      clampPanelWidth({ viewport: 800, requested: 5000, reservedLeft: 256 }),
    ).toBe(PANEL_MIN_WIDTH);
  });

  it("treats a non-finite request as the default", () => {
    expect(clampPanelWidth({ viewport: 2000, requested: NaN })).toBe(
      PANEL_DEFAULT_WIDTH,
    );
  });

  it("rounds a fractional pointer position", () => {
    expect(clampPanelWidth({ viewport: 1600, requested: 500.6 })).toBe(501);
  });
});

describe("panelMaxWidth", () => {
  it("is never below the minimum", () => {
    expect(panelMaxWidth(500, 400)).toBe(PANEL_MIN_WIDTH);
  });
});

describe("defaultPanelWidth", () => {
  it("is 560 on a wide window", () => {
    expect(defaultPanelWidth(1920)).toBe(560);
  });

  it("is 45% of a narrower one", () => {
    expect(defaultPanelWidth(1000)).toBe(450);
  });
});

describe("parseStoredPanelWidth", () => {
  it("reads a stored width", () => {
    expect(parseStoredPanelWidth("640")).toBe(640);
  });

  it("rejects absent, garbage and too-small values", () => {
    for (const raw of [null, "", "  ", "wide", "NaN", "Infinity", "120"]) {
      expect(parseStoredPanelWidth(raw)).toBeNull();
    }
  });
});

describe("panelWidthForKey", () => {
  const at = (key: string, shiftKey = false, width = 600) =>
    panelWidthForKey({ key, shiftKey, width, min: 360, max: 900 });

  it("widens on ArrowLeft and narrows on ArrowRight", () => {
    expect(at("ArrowLeft")).toBe(600 + PANEL_KEY_STEP);
    expect(at("ArrowRight")).toBe(600 - PANEL_KEY_STEP);
  });

  it("takes bigger steps with Shift", () => {
    expect(at("ArrowLeft", true)).toBe(600 + PANEL_KEY_STEP_LARGE);
  });

  it("jumps to the extremes on Home and End", () => {
    expect(at("Home")).toBe(360);
    expect(at("End")).toBe(900);
  });

  it("clamps steps at the bounds", () => {
    expect(at("ArrowLeft", true, 890)).toBe(900);
    expect(at("ArrowRight", true, 370)).toBe(360);
  });

  it("ignores other keys", () => {
    expect(at("Enter")).toBeNull();
    expect(at("ArrowUp")).toBeNull();
  });
});

describe("frameFit", () => {
  it("fills the stage with no device width", () => {
    expect(frameFit(undefined, 600)).toEqual({ scale: 1 });
  });

  it("shows a device narrower than the stage at full size", () => {
    expect(frameFit(390, 600)).toEqual({ width: 390, scale: 1 });
  });

  it("scales a device wider than the stage down to fit", () => {
    expect(frameFit(768, 384)).toEqual({ width: 768, scale: 0.5 });
  });

  it("does not divide by an unmeasured stage", () => {
    expect(frameFit(768, 0)).toEqual({ scale: 1 });
  });
});
