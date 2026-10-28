-- FREV-03: converge every observation row on the Bot's STABLE resource scope.
--
-- Before this migration, a row's scope_key was the per-request composite
-- `joinKey(["wb", actor_id, bot_id, epoch])` (length-prefixed segments, e.g.
-- `2:wb|6:user-a|7:agent-1|1:1`), and the upstream workspace/project address was
-- derived from that composite. Consequences FREV-03 proved: an administrator's
-- scope for a creator's Bot named a different address (no aggregation over the
-- management range), a profile rename rotated the epoch and moved the address,
-- and an ownership transfer stranded the history under the previous actor.
--
-- The application now keys data on `joinKey(["wb", bot_id])` — the `wb` kind tag
-- plus the Bot id, and nothing else — and derives the locator from it:
--   stable_key        = '2:wb|' || length(bot_id) || ':' || bot_id
--   fingerprint       = length(stable_key) || '-' || left(sha256(stable_key), 16 hex)
--   locator_workspace = 'openbot-workbench-' || fingerprint
--   locator_project   = 'bot-' || bot_id || '-' || fingerprint
-- (see server/src/ai-observability/scope.ts, resourceScopeKey /
-- resolveStorageLocator). The report for this fix calls this the smooth
-- re-derivation: both values are pure functions of bot_id, no local column is
-- read to compute them, and re-running this file sets every row to the value it
-- already holds.
--
-- The hash input is `convert_to(<key>, 'UTF8')`, not `<key>::bytea`: the app hashes
-- the key's UTF-8 bytes (Node's createHash().update), and `::bytea` would take the
-- database encoding's bytes instead — equal only on a UTF8-encoded cluster. The
-- length halves of the key and fingerprint use `length()` (characters): that equals
-- the app's JS `.length` (UTF-16 code units) for every BMP string, and Bot ids are
-- ASCII (UUID/short ids), where all three counts coincide. OCR R5: pinned by
-- explicit UTF-8 hashing rather than a database-encoding assumption.
--
-- Collisions. Rows that were recorded under different composites for the SAME
-- Bot can share a natural subject (same run/attempt, same dataset name, …).
-- This migration never deletes or merges an authoritative row: per unique index
-- the earliest row (created_at, id) moves to the stable key and a later
-- colliding row KEEPS its legacy key. Such a row stays in its old key space —
-- invisible to the new stable-key reads — and continues to age out through the
-- normal retention discovery (which scans by state/expiry, not by scope key).
--
-- Ranking is NESTED (OCR R5): the subject index ranks first (every natural
-- subject's earliest row is its candidate), then the secondary index (upstream
-- trace / dataset id / frozen hash / upstream link) is ranked WITHIN the subject
-- winners, partitioned by bot, with already-stable rows preferred in every
-- partition. The full-table secondary windows this file first shipped with let a
-- non-winner row claim a secondary value and strand its whole subject at the
-- legacy key; nesting bounds the secondary race to the candidates that will
-- actually move. Residual, forced by the unique index itself: a subject whose
-- winner's secondary value was already claimed by an EARLIER subject's winner
-- still keeps its legacy key — moving it would violate (stable_key, secondary)
-- the same way the old code did.
--
-- Already-stable rows win every partition (a re-run is a no-op) and are skipped
-- by the final scope_key predicate, so a legacy row never rewrites a destination
-- an already-stable row occupies — the partial-state / rolling-upgrade shape that
-- would otherwise collide on the unique indexes and roll the migration back.
--
-- Upstream objects already written under the old per-actor/per-epoch project
-- names are not movable by a local SQL migration. Rows are re-addressed to the
-- stable per-Bot project, so local reads, writes and drift guards all agree on
-- one address from here on; objects left in the old projects are no longer
-- addressable through local rows and age out under the Opik instance's own
-- lifecycle. retention_deletions rows are the deliberate exception: their
-- locator columns are the frozen address of the exact upstream object the record
-- exists to delete, so they are left untouched.

