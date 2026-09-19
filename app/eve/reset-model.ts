import ts from "typescript";

import { orgModelImportSpecifier } from "~/eve/org-model-module";

const unsupported = () =>
  new Error(
    "This agent has custom model logic that HARNESST cannot safely reset. Use a standard defineAgent model declaration before resetting to the workspace default.",
  );

function nameOf(node: ts.PropertyName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteral(node)
    ? node.text
    : undefined;
}

function literal(node: ts.Node): boolean {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** Compare syntax rather than formatting, comments, or quote style. */
function shape(node: ts.Node): string {
  const children: string[] = [];
  ts.forEachChild(node, (child) => {
    children.push(shape(child));
  });
  const value =
    ts.isIdentifier(node) || literal(node) || ts.isNumericLiteral(node)
      ? (node as ts.Identifier).text
      : "";
  return JSON.stringify([node.kind, value, children]);
}

function expression(source: string): ts.Expression {
  const file = ts.createSourceFile(
    "expression.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  return (file.statements[0] as ts.ExpressionStatement).expression;
}

// These are the generated playground-directive handlers shipped by agentModule.ts, including
// its two older provider-routing generations. Anything else may carry user behavior; reject it.
const generatedHandlers = [
  "harnesstModel(selected.id, selected.effort)",
  "harnesstModel(selected.id)",
  "openrouter.chatModel(selected.id)",
].map((model) =>
  shape(
    expression(`(_event, ctx) => {
    const selected = harnesstSelectedModel(ctx.messages);
    if (!selected) return null;
    return { model: ${model}, modelContextWindowTokens: selected.contextWindowTokens };
  }`),
  ),
);

function generatedDynamic(node: ts.CallExpression, source: string): boolean {
  if (!source.includes("// harnesst playground model override:")) return false;
  if (
    node.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(node.arguments[0])
  )
    return false;
  const properties = node.arguments[0].properties.filter(
    ts.isPropertyAssignment,
  );
  if (properties.length !== 2 || node.arguments[0].properties.length !== 2)
    return false;
  const fallback = properties.find(
    (property) => nameOf(property.name) === "fallback",
  );
  const events = properties.find(
    (property) => nameOf(property.name) === "events",
  );
  if (!fallback || !events || !staticModel(fallback.initializer)) return false;
  if (
    !ts.isObjectLiteralExpression(events.initializer) ||
    events.initializer.properties.length !== 1
  )
    return false;
  const handler = events.initializer.properties[0];
  return (
    ts.isPropertyAssignment(handler) &&
    nameOf(handler.name) === "step.started" &&
    generatedHandlers.includes(shape(handler.initializer))
  );
}

function staticModel(node: ts.Expression): boolean {
  if (literal(node)) return true;
  if (!ts.isCallExpression(node) || !node.arguments.every(literal))
    return false;
  const callee = node.expression.getText();
  return (
    (callee === "harnesstModel" &&
      node.arguments.length >= 1 &&
      node.arguments.length <= 2) ||
    (["openrouter", "openrouter.chatModel"].includes(callee) &&
      node.arguments.length === 1)
  );
}

/**
 * Opt a standard agent into live workspace/parent inheritance. Edits only the model properties
 * and resolver import: tools, instructions, and even neighboring source formatting survive.
 * Unknown dynamic behavior is deliberately rejected instead of silently discarded.
 */
export function resetAgentModelSource(
  source: string,
  agentName: string,
  subagentPath = "",
): string {
  const file = ts.createSourceFile(
    "agent.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const diagnostics = (
    file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (diagnostics.length) throw unsupported();
  const exports = file.statements.filter(ts.isExportAssignment);
  if (exports.length !== 1 || exports[0].isExportEquals) throw unsupported();
  const call = exports[0].expression;
  if (
    !ts.isCallExpression(call) ||
    call.expression.getText(file) !== "defineAgent" ||
    call.arguments.length !== 1
  )
    throw unsupported();
  const config = call.arguments[0];
  if (
    !ts.isObjectLiteralExpression(config) ||
    config.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) ||
        (property.name && ts.isComputedPropertyName(property.name)),
    )
  )
    throw unsupported();

  const imports = file.statements.filter(ts.isImportDeclaration);
  const eveBindings = imports
    .filter(
      (item) =>
        ts.isStringLiteral(item.moduleSpecifier) &&
        item.moduleSpecifier.text === "eve" &&
        !item.importClause?.isTypeOnly,
    )
    .flatMap((item) =>
      item.importClause?.namedBindings &&
      ts.isNamedImports(item.importClause.namedBindings)
        ? [...item.importClause.namedBindings.elements]
        : [],
    );
  if (
    !eveBindings.some(
      (item) =>
        item.name.text === "defineAgent" &&
        !item.propertyName &&
        !item.isTypeOnly,
    )
  )
    throw unsupported();

  // Config-level event hooks can bypass the model slot altogether. A hook referring to model
  // selection is custom logic even when the model property's own value looks ordinary.
  for (const property of config.properties) {
    if (!property.name || nameOf(property.name) !== "events") continue;
    let choosesModel = false;
    const visit = (node: ts.Node) => {
      if (
        (ts.isIdentifier(node) || ts.isStringLiteral(node)) &&
        ["model", "reasoning", "modelContextWindowTokens"].includes(node.text)
      )
        choosesModel = true;
      ts.forEachChild(node, visit);
    };
    visit(property);
    if (
      !ts.isPropertyAssignment(property) ||
      !ts.isObjectLiteralExpression(property.initializer) ||
      choosesModel
    )
      throw unsupported();
  }

  const selections = config.properties.filter(
    (property) =>
      property.name &&
      ["model", "reasoning", "modelContextWindowTokens"].includes(
        nameOf(property.name) ?? "",
      ),
  );
  const names = selections.map((property) => nameOf(property.name!));
  if (
    new Set(names).size !== names.length ||
    !selections.every(ts.isPropertyAssignment)
  )
    throw unsupported();
  const model = selections.find(
    (property) => nameOf(property.name) === "model",
  );
  if (model) {
    const value = model.initializer;
    const resolver =
      ts.isCallExpression(value) &&
      value.expression.getText(file) === "harnesstAgentModel" &&
      value.arguments.length >= 1 &&
      value.arguments.length <= 2 &&
      value.arguments.every(literal);
    const dynamic =
      ts.isCallExpression(value) &&
      value.expression.getText(file) === "defineDynamic" &&
      eveBindings.some(
        (binding) =>
          binding.name.text === "defineDynamic" &&
          !binding.propertyName &&
          !binding.isTypeOnly,
      ) &&
      generatedDynamic(value, source);
    if (!resolver && !dynamic && !staticModel(value)) throw unsupported();
    if (!resolver && !dynamic && ts.isCallExpression(value)) {
      const callee = value.expression.getText(file);
      if (
        callee === "harnesstModel" &&
        !source.includes("// harnesst playground model override:")
      )
        throw unsupported();
      if (callee.startsWith("openrouter")) {
        const factories = file.statements
          .filter(ts.isVariableStatement)
          .flatMap((statement) => [...statement.declarationList.declarations])
          .filter(
            (declaration) =>
              ts.isIdentifier(declaration.name) &&
              declaration.name.text === "openrouter",
          );
        const factory = factories[0]?.initializer;
        if (
          factories.length !== 1 ||
          !factory ||
          !ts.isCallExpression(factory) ||
          !["createOpenAICompatible", "createOpenRouter"].includes(
            factory.expression.getText(file),
          )
        )
          throw unsupported();
      }
    }
  }
  for (const property of selections) {
    if (nameOf(property.name) === "reasoning" && !literal(property.initializer))
      throw unsupported();
    if (
      nameOf(property.name) === "modelContextWindowTokens" &&
      !ts.isNumericLiteral(property.initializer)
    )
      throw unsupported();
  }

  const segments = subagentPath.split("/").filter(Boolean);
  const specifier = orgModelImportSpecifier(segments.length * 2);
  const target = [agentName, ...(segments.length ? [segments.join("/")] : [])]
    .map((value) => JSON.stringify(value))
    .join(", ");
  const edits: { start: number; end: number; text: string }[] = [];
  const resolverImports = imports.filter(
    (item) =>
      item.importClause?.namedBindings &&
      ts.isNamedImports(item.importClause.namedBindings) &&
      item.importClause.namedBindings.elements.some(
        (binding) => binding.name.text === "harnesstAgentModel",
      ),
  );
  if (resolverImports.length > 1) throw unsupported();
  if (resolverImports.length) {
    const existing = resolverImports[0];
    const bindings = existing.importClause?.namedBindings;
    if (
      existing.importClause?.isTypeOnly ||
      !bindings ||
      !ts.isNamedImports(bindings) ||
      bindings.elements.some(
        (binding) =>
          binding.name.text === "harnesstAgentModel" &&
          (binding.isTypeOnly || binding.propertyName),
      ) ||
      !ts.isStringLiteral(existing.moduleSpecifier) ||
      !/^(?:\.\.?\/)+(?:harnesst\/model|harnesst-model)(?:\.[jt]s)?$/.test(
        existing.moduleSpecifier.text,
      )
    )
      throw unsupported();
    if (existing.moduleSpecifier.text !== specifier) {
      edits.push({
        start: existing.moduleSpecifier.getStart(file),
        end: existing.moduleSpecifier.end,
        text: JSON.stringify(specifier),
      });
    }
  } else {
    // A preexisting local binding would make the new import ambiguous or change custom behavior.
    let collision = false;
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === "harnesstAgentModel")
        collision = true;
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (collision) throw unsupported();
    const at = imports.at(-1)?.end ?? 0;
    edits.push({
      start: at,
      end: at,
      text: `\nimport { harnesstAgentModel } from ${JSON.stringify(specifier)};\n`,
    });
  }
  if (model) {
    const replacement = `harnesstAgentModel(${target})`;
    if (shape(model.initializer) !== shape(expression(replacement))) {
      edits.push({
        start: model.initializer.getStart(file),
        end: model.initializer.end,
        text: replacement,
      });
    }
  } else {
    edits.push({
      start: config.getStart(file) + 1,
      end: config.getStart(file) + 1,
      text: `\n  model: harnesstAgentModel(${target}),`,
    });
  }
  for (const property of selections) {
    if (property === model) continue;
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      true,
      ts.LanguageVariant.Standard,
      source,
      undefined,
      property.end,
    );
    const end =
      scanner.scan() === ts.SyntaxKind.CommaToken
        ? scanner.getTextPos()
        : property.end;
    edits.push({ start: property.getStart(file), end, text: "" });
  }
  return edits
    .sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce(
      (result, edit) =>
        result.slice(0, edit.start) + edit.text + result.slice(edit.end),
      source,
    );
}
