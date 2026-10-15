ALTER TABLE "enterprise_run_attempts" ADD COLUMN "request_owner_token" uuid;--> statement-breakpoint
ALTER TABLE "enterprise_run_attempts" ADD COLUMN "request_owner_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "enterprise_run_attempts" ADD CONSTRAINT "enterprise_run_attempts_request_owner_check" CHECK (("enterprise_run_attempts"."request_owner_token" is null and "enterprise_run_attempts"."request_owner_expires_at" is null) or ("enterprise_run_attempts"."request_owner_token" is not null and "enterprise_run_attempts"."request_owner_expires_at" is not null)) NOT VALID;
--> statement-breakpoint
GRANT UPDATE ("request_owner_token", "request_owner_expires_at") ON TABLE "enterprise_run_attempts" TO ob_ent_data;
