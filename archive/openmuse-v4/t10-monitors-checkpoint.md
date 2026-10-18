# T10 — Schedule a Monitor: Checkpoint (issue #67)

Worktree `/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base`, branch `v4/openbot-exec`, no commits made.

## Task 0 — scheduling decision: queue runAt, not poll-sweep

Cited from `server/src/work/queue.ts`: `offer` accepts `runAt` (line 106, written at lines 204–208) and `claim` gates on `"run_at" <= now()` (line 287, database clock). Decision: **offer with `runAt = nextCheckAt`** — creation, resume and every post-check re-arm offer the monitor's check at its due instant; the queue's own due gate owns "when". No poll-sweep of due rows was built. The stored `nextCheckAt` remains the truth on the row: the runner's settle re-arms it (`now + interval`) and every re-offer carries it.

Arming choices recorded:

- Initial `nextCheckAt` = creation instant + interval (UTC, from the injected clock seam `store.now`).
- After a check: `nextCheckAt = now + interval` (completion-anchored — a check that runs late does not burst-catch-up).
- Resume (T05): re-arms from **now + interval**, computed inside the paused→scheduled CAS in SQL (`now() + make_interval(mins => (monitor_condition->>'intervalMinutes')::int)`); re-offer carries `runAt` = the re-armed instant.
- `intervalMinutes` rides inside the `monitor_condition` jsonb (plan names the two columns exactly; the interval is schedule metadata typed at the seam, same philosophy as steps/evidence).

## Migration 00NN — SQL verbatim

`server/drizzle/0091_remarkable_sunset_bain.sql` (db:generate with DATABASE_URL from the main checkout; journal idx 91, snapshot `meta/0091_snapshot.json`). Contains only the two T10 columns — no concurrent-worker columns leaked in:

```sql
ALTER TABLE "openmuse_tasks" ADD COLUMN "monitor_condition" jsonb;--> statement-breakpoint
ALTER TABLE "openmuse_tasks" ADD COLUMN "next_check_at" timestamp with time zone;
```

## Behaviour shipped

- Creation (route zod + matrix): `condition {type: change|contains|price_below, intervalMinutes 1–10,080, source?, selector?, threshold?}`; `price_below` without threshold → 400; `contains`/`change` without source → 400; 0 / 10,081 / non-integer interval → 400; only a monitor carries a condition. Monitor row is born `scheduled`; DTO exposes `condition` + `nextCheckAt`.
- Runner: monitor branch runs one due check through the injectable `checkMonitor` seam, records the raw observation as ONE evidence row (`{id}:observation:{dueInstant}`, kind `web`), re-arms `nextCheckAt` and returns to `scheduled` in the same generation-CAS'd settle, then re-offers at the new instant. Cancel/pause mid-check wait for the check's end (safe boundary) and settle terminal with the observation retained; cancel/pause during `scheduled` prevent later offers (claim skips, no re-offer). A failed check completes its cycle with a `Check failed` evidence note (backoff is T11's). Lease-loss recovery follows T07's shape for monitors: prior observations ⇒ `failed` + reconciliation note, effect-free ⇒ one re-run as a new generation.
- §9 disabled-owner and foreign-bot 404 behaviour unchanged for monitors (tested).

## Files + shasum (sha256)

| File | sha256 |
| --- | --- |
| server/src/openmuse-tasks/store.ts | d99161cde9c0f64ec9d2b3cbbe647bc15e6a023e6603d7005d27e99635538cd0 |
| server/src/openmuse-tasks/routes.ts | 98f1ce3bc5a20c7c3cd5759cc86eef23105c7aaac1e9f52674449079f7116926 |
| server/src/openmuse-tasks/runner.ts | fd3ae8d8c3fdd86c606b927a34bb0e4c97b05e2285752fa2d2c70c5e50e41fcb |
| server/src/db/schema/openmuse.ts | fa3dfa51c9e1f8f7cdca10c564c8ed6f29c6ec058832e37000798c6b02d944e9 (shared file — additive-only edits; R05/F05 also edit it) |
| server/tests/openmuse-tasks.test.ts | d5519ec94041d46566c84b14bbe44dbaafdb4ed3bf3e600afac642006df80e31 |
| server/tests/openmuse-task-runner.test.ts | ccf21a69ac7002d7c7e7b83b686fdfeed0e9c1cba496ac71ab28254d59958707 |
| server/drizzle/0091_remarkable_sunset_bain.sql | c391a907bba744f8d0bb1cb60b36cd57c2dc23c3706a756df0f8aeaaaf127754 |
| server/drizzle/meta/0091_snapshot.json | 0f54bcee672a6edb5e1199fcb5d0e74b4623055ae8245bfd732c866308de588e |

No app.ts / index.ts changes (runner's new options are optional; default `checkMonitor` refuses rather than fakes).

## Verification (test tails)

```
$ bun test tests/openmuse-tasks.test.ts tests/openmuse-task-runner.test.ts tests/ready.test.ts
 98 pass
 0 fail
 521 expect() calls
Ran 98 tests across 3 files. [475.00ms]

$ bun run typecheck        # tsc --noEmit — clean, no output
$ bunx biome check <owned files>  # clean after --write (4 files reformatted)
```

TDD: RED first — 13 new T10 tests failed against the unextended code (a monitor row ran a Bot turn and failed); GREEN after store/routes/runner/schema.

## S32 deferred note

S32 ("condition match appears once with notification") needs T11 (observation identity `sha256(monitorId+normalizedSource+normalizedValue)`, cursor, dedup, failure backoff) and T12 (event-keyed `monitor.matched` notifications). T10 ships scheduling + the raw-observation evidence row only. Also deferred: the real `checkMonitor` producer wiring in index.ts (out of this ticket's owned files — the default seam refuses with "No monitor check producer is wired yet", recorded as a `Check failed` note rather than a fabricated observation), and retry of a `failed` monitor (T06 retry lands it `queued`; the monitor branch will skip it until a follow-up ticket re-arms monitors on retry).
