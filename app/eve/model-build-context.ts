import ts from "typescript";

function declaration(source: string) {
  const file = ts.createSourceFile(
    "agent.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const exported = file.statements.find(ts.isExportAssignment)?.expression;
  const config =
    exported &&
    ts.isCallExpression(exported) &&
    exported.expression.getText(file) === "defineAgent"
      ? exported.arguments[0]
      : undefined;
  if (
    !config ||
    !ts.isObjectLiteralExpression(config) ||
    config.properties.some(
      (p) =>
        ts.isSpreadAssignment(p) ||
        (p.name && ts.isComputedPropertyName(p.name)),
    )
  )
    throw new Error(
      "Cannot supply model build metadata to a custom agent declaration.",
    );
  const properties = config.properties.filter(
    (p) =>
      p.name &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === "modelContextWindowTokens",
  );
  if (
    properties.length > 1 ||
    properties.some((p) => !ts.isPropertyAssignment(p))
  )
    throw new Error("Ambiguous model context window in agent declaration.");
  return {
    file,
    config,
    property: properties[0] as ts.PropertyAssignment | undefined,
  };
}

export function agentBuildContextWindow(source: string): number | null {
  const { property } = declaration(source);
  const value =
    property && ts.isNumericLiteral(property.initializer)
      ? Number(property.initializer.text)
      : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Compile-time snapshot only. Dynamic model selections supply the live window per step. */
export function withAgentBuildContextWindow(
  source: string,
  tokens: number,
): string {
  if (!Number.isSafeInteger(tokens) || tokens <= 0)
    throw new Error("No known positive model context window for this agent.");
  if (agentBuildContextWindow(source) !== null) return source;
  const { file, config, property } = declaration(source);
  if (property)
    return (
      source.slice(0, property.initializer.getStart(file)) +
      tokens +
      source.slice(property.initializer.end)
    );
  const at = config.getStart(file) + 1;
  return (
    source.slice(0, at) +
    `\n  modelContextWindowTokens: ${tokens},` +
    source.slice(at)
  );
}
