import { mkdir, readFile, writeFile, copyFile, cp, rm } from "node:fs/promises";
const root = new URL("./", import.meta.url);
const target = new URL("hosted/", root);
await mkdir(new URL("supabase/migrations/", target), { recursive: true });
await rm(new URL("supabase/functions/", target), {
  recursive: true,
  force: true,
});
await cp(
  new URL("supabase/functions/", root),
  new URL("supabase/functions/", target),
  { recursive: true },
);
for (const [source, destination] of [
  ["0001_ledger.sql", "supabase/migrations/20260917000001_ledger.sql"],
  [
    "0002_supabase_delivery.sql",
    "supabase/migrations/20260917000002_delivery.sql",
  ],
  [
    "0005_hosted_authorization.sql",
    "supabase/migrations/20260917000005_hosted_authorization.sql",
  ],
  [
    "0006_oauth_recovery.sql",
    "supabase/migrations/20260917000006_oauth_recovery.sql",
  ],
  [
    "0007_scoped_oauth_writes.sql",
    "supabase/migrations/20260917000007_scoped_oauth_writes.sql",
  ],
  ["0008_review_content.sql", "supabase/migrations/20260917000008_review_content.sql"],
  ["0009_tickets.sql", "supabase/migrations/20260917000009_tickets.sql"],
  ["0010_leases.sql", "supabase/migrations/20260917000010_leases.sql"],
  ["supabase/config.toml", "supabase/config.toml"],
  ["0003_workflow.sql", "supabase/migrations/20260917000003_workflow.sql"],
  [
    "0004_mayi_approvals.sql",
    "supabase/migrations/20260917000004_mayi_approvals.sql",
  ],
])
  await copyFile(new URL(source, root), new URL(destination, target));
for (const file of ["authorize-mayi.mjs", "verify-mayi-grant.mjs"])
  await rm(new URL(file, target), { force: true });
await writeFile(
  new URL("package.json", target),
  JSON.stringify(
    { private: true, type: "module", dependencies: { postgres: "3.4.9" } },
    null,
    2,
  ) + "\n",
);
await copyFile(
  new URL("TEAM-SETUP.md", root),
  new URL("LEDGER-SETUP.md", target),
);
// Prebundle the fixed backend assets; installation uploads these without a CLI.
const { build } = await import("esbuild");
await mkdir(new URL("deploy/", target), { recursive: true });
for (const slug of [
  "approval-callback",
  "approval-dispatch",
  "approval-oauth",
]) {
  await build({
    entryPoints: [
      new URL(`supabase/functions/${slug}/index.ts`, root).pathname,
    ],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    outfile: new URL(`deploy/${slug}.js`, target).pathname,
    external: ["@mayiapp/sdk/webhook-verifier"],
    banner: { js: "// Generated from canonical Supabase sources." },
  });
  const file = new URL(`deploy/${slug}.js`, target);
  await writeFile(
    file,
    (await readFile(file, "utf8")).replaceAll(
      '"@mayiapp/sdk/webhook-verifier"',
      '"npm:@mayiapp/sdk@0.3.0/webhook-verifier"',
    ),
  );
}
console.log(
  "Hosted Supabase deployment package prepared. No cloud changes made.",
);
// Bundle the operator deployment assets as platform files, outside Eve's agent tree.
const { readdir } = await import("node:fs/promises");
const bundle = new URL("../templates/bundles/ledger/", root);
const manifest = JSON.parse(
  await readFile(new URL("template.json", bundle), "utf8"),
);
await rm(new URL("files/harnesst/ledger-setup/", bundle), {
  recursive: true,
  force: true,
});
const shipped = [];
async function packageFiles(dir, prefix = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const relative = prefix + entry.name;
    if (entry.isDirectory()) {
      await packageFiles(new URL(entry.name + "/", dir), relative + "/");
      continue;
    }
    const path = "harnesst/ledger-setup/" + relative;
    const destination = new URL("files/" + path, bundle);
    await mkdir(new URL("./", destination), { recursive: true });
    await copyFile(new URL(entry.name, dir), destination);
    shipped.push(path);
  }
}
await packageFiles(target);
manifest.files = shipped.sort();
manifest.setup = await readFile(new URL("TEAM-SETUP.md", root), "utf8");
await writeFile(
  new URL("template.json", bundle),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  "Ledger Marketplace bundle includes the Supabase deployment assets.",
);
