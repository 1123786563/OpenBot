-- Bifrost BP06 (#374): the account-level resolution registry — one row per authorized
-- disposal command on one payer account, written through the only door that records
-- them (billing/account-resolution.ts), never by anything else.
--
-- WHAT A ROW IS. The durable RESULT REGISTRATION the ticket names (授权补发/结算/释放/
-- 平台承担损失与人工退款结果登记): the account-scope decision an operator made, the
-- evidence it stood on, who commanded it, and the command's own retry identity. The
-- ACTIONS themselves move money through their own doors — an item's hold settles or
-- releases only through 08.9's evidenced disposal, a plan's redelivery through the
-- activation path — so this table is the account ledger of DECISIONS, not a second way
-- to move a hold.
--
-- WHY A TABLE AND NOT AUDIT ROWS ALONE. Replay is a query the next command needs: a
-- transport retry of the SAME command must read the recorded answer and do nothing
-- (可重放不重复), which is the UNIQUE index on idempotency_key — a database-level truth,
-- so two replicas racing the same command cannot both register it. The refund ceiling
-- (超可退额) reads the PRIOR refund rows of the account; an audit trail is not a balance.
--
-- EVIDENCE IS A COLUMN PAIR, NOT PROSE. kind from a closed vocabulary
-- (reconcile_finding / payment_event / recovery_evidence / operator_statement) plus the
-- specific reference: a command without evidence does not reach this table at all (the
-- service refuses it before the insert), and the CHECKs keep a landed row honest.

CREATE TABLE "billing_account_resolutions" (
  "id" text PRIMARY KEY,
  "external_customer_id" text NOT NULL REFERENCES "billing_customers"("external_id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "reason_code" text NOT NULL,
  "evidence_kind" text NOT NULL,
  "evidence_reference" text NOT NULL,
  "operator_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "amount_cents" integer,
  "detail" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "billing_account_resolutions_action_check" CHECK ("billing_account_resolutions"."action" IN ('reissue', 'settle', 'release', 'absorb', 'refund')),
  CONSTRAINT "billing_account_resolutions_evidence_kind_check" CHECK ("billing_account_resolutions"."evidence_kind" IN ('reconcile_finding', 'payment_event', 'recovery_evidence', 'operator_statement')),
  CONSTRAINT "billing_account_resolutions_amount_check" CHECK ("billing_account_resolutions"."amount_cents" IS NULL OR "billing_account_resolutions"."amount_cents" > 0),
  CONSTRAINT "billing_account_resolutions_reason_code_shape_check" CHECK ("billing_account_resolutions"."reason_code" ~ '^[a-z0-9_]{1,64}$')
);

CREATE UNIQUE INDEX "billing_account_resolutions_idempotency_key_unique_idx" ON "billing_account_resolutions" ("idempotency_key");
CREATE INDEX "billing_account_resolutions_account_idx" ON "billing_account_resolutions" ("external_customer_id", "created_at");
