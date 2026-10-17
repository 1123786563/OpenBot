-- Bifrost 04.8 (#241): mark how each model access grant came to exist.
--
-- Until now every `access_grants` row was created by the same flow — the external Bot's one-time
-- binding code, confirmed at login (04.5) — so no marker was needed. 04.8 adds a second writer,
-- the built-in workbench bot's implicit grant, where the login session itself is the act of
-- authorization, and audit trails, listing screens and revocation sweeps must be able to tell
-- the two kinds apart inside one model. The column is a closed enum for the same reason scope
-- is: source is an admission-adjacent surface, and a value nobody shipped must not be storable.
-- `binding-code` is the default because every pre-04.8 row came from that flow and no other
-- writer exists; the backfill is therefore instantaneous and total.
ALTER TABLE "access_grants" ADD COLUMN "source" text DEFAULT 'binding-code' NOT NULL;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_source_check" CHECK ("access_grants"."source" IN ('binding-code', 'workbench-implicit'));
