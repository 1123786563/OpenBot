CREATE TABLE "flexprice_usage_deliveries" (
	"event_id" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"failure" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flexprice_usage_deliveries_state" CHECK ("flexprice_usage_deliveries"."state" IN ('pending', 'accepted', 'paused'))
);
--> statement-breakpoint
ALTER TABLE "flexprice_usage_deliveries" ADD CONSTRAINT "flexprice_usage_deliveries_event_id_lago_usage_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."lago_usage_events"("event_id") ON DELETE no action ON UPDATE no action;