CREATE TABLE "bundle_provisioning" (
	"project_id" varchar(12) PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'supabase-ledger' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"step" text DEFAULT 'Connect Supabase' NOT NULL,
	"error" text,
	"project_ref" text,
	"public_origin" text,
	"encrypted_state" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bundle_provisioning" ADD CONSTRAINT "bundle_provisioning_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;