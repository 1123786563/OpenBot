-- Bifrost 15.2 (#315): the realtime billing unit — one row per independently reserved,
-- independently attempt-identified segment of a realtime session's money.
--
-- WHAT A UNIT IS. A session's cost does not move as one hold: it moves per BILLING UNIT
-- (按供应商实际计费粒度), and this row is a unit's durable identity — the session it belongs
-- to, the caller's stable unit key, the unit's KIND (which side of the session's money it
-- covers: 输入音频 / 输出音频 / 响应 / 时长), and the hold ceiling (`bound_cents`, scaled ×100)
-- the unit was certified against. Every unit is reserved BEFORE processing (处理前都有独立
-- attemptId 与预留): the attempt and reservation identities land on the row the moment the
-- 06.3 door answers, and units of one session share the same account's ATOMIC capacity —
-- each reserve rides the credit writer's customer lock, so two units of one session can
-- never both spend the same cent (同一会话的多个单元共享同一账户的原子额度).
--
-- THE STATE MACHINE IS THE CONTRACT (the ticket's Produces): pending → reserved →
-- processing → settled | unknown | refused. `pending` exists inside the open transaction
-- only — the insert and the reserve outcome land as one commit — but it is a member of the
-- closed set because the CHECK names the whole machine, and the later tickets (15.4/15.5,
-- 06.8 unknown) write their states through it. `refused` is a RECORDED outcome, not an
-- absent one: a unit whose reserve was refused stays queryable with the door's own reason
-- code (预留失败的单元不进入处理 — the row is the evidence, the missing reservation is the
-- proof no provider input could be billed to it).
--
-- WHY unit_key IS UNIQUE PER SESSION. One unit is one (session, key), ever — a replayed
-- open of the same key converges on the original row and its original answer, so a lost
-- response recovers the unit instead of paying for a second one (结算重放不重扣). The
-- attempt id is unique wherever present, mirroring 06.7's one-attempt-one-reservation
-- mapping at unit granularity.

CREATE TABLE "realtime_units" (
  "unit_id" text PRIMARY KEY,
  "session_id" text NOT NULL REFERENCES "realtime_sessions"("session_id"),
  "unit_key" text NOT NULL,
  "kind" text NOT NULL,
  "bound_cents" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "attempt_id" text,
  "reservation_id" text,
  "refusal_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "state_updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "realtime_units_kind_check" CHECK ("realtime_units"."kind" IN ('input_audio', 'output_audio', 'response', 'duration')),
  CONSTRAINT "realtime_units_bound_check" CHECK ("realtime_units"."bound_cents" > 0),
  CONSTRAINT "realtime_units_state_check" CHECK ("realtime_units"."state" IN ('pending', 'reserved', 'processing', 'settled', 'unknown', 'refused')),
  CONSTRAINT "realtime_units_state_shape_check" CHECK (
    ("realtime_units"."state" = 'pending' AND "realtime_units"."attempt_id" IS NULL AND "realtime_units"."reservation_id" IS NULL AND "realtime_units"."refusal_reason" IS NULL) OR
    ("realtime_units"."state" IN ('reserved', 'processing', 'settled', 'unknown') AND "realtime_units"."attempt_id" IS NOT NULL AND "realtime_units"."reservation_id" IS NOT NULL AND "realtime_units"."refusal_reason" IS NULL) OR
    ("realtime_units"."state" = 'refused' AND "realtime_units"."attempt_id" IS NULL AND "realtime_units"."reservation_id" IS NULL AND "realtime_units"."refusal_reason" IS NOT NULL)
  ),
  CONSTRAINT "realtime_units_reservation_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "credit_reservations"("id")
);

-- One unit per (session, key), ever: the replay's convergence point.
CREATE UNIQUE INDEX "realtime_units_session_key_idx" ON "realtime_units" USING btree ("session_id", "unit_key");
-- One attempt identity names at most one unit, wherever an attempt is present.
CREATE UNIQUE INDEX "realtime_units_attempt_idx" ON "realtime_units" ("attempt_id") WHERE "attempt_id" IS NOT NULL;
-- The recovery and user reads walk a session's units oldest first.
CREATE INDEX "realtime_units_session_created_idx" ON "realtime_units" USING btree ("session_id", "created_at");
