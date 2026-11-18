ALTER TABLE "run_steps" ADD COLUMN "tokens_cache_read" integer;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "tokens_cache_write" integer;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "cost_usd" double precision;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "context_window" integer;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "eve_session_id" text;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "turn_id" text;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "step_index" integer;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "subagent_name" text;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "parent_call_id" text;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "call_id" text;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "result_bytes" integer;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "result_tokens" integer;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "result_capped" boolean;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "tokens_cached_input" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cost_usd" double precision;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "compaction_count" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "peak_context_tokens" integer;