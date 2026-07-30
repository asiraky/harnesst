CREATE TABLE "artifacts" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"agent_id" varchar(12) NOT NULL,
	"session_id" varchar(12) NOT NULL,
	"deployment_id" varchar(12),
	"name" text NOT NULL,
	"title" text,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_path" text NOT NULL,
	"stream_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_session_id_playground_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."playground_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_session_idx" ON "artifacts" USING btree ("session_id","stream_index");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_session_sha_uq" ON "artifacts" USING btree ("session_id","sha256");