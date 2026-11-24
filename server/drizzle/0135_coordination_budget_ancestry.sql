ALTER TABLE "test_credit_budgets" ADD COLUMN "parent_budget_id" text;--> statement-breakpoint
ALTER TABLE "test_credit_budgets" ADD COLUMN "child_kind" text;--> statement-breakpoint
ALTER TABLE "test_credit_budgets" ADD COLUMN "child_bot_id" text;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD COLUMN "parent_run_id" text;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD COLUMN "coordination_tool_names" jsonb;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD COLUMN "result_calls" jsonb;--> statement-breakpoint
ALTER TABLE "test_credit_resume_points" ADD COLUMN "required_budget_id" text;--> statement-breakpoint
ALTER TABLE "test_credit_budgets" ADD CONSTRAINT "test_credit_budgets_parent_fk" FOREIGN KEY ("account_id","parent_budget_id") REFERENCES "public"."test_credit_budgets"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_credit_budgets" ADD CONSTRAINT "test_credit_budgets_child_key" UNIQUE("account_id","parent_budget_id","child_kind","child_bot_id");--> statement-breakpoint
ALTER TABLE "test_credit_budgets" ADD CONSTRAINT "test_credit_budgets_child_binding" CHECK (("test_credit_budgets"."parent_budget_id" IS NULL AND "test_credit_budgets"."child_kind" IS NULL AND "test_credit_budgets"."child_bot_id" IS NULL)
        OR ("test_credit_budgets"."parent_budget_id" IS NOT NULL AND "test_credit_budgets"."parent_budget_id" <> "test_credit_budgets"."id"
          AND "test_credit_budgets"."child_kind" IN ('delegation', 'subagent') AND "test_credit_budgets"."child_kind" IS NOT NULL
          AND "test_credit_budgets"."child_bot_id" IS NOT NULL));