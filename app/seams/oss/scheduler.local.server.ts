/**
 * OSS Scheduler: persist schedules for visibility. In OSS/self-host, eve's own `schedules/`
 * run inside the always-on instance, so harnesst doesn't need to fire them. Managed swaps in a
 * scheduler that WAKES scaled-to-zero instances at cron time (ARCH §3.3) behind this seam.
 */
import { eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { schedules } from "~/db/schema";
import type { Scheduler, ScheduleSpec } from "../types";

export const localScheduler: Scheduler = {
  name: "local-passive",

  async register(spec) {
    await db
      .insert(schedules)
      .values({
        id: spec.id,
        deploymentId: spec.deploymentId,
        cron: spec.cron,
        name: spec.name ?? null,
      })
      .onConflictDoUpdate({
        target: schedules.id,
        set: { cron: spec.cron, name: spec.name ?? null },
      });
  },

  async unregister(id) {
    await db.delete(schedules).where(eq(schedules.id, id));
  },

  async list(deploymentId) {
    const rows = await db
      .select()
      .from(schedules)
      .where(eq(schedules.deploymentId, deploymentId));
    return rows.map(
      (r): ScheduleSpec => ({
        id: r.id,
        deploymentId: r.deploymentId,
        cron: r.cron,
        name: r.name ?? undefined,
      }),
    );
  },
};
