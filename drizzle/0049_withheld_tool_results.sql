CREATE TABLE "withheld_tool_results" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"tokens" integer NOT NULL,
	"limit_tokens" integer NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withheld_tool_results_call_uq" UNIQUE("org_id","call_id")
);
--> statement-breakpoint
ALTER TABLE "withheld_tool_results" ADD CONSTRAINT "withheld_tool_results_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;