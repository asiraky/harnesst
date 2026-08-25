/**
 * Recruit — a marketplace template's detail page (PRD §7.8, Milestone 6 phase 1).
 *
 * Shows the whole template so a customer can decide before installing: the manifest facts
 * (version, eve range, suggested model), what it will ask of them (required secrets, npm
 * dependencies), and every file it ships — each collapsible, with its content in a scrollable
 * pre. The full template (files included) comes through the CatalogSource seam.
 *
 * The Install button is rendered DISABLED on purpose: it is the seam for phase 2 (the install
 * wizard + change-set materialization). Wiring it up is the next milestone phase, not this one.
 */
import { sessionLoader } from "~/auth/session.server";
import { data, Link, type LoaderFunctionArgs } from "react-router";

import { MarkdownText } from "~/components/chat";
import { CodeEditor } from "~/components/code-editor";
import { TYPE_META, TypeBadge } from "~/components/marketplace-type-badge";
import { AppShell, PageHeader } from "~/components/shell";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  TEMPLATE_TYPES,
  isTemplateSlug,
  type TemplateType,
} from "~/marketplace/manifest";
import { getRuntime } from "~/seams/index.server";
import {
  ensureWorkspace,
  requireWorkspaceAdmin,
  resolveActiveWorkspace,
} from "~/auth/workspace.server";
import type { Route } from "./+types/marketplace.$type.$id";

/** Narrow a URL param to a TemplateType, 404-ing on anything else (unknown type = no such page). */
function parseType(param: string | undefined): TemplateType {
  if (TEMPLATE_TYPES.includes(param as TemplateType))
    return param as TemplateType;
  throw data("Unknown template type", { status: 404 });
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const type = parseType(args.params.type);
      const id = args.params.id!;
      // Gate the raw URL param before it reaches a CatalogSource — the fixture impl joins the
      // id into a filesystem path, so a non-slug id is a path-traversal attempt, not a miss.
      if (!isTemplateSlug(id)) throw data("Unknown template", { status: 404 });
      await ensureWorkspace(args.request, auth);
      const active = await resolveActiveWorkspace(auth);
      if (active) requireWorkspaceAdmin(active, "page");
      const org = active?.org;
      try {
        // Detail deliberately shows the UNRESOLVED template (catalog.template, not
        // resolveTemplate): the manifest's own `files`/`secrets`/`includes` as authored. The
        // "Includes" section links out to each referenced template; the flattened, materialized
        // view (what actually installs) is the install wizard's job.
        const template = await getRuntime().catalog.template(type, id);
        return { org, template };
      } catch (error) {
        // A missing template (or unreachable catalog) is a 404 for this URL — nothing to show.
        // The underlying error stays server-side: fixture failures name filesystem paths.
        console.warn(
          `[marketplace] template ${type}/${id} failed to load:`,
          error,
        );
        throw data(`Template ${type}/${id} isn't in the catalog.`, {
          status: 404,
        });
      }
    },
    { ensureSignedIn: true },
  );

export function meta() {
  return [{ title: "Marketplace · harnesst" }];
}

