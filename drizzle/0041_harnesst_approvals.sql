CREATE TABLE "approvals" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"source" text DEFAULT 'ledger' NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"details" jsonb NOT NULL,
	"approver_role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"decided_by" text,
	"decided_by_name" text,
	"decided_at" timestamp with time zone,
	"feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_source_external_uq" ON "approvals" USING btree ("project_id","source","external_id");--> statement-breakpoint
CREATE INDEX "approvals_project_status_idx" ON "approvals" USING btree ("project_id","status");