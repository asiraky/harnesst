CREATE TABLE "agent_github_apps" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"agent_id" varchar(12) NOT NULL,
	"app_id" text NOT NULL,
	"slug" text NOT NULL,
	"owner_login" text,
	"owner_type" text,
	"activated_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_github_apps" ADD CONSTRAINT "agent_github_apps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_github_apps" ADD CONSTRAINT "agent_github_apps_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_github_apps_agent_app_uq" ON "agent_github_apps" USING btree ("agent_id","app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_github_apps_current_agent_uq" ON "agent_github_apps" USING btree ("agent_id") WHERE "agent_github_apps"."activated_at" is not null and "agent_github_apps"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "agent_github_apps_agent_created_idx" ON "agent_github_apps" USING btree ("agent_id","created_at");