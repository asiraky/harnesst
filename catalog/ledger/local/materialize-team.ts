import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveTemplate } from "../../../app/marketplace/compose.server";
import { fixtureCatalog } from "../../../app/seams/oss/catalog.fixture.server";
import { planInstall } from "../../../app/marketplace/install.server";
import { emptyLock } from "../../../app/marketplace/lock";
const root = path.resolve("catalog/ledger/.local/team");
await mkdir(root, { recursive: true });
const actors = JSON.parse(
  await readFile("catalog/ledger/.local/actors.json", "utf8"),
);
let lock = emptyLock();
const basePackageJson = JSON.stringify({
  name: "ledger-prototype-team",
  private: true,
  type: "module",
  dependencies: { eve: "^0.22.0" },
});
for (const role of ["intake", "infra", "implementer", "architect"]) {
  let packageJson = basePackageJson;
  const template = await resolveTemplate(
    fixtureCatalog,
    "agent",
    "ledger-" + role,
  );
  const plan = planInstall({
    template,
    registry: "fixture",
    repoPaths: [],
    drafts: [],
    packageJson,
    lock,
    target: { kind: "new-member", name: role },
  });
  if (plan.conflicts.length) throw Error(plan.conflicts.join("\n"));
  for (const write of plan.writes) {
    const dest = path.join(root, write.path);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, write.content);
    if (write.path === "harnesst-lock.json") lock = JSON.parse(write.content);
  }
  await writeFile(
    path.join(root, `agents/${role}/.env`),
    `LEDGER_URL=http://host.docker.internal:55431\nLEDGER_ANON_KEY=local\nLEDGER_ACTOR_KEY=${actors[role].actor_key}\nLEDGER_WAKE_TOKEN=${actors[role].wake_token}\n`,
    { mode: 0o600 },
  );
}
console.log(
  `Composed team: ${root}\nCredentials are local ignored .env files. Use the README live-agent setup before running.`,
);
