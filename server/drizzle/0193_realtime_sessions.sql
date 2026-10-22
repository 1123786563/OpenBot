-- Bifrost 15.1 (#314): the realtime session's own durable identity — the row a WebSocket
-- (or WebRTC) session is born under, so its payer, authorization, model and price basis are
-- FIXED at establishment and survive disconnects and restarts.
--
-- WHAT THE TABLE IS. One row per established realtime session: the local session identity
-- (`rs-` prefix, recognisable on sight like the reservation's `cr-`), the grant the session
-- runs under, the payment account the door RESOLVED server-side (never the request's
-- spelling of it), the model cell, and BOTH locked versions — the contract members the
-- ticket's own Produces names. Everything a recovery flow (15.8) or a later unit (15.2)
-- needs to attribute cost to the SAME account is in this row, frozen at creation: 会话期间
-- 身份与账务基准固定不变.
--
-- WHY NO RESERVATION COLUMN. 15.1 establishes identity only: a session's money moves per
-- BILLING UNIT (15.2's own subject), so the row carries no reservation and the
-- establishment path writes no hold, no ledger, and no dispatch (会话建立本身不产生供应商
-- 计费派发). The state machine is deliberately two-valued — `open` until 15.6's
-- revocation/expiry stop closes it — and the CHECK keeps the pair honest: a closed row must
-- name when and why, an open row must not.
--
-- WHY PAYER_KIND IS THE CLOSED SET. The column records what the door resolved, and the
-- personal-scope grant a realtime session runs under today resolves to `personal`; the set
-- is the same one async_jobs carries so the two identity rows speak one vocabulary.

CREATE TABLE "realtime_sessions" (
  "session_id" text PRIMARY KEY,
  "grant_id" text NOT NULL REFERENCES "access_grants"("grant_id"),
  "payer_kind" text NOT NULL,
  "payer_id" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "capability" text NOT NULL,
  "snapshot_version" integer NOT NULL,
  "rate_version" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'open',
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "closed_at" timestamp with time zone,
  "close_reason" text,
  CONSTRAINT "realtime_sessions_capability_check" CHECK ("realtime_sessions"."capability" = 'realtime'),
  CONSTRAINT "realtime_sessions_payer_kind_check" CHECK ("realtime_sessions"."payer_kind" IN ('personal', 'company', 'legacy_deployment', 'unknown_owner')),
  CONSTRAINT "realtime_sessions_state_check" CHECK ("realtime_sessions"."state" IN ('open', 'closed')),
  CONSTRAINT "realtime_sessions_version_check" CHECK ("realtime_sessions"."snapshot_version" >= 1 AND "realtime_sessions"."rate_version" >= 0),
  CONSTRAINT "realtime_sessions_closed_shape_check" CHECK (("realtime_sessions"."state" = 'open' AND "realtime_sessions"."closed_at" IS NULL AND "realtime_sessions"."close_reason" IS NULL) OR ("realtime_sessions"."state" = 'closed' AND "realtime_sessions"."closed_at" IS NOT NULL))
);

-- Recovery (15.8) and the user's own session list read by grant, newest first; the index
-- keeps that lookup cheap without widening the primary key's identity.
CREATE INDEX "realtime_sessions_grant_idx" ON "realtime_sessions" USING btree ("grant_id", "started_at");