export default function TemplateDetail({ loaderData }: Route.ComponentProps) {
  const { user, template } = loaderData;
  const { manifest, files } = template;
  const deps = Object.entries(manifest.dependencies ?? {});
  // Issue #47: provisioned secrets (GITHUB_APP_ID and friends) are harnesst's concern, set by the
  // Create GitHub App guided flow on the Deployment tab — never something the user provides. Keep
  // them out of the "Secrets you provide" list; if EVERY secret is provisioned, the card is dropped
  // entirely (the Setup card already tells the user to run Create GitHub App).
  // Issue #163: generated secrets are minted by harnesst at first deploy — like provisioned ones,
  // never something the user provides.
  const secrets = manifest.secrets ?? [];
  const userSecrets = secrets.filter((s) => !s.provisioned && !s.generated);
  const provisionedSecrets = secrets.filter((s) => s.provisioned);
  const generatedSecrets = secrets.filter((s) => s.generated);
  const showSecretsCard = userSecrets.length > 0 || secrets.length === 0;

  return (
    <AppShell userEmail={user.email}>
      <div className="mb-4">
        <Link
          to="/marketplace"
          prefetch="intent"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          ← Marketplace
        </Link>
      </div>

      <PageHeader
        icon={TYPE_META[manifest.type].icon}
        accent={TYPE_META[manifest.type].accent}
        title={
          <span className="flex items-center gap-3">
            {manifest.name}
            <TypeBadge type={manifest.type} />
          </span>
        }
        description={manifest.description}
        actions={
          <Button asChild>
            <Link to="./install" prefetch="intent">
              Install
            </Link>
          </Button>
        }
      />

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
            <Fact label="Version">
              <span className="font-mono">v{manifest.version}</span>
            </Fact>
            <Fact label="eve range">
              <span className="font-mono">{manifest.eve}</span>
            </Fact>
            <Fact label="Type">
              <TypeBadge type={manifest.type} />
            </Fact>
            {manifest.model && (
              <Fact label="Suggested model">
                <span className="font-mono">{manifest.model}</span>
              </Fact>
            )}
          </CardContent>
        </Card>

        {manifest.setup && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Setup</CardTitle>
              <CardDescription>
                One-time setup to complete before this works.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              <MarkdownText text={manifest.setup} />
            </CardContent>
          </Card>
        )}

        {manifest.includes && manifest.includes.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Includes</CardTitle>
              <CardDescription>
                Bundled from the catalog. These are materialized into the target
                agent at install — you don&rsquo;t install them separately.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {manifest.includes.map((inc) => (
                  <li
                    key={`${inc.type}/${inc.id}`}
                    className="flex items-center gap-2"
                  >
                    <Link
                      to={`/marketplace/${inc.type}/${inc.id}`}
                      prefetch="intent"
                      className="font-mono text-xs underline-offset-4 hover:underline"
                    >
                      {inc.id}
                    </Link>
                    <TypeBadge type={inc.type} />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-6 sm:grid-cols-2">
          {/* Issue #47: only "Secrets you provide" (non-provisioned). When every secret is
              provisioned, this card is dropped and the npm card stands alone in the grid. */}
          {showSecretsCard && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Secrets you provide</CardTitle>
                <CardDescription>
                  Values go to the secrets store, never the repo. The install
                  wizard collects them.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {userSecrets.length > 0 ? (
                  <ul className="space-y-2 text-sm">
                    {userSecrets.map((s) => (
                      <li key={s.name}>
                        <span className="font-mono text-xs">{s.name}</span>
                        {s.description && (
                          <span className="block text-xs text-muted-foreground">
                            {s.description}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">None.</p>
                )}
                {provisionedSecrets.length > 0 && (
                  <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      Configured automatically:
                    </span>{" "}
                    <span className="font-mono">
                      {provisionedSecrets.map((s) => s.name).join(", ")}
                    </span>{" "}
                    — harnesst sets{" "}
                    {provisionedSecrets.length === 1 ? "this" : "these"} via
                    guided setup on the agent&rsquo;s Deployment tab. You never
                    provide {provisionedSecrets.length === 1 ? "it" : "them"}.
                  </p>
                )}
                {generatedSecrets.length > 0 && (
                  <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      Generated automatically:
                    </span>{" "}
                    <span className="font-mono">
                      {generatedSecrets.map((s) => s.name).join(", ")}
                    </span>{" "}
                    — harnesst mints{" "}
                    {generatedSecrets.length === 1 ? "this" : "these"} at first
                    deploy. You never provide{" "}
                    {generatedSecrets.length === 1 ? "it" : "them"}.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">npm dependencies</CardTitle>
              <CardDescription>
                Added to the target agent&rsquo;s package.json at install.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {deps.length > 0 ? (
                <ul className="space-y-1 text-sm">
                  {deps.map(([name, range]) => (
                    <li key={name} className="font-mono text-xs">
                      {name}
                      <span className="text-muted-foreground"> {range}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">None.</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* A pure-composition bundle ships no files of its own — hide the empty section. */}
        {manifest.files.length > 0 && (
          <div>
            <h2 className="mb-3 text-base font-semibold tracking-tight">
              Files{" "}
              <span className="text-sm font-normal text-muted-foreground">
                ({manifest.files.length})
              </span>
            </h2>
            <div className="space-y-2">
              {manifest.files.map((path) => (
                <details
                  key={path}
                  className="group overflow-hidden rounded-lg ring-1 ring-foreground/10"
                >
                  <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium hover:bg-accent/50">
                    <span className="text-muted-foreground transition-transform group-open:rotate-90">
                      ›
                    </span>
                    <span className="font-mono text-xs">{path}</span>
                  </summary>
                  <div className="border-t bg-muted/30 p-3">
                    <FileBody path={path} content={files[path] ?? ""} />
                  </div>
                </details>
              ))}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

/**
 * A shipped file's body: Markdown files (instructions, skills, READMEs) render formatted so they
 * read the way they're meant to; everything else gets CodeMirror syntax highlighting via the same
 * read-only editor the repo already uses. An empty body is a plain note, not a blank box.
 */
function FileBody({ path, content }: { path: string; content: string }) {
  if (!content.trim()) {
    return <p className="text-xs text-muted-foreground">Empty file.</p>;
  }
  if (/\.(md|markdown)$/i.test(path)) {
    return (
      <div className="max-h-96 overflow-auto px-1 text-sm">
        <MarkdownText text={content} />
      </div>
    );
  }
  return <CodeEditor path={path} value={content} readOnly />;
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
