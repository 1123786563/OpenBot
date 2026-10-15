-- Dataset version rows leave only through dataset cleanup (Issue #26/T20, T19 review finding).
-- A direct DELETE of one frozen version is refused by the database: an experiment that pinned a
-- version must not find its content vanished under it. The one sanctioned path is the dataset
-- cleanup API, which runs inside a transaction that sets ai_observation.dataset_cleanup = 'on'
-- (transaction-local, via set_config) before deleting the subject row the versions cascade from.
-- Like 0123's immutability trigger, this is a database fact drizzle-kit's snapshot model does not
-- describe; the file is hand-merged and its snapshot is a copy of 0123's (T07 precedent).
CREATE FUNCTION "ai_observation_dataset_versions_reject_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- IS DISTINCT FROM, never <>: unset reads NULL here, and NULL <> 'on' is NULL, which
	-- the IF treats as false — the guard fails open on every fresh connection.
	IF current_setting('ai_observation.dataset_cleanup', true) IS DISTINCT FROM 'on' THEN
		RAISE EXCEPTION 'dataset versions are removed only through dataset cleanup'
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "ai_observation_dataset_versions_cleanup_only" BEFORE DELETE ON "ai_observation_dataset_versions" FOR EACH ROW EXECUTE FUNCTION "ai_observation_dataset_versions_reject_delete"();
