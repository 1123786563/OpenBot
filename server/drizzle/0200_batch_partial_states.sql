-- Bifrost 18.3 (#335): the batch's partial-success semantics — the per-item OUTCOME rows
-- the classification writes, and the batch-level terminal states and per-class counts the
-- status views read.
--
-- WHY AN OUTCOMES TABLE. A partial batch's money moves when EVERY item's disposition is
-- known: the billable items' exact costs are summed into the ONE settlement, and the
-- not-dispatched items' certified shares hand back WITH that settlement — on their
-- EVIDENCE, never because "the batch did not finish". The outcome row is where each
-- item's disposition lives: its classification (the closed four-class vocabulary the
-- ticket names), the provider's own terminal word, the release evidence (when the item
-- released — `not_dispatched` is the only member: the provider's own accounting that the
-- item never ran; a batch gone from retention or a key refused prove nothing about cost,
-- so they classify unknown and keep the hold), and how many reports arrived for the item
-- (a duplicate is a count, never a second charge).
--
-- THE BATCH'S TERMINAL STATES. `partial` (some items completed, some not),
-- `completed` (every item completed), `failed` (no item completed) — reachable only
-- after the settlement committed, which the extended dispatch-shape CHECK enforces: a
-- terminal-state row carries the provider batch id AND a settled_at. The per-class
-- counts are the status view's own members, updated in the settlement's wake.
--
-- NO MONEY HERE. The classification and its counts are observability; the ledger is one,
-- and it is not this table.

-- The outcome rows: one per item of a batch that has begun reporting.
CREATE TABLE "batch_item_outcomes" (
  "item_id" text PRIMARY KEY REFERENCES "batch_items"("item_id"),
  "batch_id" text NOT NULL REFERENCES "batch_jobs"("batch_id"),
  "custom_id" text NOT NULL,
  "classification" text NOT NULL,
  "terminal_state" text,
  "evidence" jsonb,
  "usage" jsonb,
  "reports" integer NOT NULL DEFAULT 1,
  "first_reported_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_reported_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "batch_item_outcomes_classification_check" CHECK ("classification" IN ('completed', 'failed_billable', 'not_dispatched', 'unknown')),
  CONSTRAINT "batch_item_outcomes_terminal_state_check" CHECK ("terminal_state" IS NULL OR "terminal_state" IN ('completed', 'failed', 'cancelled')),
  CONSTRAINT "batch_item_outcomes_reports_check" CHECK ("reports" >= 1),
  CONSTRAINT "batch_item_outcomes_shape_check" CHECK (
    ("classification" IN ('completed', 'failed_billable') AND "terminal_state" IS NOT NULL AND "usage" IS NOT NULL)
    OR ("classification" = 'not_dispatched' AND "evidence" IS NOT NULL)
    OR ("classification" = 'unknown')
  )
);

CREATE INDEX "batch_item_outcomes_batch_idx" ON "batch_item_outcomes" ("batch_id", "custom_id");

-- The batch's terminal states, the per-class counts and the settle instant (columns
-- first — the rewritten CHECKs below reference settled_at).
ALTER TABLE "batch_jobs"
  ADD COLUMN "completed_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "failed_billable_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "released_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "unknown_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "settled_at" timestamp with time zone,
  ADD CONSTRAINT "batch_jobs_counts_check" CHECK (
    "completed_count" >= 0 AND "failed_billable_count" >= 0
    AND "released_count" >= 0 AND "unknown_count" >= 0
  );

ALTER TABLE "batch_jobs" DROP CONSTRAINT "batch_jobs_state_check";
ALTER TABLE "batch_jobs" ADD CONSTRAINT "batch_jobs_state_check" CHECK ("state" IN ('submitted', 'dispatch_unconfirmed', 'partial', 'completed', 'failed'));

ALTER TABLE "batch_jobs" DROP CONSTRAINT "batch_jobs_dispatch_shape_check";
ALTER TABLE "batch_jobs" ADD CONSTRAINT "batch_jobs_dispatch_shape_check" CHECK (
  ("state" = 'submitted' AND "provider_batch_id" IS NOT NULL AND "dispatched_at" IS NOT NULL)
  OR ("state" = 'dispatch_unconfirmed' AND "provider_batch_id" IS NULL)
  OR ("state" IN ('partial', 'completed', 'failed') AND "provider_batch_id" IS NOT NULL AND "settled_at" IS NOT NULL)
);
