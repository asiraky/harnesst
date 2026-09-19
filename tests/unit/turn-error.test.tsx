import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { TurnError } from "~/components/turn-error";

function render(props: React.ComponentProps<typeof TurnError>) {
  return renderToString(
    <MemoryRouter>
      <TurnError {...props} />
    </MemoryRouter>,
  );
}

describe("TurnError recovery context", () => {
  it("preserves the original message even when details mention authentication", () => {
    const message = "Provider rejected this regional request";
    const html = render({
      message,
      detail: "OpenAI Codex needs authentication",
    });
    expect(html).toContain(message);
    expect(html).not.toContain("href=");
  });

  it.each(["codex/abcdefghijkl/test", "anthropic/mnopqrstuvwx/test"])(
    "links the explicit model's connection without parsing its error text: %s",
    (modelId) => {
      const message = "Upstream supplied diagnostic";
      const html = render({ message, modelId });
      expect(html).toContain(message);
      expect(html).toContain(
        `href="/settings/connections#connection-${modelId.split("/")[1]}"`,
      );
    },
  );
});
