-- Bifrost 12.2 (#303): the per-settlement line detail — the structured entry a capability's
-- settlement writes beside its ledger row, so a user's consumption detail can show WHAT was
-- consumed (the image spec and count), not only what it cost.
--
-- WHY A TABLE AND NOT A TITLE STRING. The ledger row's title is prose; a consumption entry
-- that must show 规格、数量 and be distinguishable from every other capability (可与其他能力
-- 区分) needs structure a view can read and a CHECK can keep honest. The MONEY stays on the
-- ledger row (its `credits` is the amount shown); this table carries the line's own facts —
-- the frozen request spec (12.1), the provider-reported actual count, and the locked tier
-- price the settlement priced at (the audit face of 结算使用预留时锁定的价格版本).
--
-- ONE LINE PER SETTLED RESERVATION. The unique key is the reservation: a settlement is one
-- terminal fact of one hold (06.9), and the writer inserts this row inside the SAME
-- transaction as the ledger row and the reservation's terminal update — the money, the
-- release, and the detail land as one commit, so a settled charge can never exist without
-- the detail that names it. `ledger_id` joins the view to the ledger row; `capability` is a
-- closed vocabulary (image today; a new capability arrives with its own migration, the rule
-- the dimension vocabulary follows).

CREATE TABLE "credit_settlement_details" (
  "reservation_id" text PRIMARY KEY REFERENCES "credit_reservations"("id"),
  "ledger_id" text NOT NULL REFERENCES "credit_ledger"("id"),
  "capability" text NOT NULL,
  "requested_count" integer NOT NULL,
  "generated_count" integer NOT NULL,
  "input_images" integer NOT NULL DEFAULT 0,
  "size" text,
  "quality" text,
  "unit_price_usd" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "credit_settlement_details_capability_check" CHECK ("credit_settlement_details"."capability" IN ('image')),
  CONSTRAINT "credit_settlement_details_counts_check" CHECK (
    "credit_settlement_details"."requested_count" > 0
    AND "credit_settlement_details"."generated_count" >= 0
    AND "credit_settlement_details"."generated_count" <= "credit_settlement_details"."requested_count"
    AND "credit_settlement_details"."input_images" >= 0
  ),
  CONSTRAINT "credit_settlement_details_unit_price_shape_check" CHECK ("credit_settlement_details"."unit_price_usd" ~ '^[0-9]+(\.[0-9]+)?$')
);

CREATE INDEX "credit_settlement_details_ledger_idx" ON "credit_settlement_details" ("ledger_id");
