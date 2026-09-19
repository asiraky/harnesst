CREATE TABLE "model_connection_aliases" (
	"org_id" text NOT NULL,
	"old_id" varchar(12) NOT NULL,
	"connection_id" varchar(12) NOT NULL,
	"verified_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_connection_aliases_org_id_old_id_pk" PRIMARY KEY("org_id","old_id")
);
--> statement-breakpoint
CREATE TABLE "model_connection_logins" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" varchar(12),
	"credential_version" integer,
	"device_auth_id" text NOT NULL,
	"user_code" text NOT NULL,
	"processing" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_provider_connections" ADD COLUMN "credential_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_connection_aliases" ADD CONSTRAINT "model_connection_aliases_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connection_aliases" ADD CONSTRAINT "model_connection_aliases_connection_id_model_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."model_provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connection_aliases" ADD CONSTRAINT "model_connection_aliases_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connection_logins" ADD CONSTRAINT "model_connection_logins_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connection_logins" ADD CONSTRAINT "model_connection_logins_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;