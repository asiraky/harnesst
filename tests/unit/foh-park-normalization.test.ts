import { describe, expect, it } from "vitest";

import { inputRequestsOf } from "~/agent/talk.server";
import { normalizeParkRequests } from "~/foh/park.server";

describe("normalizeParkRequests rich option presentation", () => {
  it("keeps bounded media references and typed card fields", () => {
    const requests = normalizeParkRequests([
      {
        requestId: "req_1",
        prompt: "Choose a direction",
        surface: "web",
        options: [
          {
            id: "assigned",
            label: "Bespoke fitting",
            media: {
              artifactId: "art_1",
              artifactName: "sketch-assigned.webp",
              artifactVersionId: "ver_1",
              artifact: { url: "https://tracker.invalid/pixel.png" },
            },
            fields: [
              {
                label: "Thesis",
                value: {
                  type: "text",
                  text: "Recruiting as a bespoke fitting.",
                },
              },
              {
                label: "Palette",
                value: {
                  type: "swatches",
                  swatches: [
                    { color: "#1A1A1A", label: "Charcoal" },
                    { color: "#f5f1e8" },
                  ],
                },
              },
            ],
          },
        ],
      },
    ]);

    expect(requests?.[0].options?.[0]).toEqual({
      id: "assigned",
      label: "Bespoke fitting",
      description: null,
      style: null,
      media: {
        artifactId: "art_1",
        artifactName: "sketch-assigned.webp",
        artifactVersionId: "ver_1",
      },
      fields: [
        {
          label: "Thesis",
          value: { type: "text", text: "Recruiting as a bespoke fitting." },
        },
        {
          label: "Palette",
          value: {
            type: "swatches",
            swatches: [
              { color: "#1A1A1A", label: "Charcoal" },
              { color: "#f5f1e8", label: null },
            ],
          },
        },
      ],
    });
    expect(requests?.[0].surface).toBe("web");
  });

  it("drops unknown or unsafe presentation values without rejecting the option", () => {
    const requests = normalizeParkRequests([
      {
        requestId: "req_1",
        prompt: "Choose a direction",
        surface: "television",
        options: [
          {
            id: "assigned",
            label: "Editorial",
            media: {
              artifactVersionId: "ver_1",
            },
            fields: [
              { label: "Unknown", value: { type: "markdown", text: "**no**" } },
              {
                label: "Palette",
                value: {
                  type: "swatches",
                  swatches: [
                    { color: "url(https://tracker.invalid/pixel)" },
                    { color: "#abc" },
                  ],
                },
              },
            ],
          },
        ],
      },
    ]);

    expect(requests?.[0].options?.[0]).toMatchObject({
      id: "assigned",
      media: null,
      fields: [
        {
          label: "Palette",
          value: {
            type: "swatches",
            swatches: [{ color: "#abc", label: null }],
          },
        },
      ],
    });
    expect(requests?.[0].surface).toBeNull();
  });

  it("preserves the same rich fields when projecting eve's direct event stream", () => {
    const requests = inputRequestsOf({
      requests: [
        {
          requestId: "req_1",
          prompt: "Choose",
          surface: "mobile",
          options: [
            {
              id: "assigned",
              label: "Editorial",
              media: {
                artifactName: "sketch-assigned.webp",
                artifactVersionId: "ver_1",
              },
              fields: [
                {
                  label: "Risk",
                  value: { type: "text", text: "Dense on a small screen." },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(requests[0].options?.[0]).toMatchObject({
      id: "assigned",
      media: {
        artifactName: "sketch-assigned.webp",
        artifactVersionId: "ver_1",
      },
      fields: [
        {
          label: "Risk",
          value: { type: "text", text: "Dense on a small screen." },
        },
      ],
    });
    expect(requests[0].surface).toBe("mobile");
  });
});
