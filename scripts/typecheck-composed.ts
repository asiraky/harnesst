#!/usr/bin/env tsx
/**
 * Compile what harnesst ships, not just harnesst itself (#336).
 *
 * The matrix comes from catalog/index.json, so every new catalog entry is compiled automatically.
 * Each entry is resolved through the real include composer, staged at its real install paths, and
 * combined with the platform-generated model module and build-time sources. A kitchen-sink fixture
 * adds subagents and teammate tools; a migration fixture compiles the legacy-import rewriter.
 *
 * External package declarations are deliberately thin. This check owns the interface between
 * harnesst's producers and a NodeNext project: strictness, relative resolution, JSON imports, and
 * the generated source itself. The customer's actual image build remains responsible for checking
 * third-party package APIs against the exact dependency versions selected by that project.
 */
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  orgModelModuleSource,
  rewriteOrgModelImports,
  scaffoldOrgModelAgentModule,
} from "~/eve/org-model-module";
import { planInstall } from "~/marketplace/install.server";
import { resolveTemplate } from "~/marketplace/compose.server";
import { emptyLock } from "~/marketplace/lock";
import {
  HARNESST_RUN_HOOK_PATH,
  HARNESST_RUN_HOOK_SOURCE,
} from "~/observability/run-hook-template";
import { fixtureCatalog } from "~/seams/oss/catalog.fixture.server";
import {
  ASK_TEAMMATE_TOOL_PATH,
  ASK_TEAMMATE_TOOL_SOURCE,
  CONTACT_USER_TOOL_PATH,
  CONTACT_USER_TOOL_SOURCE,
  TELL_TEAMMATE_TOOL_PATH,
  TELL_TEAMMATE_TOOL_SOURCE,
} from "~/team/tool-template";
import {
  SESSION_WORKSPACE_CHANNEL_PATH,
  SESSION_WORKSPACE_CHANNEL_SOURCE,
} from "~/deploy/session-workspace-channel";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_PATH = path.join(ROOT, "config/composed-tsconfig.json");

type FixtureFiles = Record<string, string>;

async function writeFixture(root: string, name: string, files: FixtureFiles) {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), '{"type":"module"}\n');
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const destination = path.join(dir, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }),
  );
}

function baseFiles(agentName: string): FixtureFiles {
  return {
    "agent/agent.ts": scaffoldOrgModelAgentModule(agentName),
    "harnesst/model.ts": orgModelModuleSource(),
    [HARNESST_RUN_HOOK_PATH]: HARNESST_RUN_HOOK_SOURCE,
    [CONTACT_USER_TOOL_PATH]: CONTACT_USER_TOOL_SOURCE,
    [SESSION_WORKSPACE_CHANNEL_PATH]: SESSION_WORKSPACE_CHANNEL_SOURCE,
  };
}

async function materializeMatrix(root: string): Promise<number> {
  const index = await fixtureCatalog.index();
  for (const entry of index.templates) {
    const resolved = await resolveTemplate(
      fixtureCatalog,
      entry.type,
      entry.id,
    );
    const files = baseFiles(entry.id);
    applyInstall(files, resolved);
    await writeFixture(root, `catalog-${entry.type}-${entry.id}`, files);
  }

  const kitchenSink: FixtureFiles = {
    ...baseFiles("kitchen-sink"),
    "agent/subagents/reader/agent.ts": scaffoldOrgModelAgentModule(
      "kitchen-sink",
      { subagentPath: "reader" },
    ),
    [ASK_TEAMMATE_TOOL_PATH]: ASK_TEAMMATE_TOOL_SOURCE,
    [TELL_TEAMMATE_TOOL_PATH]: TELL_TEAMMATE_TOOL_SOURCE,
  };
  for (const entry of index.templates.filter(
    (item) => item.type === "connection",
  )) {
    applyInstall(
      kitchenSink,
      await resolveTemplate(fixtureCatalog, entry.type, entry.id),
    );
  }
  await writeFixture(root, "kitchen-sink", kitchenSink);

  await writeFixture(root, "legacy-migration", {
    ...baseFiles("legacy"),
    "agent/agent.ts": rewriteOrgModelImports(
      "import { harnesstAgentModel } from './harnesst-model';\n" +
        "export const model = harnesstAgentModel('legacy');\n",
      0,
    ),
  });

  return index.templates.length + 2;
}

function applyInstall(
  files: FixtureFiles,
  template: Awaited<ReturnType<typeof resolveTemplate>>,
): void {
  const plan = planInstall({
    template,
    registry: "fixture",
    repoPaths: [],
    drafts: [],
    packageJson:
      files["package.json"] ?? '{"type":"module","dependencies":{}}\n',
    lock: emptyLock(),
    target: { kind: "member", memberName: null, root: "agent" },
  });
  if (plan.conflicts.length > 0) {
    throw new Error(
      `Could not compose ${template.manifest.type}/${template.manifest.id}: ${plan.conflicts.join(", ")}`,
    );
  }
  for (const write of plan.writes) files[write.path] = write.content;
}

async function typescriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) files.push(absolute);
    }
  }
  await walk(root);
  return files;
}

