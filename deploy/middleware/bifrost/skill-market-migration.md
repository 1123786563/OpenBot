# Migrate the SkillHub catalog

Run the migration against a rehearsal destination first. Follow the
[cutover runbook](skill-market-cutover.md) for the release gates. Before
taking the final inventory, pause
publishing and new installations and take a matched SkillHub PostgreSQL
backup and local object-storage snapshot. Restore the database separately
with a read-only login and mount the object root read-only. Keep this pair
as the archive for withdrawn content. The importer reads the v0.2.28
`namespace`, `skill`, `skill_version`, `skill_file`, and `review_task`
tables. It uses each version's recorded file count, total bytes, and file
SHA-256 values to verify the objects before writing to Bifrost.

Use a dedicated pinned Bifrost v2.6.0 target with PostgreSQL blob storage.
Apply the current [reader schema and publication trigger](skill-market-reader.sql) before
importing. Keep destination publishing paused while importing and verifying. Confirm that the private
management origin and the reader database reach the same Bifrost instance.

Supply these settings in a private operator environment file.

| Setting | Value |
| --- | --- |
| `SKILLHUB_URL` | Original SkillHub HTTP origin, recorded as part of the legacy identity. |
| `SKILLHUB_CATALOG_NAMESPACE` | Original OpenBot team namespace. |
| `SKILLHUB_MIGRATION_SNAPSHOT_ID` | Unique label for the retained database and storage pair. |
| `SKILLHUB_MIGRATION_DATABASE_URL` | Read-only connection to the restored SkillHub snapshot. |
| `SKILLHUB_MIGRATION_STORAGE_ROOT` | Mounted root of the original SkillHub local object store. |
| `SKILLHUB_COMPATIBILITY_CONFIRMATIONS` | The original OpenBot deployment's exact-version confirmation array, if configured. |
| `BIFROST_MIGRATION_REGISTRY_ID` | Stable deployment identifier for the target Bifrost registry. Use the same identifier for verification and downstream identity mapping. |
| `BIFROST_MIGRATION_URL` | Private Bifrost management origin. |
| `BIFROST_MIGRATION_COOKIE` | Cookie header from a short-lived Bifrost administrator session. Only import mode uses it. |
| `BIFROST_SKILL_MARKET_DATABASE_URL` | The OpenBot catalog reader URL for the target. |

From the repository root, run the import and then run independent read-only
verification. Use a fresh evidence file for every invocation and keep it
private because it contains reviewer identities and comments.

```sh
umask 077
bun --no-env-file --env-file=/private/operator/import.env server/scripts/migrate-skill-market.ts import > import.json
bun --no-env-file --env-file=/private/operator/verify.env server/scripts/migrate-skill-market.ts verify > verify.json
```

The command writes JSON to standard output. An incomplete run, a nonzero
exit status, or a report with `ready: false` blocks cutover. Fix the reported
failure and rerun against the same snapshot. Successful versions can be
reused by exact identity and content. If a historical or withdrawn coordinate
already exists in the destination, resolve it explicitly before retrying.
The importer leaves the existing record in place and reports a conflict.

The importer creates a skill with its first version and stages subsequent
versions. Set or review the serving pointer separately before cutover. The
pointer does not determine exact-version correspondence or OpenBot approval.
Import includes published, downloadable versions in the legacy team's
visible catalog, including versions that still require compatibility review.
Unpublished drafts are excluded. Previously published versions outside that
set are verified against the retained snapshot and represented as history.
Existing OpenBot installation snapshots, disablements and runs remain in the
OpenBot database. This job supplies evidence for their cutover checks.

## Evidence contract for #138

Consume a complete schema version 1 report with `mode: "verify"` and
`ready: true` from the final paused inventory. Match the report's `snapshotId`,
`source` scope and `target.registryId` to the expected deployment. The
report records the following for each source version.

