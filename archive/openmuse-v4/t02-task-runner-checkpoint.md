# T02 — Execute one Task with the existing headless runner: checkpoint

Ticket: GitHub issue #58 / catalog T02. Plan: `docs/superpowers/plans/tickets/T02-task-runner.md`.
Executed with full TDD (RED → GREEN) in `/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base`. **No commit** — all changes sit in the worktree beside the prior uncommitted checkpoints (G01 etc.), nothing reverted.

## runTurn wiring citation

`server/src/index.ts:2607` — `runTurn: createTurnRunner({...})`, the **same** headless turn
implementation wake-up uses (`server/src/index.ts:2544` for wake-up; `createTurnRunner` from
`server/src/routines/run-turn.ts`, imported at `server/src/index.ts:322`), with the identical
dependency set as wake-up's (intelligence/runner/components/buildAgentFor/toolsForTurn/
learningContainerForThread). The runner's seam type `OpenMuseTaskTurn`
(`server/src/openmuse-tasks/runner.ts`) is TurnRunner-compatible, so `createTurnRunner(...)`
is passed directly, exactly as wake-up does. The prompt rides as `instruction`, and
`routineId`/`initiator` are `openmuse-task:${task.id}`.

## Scheduling mechanism

Mirror of wake-up: `repeatAfterEach` (`server/src/work/loop.ts`) loops in `server/src/index.ts` —
sweep every 5s at `index.ts:2632` (`openMuseTaskSweep`), reaper hourly at `index.ts:2648`
(`openMuseTaskReaper`), both stopped in the SIGINT/SIGTERM handler at `index.ts:4390-4391`,
exactly like `wakeUpSweep`/`wakeUpReaper` (`index.ts:2570/2586`, stopped at `index.ts:4388-4389`).
**app.ts was NOT touched** — no tail param was needed: the queue dep was injected into
`createOpenMuseTaskStore` (constructed in `index.ts:2597`, passed as the existing
`openMuseTasks` tail param at `index.ts:4178`), so `ready.test.ts`'s offset stays `-5`.

## Offer placement (one plan deviation, its own preference honored)

The plan preferred routing the queue through the routes factory, but its hard constraint said
prefer "WITHOUT app.ts changes if possible" — it was possible. The offer on create lives in
`store.create` (`server/src/openmuse-tasks/store.ts`), gated on `created === true` so an
idempotent retry does not re-offer; production wiring is in `index.ts` (`store` built with
`queue` at `index.ts:2597-2600`). `routes.ts` needed no change; POST behavior is covered by
tests through the real routes app. Offer shape: `{kind: "openmuse-task", key: task.id,
payload: {ownerUserId}}`, idempotent on (kind, key) by the queue's own conflict rule.

## Changed files + shasum (sha256)

- `server/src/openmuse-tasks/runner.ts` (new) — `8822ecdf9d324043181a87094ee0c15e175960a1c7194ec0ed8d2ecf7936ae4f`
- `server/src/openmuse-tasks/store.ts` (extended) — `85690096146889a152d70542d66445cbf0bb9073d64aa3764825b28a672dad76`
- `server/tests/openmuse-task-runner.test.ts` (new) — `2a24d95b81555dedd202d2c283445755b7a8aa715682d26618ce330055398a9e`
- `server/src/index.ts` (wiring) — `52ed387fa547239236975fc6e2da7cd25a9a885b4ecccddac204e7e354844b2c`

No migration: `steps`/`evidence` jsonb columns already exist (§7 Task minimum, T01).

## Runner semantics

`createOpenMuseTaskRunner` mirrors `createWakeUpRunner`: `queue.claim({kind:"openmuse-task",
owner: workOwner("openmuse-task"), leaseMs, limit: 1, maxAttempts: 1})` (no retry — a failed
turn may already have acted); load row by `(payload.ownerUserId, key)`; skip+finish when the
row is gone or already settled (succeeded/failed/cancelled); `queued → running`; one turn
through `channels.direct(actor, botId).threadId` under `AbortSignal.timeout(deadlineMs)` with
the `Promise.race` + pre-attached `catch` pattern so a losing turn's late rejection is never
unhandled; settle = prompt evidence (kind "user") + result evidence + one step
(`{id:"run", title:"Run", dependsOn:[], status, result}`) + terminal status, then
`queue.finish`. Error detail capped at 500 chars; result evidence excerpt at 2000 (step keeps
the full reply). `reap` purges settled queue rows older than 7 days, mirroring wake-up.

## Deadline default

`OPENMUSE_TASK_DEADLINE_MS`, read once in the module, default **300_000ms (300s)** per §7's
one-step acceptance deadline table; invalid/non-positive values fall back to the default.
Lease = deadline + 60s settle headroom (tests assert `leaseMs ≥ deadlineMs` and
`maxAttempts === 1`).

## Verification tails

- `bun test tests/openmuse-task-runner.test.ts tests/openmuse-tasks.test.ts tests/ready.test.ts`
  → `23 pass / 0 fail / 100 expect() calls / Ran 23 tests across 3 files`
- runner file alone → `10 pass / 0 fail / 42 expect() calls / Ran 10 tests across 1 file`
- adjacent family (`openmuse-bot/files/google-oauth/template-revision`) → `53 pass / 0 fail`
- `bun run build` (`tsc --noEmit`) → clean, no output
- `biome check` on all four touched files → clean, no findings

## S28 deferred statement

Live closed-client execution evidence (S28) is **gate-level**, not this ticket's: T02's tests
verify claim-once, deadline, finish, and no-replay against fakes that mirror the real WorkQueue
contract (leaseMs/maxAttempts passed through), while an actual client-closed live run belongs
to the integration gate that starts the real server and a real turn.
