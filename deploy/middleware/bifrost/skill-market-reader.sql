-- Apply as the Bifrost database owner after v2.6.0 has initialized its schema.
-- Create openbot_skill_reader as a separate LOGIN role before applying.
BEGIN;
CREATE SCHEMA IF NOT EXISTS openbot_skill_market;
REVOKE ALL ON SCHEMA openbot_skill_market FROM PUBLIC;

CREATE OR REPLACE VIEW openbot_skill_market.catalog AS
SELECT name, description, latest_version, id AS skill_id
FROM public.skills;

CREATE OR REPLACE VIEW openbot_skill_market.versions AS
SELECT version.id, skill.name, version.version, version.created_at,
       version.skill_md_body, version.frontmatter_snapshot
FROM public.skill_versions AS version
JOIN public.skills AS skill ON skill.id = version.skill_id;

CREATE OR REPLACE VIEW openbot_skill_market.files AS
SELECT file.skill_version_id, file.path, file.source_type, file.file_size_bytes,
       blob.data
FROM public.skill_files AS file
LEFT JOIN public.skill_file_blobs AS blob ON blob.id = file.blob_id
  AND file.storage_key IS NULL
  AND file.source_type IN ('text', 'dataurl', 'upload');

REVOKE ALL ON ALL TABLES IN SCHEMA openbot_skill_market FROM PUBLIC;
GRANT USAGE ON SCHEMA openbot_skill_market TO openbot_skill_reader;
GRANT SELECT ON openbot_skill_market.catalog, openbot_skill_market.versions,
  openbot_skill_market.files TO openbot_skill_reader;
COMMIT;
