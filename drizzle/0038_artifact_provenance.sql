ALTER TABLE "deployments" ADD COLUMN "artifact_provenance" jsonb;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "artifact_provenance" jsonb;