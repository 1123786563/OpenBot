-- Bifrost 18.1 (#333): the batch's own durable identity — the parent row the submit
-- idempotency key converges on, and one child row per item, all under the ONE whole-batch
-- reservation the submit holds BEFORE any provider dispatch.
--
-- WHAT THE PARENT ROW IS. One row per accepted batch submit: the local `bj-` identity,
-- the submit's stable idempotency key (UNIQUE — a replayed submit lands on this row and
-- never creates a second batch, a second reservation or a second dispatch), the
-- grant/payer/versions the batch was born under, and the whole-batch cap
-- (`maximum_credits` — every item's worst case summed EXACTLY across the items' own model
-- cells, ONE upward rounding at the end; a second, larger reservation can never follow,
-- because the cap is fixed at creation and the submit key is the only door).
--
-- WHY THE BATCH DOES NOT COPY THE ASYNC JOBS' MODEL COLUMNS. A batch spans items whose
-- models (and therefore unit prices) DIFFER — there is no single model cell that is the
-- batch's price basis. The pricing basis is the PAIR (batch versions × each item's own
-- cell) on the child rows; the reservation's own basis lock names the batch's anchor cell
-- (the first distinct cell admitted), which is a true resolvable basis but NOT the batch's
-- price basis — batch settlement prices from the child rows, never from the hold's lock.
--
-- WHY provider_batch_id IS NULLABLE. The provider's answer can be lost between dispatch
-- and the write (the async family's 17.3 lane): "not yet known" is a state the row holds
-- while the reservation stays occupied at its FULL cap (moved to `unknown` the moment the
-- loss is known — a missing provider id is never evidence of no cost).
--
-- WHAT THE CHILD ROWS ARE. One row per item: the item's own `bi-` identity, the caller's
-- `custom_id` (UNIQUE per batch — the key the provider's per-item results come back
-- keyed by, so a result maps to exactly one item), the item's own model cell, and the
-- item's certified worst-case quantities (frozen at submit — the input-side evidence the
-- cap was certified from). The child carries NO money and NO payer of its own: its
-- attribution IS the parent's (one payer, one hold, by construction — the CHECKs the
-- parent owns keep the pair honest).

CREATE TABLE "batch_jobs" (
  "batch_id" text PRIMARY KEY,
  "submit_idempotency_key" text NOT NULL,
  "grant_id" text NOT NULL REFERENCES "access_grants"("grant_id"),
  "payer_kind" text NOT NULL,
  "payer_id" text NOT NULL,
  "snapshot_version" integer NOT NULL,
  "rate_version" integer NOT NULL,
  "provider_batch_id" text,
  "reservation_id" text NOT NULL REFERENCES "credit_reservations"("id"),
  "maximum_credits" integer NOT NULL,
  "item_count" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'dispatch_unconfirmed',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "dispatched_at" timestamp with time zone,
  CONSTRAINT "batch_jobs_submit_idempotency_key_unique_idx" UNIQUE ("submit_idempotency_key"),
  CONSTRAINT "batch_jobs_payer_kind_check" CHECK ("payer_kind" IN ('personal', 'company', 'legacy_deployment', 'unknown_owner')),
  CONSTRAINT "batch_jobs_version_check" CHECK ("snapshot_version" >= 1 AND "rate_version" >= 0),
  CONSTRAINT "batch_jobs_maximum_check" CHECK ("maximum_credits" > 0),
  CONSTRAINT "batch_jobs_item_count_check" CHECK ("item_count" > 0),
  CONSTRAINT "batch_jobs_state_check" CHECK ("state" IN ('submitted', 'dispatch_unconfirmed')),
  CONSTRAINT "batch_jobs_dispatch_shape_check" CHECK (("state" = 'submitted' AND "provider_batch_id" IS NOT NULL AND "dispatched_at" IS NOT NULL) OR ("state" = 'dispatch_unconfirmed' AND "provider_batch_id" IS NULL))
);

-- The recovery sweep and the status reads arrive by grant and by provider batch id; both
-- get an index now, the same lookup pattern the async family's row exists for.
CREATE INDEX "batch_jobs_grant_idx" ON "batch_jobs" USING btree ("grant_id", "created_at");
CREATE UNIQUE INDEX "batch_jobs_provider_batch_id_idx" ON "batch_jobs" ("provider_batch_id") WHERE "provider_batch_id" IS NOT NULL;

CREATE TABLE "batch_items" (
  "item_id" text PRIMARY KEY,
  "batch_id" text NOT NULL REFERENCES "batch_jobs"("batch_id"),
  "item_index" integer NOT NULL,
  "custom_id" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "capability" text NOT NULL,
  "quantities" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "batch_items_index_check" CHECK ("item_index" >= 0),
  CONSTRAINT "batch_items_custom_id_check" CHECK (length("custom_id") > 0 AND length("custom_id") <= 512),
  CONSTRAINT "batch_items_capability_check" CHECK ("capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown')),
  CONSTRAINT "batch_items_quantities_shape_check" CHECK (jsonb_typeof("quantities") = 'object'),
  CONSTRAINT "batch_items_batch_index_unique_idx" UNIQUE ("batch_id", "item_index"),
  CONSTRAINT "batch_items_custom_id_unique_idx" UNIQUE ("batch_id", "custom_id")
);

-- The result lane joins by custom id inside one batch; the item walk joins by parent.
CREATE INDEX "batch_items_batch_idx" ON "batch_items" USING btree ("batch_id", "item_index");
