ALTER TABLE "approvals" ADD COLUMN "merge_status" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "merge_sha" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "merge_error" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "merged_at" timestamp with time zone;