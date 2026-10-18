-- The icon column on skills was lost from the migration chain during the
-- trpc-intelligence merge (522eff8a): the snapshot lineage kept it, but no SQL
-- file in the chain ever added it, so a deployment starting from nothing walks
-- the whole chain without skills.icon and the boot-time builtin-skill seed
-- dies with `column "icon" of relation "skills" does not exist`.
ALTER TABLE "skills" ADD COLUMN "icon" text;
