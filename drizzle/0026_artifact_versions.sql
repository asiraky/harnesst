-- Artifact versions (issue #292). Additive child table + a one-pass data migration that turns
-- every artifact that already exists into its own v1, so nothing has to read "no versions" as a
-- special case at run time (a fallback would have had to live in the hot preview path).
--
-- The one non-mechanical part is the new identity index. `(session_id, name)` is now unique, and
-- rows published before this migration were free to repeat a name inside a conversation — the old
-- key was `(session_id, sha256)`. So same-named rows are FOLDED: the earliest becomes the surviving
-- artifact (its id keeps the card, its `stream_index` keeps the card's place in the transcript) and
-- the later ones become its versions in publish order, which is exactly what they would have been
-- had they been published after this migration.
CREATE TABLE "artifact_versions" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"artifact_id" varchar(12) NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"version_number" integer NOT NULL,
	"entry_path" text,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_path" text NOT NULL,
	"stream_index" integer NOT NULL,
	"deployment_id" varchar(12),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "artifact_files" ADD COLUMN "version_id" varchar(12);--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "latest_version_id" varchar(12);--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "version_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "version_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- One version per existing artifact row. The version id is derived from the artifact id rather
-- than minted, so the `artifact_files` re-pointing below can find it without a temporary column.
INSERT INTO "artifact_versions" (
	"id", "artifact_id", "project_id", "version_number", "entry_path", "content_type",
	"byte_size", "sha256", "storage_path", "stream_index", "deployment_id", "created_at"
)
SELECT
	substr(md5("a"."id"), 1, 12),
	first_value("a"."id") OVER "w",
	"a"."project_id",
	row_number() OVER "w",
	"a"."entry_path",
	"a"."content_type",
	"a"."byte_size",
	"a"."sha256",
	"a"."storage_path",
	"a"."stream_index",
	"a"."deployment_id",
	"a"."created_at"
FROM "artifacts" "a"
WINDOW "w" AS (
	PARTITION BY "a"."session_id", "a"."name"
	ORDER BY "a"."stream_index", "a"."created_at", "a"."id"
);--> statement-breakpoint
-- Bundle members move to the version they were published as, and to the surviving artifact.
UPDATE "artifact_files" "f"
SET "version_id" = "v"."id", "artifact_id" = "v"."artifact_id"
FROM "artifact_versions" "v"
WHERE "v"."id" = substr(md5("f"."artifact_id"), 1, 12);--> statement-breakpoint
-- The folded-in duplicates: their content and their members now hang off the survivor.
DELETE FROM "artifacts"
WHERE "id" NOT IN (SELECT "artifact_id" FROM "artifact_versions");--> statement-breakpoint
-- Every survivor points at its newest version, content columns included: those columns are the
-- latest version's, and a folded artifact's own were the oldest's.
UPDATE "artifacts" "a"
SET
	"latest_version_id" = "l"."id",
	"version_number" = "l"."version_number",
	"version_count" = "l"."total",
	"entry_path" = "l"."entry_path",
	"content_type" = "l"."content_type",
	"byte_size" = "l"."byte_size",
	"sha256" = "l"."sha256",
	"storage_path" = "l"."storage_path"
FROM (
	SELECT DISTINCT ON ("artifact_id")
		"artifact_id", "id", "version_number", "entry_path", "content_type", "byte_size",
		"sha256", "storage_path",
		count(*) OVER (PARTITION BY "artifact_id") AS "total"
	FROM "artifact_versions"
	ORDER BY "artifact_id", "version_number" DESC
) "l"
WHERE "a"."id" = "l"."artifact_id";--> statement-breakpoint
ALTER TABLE "artifact_files" ALTER COLUMN "version_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX "artifacts_session_sha_uq";--> statement-breakpoint
DROP INDEX "artifact_files_path_uq";--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_versions_number_uq" ON "artifact_versions" USING btree ("artifact_id","version_number");--> statement-breakpoint
CREATE INDEX "artifact_versions_project_idx" ON "artifact_versions" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "artifact_files" ADD CONSTRAINT "artifact_files_version_id_artifact_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_session_name_uq" ON "artifacts" USING btree ("session_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_files_path_uq" ON "artifact_files" USING btree ("version_id","rel_path");
