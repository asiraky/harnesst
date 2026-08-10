DROP INDEX "artifacts_session_name_uq";--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "share_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_agent_unattached_name_uq" ON "artifacts" USING btree ("agent_id","name") WHERE "artifacts"."session_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_share_token_uq" ON "artifacts" USING btree ("share_token") WHERE "artifacts"."share_token" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_session_name_uq" ON "artifacts" USING btree ("session_id","name") WHERE "artifacts"."session_id" is not null;