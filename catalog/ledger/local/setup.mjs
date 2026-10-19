import { readFile, writeFile, mkdir } from "node:fs/promises";
import { sql, rpc } from "./db.mjs";
const root = new URL("../", import.meta.url);
// Migration files carry their own begin/commit, which postgres.js only allows on one connection.
async function apply(file) {
  const connection = await sql.reserve();
  try {
    await connection.unsafe(await readFile(new URL(file, root), "utf8"));
  } finally {
    connection.release();
  }
}
try {
  await sql.unsafe(await readFile(new URL("local/roles.sql", root), "utf8"));
  const [exists] =
    await sql`select to_regclass('ledger.work_items') as present`;
  if (!exists.present) {
    const connection = await sql.reserve();
    try {
      await connection.unsafe(
        await readFile(new URL("0001_ledger.sql", root), "utf8"),
      );
    } finally {
      connection.release();
    }
  }
  const file = new URL(".local/actors.json", root);
  let actors;
  try {
    actors = JSON.parse(await readFile(file, "utf8"));
  } catch {}
  if (actors) {
    try {
      for (const role of ["intake", "infra", "implementer", "architect", "github"])
        await rpc("whoami", actors[role].actor_key);
    } catch {
      actors = null;
    }
  }
  if (!actors) {
    actors = {};
    for (const [role, kind, email] of [
      ["intake", "agent", null],
      ["infra", "agent", null],
      ["implementer", "agent", null],
      ["architect", "agent", null],
      ["github", "system", null],
      ["engineer", "human", "engineer@example.test"],
      ["requester", "human", "requester@example.test"],
    ]) {
      const [row] =
        await sql`select public.ledger_mint_actor(${role},${kind},${role},${email}) as result`;
      actors[role] = row.result;
    }
    await mkdir(new URL(".local/", root), { recursive: true });
    await writeFile(file, JSON.stringify(actors, null, 2), { mode: 0o600 });
  }
  const [approvals] =
    await sql`select to_regclass('ledger.approval_requests') as present`;
  if (!approvals.present) {
    const connection = await sql.reserve();
    try {
      await connection.unsafe(
        "do $$ begin if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if; end $$",
      );
      await connection.unsafe(
        await readFile(new URL("0004_mayi_approvals.sql", root), "utf8"),
      );
    } finally {
      connection.release();
    }
  }
  // 0011 retires the May I tables that 0005-0010 create or reference, so once it has run only
  // 0011 itself (re-runnable) is applied again.
  const [retired] =
    await sql`select to_regclass('ledger.approval_access') as present`;
  if (!retired.present) {
    const [hosted] =
      await sql`select to_regclass('ledger.oauth_attempts') as present`;
    if (!hosted.present) await apply("0005_hosted_authorization.sql");
    for (const file of [
      "0006_oauth_recovery.sql",
      "0007_scoped_oauth_writes.sql",
      "0008_review_content.sql",
      "0009_tickets.sql",
      "0010_leases.sql",
    ])
      await apply(file);
  }
  await apply("0011_harnesst_approvals.sql");
  const workflow = JSON.parse(
    await readFile(new URL("workflow.json", root), "utf8"),
  );
  await sql`insert into ledger.workflow_templates(name,definition) values('default',${sql.json(workflow)}) on conflict(name) do nothing`;
  const projects = await rpc("list_projects", actors.intake.actor_key);
  if (!projects.length)
    await rpc("create_project", actors.intake.actor_key, {
      slug: "prototype",
      name: "Prototype product",
      repo: "local/prototype",
      docs: {
        purpose:
          "Local ledger playground. Simulated evidence is labelled; no cloud resources are changed.",
      },
      workflow_template: "default",
    });
  console.log("Ledger ready. npm run ledger:dev → http://localhost:55430");
} finally {
  await sql.end();
}
