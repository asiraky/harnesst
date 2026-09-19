/** Real transaction coverage: concurrent resets must never overwrite a racing user save. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

describe.runIf(LIVE)("atomic reset draft staging against Postgres", () => {
  it("allows only one competing reset and preserves a later ordinary save", async () => {
    const { db } = await import("~/db/client.server");
    const { organization } = await import("~/db/auth-schema");
    const { projects } = await import("~/db/schema");
    const { drizzleDataStore: store } = await import("~/data/drizzle.server");
    const orgId = `org_reset_cas_${crypto.randomUUID()}`;
    await db
      .insert(organization)
      .values({
        id: orgId,
        name: "Reset CAS smoke",
        slug: orgId,
        createdAt: new Date(),
      });
    const [project] = await db
      .insert(projects)
      .values({ orgId, name: "reset-cas", slug: orgId })
      .returning();
    const write = (path: string, content: string) => ({
      projectId: project.id,
      agentId: null,
      path,
      content,
    });
    try {
      const competing = await Promise.all([
        store.drafts.compareAndStage(
          project.id,
          [],
          [
            write("agent/agent.ts", "reset A"),
            write("package.json", "package A"),
          ],
        ),
        store.drafts.compareAndStage(
          project.id,
          [],
          [
            write("agent/agent.ts", "reset B"),
            write("package.json", "package B"),
          ],
        ),
      ]);
      expect(competing.filter((result) => result !== null)).toHaveLength(1);
      expect(competing.filter((result) => result === null)).toHaveLength(1);
      const captured = await store.drafts.listByProject(project.id);
      expect(captured).toHaveLength(2);
      const winner = captured
        .find((draft) => draft.path === "agent/agent.ts")!
        .content!.at(-1);
      expect(
        captured.find((draft) => draft.path === "package.json")!.content,
      ).toBe(`package ${winner}`);

      await store.drafts.upsert(write("agent/agent.ts", "Later user edit"));
      expect(
        await store.drafts.compareAndStage(project.id, captured, [
          write("agent/agent.ts", "reset C"),
          write("new-file.ts", "must not appear"),
        ]),
      ).toBeNull();
      expect(
        (await store.drafts.get(project.id, "agent/agent.ts"))?.content,
      ).toBe("Later user edit");
      expect(await store.drafts.get(project.id, "new-file.ts")).toBeNull();
    } finally {
      await db.delete(organization).where(eq(organization.id, orgId));
    }
  });
});
