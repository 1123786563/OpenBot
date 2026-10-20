-- Bifrost 09.2 (#287): the usage fact's team dimension.
--
-- A company-workbench call records the workspace it ran under (the scope's workspaceId), so
-- the usage row answers "which team" beside the ownerUserId that already answers "which
-- person" (09.1). Attribution only: the column never influences the payer — the account the
-- call billed stays whatever the request's binding fixed (09.2), no matter what this reads.
-- Nullable like its siblings: every path without a company scope leaves it absent, a named
-- absence rather than a guessed team.
ALTER TABLE "usage_outbox" ADD COLUMN "workspace_id" text;
