import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  isSessionWorkspaceContinuationToken,
  SESSION_WORKSPACE_CHANNEL_NAME,
  SESSION_WORKSPACE_CHANNEL_SOURCE,
  SESSION_WORKSPACE_ID_HEADER,
  SESSION_WORKSPACE_ROUTE,
} from "~/deploy/session-workspace-channel";

describe("session workspace channel", () => {
  it("recognizes only continuation tokens owned by the private channel", () => {
    expect(
      isSessionWorkspaceContinuationToken(
        `${SESSION_WORKSPACE_CHANNEL_NAME}:workspace:abc`,
      ),
    ).toBe(true);
    expect(isSessionWorkspaceContinuationToken("session:abc")).toBe(false);
    expect(isSessionWorkspaceContinuationToken(null)).toBe(false);
  });

  it("ships syntactically valid TypeScript with authenticated create and continue routes", () => {
    const output = ts.transpileModule(SESSION_WORKSPACE_CHANNEL_SOURCE, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      reportDiagnostics: true,
    });

    expect(
      output.diagnostics?.filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      ),
    ).toEqual([]);
    expect(SESSION_WORKSPACE_CHANNEL_SOURCE).toContain(
      `const CREATE_ROUTE = "${SESSION_WORKSPACE_ROUTE}"`,
    );
    expect(SESSION_WORKSPACE_CHANNEL_SOURCE).toContain(
      `const WORKSPACE_HEADER = "${SESSION_WORKSPACE_ID_HEADER}"`,
    );
    expect(SESSION_WORKSPACE_CHANNEL_SOURCE).toContain(
      "state: { sandboxSessionId: workspace }",
    );
    expect(SESSION_WORKSPACE_CHANNEL_SOURCE).toContain("authorization");
  });
});
