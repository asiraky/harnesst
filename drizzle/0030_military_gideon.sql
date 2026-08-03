ALTER TABLE "deployments" ADD COLUMN "env_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "env_revision" integer DEFAULT 0 NOT NULL;