-- bindings: unique (scope_key, run_id, attempt_id) and (scope_key, opik_trace_id) where not null.
WITH keyed AS (
  SELECT
    id,
    scope_key,
    opik_trace_id,
    created_at,
    bot_id,
    run_id,
    attempt_id,
    '2:wb|' || length(bot_id) || ':' || bot_id AS stable_key
  FROM ai_observation_bindings
), ranked AS (
  SELECT
    id,
    scope_key,
    stable_key,
    opik_trace_id,
    bot_id,
    created_at,
    row_number() OVER (
      PARTITION BY bot_id, run_id, attempt_id
      ORDER BY
        (scope_key = stable_key) DESC,
        created_at, id
    ) AS subject_rank
  FROM keyed
), winners AS (
  SELECT id, scope_key, stable_key, opik_trace_id, bot_id, created_at
  FROM ranked
  WHERE subject_rank = 1
), trace_ranked AS (
  SELECT
    id,
    scope_key,
    stable_key,
    CASE
      WHEN opik_trace_id IS NULL THEN 1
      ELSE row_number() OVER (
        PARTITION BY bot_id, opik_trace_id
        ORDER BY
          (scope_key = stable_key) DESC,
          created_at, id
      )
    END AS trace_rank
  FROM winners
)
UPDATE ai_observation_bindings AS target
SET
  scope_key = trace_ranked.stable_key,
  locator_workspace = 'openbot-workbench-' || length(trace_ranked.stable_key) || '-' ||
    left(encode(sha256(convert_to(trace_ranked.stable_key, 'UTF8')), 'hex'), 16),
  locator_project = 'bot-' || target.bot_id || '-' || length(trace_ranked.stable_key) || '-' ||
    left(encode(sha256(convert_to(trace_ranked.stable_key, 'UTF8')), 'hex'), 16)
FROM trace_ranked
WHERE target.id = trace_ranked.id
  AND trace_ranked.trace_rank = 1
  AND target.scope_key <> trace_ranked.stable_key;

--> statement-breakpoint

-- datasets: unique (scope_key, name) and (scope_key, opik_dataset_id) where not null.
WITH keyed AS (
  SELECT
    id,
    scope_key,
    name,
    opik_dataset_id,
    created_at,
    bot_id,
    '2:wb|' || length(bot_id) || ':' || bot_id AS stable_key
  FROM ai_observation_datasets
), ranked AS (
  SELECT
    id,
    scope_key,
    stable_key,
    name,
    opik_dataset_id,
    bot_id,
    created_at,
    row_number() OVER (
      PARTITION BY bot_id, name
      ORDER BY
        (scope_key = stable_key) DESC,
        created_at, id
    ) AS name_rank
  FROM keyed
), winners AS (
  SELECT id, scope_key, stable_key, name, opik_dataset_id, bot_id, created_at
  FROM ranked
  WHERE name_rank = 1
), upstream_ranked AS (
  SELECT
    id,
    scope_key,
    stable_key,
    CASE
      WHEN opik_dataset_id IS NULL THEN 1
      ELSE row_number() OVER (
        PARTITION BY bot_id, opik_dataset_id
        ORDER BY
          (scope_key = stable_key) DESC,
          created_at, id
      )
    END AS upstream_rank
  FROM winners
)
UPDATE ai_observation_datasets AS target
SET
  scope_key = upstream_ranked.stable_key,
  locator_workspace = 'openbot-workbench-' || length(upstream_ranked.stable_key) || '-' ||
    left(encode(sha256(convert_to(upstream_ranked.stable_key, 'UTF8')), 'hex'), 16),
  locator_project = 'bot-' || target.bot_id || '-' || length(upstream_ranked.stable_key) || '-' ||
    left(encode(sha256(convert_to(upstream_ranked.stable_key, 'UTF8')), 'hex'), 16)
FROM upstream_ranked
WHERE target.id = upstream_ranked.id
  AND upstream_ranked.upstream_rank = 1
  AND target.scope_key <> upstream_ranked.stable_key;

--> statement-breakpoint

-- dataset versions have no bot_id of their own: they follow the dataset row they
-- belong to (already converged above), which is exactly the address the datasets
-- service reads them back under. Unique (scope_key, dataset_id, content_hash).
--
-- The versions table's 0150 immutability trigger refuses every UPDATE. That guard
-- protects the recorded CONTENT of a version; re-addressing a row writes only
-- scope_key and the derived locator, so the trigger is suspended for exactly this
-- statement (transactionally — the migration runner commits this file as one
-- transaction, and the ENABLE below always follows).
ALTER TABLE ai_observation_dataset_versions
  DISABLE TRIGGER ai_observation_dataset_versions_immutable;

--> statement-breakpoint

WITH keyed AS (
  SELECT
    version.id,
    version.scope_key,
    dataset.scope_key AS stable_key,
    dataset.bot_id AS bot_id,
    row_number() OVER (
      PARTITION BY version.dataset_id, version.content_hash
      ORDER BY
        (version.scope_key = dataset.scope_key) DESC,
        version.created_at, version.id
    ) AS subject_rank
  FROM ai_observation_dataset_versions AS version
  JOIN ai_observation_datasets AS dataset ON dataset.id = version.dataset_id
)
UPDATE ai_observation_dataset_versions AS target
SET
  scope_key = keyed.stable_key,
  locator_workspace = 'openbot-workbench-' || length(keyed.stable_key) || '-' ||
    left(encode(sha256(convert_to(keyed.stable_key, 'UTF8')), 'hex'), 16),
  locator_project = 'bot-' || keyed.bot_id || '-' || length(keyed.stable_key) || '-' ||
    left(encode(sha256(convert_to(keyed.stable_key, 'UTF8')), 'hex'), 16)
