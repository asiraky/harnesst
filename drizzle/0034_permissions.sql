-- Permissions model: per-repo `read` / `write` grants replace Better Auth teams.
--
-- Order matters: the new tables are created and BACKFILLED from the team data before that
-- data is dropped, so nobody loses access on deploy:
--   * every team member becomes `read` on the team's repo (the old "member" experience);
--   * every workspace owner/admin becomes `write` on every repo in their workspace (owners are
--     implicit anyway; admins no longer are, so they get an explicit grant for what they had);
--   * pending invitations that named teams get equivalent `read` grants.
CREATE TABLE "invitation_project_grants" (
	"invitation_id" text NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "invitation_project_grants_invitation_id_project_id_pk" PRIMARY KEY("invitation_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "project_access" (
	"project_id" varchar(12) NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_access_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "invitation_project_grants" ADD CONSTRAINT "invitation_project_grants_invitation_id_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_project_grants" ADD CONSTRAINT "invitation_project_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_access_user_idx" ON "project_access" USING btree ("user_id");--> statement-breakpoint
-- Backfill 1: team members -> read on the team's repo (only for users still in the workspace).
INSERT INTO "project_access" ("project_id", "user_id", "role")
SELECT p."id", tm."user_id", 'read'
FROM "team_member" tm
JOIN "projects" p ON p."team_id" = tm."team_id"
JOIN "member" m ON m."user_id" = tm."user_id" AND m."organization_id" = p."org_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Backfill 2: workspace owners/admins -> write on every repo in their workspace.
INSERT INTO "project_access" ("project_id", "user_id", "role")
SELECT p."id", m."user_id", 'write'
FROM "member" m
JOIN "projects" p ON p."org_id" = m."organization_id"
WHERE EXISTS (
  SELECT 1 FROM unnest(string_to_array(m."role", ',')) AS r(role)
  WHERE btrim(r.role) IN ('owner', 'admin')
)
ON CONFLICT ("project_id", "user_id") DO UPDATE SET "role" = 'write', "updated_at" = now();--> statement-breakpoint
-- Backfill 3: pending invitations that named repo teams -> read grants on those repos.
INSERT INTO "invitation_project_grants" ("invitation_id", "project_id", "role")
SELECT i."id", p."id", 'read'
FROM "invitation" i
CROSS JOIN LATERAL unnest(string_to_array(coalesce(i."team_id", ''), ',')) AS t(team_id)
JOIN "projects" p ON p."team_id" = btrim(t.team_id) AND p."org_id" = i."organization_id"
WHERE i."status" = 'pending'
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_team_id_team_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "team_id";--> statement-breakpoint
ALTER TABLE "team" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_member" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "team_member" CASCADE;--> statement-breakpoint
DROP TABLE "team" CASCADE;--> statement-breakpoint
ALTER TABLE "session" DROP COLUMN "active_team_id";
