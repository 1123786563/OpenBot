-- Bifrost 08.9 (#284): the disposal's own columns on the recovery item — the version an
-- operator's expectedVersion stands on, and the resolution record a disposal leaves
-- (action, who, when, the specific evidence row, the command's idempotency key).
--
-- WHY COLUMNS AND NOT A SECOND TABLE: the disposal is a fact ABOUT the item's lifecycle,
-- terminal like the item's own `resolved` state, and it must move WITH that state in one
-- UPDATE (the version guard below) — a side table could drift from the state it resolves.
-- The recovery handlers' own resolutions (08.2's replay) keep these columns NULL: their
-- evidence is the replay's reason, not an operator's evidence row.
--
-- ALL-OR-NOTHING (the CHECK): a disposal record is complete or absent — an action without
-- its operator, or an evidence pointer without an action, is a half-fact this table
-- refuses to hold. The partial unique index makes one disposal per idempotency key a
-- database-level truth, so two replicas racing the same command cannot both record it.

ALTER TABLE "credit_recovery_items" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
ALTER TABLE "credit_recovery_items" ADD COLUMN "resolved_action" text;
ALTER TABLE "credit_recovery_items" ADD COLUMN "resolved_by" text;
ALTER TABLE "credit_recovery_items" ADD COLUMN "resolved_at" timestamp with time zone;
ALTER TABLE "credit_recovery_items" ADD COLUMN "resolution_evidence_id" text REFERENCES "credit_recovery_queries"("id");
ALTER TABLE "credit_recovery_items" ADD COLUMN "resolution_idempotency_key" text;

ALTER TABLE "credit_recovery_items" ADD CONSTRAINT "credit_recovery_items_version_check" CHECK ("credit_recovery_items"."version" >= 1);
ALTER TABLE "credit_recovery_items" ADD CONSTRAINT "credit_recovery_items_resolved_action_check" CHECK ("credit_recovery_items"."resolved_action" IS NULL OR "credit_recovery_items"."resolved_action" IN ('settle', 'release'));
ALTER TABLE "credit_recovery_items" ADD CONSTRAINT "credit_recovery_items_disposal_shape_check" CHECK (
  (
    "credit_recovery_items"."resolved_action" IS NULL AND
    "credit_recovery_items"."resolved_by" IS NULL AND
    "credit_recovery_items"."resolved_at" IS NULL AND
    "credit_recovery_items"."resolution_evidence_id" IS NULL AND
    "credit_recovery_items"."resolution_idempotency_key" IS NULL
  ) OR (
    "credit_recovery_items"."resolved_action" IN ('settle', 'release') AND
    "credit_recovery_items"."resolved_by" IS NOT NULL AND
    "credit_recovery_items"."resolved_at" IS NOT NULL AND
    "credit_recovery_items"."resolution_evidence_id" IS NOT NULL AND
    "credit_recovery_items"."resolution_idempotency_key" IS NOT NULL
  )
);

CREATE UNIQUE INDEX "credit_recovery_items_resolution_idempotency_key_unique_idx"
  ON "credit_recovery_items" ("resolution_idempotency_key")
  WHERE "credit_recovery_items"."resolution_idempotency_key" IS NOT NULL;

-- The claim CHECK's third shape: an evidenced disposal resolves an item straight out of
-- `pending` (the review queue's items are unclaimed — that is why an operator reads
-- them), so `resolved` without a claim is legal exactly when a DISPOSAL RECORD exists
-- (the all-or-nothing CHECK above guarantees its who/when/evidence/key completeness).
-- A handler's resolution keeps the old shape: claimed, then resolved with the claim kept.
ALTER TABLE "credit_recovery_items" DROP CONSTRAINT "credit_recovery_items_claim_consistency_check";
ALTER TABLE "credit_recovery_items" ADD CONSTRAINT "credit_recovery_items_claim_consistency_check" CHECK (
  (
    "credit_recovery_items"."state" = 'pending' AND
    "credit_recovery_items"."claimed_at" IS NULL AND
    "credit_recovery_items"."claimed_by" IS NULL
  ) OR (
    "credit_recovery_items"."state" IN ('claimed', 'resolved') AND
    "credit_recovery_items"."claimed_at" IS NOT NULL AND
    "credit_recovery_items"."claimed_by" IS NOT NULL
  ) OR (
    "credit_recovery_items"."state" = 'resolved' AND
    "credit_recovery_items"."resolved_action" IS NOT NULL
  )
);
