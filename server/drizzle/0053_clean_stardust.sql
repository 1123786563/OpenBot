CREATE TABLE "billing_customers" (
	"external_id" text PRIMARY KEY NOT NULL,
	"name" text,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"external_customer_id" text NOT NULL,
	"external_subscription_id" text PRIMARY KEY NOT NULL,
	"plan_code" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_status_check" CHECK ("billing_subscriptions"."status" IN ('active', 'incomplete', 'canceled', 'terminated'))
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"lago_unique_key" text,
	"webhook_type" text NOT NULL,
	"object_id" text,
	"processed" boolean DEFAULT true NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_ext_customer_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_subscriptions_customer_idx" ON "billing_subscriptions" USING btree ("external_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_webhook_events_provider_event_idx" ON "billing_webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_unique_key_idx" ON "billing_webhook_events" USING btree ("lago_unique_key");