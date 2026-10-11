-- Billing batch 2: the credit ledger's withdrawal side gets its idempotency anchor and its
-- overdraw-visibility column.
--
-- `credit_ledger.idempotency_key` (NOT NULL, plain unique index): one draw per consumption
-- occurrence — the same ids the Lago meter reports under (`llm:<key>:<seq>`, `code-run:<runId>`)
-- make a retried report a no-op rather than a second deduction. Plain (not partial) for the ON
-- CONFLICT inference reason the grants' key learned the hard way in 0071: Postgres cannot infer
-- a partial index without its WHERE spelled in-statement. `request_id` stays the display copy.
--
-- `credit_ledger.applied` (NOT NULL DEFAULT 0, CHECK 0 <= applied <= credits): how much of the
-- cost the grants actually absorbed. Post-paid semantics — the row always records the ACTUAL
-- cost in `credits`; `applied` is what the balance could fund, so `credits - applied` is the
-- overdraw, visible to reconciliation instead of rounded away. Default 0 keeps the migration
-- online for any historical rows (there are none — the table had no writer until batch 1 —
-- but the default is the honest birth state regardless).
ALTER TABLE "credit_ledger" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "applied" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_idempotency_key_unique_idx" ON "credit_ledger" USING btree ("idempotency_key");--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_applied_check" CHECK ("credit_ledger"."applied" >= 0 AND "credit_ledger"."applied" <= "credit_ledger"."credits");
