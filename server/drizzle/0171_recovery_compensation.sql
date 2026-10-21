-- Bifrost 08.10 (#285): the platform-loss compensation as a third disposal action.
--
-- The compensation is NOT a release wearing different words: a release stands on
-- no_charge_evidence and records "confirmed no charge"; the compensation stands on
-- still_unknown and records that the PLATFORM ABSORBED the loss the account's own trail
-- could not settle. Keeping it in the same disposal-record columns (not a side table)
-- preserves 0169's all-or-nothing discipline — the action, who, when, the evidence row
-- and the command's idempotency key move with the item's `resolved` state in one UPDATE —
-- while the vocabulary below (and the audit event the command writes) keeps the two acts
-- impossible to confuse after the fact.

ALTER TABLE "credit_recovery_items" DROP CONSTRAINT "credit_recovery_items_resolved_action_check";
ALTER TABLE "credit_recovery_items" ADD CONSTRAINT "credit_recovery_items_resolved_action_check" CHECK ("credit_recovery_items"."resolved_action" IS NULL OR "credit_recovery_items"."resolved_action" IN ('settle', 'release', 'compensate'));

ALTER TABLE "credit_recovery_items" DROP CONSTRAINT "credit_recovery_items_disposal_shape_check";
ALTER TABLE "credit_recovery_items" ADD CONSTRAINT "credit_recovery_items_disposal_shape_check" CHECK (
  (
    "credit_recovery_items"."resolved_action" IS NULL AND
    "credit_recovery_items"."resolved_by" IS NULL AND
    "credit_recovery_items"."resolved_at" IS NULL AND
    "credit_recovery_items"."resolution_evidence_id" IS NULL AND
    "credit_recovery_items"."resolution_idempotency_key" IS NULL
  ) OR (
    "credit_recovery_items"."resolved_action" IN ('settle', 'release', 'compensate') AND
    "credit_recovery_items"."resolved_by" IS NOT NULL AND
    "credit_recovery_items"."resolved_at" IS NOT NULL AND
    "credit_recovery_items"."resolution_evidence_id" IS NOT NULL AND
    "credit_recovery_items"."resolution_idempotency_key" IS NOT NULL
  )
);
