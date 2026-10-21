-- MT044 (Issue #87): inbound email / GitHub / webhook ownership attribution.
--
-- Inbound deliveries resolve their company and team from a server-side persisted mapping on the
-- trigger row, never from anything the payload claims. These columns are that mapping: null on both
-- means the legacy personal trigger (owner user) — every existing row — and a value pair means the
-- trigger's deliveries are enterprise-attributed to that (company, team). Plain text with no
-- foreign keys on purpose: the enterprise tables are not guaranteed to exist on a personal
-- deployment, and the live check ("is this mapping still resolvable against the authoritative
-- rows?") belongs to resolution time, not to schema shape. Expand-only: nullable columns and a new
-- index, nothing else about `responsibility_triggers` changes.
ALTER TABLE "responsibility_triggers" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "responsibility_triggers" ADD COLUMN "workspace_id" text;--> statement-breakpoint
CREATE INDEX "responsibility_triggers_tenant_idx" ON "responsibility_triggers" USING btree ("tenant_id");--> statement-breakpoint
-- Quarantine for authenticated inbound deliveries whose ownership cannot be resolved (rotted
-- mapping, deleted tenant, revoked membership, an email address that no longer routes). The
-- delivery is recorded for operators instead of landing in any business scope. Platform-side table
-- by design: an unattributable event has no tenant, so tenant-scoped policies cannot govern it —
-- visibility is the ops listing gated on a platform machine identity, never a business reader.
-- `trigger_id` is '' when the channel could not resolve any trigger row (unrouted email address);
-- the (channel, trigger_id, delivery_id) triple deduplicates provider redeliveries of the same
-- quarantined event.
CREATE TABLE "responsibility_inbound_quarantine" (
	"id" text PRIMARY KEY,
	"channel" text NOT NULL,
	"trigger_id" text DEFAULT '' NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text DEFAULT '' NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"review_note" text
);--> statement-breakpoint
CREATE UNIQUE INDEX "responsibility_inbound_quarantine_delivery_idx" ON "responsibility_inbound_quarantine" USING btree ("channel", "trigger_id", "delivery_id");--> statement-breakpoint
CREATE INDEX "responsibility_inbound_quarantine_pending_idx" ON "responsibility_inbound_quarantine" USING btree ("reviewed_at", "received_at");
