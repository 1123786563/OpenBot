-- multitenancy migrate-test
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM mt_tool_selfcheck) THEN RAISE EXCEPTION 'mt_tool_selfcheck row missing: step ordering broken'; END IF; END $$;
