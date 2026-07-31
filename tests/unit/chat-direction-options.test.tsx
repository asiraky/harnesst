import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InputRequestsBlock } from "~/components/chat";
import type { ChatInputRequest } from "~/chat/types";

function render(request: ChatInputRequest): string {
  return renderToStaticMarkup(<InputRequestsBlock requests={[request]} />);
}

const fields = [
  {
    label: "Thesis",
    value: { type: "text" as const, text: "The product as a field guide." },
  },
  {
    label: "Palette",
    value: {
      type: "swatches" as const,
      swatches: [
        { color: "#102030", label: "Ink" },
        { color: "#f4e8cc", label: "Paper" },
      ],
    },
  },
];

describe("direction option cards", () => {
  it("renders a web sketch whole in a landscape frame with facts outside it", () => {
    const html = render({
      requestId: "req_1",
      prompt: "Choose a direction",
      surface: "web",
      options: [
        {
          id: "assigned",
          label: "Field guide",
          media: {
            artifactName: "sketch-assigned.webp",
            artifactVersionId: "ver_1",
            // A stale/hand-written per-option value must not override the request-wide frame.
            surface: "mobile",
            artifact: {
              id: "art_1",
              name: "sketch-assigned.webp",
              title: null,
              kind: "image",
              contentType: "image/webp",
              byteSize: 100,
              url: "/api/foh/proj_1/artifact/art_1/ver_1",
              version: 1,
            },
          } as never,
          fields,
        },
        {
          id: "challenger-1",
          label: "Ledger",
          media: {
            artifactName: "sketch-challenger-1.webp",
            artifactVersionId: "ver_2",
            surface: "native",
            artifact: {
              id: "art_2",
              name: "sketch-challenger-1.webp",
              title: null,
              kind: "image",
              contentType: "image/webp",
              byteSize: 100,
              url: "/api/foh/proj_1/artifact/art_2/ver_2",
              version: 1,
            },
          } as never,
        },
      ],
    });

    expect(html.match(/aspect-\[8\/5\]/g)).toHaveLength(2);
    expect(html).not.toContain("aspect-[9/16]");
    expect(html).toContain("object-contain");
    expect(html).toContain("Open sketch");
    expect(html).toContain("The product as a field guide.");
    expect(html).toContain("background-color:#102030");
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf("Thesis"));
  });

  it("uses portrait framing for mobile and native surfaces", () => {
    for (const surface of ["mobile", "native"] as const) {
      const html = render({
        requestId: `req_${surface}`,
        prompt: "Choose",
        surface,
        options: [
          {
            id: "assigned",
            label: "Pocket edition",
            media: {
              artifactId: "art_1",
              artifactVersionId: "ver_1",
              artifact: {
                id: "art_1",
                name: "pocket.webp",
                title: null,
                kind: "image",
                contentType: "image/webp",
                byteSize: 100,
                url: "/api/foh/proj_1/artifact/art_1/ver_1",
                version: 1,
              },
            },
            fields,
          },
        ],
      });

      expect(html).toContain("aspect-[9/16]");
      expect(html).toContain("max-w-sm");
    }
  });

  it("keeps structured text cards useful without rendering an empty image frame", () => {
    const html = render({
      requestId: "req_1",
      prompt: "Choose",
      options: [{ id: "assigned", label: "Field guide", fields }],
    });

    expect(html).not.toContain("<img");
    expect(html).not.toContain("Open sketch");
    expect(html).toContain("Thesis");
    expect(html).toContain("background-color:#102030");
  });

  it("does not load a wire-supplied external artifact URL", () => {
    const html = render({
      requestId: "req_1",
      prompt: "Choose",
      surface: "web",
      options: [
        {
          id: "assigned",
          label: "Unsafe",
          media: {
            artifactId: "art_1",
            artifactVersionId: "ver_1",
            artifact: {
              id: "art_1",
              name: "unsafe.png",
              title: null,
              kind: "image",
              contentType: "image/png",
              byteSize: 1,
              url: "https://tracker.invalid/pixel.png",
              version: 1,
            },
          },
        },
      ],
    });

    expect(html).not.toContain("<img");
    expect(html).not.toContain("tracker.invalid");
    expect(html).toContain("Unsafe");
  });
});
