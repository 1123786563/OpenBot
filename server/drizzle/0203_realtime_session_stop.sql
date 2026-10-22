-- Bifrost 15.5 (#318): the realtime session's STOPPED state — what balance exhaustion
-- writes when the next unit no longer fits under the account (余额耗尽后不开始新的付费单元).
--
-- STOP IS NOT CLOSE. The session's state machine stays two-valued (`open` until 15.6's
-- revocation/expiry stop closes it, exactly as 0193 reserved); a stopped session is one
-- that admits NO NEW BILLING UNIT until its money question changes, while everything
-- already admitted keeps its rights: holds stay held, settlement proceeds exactly as
-- before, and the session is not torn down (停止不等于关闭会话). Keeping the two
-- vocabularies in separate columns keeps the two tickets' semantics from colliding: a
-- revocation closes (terminal), an exhaustion stops (recoverable in principle, never by
-- optimism — only a changed balance verdict on a later unit open could, and 15.5's door
-- refuses every later unit outright, so in practice the stopped session ends when the
-- client disconnects).
--
-- THE REASON IS THE ANSWER, AND IT IS CLOSED BY CONVENTION. `stop_reason` carries the
-- door's own refusal code that exhausted the balance (`insufficient_credits`) — the same
-- closed vocabulary the unit rows record, so the user-visible surfaces (restore, the
-- pending-settlement views) distinguish a money verdict from every transport-shaped
-- failure without a second vocabulary (耗尽原因与网络错误可区分).
--
-- THE SHAPE CHECK keeps the pair honest the way 0193's closed shape does: a stopped
-- session must name when and why; a never-stopped session must carry neither.

ALTER TABLE "realtime_sessions" ADD COLUMN "stopped_at" timestamp with time zone;
ALTER TABLE "realtime_sessions" ADD COLUMN "stop_reason" text;

ALTER TABLE "realtime_sessions" ADD CONSTRAINT "realtime_sessions_stopped_shape_check" CHECK (
  ("realtime_sessions"."stopped_at" IS NULL AND "realtime_sessions"."stop_reason" IS NULL) OR
  ("realtime_sessions"."stopped_at" IS NOT NULL AND "realtime_sessions"."stop_reason" IS NOT NULL)
);
