import { readFile, writeFile, mkdir } from "node:fs/promises";
import { sql, rpc } from "./db.mjs";
const root = new URL("../", import.meta.url);
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
  const [hosted] =
    await sql`select to_regclass('ledger.oauth_attempts') as present`;
  if (!hosted.present)
    await sql.unsafe(
      await readFile(new URL("0005_hosted_authorization.sql", root), "utf8"),
    );

  // Local prototype setup is repeatable; this migration only replaces functions.
  await sql.unsafe(
    await readFile(new URL("0006_oauth_recovery.sql", root), "utf8"),
  );
  await sql.unsafe(
    await readFile(new URL("0007_scoped_oauth_writes.sql", root), "utf8"),
  );
  await sql.unsafe(await readFile(new URL("0008_review_content.sql", root), "utf8"));
  await sql.unsafe(await readFile(new URL("0009_tickets.sql", root), "utf8"));
  await sql.unsafe(await readFile(new URL("0010_leases.sql", root), "utf8"));
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
