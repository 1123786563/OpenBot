-- Bifrost 03.7 (#229, AC10/Q4/Q17): the administrator's model open scope.
--
-- `gateway_model_open_scopes` holds every ModelRef cell an administrator has explicitly
-- acted on, with the state that action left (`open` / `closed`) and the reason they
-- recorded. A ref with NO row here has never been opened — which is exactly the default a
-- sync must arrive at: a newly synced model widens nothing until an administrator says so
-- (Q17: 同步不自动扩大管理员开放范围), so absence of a row is the closed state, not an
-- oversight.
--
-- The table holds the CURRENT state only. Every open and close also writes an audit row
-- (`gateway.model_scope_changed`, previous state and reason included) into the append-only
-- `audit_events` trail, so the history cannot be rewritten; this table stays the cheap
-- current-state read `isModelOpen` resolves against. Re-opening, re-closing and reason
-- updates are ordinary upserts, each audited.
--
-- Scope changes are admission-bound, never retrospective: writing here touches nothing
-- else. The price snapshots a request locked stay resolvable forever (0133's append-only
-- table) and live reservations are untouched — a close refuses new selections and new
-- admissions only (AC10).
CREATE TABLE IF NOT EXISTS "gateway_model_open_scopes" (
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"capability" text NOT NULL,
	"state" text NOT NULL,
	"reason" text NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_model_open_scopes_identity_pk" PRIMARY KEY("provider","model","capability")
);
--> statement-breakpoint
ALTER TABLE "gateway_model_open_scopes" ADD CONSTRAINT "gateway_model_open_scopes_state_allowed" CHECK ("gateway_model_open_scopes"."state" IN ('open', 'closed'));
--> statement-breakpoint
ALTER TABLE "gateway_model_open_scopes" ADD CONSTRAINT "gateway_model_open_scopes_capability_allowed" CHECK ("gateway_model_open_scopes"."capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown'));
