-- Effective time and correction history on general personal preferences (Hindsight 09 / #386).
--
-- A correction of a time-varying fact is not a deletion: the OLD fact keeps its content and
-- its validity window, the NEW fact applies from the person's stated effective time, and both
-- remain recallable — current questions read the row whose window covers now, historical
-- questions read the one whose window covered the asked-about moment. The columns:
--
--   effective_from  — when the fact began to apply. NULL = the start could not be determined
--                     (an unknown-time correction, or a row predating this migration): such a
--                     row may answer CURRENT questions, flagged uncertain; it never claims
--                     historical validity.
--   effective_until — when the fact stopped applying. NULL = still open. A window only ever
--                     closes by correction (the CHECK below), never by forgetting — forgetting
--                     stays the tombstone's job (deleted_at + enabled + content cleared), and
--                     a tombstoned row answers nothing, current or historical.
--   superseded_by   — the correcting row's id; the chain head (superseded_by IS NULL) is the
--                     current fact.
--   superseded_time_unknown — the correction that closed this row could not name a time; the
--                     open-ended window is an UNKNOWN, not an "ongoing", so historical reads
--                     inside the ambiguity surface the row flagged uncertain rather than
--                     fabricating a transition date.
--   corrected_at    — when the person made the correction (the decision's evidence).
ALTER TABLE "generic_personal_preferences" ADD COLUMN "effective_from" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "generic_personal_preferences" ADD COLUMN "effective_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "generic_personal_preferences" ADD COLUMN "superseded_by" text;
--> statement-breakpoint
ALTER TABLE "generic_personal_preferences" ADD COLUMN "superseded_time_unknown" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "generic_personal_preferences" ADD COLUMN "corrected_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "generic_personal_preferences" ADD CONSTRAINT "generic_personal_preference_window_shape" CHECK (
	(
		(("generic_personal_preferences"."superseded_by" is null) = ("generic_personal_preferences"."effective_until" is null)) or
		("generic_personal_preferences"."superseded_by" is not null and "generic_personal_preferences"."effective_until" is null and "generic_personal_preferences"."superseded_time_unknown" = true)
	) and
	("generic_personal_preferences"."effective_until" is null or "generic_personal_preferences"."effective_from" is null or "generic_personal_preferences"."effective_until" > "generic_personal_preferences"."effective_from")
);
--> statement-breakpoint
ALTER TABLE "generic_personal_preferences" ADD CONSTRAINT "generic_personal_preference_unknown_flag" CHECK (
	("generic_personal_preferences"."superseded_time_unknown" = false) or
	("generic_personal_preferences"."superseded_by" is not null and "generic_personal_preferences"."effective_until" is null)
);
--> statement-breakpoint
ALTER TABLE "generic_personal_preferences" ADD CONSTRAINT "generic_personal_preferences_tenant_id_superseded_by_generic_personal_preferences_tenant_id_id_fk" FOREIGN KEY ("tenant_id","superseded_by") REFERENCES "public"."generic_personal_preferences"("tenant_id","id") ON DELETE no action ON UPDATE no action;