/** Create contextual-any declarations for packages outside the composed tree. */
function externalModuleDeclarations(
  files: Array<{ path: string; source: string }>,
  options: ts.CompilerOptions,
): string {
  const exportsByModule = new Map<string, Set<string>>();
  const defaults = new Set<string>();

  for (const file of files) {
    const sourceFile = ts.createSourceFile(
      file.path,
      file.source,
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      if (
        ts.resolveModuleName(specifier, file.path, options, ts.sys)
          .resolvedModule
      ) {
        continue;
      }
      const names = exportsByModule.get(specifier) ?? new Set<string>();
      const clause = statement.importClause;
      if (clause?.name) defaults.add(specifier);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          names.add(element.propertyName?.text ?? element.name.text);
        }
      }
      exportsByModule.set(specifier, names);
    }
  }

  return [...exportsByModule]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([specifier, names]) => {
      const lines = [`declare module ${JSON.stringify(specifier)} {`];
      if (defaults.has(specifier)) {
        lines.push(
          "  const defaultExport: any;",
          "  export default defaultExport;",
        );
      }
      for (const name of [...names].sort()) {
        lines.push(
          `  export function ${name}<T = any>(...args: any[]): any;`,
          `  export type ${name} = any;`,
        );
      }
      lines.push("}");
      return lines.join("\n");
    })
    .join("\n\n");
}

function compilerOptions(): ts.CompilerOptions {
  const config = ts.readConfigFile(CONFIG_PATH, ts.sys.readFile);
  if (config.error)
    throw new Error(ts.formatDiagnostic(config.error, diagnosticHost));
  const parsed = ts.convertCompilerOptionsFromJson(
    config.config.compilerOptions ?? {},
    path.dirname(CONFIG_PATH),
  );
  if (parsed.errors.length > 0) {
    throw new Error(ts.formatDiagnostics(parsed.errors, diagnosticHost));
  }
  return {
    ...parsed.options,
    baseUrl: ROOT,
    // Shipped projects use Zod 4. The control plane still has Zod 3 at its package root, while
    // Better Auth brings the same Zod 4 release the generated/package templates request.
    paths: { zod: ["node_modules/better-auth/node_modules/zod/index.d.cts"] },
  };
}

const diagnosticHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (name) => name,
  getCurrentDirectory: () => ROOT,
  getNewLine: () => "\n",
};

function untypedFunctionDiagnostics(
  files: Array<{ path: string; source: string }>,
): string[] {
  const failures: string[] = [];
  for (const file of files) {
    if (
      file.source.split("\n", 2).some((line) => line.includes("@ts-nocheck"))
    ) {
      continue;
    }
    const sourceFile = ts.createSourceFile(
      file.path,
      file.source,
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      const isConcreteFunction =
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node);
      if (
        isConcreteFunction &&
        (ts.isFunctionDeclaration(node) || !hasContextualFunctionType(node))
      ) {
        for (const parameter of node.parameters) {
          if (parameter.type) continue;
          const position = sourceFile.getLineAndCharacterOfPosition(
            parameter.getStart(sourceFile),
          );
          failures.push(
            `${file.path}:${position.line + 1}:${position.character + 1}: generated function parameter must have an explicit type`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return failures;
}

/**
 * External packages give callbacks their parameter types in the real project. The intentionally
 * thin module stubs used by this check cannot model those APIs, so distinguish a callback living
 * inside a typed/call context from a generated standalone function that must declare its own
 * parameter types.
 */
function hasContextualFunctionType(node: ts.Node): boolean {
  let current = node;
  while (current.parent && !ts.isSourceFile(current.parent)) {
    const parent = current.parent;
    if (
      (ts.isVariableDeclaration(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isParameter(parent)) &&
      parent.initializer === current
    ) {
      return Boolean(parent.type);
    }
    if (
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isSatisfiesExpression(parent)
    ) {
      return true;
    }
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      return Boolean(parent.arguments?.includes(current as ts.Expression));
    }
    if (
      parent !== node &&
      (ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isArrowFunction(parent) ||
        ts.isMethodDeclaration(parent))
    ) {
      return false;
    }
    current = parent;
  }
  return false;
}

export async function typecheckComposedProjects(): Promise<number> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "harnesst-composed-"));
  try {
    await symlink(
      path.join(ROOT, "node_modules"),
      path.join(tempRoot, "node_modules"),
      "dir",
    );
    const fixtureCount = await materializeMatrix(tempRoot);
    const paths = await typescriptFiles(tempRoot);
    const sources = await Promise.all(
      paths.map(async (filePath) => ({
        path: filePath,
        source: await readFile(filePath, "utf8"),
      })),
    );
    const explicitTypeFailures = untypedFunctionDiagnostics(sources);
    if (explicitTypeFailures.length > 0) {
      throw new Error(
        `Composed agent source has untyped generated functions:\n${explicitTypeFailures.join("\n")}`,
      );
    }
    const options = compilerOptions();
    const declarationsPath = path.join(tempRoot, "external-modules.d.ts");
    await writeFile(
      declarationsPath,
      externalModuleDeclarations(sources, options),
    );

    const program = ts.createProgram([...paths, declarationsPath], options);
    // Eve and the AI SDK supply callback context in the real image. The fallback declarations
    // above cannot reproduce those entire APIs, so ignore only their contextual-any fallout.
    // Explicit function declarations are checked independently above; every other diagnostic
    // (including unknown catch values, relative resolution, and JSON import attributes) stays.
    const stubFallout = new Set([7006, 7031, 2347]);
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => !stubFallout.has(diagnostic.code));
    if (diagnostics.length > 0) {
      const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        ...diagnosticHost,
        getCurrentDirectory: () => tempRoot,
      });
      throw new Error(
        `Composed agent source does not typecheck:\n${formatted}`,
      );
    }
    return fixtureCount;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  typecheckComposedProjects()
    .then((count) =>
      console.log(`typecheck-composed: ok (${count} derived fixtures)`),
    )
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
