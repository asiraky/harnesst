ALTER TABLE "agent_model_overrides" ADD COLUMN "subagent_path" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_model_overrides" ADD COLUMN "project_id" varchar(12) DEFAULT '' NOT NULL;--> statement-breakpoint
-- Back-fill `project_id` for existing (name-keyed) rows: only when the workspace has EXACTLY ONE
-- project whose roster carries an agent of that name. Ambiguous or unmatched rows deliberately
-- stay `''` — they keep resolving by name alone for every repo, exactly as they do today, and a
-- later save from Agent Settings pins a row to its own repo. Runs BEFORE the new primary key so
-- the key is created over the final values (the back-fill assigns at most one project per
-- (org, agent_name), so it can never introduce a duplicate).
UPDATE "agent_model_overrides" AS "override"
SET "project_id" = "match"."project_id"
FROM (
  SELECT "project"."org_id" AS "org_id",
         "agent"."name" AS "agent_name",
         MIN("project"."id") AS "project_id"
  FROM "agents" AS "agent"
  JOIN "projects" AS "project" ON "project"."id" = "agent"."project_id"
  GROUP BY "project"."org_id", "agent"."name"
  HAVING COUNT(DISTINCT "project"."id") = 1
) AS "match"
WHERE "override"."org_id" = "match"."org_id"
  AND "override"."agent_name" = "match"."agent_name"
  AND "override"."project_id" = '';--> statement-breakpoint
ALTER TABLE "agent_model_overrides" DROP CONSTRAINT "agent_model_overrides_org_id_agent_name_pk";--> statement-breakpoint
ALTER TABLE "agent_model_overrides" ADD CONSTRAINT "agent_model_overrides_pk" PRIMARY KEY("org_id","project_id","agent_name","subagent_path");--> statement-breakpoint
DROP INDEX IF EXISTS "agent_model_overrides_project_idx";--> statement-breakpoint
CREATE INDEX "agent_model_overrides_agent_idx" ON "agent_model_overrides" USING btree ("org_id","agent_name");
