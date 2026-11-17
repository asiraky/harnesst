CREATE TABLE "codex_rate_limit_samples" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"connection_id" varchar(12) NOT NULL,
	"org_id" text NOT NULL,
	"primary_used_percent" double precision,
	"primary_window_minutes" integer,
	"primary_resets_at" timestamp with time zone,
	"secondary_used_percent" double precision,
	"secondary_window_minutes" integer,
	"secondary_resets_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "codex_rate_limits" (
	"connection_id" varchar(12) PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"primary_used_percent" double precision,
	"primary_window_minutes" integer,
	"primary_resets_at" timestamp with time zone,
	"secondary_used_percent" double precision,
	"secondary_window_minutes" integer,
	"secondary_resets_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_calls" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" varchar(12),
	"token_kind" varchar(16) NOT NULL,
	"agent_name" text,
	"subagent_path" text,
	"session_id" text,
	"turn_id" text,
	"step_index" integer,
	"connection_id" varchar(12) NOT NULL,
	"account_id" text,
	"plan_type" text,
	"model" text NOT NULL,
	"reasoning_effort" text,
	"streamed" boolean NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ttft_ms" integer,
	"duration_ms" integer NOT NULL,
	"http_status" integer,
	"finish_reason" text,
	"error_code" text,
	"error_message" text,
	"upstream_request_id" text,
	"input_tokens" integer,
	"cached_input_tokens" integer,
	"output_tokens" integer,
	"reasoning_tokens" integer,
	"context_window" integer,
	"composition" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
ALTER TABLE "codex_rate_limit_samples" ADD CONSTRAINT "codex_rate_limit_samples_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_rate_limits" ADD CONSTRAINT "codex_rate_limits_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_calls" ADD CONSTRAINT "gateway_calls_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_calls" ADD CONSTRAINT "gateway_calls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "codex_rate_limit_samples_connection_observed_idx" ON "codex_rate_limit_samples" USING btree ("connection_id","observed_at");--> statement-breakpoint
CREATE INDEX "codex_rate_limit_samples_observed_idx" ON "codex_rate_limit_samples" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "gateway_calls_org_started_idx" ON "gateway_calls" USING btree ("org_id","started_at");--> statement-breakpoint
CREATE INDEX "gateway_calls_project_started_idx" ON "gateway_calls" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "gateway_calls_session_turn_step_idx" ON "gateway_calls" USING btree ("session_id","turn_id","step_index");--> statement-breakpoint
CREATE INDEX "gateway_calls_connection_started_idx" ON "gateway_calls" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE INDEX "gateway_calls_started_idx" ON "gateway_calls" USING btree ("started_at");