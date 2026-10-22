-- Bifrost 15.7 (#320): the realtime unit's settled tail — when a unit's hold settled, the
-- evidence the "only once" answer stands on (关停后的尾部费用在原预留上限内结算，且只结算一次).
--
-- WHY A COLUMN AT ALL. The reservation's own settle (06.9) is the money authority — one
-- settle per reservation, fenced on the ledger — so the unit row does not re-fence the
-- charge; what it records is the UNIT's view of that fact: the moment the tail landed,
-- `settled_at`, present exactly when the state is `settled`. A replayed settle answers the
-- reservation's original result (06.9's idempotency); the unit row's guard makes the same
-- true for every reader of the unit: settled is settled, and the timestamp never moves.
--
-- THE SHAPE CHECK mirrors the unknown shape: `settled_at` is present exactly when the
-- state is `settled`, and `settled` never carries `unknown_reason` — the two terminal
-- tails of a holding unit are mutually exclusive facts about one hold.

ALTER TABLE "realtime_units" ADD COLUMN "settled_at" timestamp with time zone;

ALTER TABLE "realtime_units" ADD CONSTRAINT "realtime_units_settled_shape_check" CHECK (
  ("realtime_units"."state" = 'settled' AND "realtime_units"."settled_at" IS NOT NULL AND "realtime_units"."unknown_reason" IS NULL) OR
  ("realtime_units"."state" <> 'settled' AND "realtime_units"."settled_at" IS NULL)
);
