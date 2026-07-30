CREATE TABLE "artifact_files" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"artifact_id" varchar(12) NOT NULL,
	"rel_path" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "kind" text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "entry_path" text;--> statement-breakpoint
ALTER TABLE "artifact_files" ADD CONSTRAINT "artifact_files_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_files_path_uq" ON "artifact_files" USING btree ("artifact_id","rel_path");