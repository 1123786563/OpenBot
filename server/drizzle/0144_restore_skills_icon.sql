-- The icon column on skills was lost from the migration chain during the
-- trpc-intelligence merge (522eff8a): the snapshot lineage kept it, but no SQL
-- file in the chain ever added it, so a deployment starting from nothing walks
-- all 139 migrations, has no skills.icon, and the boot-time builtin-skill seed
-- dies with `column "icon" of relation "skills" does not exist` (the image CI
-- job caught exactly this). category survived in the chain; icon did not.
ALTER TABLE "skills" ADD COLUMN "icon" text;
