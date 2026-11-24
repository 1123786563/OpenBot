CREATE TABLE "paid_pilot_closure" (
	"id" text PRIMARY KEY NOT NULL,
	"sales_stopped_at" timestamp with time zone,
	"reserves_stopped_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_credit_budgets" DROP CONSTRAINT "test_credit_budget_credit_type";--> statement-breakpoint
ALTER TABLE "test_credit_budgets" ADD CONSTRAINT "test_credit_budget_credit_type" CHECK ("credit_type" IN ('test', 'paid'));