FROM keyed
WHERE target.id = keyed.id
  AND keyed.subject_rank = 1
  AND target.scope_key <> keyed.stable_key;

--> statement-breakpoint

ALTER TABLE ai_observation_dataset_versions
  ENABLE TRIGGER ai_observation_dataset_versions_immutable;

--> statement-breakpoint

-- experiments: unique (scope_key, name) and (scope_key, config_hash) where frozen.
-- The 0153 immutability trigger refuses UPDATE on every frozen row; the submitted
-- configuration is what it protects, and this statement touches only scope_key, so
-- the trigger is suspended for exactly this statement (same transactional window).
ALTER TABLE ai_observation_experiments
  DISABLE TRIGGER ai_observation_experiments_immutable;

--> statement-breakpoint

WITH keyed AS (
  SELECT
    id,
    scope_key,
    name,
    state,
    config_hash,
    created_at,
    bot_id,
    '2:wb|' || length(bot_id) || ':' || bot_id AS stable_key
  FROM ai_observation_experiments
), ranked AS (
  SELECT
    id,
    scope_key,
    stable_key,
    state,
    config_hash,
    bot_id,
    created_at,
    row_number() OVER (
      PARTITION BY bot_id, name
      ORDER BY
        (scope_key = stable_key) DESC,
        created_at, id
    ) AS name_rank
  FROM keyed
), winners AS (
  SELECT id, scope_key, stable_key, state, config_hash, bot_id, created_at
  FROM ranked
  WHERE name_rank = 1
), hash_ranked AS (
  SELECT
    id,
    scope_key,
    stable_key,
    CASE
      WHEN state <> 'frozen' THEN 1
      ELSE row_number() OVER (
        PARTITION BY bot_id, config_hash
        ORDER BY
          (scope_key = stable_key) DESC,
          created_at, id
      )
    END AS hash_rank
  FROM winners
)
UPDATE ai_observation_experiments AS target
SET scope_key = hash_ranked.stable_key
FROM hash_ranked
WHERE target.id = hash_ranked.id
  AND hash_ranked.hash_rank = 1
  AND target.scope_key <> hash_ranked.stable_key;

--> statement-breakpoint

ALTER TABLE ai_observation_experiments
  ENABLE TRIGGER ai_observation_experiments_immutable;

--> statement-breakpoint

-- id links: unique (scope_key, local_kind, local_id) and (scope_key, upstream_kind, upstream_id).
WITH keyed AS (
  SELECT
    id,
    scope_key,
    upstream_kind,
    upstream_id,
    created_at,
    bot_id,
    local_kind,
    local_id,
    '2:wb|' || length(bot_id) || ':' || bot_id AS stable_key
  FROM ai_observation_id_links
), ranked AS (
  SELECT
    id,
    scope_key,
    stable_key,
    upstream_kind,
    upstream_id,
    bot_id,
    created_at,
    row_number() OVER (
      PARTITION BY bot_id, local_kind, local_id
      ORDER BY
        (scope_key = stable_key) DESC,
        created_at, id
    ) AS local_rank
  FROM keyed
), winners AS (
  SELECT id, scope_key, stable_key, upstream_kind, upstream_id, bot_id, created_at
  FROM ranked
  WHERE local_rank = 1
), upstream_ranked AS (
  SELECT
    id,
    scope_key,
    stable_key,
    row_number() OVER (
      PARTITION BY bot_id, upstream_kind, upstream_id
      ORDER BY
        (scope_key = stable_key) DESC,
        created_at, id
    ) AS upstream_rank
  FROM winners
)
UPDATE ai_observation_id_links AS target
SET scope_key = upstream_ranked.stable_key
FROM upstream_ranked
WHERE target.id = upstream_ranked.id
  AND upstream_ranked.upstream_rank = 1
  AND target.scope_key <> upstream_ranked.stable_key;

--> statement-breakpoint

-- experiment executions: like export jobs, no scope-composite unique index (the
-- (scope_key, created_at) index is a plain read index), so the collision class the
-- header reserves legacy keys for is empty here and every row converges (OCR R5:
-- the table this convergence forgot — legacy-key executions stayed invisible to
-- stable-key reads, and the executions subdelete in the experiment's delete branch
-- missed them, so the experiment's foreign key raised 23503 and pinned it forever
-- as RETENTION_TARGET_PINNED).
UPDATE ai_observation_experiment_executions AS target
SET scope_key = '2:wb|' || length(target.bot_id) || ':' || target.bot_id;

