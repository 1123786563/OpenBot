-- Bifrost 18.2 (#334): the batch settlement's per-item line details — one row per item,
-- written beside the ONE aggregated ledger row of the batch's settlement, so a user's
-- consumption detail shows WHAT each item cost (which item, which model, which terminal
-- state, the real usage, the exact cost) and the charge is attributable at BOTH levels:
-- the batch (the ledger row, named by `request_id` = batchId) and every item (its own
-- line here, joined to that same ledger row).
--
-- WHY PER-ITEM ROWS INSTEAD OF ONE ROW. The async line (0197) attributes a whole job by
-- ONE row because the job's charge is one fact; a batch's charge is N facts — each item
-- ran, each item's usage is its own, and 18.3/18.4's partial semantics classify ITEMS,
-- not the batch. The item is therefore the attribution anchor (item_id, UNIQUE — the key
-- every per-item surface names), and the batch level is the JOIN by batch_id: the rows
-- of one settlement share one ledger_id, and their exact costs sum to the ledger row's
-- actual cost (the writer's own assert at write time, the write-side invariant).
--
-- THE MONEY STAYS ON THE LEDGER ROW. exact_cost is the item's exact rational share of
-- the ONE settlement — a traceable entry, not a second ledger; charged/applied/released
-- live on the reservation and the ledger row, where they already were. actual_usage is
-- the provider's real per-item usage, stored as the record it was, never re-derived.

CREATE TABLE "credit_batch_settlement_details" (
  "item_id" text PRIMARY KEY REFERENCES "batch_items"("item_id"),
  "batch_id" text NOT NULL REFERENCES "batch_jobs"("batch_id"),
  "ledger_id" text NOT NULL REFERENCES "credit_ledger"("id"),
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "capability" text NOT NULL,
  "custom_id" text NOT NULL,
  "terminal_state" text NOT NULL,
  "actual_usage" jsonb NOT NULL,
  "exact_cost" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "credit_batch_settlement_details_capability_check" CHECK ("capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown')),
  CONSTRAINT "credit_batch_settlement_details_terminal_state_check" CHECK ("terminal_state" IN ('completed', 'failed', 'cancelled')),
  CONSTRAINT "credit_batch_settlement_details_custom_id_check" CHECK (length("custom_id") > 0),
  CONSTRAINT "credit_batch_settlement_details_usage_shape_check" CHECK (jsonb_typeof("actual_usage") = 'object'),
  CONSTRAINT "credit_batch_settlement_details_cost_shape_check" CHECK (
    jsonb_typeof("exact_cost") = 'object'
    AND jsonb_typeof("exact_cost"->'numerator') = 'string'
    AND jsonb_typeof("exact_cost"->'denominator') = 'string'
  )
);

-- The batch-level attribution read: one settlement's item lines, oldest (index) first.
CREATE INDEX "credit_batch_settlement_details_batch_idx" ON "credit_batch_settlement_details" ("batch_id");
-- The ledger join: the consumption view walks a ledger row to its item lines.
CREATE INDEX "credit_batch_settlement_details_ledger_idx" ON "credit_batch_settlement_details" ("ledger_id");
