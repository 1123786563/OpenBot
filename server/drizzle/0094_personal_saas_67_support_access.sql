CREATE TABLE "personal_support_accesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_subject" text NOT NULL,
	"resource" jsonb NOT NULL,
	"reason" text NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_support_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"ticket_id" text NOT NULL,
	"operator_id" uuid NOT NULL,
	"actor_subject" text NOT NULL,
	"resources" jsonb NOT NULL,
	"reason" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "personal_support_duration_check" CHECK ("personal_support_requests"."duration_seconds" BETWEEN 1 AND 86400)
);
--> statement-breakpoint
ALTER TABLE "personal_support_accesses" ADD CONSTRAINT "personal_support_accesses_request_id_personal_support_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."personal_support_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_support_requests" ADD CONSTRAINT "personal_support_requests_workspace_id_personal_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."personal_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_support_accesses_request_id_accessed_at_index" ON "personal_support_accesses" USING btree ("request_id","accessed_at");--> statement-breakpoint
CREATE INDEX "personal_support_requests_workspace_id_requested_at_index" ON "personal_support_requests" USING btree ("workspace_id","requested_at");