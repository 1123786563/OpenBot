# D09 — Enforce backup retention and final cleanup visibility: checkpoint

Ticket: issue #87 (catalog D09). Plan: `docs/superpowers/plans/tickets/D09-retention-visibility.md`
(in the openmuse worktree). Worktree: `OpenBot/.worktrees/v4-base`, branch `v4/openbot-exec`,
NO commits made (prior uncommitted checkpoints untouched, nothing reverted, nothing staged).

## What landed

`server/src/openmuse-deletion/retention.ts` (NEW):

- **`retentionElapsed(marker, now, retentionDays?)`** — the §9 policy seam, PURE and
  clock-injected: `now > (restoreUntil ?? disabledAt + OPENMUSE_RESTORE_WINDOW_DAYS) +
  retentionDays`. False while the manifest persists; true once the deletion is eligible
  for its final archive. The unrestored marker falls back to D05's own deadline derivation.
- **`backupRetentionDays()`** — the deployment window, env `OPENMUSE_BACKUP_RETENTION_DAYS`
  default 30, bound the O03/O04 way (unusable values keep the §9 default).
- **`createOpenMuseBackupRetention().noteBackupRetention(userId)`** — the enforcement
  point: appends ONE bookkeeping row to the marker's evidence array
  (`openmuse-backup-retention:<userId>:covered-at:<ISO>:retention-days:<n>:expires:<ISO>`)
  recording when a deployment's backup window covers the deletion and when it ages out.
  Null for a marker-less user (nothing covers a deletion that never happened). Emitted-only
  seam — deployment ops wires it; D09 adds no caller.
- **`sanitizeLastError`** — G06's display guard, server-side: a reason matching a
  token shape (`ya29.*`, `1//0*`, base64-ish run ≥40, `Bearer ` prefix) is replaced
  wholesale with the fixed sentence `"redacted: the recorded reason may quote a credential"`;
  plain reasons pass through truncated to 120.
- **`createOpenMuseDeletionCleanupView()`** — the deployment-wide visibility: every
  marker (store `list()`) with its non-personal audit facts (`userId`, `disabledAt`,
  `phase`, `restoreUntil`, `retentionElapsed`, `retryable` count) plus its unresolved
  manifest rows (`kind`, safe `id`, `state`, sanitized `lastError?`, `at`). Deleted rows
  are terminal and never listed; byte-store keys/aliases (`externalKey`) are dropped at
  the DTO; nothing is ever cleared by the view — it is read-only.

`GET /api/admin/openmuse-deletion/cleanup` (on the D05 admin route factory in
`restore.ts`, `requireUser` + `requireAdmin`; 404 when unwired, 403 for non-admins):
answers `{cleanup: {retentionDays, markers: [...]}}`. NO app.ts/index.ts change — the
admin factory stays deployment-mounted per D05's pattern.

`store.ts`: the roster seam `list()` — every marker in stable (disabledAt, userId)
order; drizzle + the test fake both implement it (DB-gated test added).

`scripts/openmuse-v4-baseline.sh`: the D09 env comment in `baseline_env()`'s
documented-not-set block (beside O03/O04's).

## Retention scoping — CHOICE RECORDED (honest)

The **actual backup system is deployment infrastructure** the API does not own: D09
lands the **policy-level enforcement POINT and evidence**, not backup deletion.
`retentionElapsed` decides the window; `noteBackupRetention` records the covered/expiry
facts on the marker; the visibility flags `retentionElapsed` per marker. Until retention
elapses the manifest persists; after it, the marker is *eligible* for the final archive —
the archive itself is the operator's act (unresolved rows are never silently cleared,
pinned end-to-end through a failing purge + failing retry).

Post-success: a fully-cleaned deletion (D08 completed) answers the endpoint with ONLY
the non-personal audit summary (timestamps + phases, `retryable: 0`, `unresolved: []`)
— the emptied manifest named every resource id, so completion already removed the
personal part; the completed marker is the audit proof that remains.

## Files + shasum (post-biome)

```
ea432b27428b36e414c85ad057680150cd3be653  src/openmuse-deletion/retention.ts   (NEW)
d6719b03da100ea9ae48444c27a4b16cb54e1772  src/openmuse-deletion/restore.ts
703bf3bd1bfcdd29c99a3e4598675d548c4dc2b4  src/openmuse-deletion/store.ts
7039db1ff477c2204314b58b225a15331a3542e5  tests/openmuse-deletion.test.ts
892155be20ce9d6848e35152d4ad2faf6ce68476  ../scripts/openmuse-v4-baseline.sh
```

(shasum run from `server/`; baseline script from repo root.)

NOT touched: `app.ts`, `index.ts`, `apps/openmuse-mobile` (B04's unstaged deletion left
exactly as it stood), no commits, nothing staged.

## S43 — deferred note

S43 (the live acceptance card: injected connector refresh failure + aged queued Task +
outcome_unknown write + cleanup retryable_error → four health/ops signals with safe IDs
and no secrets) needs a live deployment with O05's fault signals; this ticket covers its
D09 half at the seam level (sanitized cleanup retry visibility, pinned in tests). The
live S43 run stays with the acceptance pass, as planned.

## Verification (re-run per file, `TEST_DATABASE_URL=…openbot_test`)

- RED first: 51 pass / 7 fail (the D09 describe against stubs).
- `tests/openmuse-deletion.test.ts` — **59 pass / 0 fail** (51 baseline + 7 D09 + 1
  store-list DB test).
- `tests/ready.test.ts` — **3 pass / 0 fail**.
- `bun run typecheck` (tsc --noEmit) — clean.
- `biome check` on all four owned source/test files — clean (post `--write`).
- `bash -n scripts/openmuse-v4-baseline.sh` — clean.
