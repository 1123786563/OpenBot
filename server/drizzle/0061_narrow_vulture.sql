CREATE TABLE "payment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"state" text,
	"channel_transaction_id" text,
	"amount_cents" integer,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_kind_check" CHECK ("payment_events"."kind" IN ('fact', 'anomaly'))
);
--> statement-breakpoint
CREATE TABLE "payment_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_code" text NOT NULL,
	"provider" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"status" text NOT NULL,
	"activation_state" text DEFAULT 'pending' NOT NULL,
	"channel_transaction_id" text,
	"checkout_payload" text,
	"expires_at" timestamp with time zone NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "payment_orders_status_check" CHECK ("payment_orders"."status" IN ('pending', 'paid', 'blocked', 'canceled', 'expired')),
	CONSTRAINT "payment_orders_activation_state_check" CHECK ("payment_orders"."activation_state" IN ('pending', 'applied', 'failed')),
	CONSTRAINT "payment_orders_provider_check" CHECK ("payment_orders"."provider" IN ('alipay', 'wechat')),
	CONSTRAINT "payment_orders_amount_check" CHECK ("payment_orders"."amount_cents" > 0),
	CONSTRAINT "payment_orders_currency_check" CHECK ("payment_orders"."currency" = 'CNY')
);
--> statement-breakpoint
CREATE TABLE "expert_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"expert_slug" text NOT NULL,
	"agent_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enterprise_resource_grants" DROP CONSTRAINT "enterprise_grant_action";--> statement-breakpoint
ALTER TABLE "enterprise_run_releases" ALTER COLUMN "model_route_ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "enterprise_run_releases" ALTER COLUMN "tool_manifest_digest" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_order_id_payment_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."payment_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_installs" ADD CONSTRAINT "expert_installs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_installs" ADD CONSTRAINT "expert_installs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_paid_fact_unique_idx" ON "payment_events" USING btree ("channel_transaction_id") WHERE "payment_events"."kind" = 'fact' AND "payment_events"."state" = 'paid';--> statement-breakpoint
CREATE INDEX "payment_events_order_idx" ON "payment_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payment_orders_plan_provider_status_idx" ON "payment_orders" USING btree ("plan_code","provider","status");--> statement-breakpoint
CREATE INDEX "payment_orders_status_expires_idx" ON "payment_orders" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "expert_installs_owner_slug_key" ON "expert_installs" USING btree ("owner_user_id","expert_slug");--> statement-breakpoint
CREATE INDEX "expert_installs_agent_idx" ON "expert_installs" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "enterprise_resource_grants" ADD CONSTRAINT "enterprise_grant_action" CHECK ("enterprise_resource_grants"."action" in ('read','run'));