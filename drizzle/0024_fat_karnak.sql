ALTER TABLE "playground_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "playground_events" CASCADE;--> statement-breakpoint
ALTER TABLE "playground_sessions" DROP CONSTRAINT "playground_sessions_last_deployment_id_deployments_id_fk";
--> statement-breakpoint
ALTER TABLE "playground_sessions" DROP CONSTRAINT "playground_sessions_last_release_id_releases_id_fk";
--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD COLUMN "predecessor_external_session_id" text;--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD COLUMN "opening_message" text;--> statement-breakpoint
ALTER TABLE "playground_sessions" DROP COLUMN "cache_index_offset";--> statement-breakpoint
ALTER TABLE "playground_sessions" DROP COLUMN "last_deployment_id";--> statement-breakpoint
ALTER TABLE "playground_sessions" DROP COLUMN "last_release_id";