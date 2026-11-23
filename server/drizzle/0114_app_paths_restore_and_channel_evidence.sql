CREATE TABLE "billing_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"operator" text NOT NULL,
	"resource_prefix" text NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"paused_at" timestamp with time zone,
	"paused_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_application_approval" CHECK (("billing_applications"."approved_at" is null) = ("billing_applications"."approved_by" is null)),
	CONSTRAINT "billing_application_pause" CHECK (("billing_applications"."paused_at" is null) = ("billing_applications"."paused_by" is null))
);
--> statement-breakpoint
CREATE TABLE "billing_restore" (
	"id" text PRIMARY KEY NOT NULL,
	"restoring_since" timestamp with time zone,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_spending_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"task_id" text,
	"resource_prefix" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"limit_microcredits" bigint NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_spending_authorizations_account_id_id_unique" UNIQUE("account_id","id"),
	CONSTRAINT "billing_authorization_amount" CHECK ("billing_spending_authorizations"."limit_microcredits" > 0),
	CONSTRAINT "billing_authorization_task" CHECK (("billing_spending_authorizations"."kind" = 'background') = ("billing_spending_authorizations"."task_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "test_credit_accounts" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD COLUMN "authorization_id" text;--> statement-breakpoint
ALTER TABLE "paid_orders" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paid_orders" ADD COLUMN "closed_by" text;--> statement-breakpoint
ALTER TABLE "billing_spending_authorizations" ADD CONSTRAINT "billing_spending_authorizations_application_id_billing_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."billing_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_spending_authorizations" ADD CONSTRAINT "billing_spending_authorizations_account_id_test_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."test_credit_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD CONSTRAINT "test_credit_authorization_fk" FOREIGN KEY ("account_id","authorization_id") REFERENCES "public"."billing_spending_authorizations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_orders" ADD CONSTRAINT "paid_orders_closed" CHECK (("paid_orders"."closed_at" is null) = ("paid_orders"."closed_by" is null));