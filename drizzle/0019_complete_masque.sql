ALTER TABLE "projects" ADD COLUMN "live_environment_name" text;--> statement-breakpoint
ALTER TABLE "workspace_tasks" ADD COLUMN "steps" jsonb;--> statement-breakpoint
ALTER TABLE "assistant_checkouts" DROP COLUMN "pr_number";--> statement-breakpoint
ALTER TABLE "assistant_checkouts" DROP COLUMN "pr_draft";--> statement-breakpoint
ALTER TABLE "workspace_tasks" DROP COLUMN "stage";--> statement-breakpoint
-- Clean cutover (issue #225 §0): abandon anything mid-flight under the old model. The publish
-- pipeline replaces the merge_change/publish_change job kinds, and every existing task row
-- carries the dropped `stage` shape; in-flight work is abandoned and the user re-publishes.
DELETE FROM jobs WHERE kind IN ('merge_change', 'publish_change');--> statement-breakpoint
DELETE FROM workspace_tasks;
