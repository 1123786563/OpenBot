ALTER TABLE "routines" ADD COLUMN "personal_resume_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_bindings" ADD COLUMN "personal_resume_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_bindings" ADD COLUMN "personal_resumed_at" timestamp with time zone;