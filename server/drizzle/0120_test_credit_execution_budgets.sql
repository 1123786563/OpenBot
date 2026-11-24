CREATE TABLE "test_credit_budgets" (
  "account_id" uuid NOT NULL,
  "id" text NOT NULL,
  "credit_type" text NOT NULL,
  "limit_microcredits" bigint NOT NULL,
  "state" text NOT NULL DEFAULT 'active',
  "confirmed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "test_credit_budgets_pk" PRIMARY KEY ("account_id", "id"),
  CONSTRAINT "test_credit_budget_limit_positive" CHECK ("limit_microcredits" > 0),
  CONSTRAINT "test_credit_budget_credit_type" CHECK ("credit_type" = 'test'),
  CONSTRAINT "test_credit_budget_state" CHECK ("state" IN ('active', 'paused', 'completed')),
  CONSTRAINT "test_credit_budgets_account_fk" FOREIGN KEY ("account_id") REFERENCES "test_credit_accounts"("id")
);
ALTER TABLE "test_credit_operations" ADD COLUMN "budget_id" text;
ALTER TABLE "test_credit_operations" ADD COLUMN "step_id" text;
ALTER TABLE "test_credit_operations" ADD COLUMN "result_text" text;
ALTER TABLE "test_credit_operations" ADD CONSTRAINT "test_credit_budget_fk" FOREIGN KEY ("account_id", "budget_id") REFERENCES "test_credit_budgets"("account_id", "id");
CREATE INDEX "test_credit_operations_budget_idx" ON "test_credit_operations" ("account_id", "budget_id", "state");

ALTER TABLE "routines" ADD COLUMN "budget_id" text;
ALTER TABLE "bot_tasks" ADD COLUMN "budget_id" text;
