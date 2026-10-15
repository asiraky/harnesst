CREATE TABLE "service_connections" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" varchar(32) NOT NULL,
	"label" text NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"credential_iv" text NOT NULL,
	"credential_auth_tag" text NOT NULL,
	"credential_version" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bundle_provisioning" RENAME COLUMN "provider" TO "provisioner";--> statement-breakpoint
ALTER TABLE "bundle_provisioning" ALTER COLUMN "provisioner" DROP DEFAULT;--> statement-breakpoint
UPDATE "bundle_provisioning" SET "provisioner" = 'supabase-ledger' WHERE "provisioner" = '';--> statement-breakpoint
ALTER TABLE "bundle_provisioning" DROP CONSTRAINT "bundle_provisioning_pkey";--> statement-breakpoint
ALTER TABLE "bundle_provisioning" ADD CONSTRAINT "bundle_provisioning_project_id_provisioner_pk" PRIMARY KEY("project_id","provisioner");--> statement-breakpoint
ALTER TABLE "bundle_provisioning" ADD COLUMN "service_connection_id" varchar(12);--> statement-breakpoint
ALTER TABLE "service_connections" ADD CONSTRAINT "service_connections_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_connections" ADD CONSTRAINT "service_connections_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_connections_org_provider_idx" ON "service_connections" USING btree ("org_id","provider");--> statement-breakpoint
ALTER TABLE "bundle_provisioning" ADD CONSTRAINT "bundle_provisioning_service_connection_fk" FOREIGN KEY ("service_connection_id") REFERENCES "public"."service_connections"("id") ON DELETE set null ON UPDATE no action;