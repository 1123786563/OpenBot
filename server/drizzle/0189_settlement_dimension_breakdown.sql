-- Bifrost 20.3 (#343): the settlement's per-dimension split — the evidence the user-facing
-- consumption detail separates MODEL fees from SURCHARGE fees on, without double counting.
--
-- WHAT THE TABLE IS. One row per (ledger row × billing dimension): the integer share of
-- that ledger row's `credits` the dimension accounts for, written in the SAME transaction
-- as the ledger row (the writer's settle transaction) under a write-time invariant the
-- caller cannot bypass: the rows' units always sum to exactly the ledger row's credits,
-- so the two-level attribution (model dimensions + surcharge dimensions) reconciles with
-- the ledger BY CONSTRUCTION, never by a read-time re-derivation that could drift.
--
-- WHY INTEGER UNITS AND NOT THE EXACT RATIONALS. The ledger row itself stores whole scaled
-- units (`charged` is the floor of the exact cost plus the carried remainder); a split that
-- carried rationals would sum to a different number than the row it explains. The single
-- rounding the settlement does is allocated deterministically at write time: the surcharge
-- group rounds UP (the fee-conservative side), the model group carries the floor, and
-- within a group the leftover units distribute in the dimension vocabulary's fixed order.
--
-- WHICH DIMENSIONS. The closed PRICE_DIMENSIONS vocabulary (gateway schema) — a row for
-- every dimension with a non-zero quantity; `surcharge_*` dimensions are the surcharge
-- group, everything else the model group. The tool/routing surcharge columns 20.1 will map
-- land in this same table as their dimensions; nothing here pre-names them (dependency
-- noted in #343: the tool dimensions themselves arrive with #341).
--
-- WHY NULL-LESS BY DESIGN. A settlement that wrote no breakdown simply has no rows; the
-- consumption view answers no split for it (never a misleading zero), and every row that
-- exists belongs to a ledger row (FK) in the same account.

CREATE TABLE "credit_settlement_dimension_breakdown" (
  "ledger_id" text NOT NULL REFERENCES "credit_ledger"("id") ON DELETE CASCADE,
  "dimension" text NOT NULL,
  "units" integer NOT NULL,
  CONSTRAINT "credit_settlement_dimension_breakdown_pkey" PRIMARY KEY ("ledger_id", "dimension"),
  CONSTRAINT "credit_settlement_dimension_breakdown_units_check" CHECK ("units" >= 0)
);
