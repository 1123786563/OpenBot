-- Apply as the Bifrost database owner after v2.6.0 has initialized its schema.
-- Create openbot_skill_reader as a separate LOGIN role before applying.
BEGIN;
CREATE SCHEMA IF NOT EXISTS openbot_skill_market;
REVOKE ALL ON SCHEMA openbot_skill_market FROM PUBLIC;

CREATE OR REPLACE VIEW openbot_skill_market.catalog AS
SELECT name, description, latest_version, id AS skill_id
FROM public.skills;

CREATE OR REPLACE FUNCTION openbot_skill_market.document_sha256(
  skill_id text, name text, version text, body text, frontmatter jsonb
) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT encode(sha256(convert_to(
    jsonb_build_array(skill_id, name, version, body, frontmatter)::text, 'UTF8'
  )), 'hex');
$$;

CREATE OR REPLACE VIEW openbot_skill_market.versions AS
SELECT version.id, skill.name, version.version, version.created_at,
       version.skill_md_body, version.frontmatter_snapshot, skill.id AS skill_id,
       openbot_skill_market.document_sha256(
         skill.id, skill.name, version.version, version.skill_md_body,
         version.frontmatter_snapshot::jsonb
       ) AS document_sha256
FROM public.skill_versions AS version
JOIN public.skills AS skill ON skill.id = version.skill_id;

CREATE OR REPLACE VIEW openbot_skill_market.files AS
SELECT file.skill_version_id, file.path, file.source_type, file.file_size_bytes,
       blob.data
FROM public.skill_files AS file
LEFT JOIN public.skill_file_blobs AS blob ON blob.id = file.blob_id
  AND file.storage_key IS NULL
  AND file.source_type IN ('text', 'dataurl', 'upload');

-- Capture once when the native version publication commits, after Bifrost saves its
-- attachments. Never reconstruct an absent seal from the current catalog rows.
CREATE TABLE IF NOT EXISTS openbot_skill_market.package_seals (
  version_id varchar PRIMARY KEY REFERENCES public.skill_versions(id) ON DELETE CASCADE,
  document_sha256 text NOT NULL,
  files jsonb NOT NULL
);

CREATE OR REPLACE FUNCTION openbot_skill_market.seal_publication()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO openbot_skill_market.package_seals (version_id, document_sha256, files)
  SELECT version.id, version.document_sha256, coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'path', file.path,
      'sha256', CASE WHEN octet_length(file.data) = file.file_size_bytes
                     THEN encode(sha256(file.data), 'hex') END
    ))
    FROM openbot_skill_market.files AS file
    WHERE file.skill_version_id = version.id
  ), '[]'::jsonb)
  FROM openbot_skill_market.versions AS version
  WHERE version.id = NEW.id
  ON CONFLICT (version_id) DO NOTHING;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION openbot_skill_market.seal_publication() FROM PUBLIC;
DROP TRIGGER IF EXISTS openbot_seal_publication ON public.skill_versions;
CREATE CONSTRAINT TRIGGER openbot_seal_publication
AFTER INSERT ON public.skill_versions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION openbot_skill_market.seal_publication();

REVOKE ALL ON ALL TABLES IN SCHEMA openbot_skill_market FROM PUBLIC;
GRANT USAGE ON SCHEMA openbot_skill_market TO openbot_skill_reader;
GRANT SELECT ON openbot_skill_market.catalog, openbot_skill_market.versions,
  openbot_skill_market.files, openbot_skill_market.package_seals TO openbot_skill_reader;
COMMIT;