- `status: "verified"` proves an exact source-to-target correspondence.
  `source` contains `source` (legacy HTTP origin), `namespace`, `slug`,
  `version`, numeric `registrySkillId`, numeric `versionId` and
  `fingerprint`. `target` contains `registryId`, `namespace` (`bifrost`),
  `slug`, `version`, Bifrost UUID `skillId`, Bifrost UUID `versionId`
  and `fingerprint`. Match by both immutable IDs and coordinates.
- `package.files` contains `path`, `size` in bytes, and lowercase
  `sha256` for every file, sorted by path using UTF-16 string order.
  `package.fingerprint` is `sha256:` followed by the SHA-256 of the UTF-8
  concatenation of `path:sha256\n` lines. This is SkillHub v0.2.28's
  version fingerprint. ZIP container bytes can differ. The package comparison
  covers every original relative path and file byte.
- `provenance` records source publication and withdrawal state, publisher
  and owner IDs, moderation records, and the matching OpenBot confirmation
  when one was supplied. Applying the receipt carries forward an exact
  confirmation with matching approved moderation evidence for a published,
  compatible package. The record keeps the original reviewer and date.
  Existing Bifrost reviews and withdrawals take precedence.
- `status: "withdrawn"` and `status: "historical"` preserve source
  identity, manifest and provenance with `target: null`. The retained
  snapshot supplies the corresponding bytes, including versions no longer
  downloadable from SkillHub.
- `status: "failed"` identifies an unresolved `conflict` or `verification`
  failure and the `source` or `target` stage. Top-level configuration or
  inventory failures produce `ready: false` and `error`.

## Record the verified receipt in OpenBot

Apply OpenBot database migration `0098_skill_market_equivalences`. Keep
publishing and installation writes paused while you record the final receipt.
Use the same snapshot ID, SkillHub origin and namespace, Bifrost registry ID,
and Bifrost reader URL as the verification run. Set `DATABASE_URL` to the
OpenBot database for the cutover.

```sh
bun --no-env-file --env-file=/private/operator/cutover.env server/scripts/apply-skill-market-receipt.ts verify.json
```

The command re-reads every verified Bifrost package by exact version. It
checks the UUIDs, coordinates, fingerprint, and complete file manifest before
it records any equivalence. A successful first run prints `applied`. A retry
with the same receipt prints `already-applied`. Keep writes paused if the
command exits with an error.

The OpenBot database retains the receipt, including historical and withdrawn
entries. Existing installations keep their original instructions and source
identities until a Bot manager explicitly switches versions. Verify that the
Bifrost version picker uses the reserved command and that approved target
versions are available to switch to. Versions without a qualifying transferred
confirmation require a Bifrost review. An emergency disablement applies to both identities of an equivalent
version. Restoring either identity allows new invocations. Previously paused
runs retain their pause.

## Bifrost v2.6.0 limits

Bifrost's management API rejects version numbers below the numeric core of
the latest created version. Import orders versions by numeric core and defers
subsequent writes for a skill after an earlier failure. Use a clean target if
a pre-existing higher version prevents a backfill. The API also restricts
names and accepts `MAJOR.MINOR.PATCH` with an optional hyphen suffix.
The importer reports unsupported inputs and keeps the original identities
in its evidence. OpenBot's 256-attachment and 32-MiB download limits apply.

Bifrost stores Markdown body and structured frontmatter separately. Its
native ZIP serialization changes YAML bytes, and its native metadata field
accepts string values only. Imported versions store the original UTF-8
header, including delimiters and line endings, as base64 under the reserved
`openbot-migration-original-header-v1` extra frontmatter field. Non-string
metadata values are serialized as JSON strings in Bifrost's native metadata
map. OpenBot reconstructs `SKILL.md` from the original header and stored
body, and validates that the header projects to the stored frontmatter before
using it. Import and verification use the same exact-version read path as
OpenBot downloads. Native Bifrost downloads still use upstream serialization.

The isolated rehearsal uses the pinned gateway and PostgreSQL.

```sh
bash deploy/middleware/bifrost/rehearsal/verify.sh --skill-migration
```
