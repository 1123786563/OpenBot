# T05 — Pause and resume a Task: checkpoint

Ticket: GitHub issue #62 / catalog T05. Plan: `docs/superpowers/plans/tickets/T05-pause-resume.md` (openmuse repo).
Executed with full TDD (RED → GREEN) in `/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base`. **No commit** — all changes sit in the worktree beside the prior uncommitted checkpoints (T02, T04, G01…), nothing reverted.

## Migration SQL (verbatim, `server/drizzle/0083_acoustic_ultron.sql`)

```sql
ALTER TABLE "openmuse_tasks" ADD COLUMN "pause_requested" boolean DEFAULT false NOT NULL;
```

Generated with `bun --env-file=<repo>/.env drizzle-kit generate` (drizzle-kit generate reads the schema only; **no `db:migrate` was run**, per plan). `server/drizzle/meta/_journal.json` and `server/drizzle/meta/0083_snapshot.json` updated by the generator. Schema column added in `server/src/db/schema/openmuse.ts` (`pauseRequested`, `pause_requested`) beside T04's `cancellationRequested`. **No app.ts / index.ts edits** — resume re-offers through the same injected queue seam T02 wired into `createOpenMuseTaskStore` (`server/src/index.ts:2597`), unchanged.

## Semantics (contracts §7, mirrors T04's cancel shape)

- `requestPause` store CAS (`requestTaskPause` rows seam, one atomic statement, WHERE = the matrix): **queued/scheduled → paused** now; **running → `pauseRequested`** internal flag (public status stays running); every other state unapplied → 409 `currentStatus`. Idempotent re-pause on a flagged running row re-answers 200 like T04's cancel.
- `resumeTask` store CAS (`resumeTask` rows seam): **paused → queued**, `pauseRequested` cleared, then **one re-offer** through the injected queue. The applied CAS *is* the status guard: a second resume while queued hits unapplied → 409 `currentStatus: queued` and offers nothing, so "exactly once" needs no extra machinery.
- Runner: honours `pauseRequested` at the same safe boundary as T04's cancel (the turn's end) via `settlePaused` — a "Paused" evidence note, never a fabricated run step, status lands last, then `queue.finish`. **Cancel wins over pause** when both land mid-run: the `cancellationRequested` branch is checked first; a cancelled row is never resurrected by a pending pause.
- **A paused task is never claimed:** enforced on the **claim side** (the sweep), not the offer side — the WorkQueue is a dumb bag of offers, so a paused row may still be sitting in it from create's offer. The sweep now runs **only `queued` rows** (`task?.status !== "queued"` → skip + finish), which subsumes T02's SETTLED check and additionally fences a resume's fresh key racing an old unconsumed one (one execution authority per Task).

## One plan-level design resolution: the re-offer key

T05's plan says "re-offer via injected queue" but the WorkQueue's `(kind, key)` is a **one-shot identity** (`server/src/work/queue.ts`): `finish` marks the row, not deletes it, and a later offer of the same key `onConflictDoNothing`-collides with the finished row and is silently swallowed — it would never be claimed again. So resume's re-offer is its own piece of work under a **fresh key** `${task.id}:${crypto.randomUUID()}`, with `taskId` riding in the payload; the runner resolves the row via `payload.taskId ?? item.key` (create's own offer still keys on the id, unchanged). Exactly-once re-offer is guaranteed by the resume CAS alone, matching the plan's "idempotent by a status guard". Test `resume re-offers once and the next sweep runs the task to succeeded` proves the re-run lands `succeeded` with the flag cleared.

## Changed files + shasum (sha256)

- `server/src/openmuse-tasks/store.ts` — `1a507351b98252a5a22b87e68659f67b201e52598534022de1f52335917d524f` (pause/resume CAS + store methods; `TaskControlCas = TaskCancelCas` alias; shared `casOutcome` read-back helper)
- `server/src/openmuse-tasks/routes.ts` — `5e3d7336a81492d1739d24d1d04e9f3cdc7d1fa8f4bb581c8ee63f625b4c8497` (POST `/:id/pause`, POST `/:id/resume`, owner-scoped, disabled 403 / foreign+missing 404 / terminal 409)
- `server/src/openmuse-tasks/runner.ts` — `430d9c9f336f53e49e91bc94696cb06d1af9a2fcbf6b3fbd2902a7edfca58b2c` (queued-only claim, `settlePaused`, cancel-over-pause precedence)
- `server/src/db/schema/openmuse.ts` — `771009cd1038f7180392d2f65e239d3b9b753838cea879840cf6cc8e4acc9a9f` (`pauseRequested` column)
- `server/tests/openmuse-tasks.test.ts` — `3b06c3aade4e44ff83d201436704150326e995d3e617980e84e66fb6a0811448` (+12 tests: pause matrix, resume matrix, re-offer exactly once, 409/404/403)
- `server/tests/openmuse-task-runner.test.ts` — `4f1b019902c4b3ced99c241d6a111259bc2da5240c1988e7ea1c89ff40460b46` (+5 tests: pre-claim pause skip, pause mid-run lands paused not succeeded, cancel wins, resume re-runs, second resume refused)
- `server/drizzle/0083_acoustic_ultron.sql` — `0960313e1f584232bb2f7bfcc09d9410381828cf78b4148397324134182075f1`
- `server/drizzle/meta/0083_snapshot.json` — `26ff5bcd9f9b7f7a98bfea1e574f9d5dd982a42f77d984aa19d6a77280977685`
- `server/drizzle/meta/_journal.json` — idx 83 appended by the generator

RED evidence: `bun test tests/openmuse-tasks.test.ts tests/openmuse-task-runner.test.ts` → **16 fail / 31 pass** (every new T05 test failed; no prior test broken) before implementation.

## Verification tails

- `bun test tests/openmuse-tasks.test.ts tests/openmuse-task-runner.test.ts tests/ready.test.ts` → **50 pass / 0 fail / 222 expect() calls / Ran 50 tests across 3 files**
- `bun run typecheck` (`tsc --noEmit`) → clean, no output
- `biome check` on the six owned code files (incl. `src/db/schema/openmuse.ts`) → clean, no findings
- Adjacent family regression: `tests/schema.test.ts` + `openmuse-bot` + `openmuse-files` + `openmuse-google-oauth` → 90 pass / 0 fail; `openmuse-template-revision` + `openmuse-mail` → 21 pass / 0 fail; `openmuse-reviewed-actions` → 19 pass / 0 fail

## S33 deferred statement

S33 (acceptance gate: "Queue Task then cancel; pause running Task at safe step, resume; retry failed Task" against the real stack) is **gate-level, not this ticket's**: T05's tests verify the full §7 pause/resume matrix, the safe-boundary settle, cancel precedence, the queued-only claim fence and the exactly-once re-offer against fakes that mirror the real WorkQueue contract (claim-once/finished semantics verified against `server/src/work/queue.ts`'s actual SQL). A live pause-at-safe-step with a real turn, a real queue and a real client belongs to the integration gate that starts the real server — as does T06's retry leg of S33.
