ALTER TABLE "model_connection_logins" ADD COLUMN "authorization_version" integer;--> statement-breakpoint
ALTER TABLE "model_connection_logins" ADD COLUMN "processing_id" text;--> statement-breakpoint
ALTER TABLE "model_connection_logins" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_connection_logins" ADD COLUMN "pending_grant" jsonb;--> statement-breakpoint
ALTER TABLE "model_provider_connections" ADD COLUMN "authorization_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Older attempts captured refresh generations; restart those transient sign-ins after upgrading.
DELETE FROM "model_connection_logins";
