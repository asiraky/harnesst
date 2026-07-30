ALTER TABLE "playground_sessions" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD COLUMN "archived_by" text;--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD CONSTRAINT "playground_sessions_archived_by_user_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playground_sessions_archived_idx" ON "playground_sessions" USING btree ("project_id","archived_at");