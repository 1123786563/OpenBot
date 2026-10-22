-- Bifrost 15.6 (#319): the realtime unit's UNKNOWN tail — the state a shutdown writes on
-- the units it could not confirm (关停不取消已发生费用的结算，未确认部分进入 unknown).
--
-- WHAT THE REASON NAMES. When a revocation or key expiry closes the session mid-flight,
-- every still-holding unit of that session becomes `unknown` in the same commit that
-- closed the session: its usage is unconfirmable BY the shutdown, its hold is kept —
-- never released (the fee's settlement responsibility survives the stop), never silently
-- charged (nothing but 06.9's evidence-based settle may move it, 15.7's own subject).
-- `unknown_reason` is the durable name for WHY the row is unknown: today the shutdown's
-- own `shutdown_tail_unconfirmed`; 15.7 adds the overage tail's `tail_exceeds_bound`.
-- The 08.x recovery scan reads the reservation the row still points at; the reason keeps
-- the disposal from guessing what kind of unknown it holds.
--
-- THE SHAPE CHECK closes the set the way the refusal shape does: `unknown_reason` is
-- present exactly when the state is `unknown` — a settled, holding, refused, or pending
-- row carries none.

ALTER TABLE "realtime_units" ADD COLUMN "unknown_reason" text;

ALTER TABLE "realtime_units" ADD CONSTRAINT "realtime_units_unknown_reason_shape_check" CHECK (
  ("realtime_units"."state" = 'unknown' AND "realtime_units"."unknown_reason" IS NOT NULL) OR
  ("realtime_units"."state" <> 'unknown' AND "realtime_units"."unknown_reason" IS NULL)
);
