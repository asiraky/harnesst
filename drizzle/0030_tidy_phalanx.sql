CREATE TABLE "assistant_eval_grants" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"conversation_id" varchar(12) NOT NULL,
	"member_name" text NOT NULL,
	"model" text NOT NULL,
	"effort" text,
	"model_source" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_concurrent_calls" integer NOT NULL,
	"active_calls" integer DEFAULT 0 NOT NULL,
	"max_calls" integer NOT NULL,
	"used_calls" integer DEFAULT 0 NOT NULL,
	"max_tokens" integer NOT NULL,
	"reserved_tokens" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_eval_grants" ADD CONSTRAINT "assistant_eval_grants_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_eval_grants" ADD CONSTRAINT "assistant_eval_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_eval_grants" ADD CONSTRAINT "assistant_eval_grants_conversation_id_playground_sessions_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."playground_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_eval_grants_project_uq" ON "assistant_eval_grants" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "assistant_eval_grants_expiry_idx" ON "assistant_eval_grants" USING btree ("expires_at");