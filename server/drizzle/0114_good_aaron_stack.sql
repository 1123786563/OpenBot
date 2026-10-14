CREATE TABLE "openmuse_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"task_id" text NOT NULL,
	"event_kind" text NOT NULL,
	"attempt_key" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "openmuse_notifications_owner_event_uq" ON "openmuse_notifications" USING btree ("user_id","task_id","event_kind","attempt_key");--> statement-breakpoint
CREATE INDEX "openmuse_notifications_owner_created_idx" ON "openmuse_notifications" USING btree ("user_id","created_at","id");