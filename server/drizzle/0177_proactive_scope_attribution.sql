-- MT045 (Issue #88): proactive research scope attribution.
--
-- Background-research settings are personal-domain rows today: a setting belongs to one owner user
-- and its suggestions deliver back to that person. Enterprise attribution follows the MT044
-- precedent (0170, responsibility_triggers): these two nullable columns carry the persisted
-- company/team mapping a delivery resolves against. Both null = the legacy personal setting and
-- every existing row — behaviour unchanged; a value pair = this setting's runs and suggestions
-- belong to that (company, team), and delivery revalidates that mapping live rather than trusting
-- the columns. Plain text with no foreign keys on purpose: the enterprise tables are not guaranteed
-- to exist on a personal deployment, and liveness belongs to resolution time, not schema shape.
-- Attribution is create-once: writes happen at creation and never migrate (changing scope = a new
-- setting), matching MT044/MT041 discipline.
ALTER TABLE "proactive_settings" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "proactive_settings" ADD COLUMN "workspace_id" text;--> statement-breakpoint
CREATE INDEX "proactive_settings_tenant_idx" ON "proactive_settings" USING btree ("tenant_id");