--> statement-breakpoint

-- export jobs have no scope-composite unique index: every row converges.
WITH ranked AS (
  SELECT
    id,
    '2:wb|' || length(bot_id) || ':' || bot_id AS stable_key
  FROM ai_observation_export_jobs
)
UPDATE ai_observation_export_jobs AS target
SET
  scope_key = ranked.stable_key,
  locator_workspace = 'openbot-workbench-' || length(ranked.stable_key) || '-' ||
    left(encode(sha256(convert_to(ranked.stable_key, 'UTF8')), 'hex'), 16),
  locator_project = 'bot-' || target.bot_id || '-' || length(ranked.stable_key) || '-' ||
    left(encode(sha256(convert_to(ranked.stable_key, 'UTF8')), 'hex'), 16)
FROM ranked
WHERE target.id = ranked.id;

--> statement-breakpoint

-- retention deletion records: the scope key converges (governance reads the
-- record in the range), the locator columns stay exactly as recorded — they are
-- the address of the object this record exists to delete. The deleteLocal key
-- join takes the record's converged key as primary (this convergence), and the
-- worker rechecks a target whose scoped read misses by id, then also matches
-- bot_id locally (see retention.ts, OCR R5): a collision-loser target row keeps
-- its legacy key, and the record must still be able to reach it.
UPDATE ai_observation_retention_deletions AS target
SET scope_key = '2:wb|' || length(target.bot_id) || ':' || target.bot_id;

--> statement-breakpoint
-- retention overrides carry only the scope key, so the Bot is parsed out of the
-- legacy composite (`<len>:<segment>` segments joined by `|`; the Bot is the
-- third segment of the four the old formula wrote). A key that is already the
-- stable two-segment form parses to itself. Overrides collide on the primary
-- key when two composites describe one Bot: the row already on the stable key
-- wins (a re-run is a no-op), else the most recently updated one.
CREATE FUNCTION pg_temp.opik_stable_scope_key(candidate text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  segments text[] := ARRAY[]::text[];
  cursor_pos integer := 1;
  total_length integer := length(candidate);
  remaining text;
  colon_offset integer;
  declared_length integer;
  segment text;
  next_pos integer;
BEGIN
  -- Length-prefixed parse: a segment may itself contain '|', so each segment is
  -- read by its declared length, never by searching for the separator.
  WHILE cursor_pos <= total_length LOOP
    remaining := substr(candidate, cursor_pos);
    colon_offset := position(':' in remaining);
    IF colon_offset = 0 OR substr(remaining, 1, colon_offset - 1) !~ '^[0-9]+$' THEN
      RETURN candidate;
    END IF;
    declared_length := substr(remaining, 1, colon_offset - 1)::integer;
    segment := substr(remaining, colon_offset + 1, declared_length);
    IF length(segment) <> declared_length THEN
      RETURN candidate;
    END IF;
    segments := segments || segment;
    next_pos := cursor_pos + colon_offset + declared_length;
    IF next_pos <= total_length AND substr(candidate, next_pos, 1) <> '|' THEN
      RETURN candidate;
    END IF;
    cursor_pos := next_pos + 1;
  END LOOP;
  -- The stable form is `wb|<bot>`; the legacy composite is `wb|<actor>|<bot>|<epoch>`.
  IF array_length(segments, 1) = 2 AND segments[1] = 'wb' THEN
    RETURN candidate;
  END IF;
  IF array_length(segments, 1) = 4 AND segments[1] = 'wb' THEN
    RETURN '2:wb|' || length(segments[3]) || ':' || segments[3];
  END IF;
  RETURN candidate;
END;
$$;

--> statement-breakpoint

WITH resolved AS (
  SELECT
    scope_key AS previous_key,
    pg_temp.opik_stable_scope_key(scope_key) AS stable_key,
    updated_at
  FROM ai_observation_retention_overrides
), ranked AS (
  SELECT
    previous_key,
    stable_key,
    row_number() OVER (
      PARTITION BY stable_key
      ORDER BY (previous_key = stable_key) DESC, updated_at DESC, previous_key
    ) AS preference_rank
  FROM resolved
)
UPDATE ai_observation_retention_overrides AS target
SET scope_key = ranked.stable_key
FROM ranked
WHERE target.scope_key = ranked.previous_key
  AND ranked.preference_rank = 1
  AND ranked.previous_key <> ranked.stable_key;

--> statement-breakpoint

DROP FUNCTION pg_temp.opik_stable_scope_key(text);
