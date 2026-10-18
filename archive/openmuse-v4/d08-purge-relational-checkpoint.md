# D08 — Purge OpenBot relational personal data: checkpoint

Ticket: issue #86 (catalog D08). Plan: `docs/superpowers/plans/tickets/D08-purge-relational.md`
(in the openmuse worktree). Worktree: `OpenBot/.worktrees/v4-base`, branch `v4/openbot-exec`,
NO commits made (prior uncommitted checkpoints untouched, nothing reverted).

## What landed

`createOpenMuseRelationalPurger` (`server/src/openmuse-deletion/purge-relational.ts`):

- **Precondition (manifest arbiter, 409-with-state):** every `openmuse-file` /
  `openmuse-google-connection` / `openmuse-google-calendar-connection` row must be
  state `deleted`; any pending or retryable row returns `{status: 409, blocked:[{kind,id,state,lastError?}]}`
  and nothing is deleted. Covers F-PURGE-1 (byte refusal) and F-PURGE-2 (grant refusal)
  leftovers alike — both stay enumerated in their own tickets' retry paths first.
- **Walk:** kind-by-kind in the manifest's own stable kind order (bot, channel, goal,
  idea, memory, notification, reviewed-action, task), one seam call per kind with the
  kind's not-yet-deleted manifest ids.
- **Partial failure:** the failing kind's unfinished rows land `retryable_error` with
  the reason; the walk CONTINUES past the failure (D06/D07 convention — one module's DB
  failure never holds its neighbours hostage); already-deleted kinds stay deleted; the
  manifest survives; `retryCleanup` re-walks only retryable rows and completes.
- **Gap rows** (`<module-gap>`, D04): never dialed, never `deleted` — landed
  `retryable_error: module gap unresolved` so finalize can never lie over them.
- **Finalize (only when nothing is owed but the marker's own row):** marker row →
  `deleted`, manifest emptied via `hardDeleteResources`, marker phase → `completed`.
  Every step idempotent; a crash between steps converges on the next pass.
- **Route:** `POST /api/admin/openmuse-deletion/:userId/purge-relational` on the D05/D06
  admin route factory (`restore.ts`), maps 409 → `{error, blocked}` 409, else `{purge: report}`.

## Batching choice (CHOICE RECORDED)

**Transactional per-module batches:** each module's removal seam is ONE owner-scoped
call for the whole kind — a single drizzle DELETE with `inArray(ids)` (atomic by
construction); Bots run one `database.transaction` (rows + vault-key retirement together).
A mid-batch failure therefore rolls back the whole kind, and the manifest retains that
kind's rows as one retryable unit. Walk continues to later kinds.

## Removal seam citations (emit-only exports, one per manifested module)

| Kind | Seam (added by D08) | Implementation |
| --- | --- | --- |
| openmuse-bot | `AgentProfileStore.hardDelete(owner, ids)` — `src/agents/profile-store.ts` | one transaction: owner-joined select, `retireReplacedKey` per Bot's vault credential (softDelete's own contract), delete `agents` rows (profile/preferences/channel seats cascade) |
| openmuse-channel | `ChannelStore.hardDelete(owner, ids)` — `src/channels/routes.ts` | one DELETE scoped by membership subquery — memberships, channel agents, attachments and the Intelligence thread mapping ride the cascade; package channels carry no membership, so never named |
| openmuse-goal | `OpenMuseGoalStore.hardDelete` → rows `hardDeleteGoals` — `src/openmuse-personal/goals.ts` | single owner-scoped DELETE |
| openmuse-idea | `OpenMuseIdeaStore.hardDelete` → rows `hardDeleteIdeas` — `src/openmuse-personal/ideas.ts` | single owner-scoped DELETE |
| openmuse-memory | `OpenMuseMemoryStore.hardDelete` → rows `hardDeleteMemories` — `src/openmuse-personal/memories.ts` | single owner-scoped DELETE |
| openmuse-notification | `OpenMuseNotificationStore.hardDelete` → rows `hardDeleteNotifications` — `src/openmuse-notifications/store.ts` | single owner-scoped DELETE |
| openmuse-reviewed-action | `OpenMuseReviewedActionService.hardDelete` → rows `hardDeleteActions` — `src/openmuse-reviewed-actions/{service,store}.ts` | attempts ride the action FK cascade |
| openmuse-task (incl. Monitors) | `OpenMuseTaskStore.hardDelete` → rows `hardDeleteTasks` — `src/openmuse-tasks/store.ts` | steps/evidence/monitor columns ride the row |

openmuse-deletion-internal seams added: marker `complete(userId)` (phase CAS →
`completed`), rows `hardDeleteResources(manifestId)`, manifest exports `MODULE_GAP` and
answers `phase: "completed"` with an empty resource list for a completed marker (a
repeat delete resurrects nothing), restore answers **410** for a completed marker.

## Interplay notes (F-PURGE-1/2 and neighbours)

- **F-PURGE-1/F-PURGE-2:** a retryable byte or grant row is exactly what D08's 409
  names (test pins both a `retryable_error` file row and a `pending` grant row);
  D06/D07's own `retryCleanup` remains the way to clear them before D08 re-runs.
- **D01 fence:** unchanged — `isDisabled` consults `phase === "fenced"` only, so the
  fence stands through every partial pass (pinned in the failure test) and a
  `completed` marker no longer fences (same as `restored`). Noted, not redesigned —
  the completed marker remains as D09's non-personal audit proof.
- **D05 restore:** completed marker → 410 (nothing is restorable, any calendar).
- **§9 "retain the manifest until every resource is deleted":** satisfied then
  exceeded at completion — the emptied manifest itself is personal data (it names
  every resource id), so completion removes the rows and leaves the phase=completed
  marker; unresolved rows stay operator-visible per D09 on partial failure.
- Soft-deleted (tombstoned) rows never enumerated by D04 are not manifested, so not
  D08's to remove — noted as a possible D09 sweep question.

## Files + shasum (post-biome)

```
5d18c7035d68be1871ca04ba305247c9a448afcd  src/openmuse-deletion/purge-relational.ts   (NEW)
9320383527d9a64b6a8ca06ac374279343619627  src/openmuse-deletion/store.ts
41b446d4566ce5b3379f54fabd10d9ee990e74a6  src/openmuse-deletion/manifest.ts
3fc4e358f8ea1e8ed5464d84b34786d51b9731ce  src/openmuse-deletion/restore.ts
2ab53250edb662bcc275407856f792171a50b3d1  src/agents/profile-store.ts
4b30bda29e8f650422f532c5e90c1a4044ccd1ee  src/channels/routes.ts
b94dfaa8414009bfaa8d1afa516c143378f82455  src/openmuse-tasks/store.ts
070b9b76e7bb3ea6db3f15f04fd775fdff0d5d43  src/openmuse-reviewed-actions/store.ts
6ae129399adcab1122779aa839cd5c0a5d143fb1  src/openmuse-reviewed-actions/service.ts
747264e3438bc19052b15d30e51901e4383d0180  src/openmuse-notifications/store.ts
058d6ffecea271d4f4b7341bd3c7568e1ec8d9f4  src/openmuse-personal/goals.ts
2611d0052c01a8470b719335f4b32170ca8c6f03  src/openmuse-personal/ideas.ts
9f8eba141855814a79d139d6d680e25a59ed1769  src/openmuse-personal/memories.ts
b42c7a97d4c33ebbac424f653b6f7828b9914528  tests/openmuse-deletion.test.ts
```

NOT touched: `app.ts`, `index.ts`, `apps/openmuse-mobile`, `docs/openmuse-v4/b01*` (B04's).

## Verification (all re-run per file, `TEST_DATABASE_URL=…openbot_test`)

- `tests/openmuse-deletion.test.ts` — **51 pass / 0 fail** (was 46 pre-D08; RED stage
  first showed 46 pass / 5 fail with the D08 describe failing on the stub).
- Touched suites — openmuse-goals 29/0, openmuse-ideas 37/0, openmuse-memories 30/0,
  openmuse-notifications 7/0, openmuse-tasks 74/0, openmuse-reviewed-actions 92/0,
  agent-profile-policy 6/0, agent-profile-store.integration 25/0, channel-routes 125/0,
  channel-{activity,events,summary}.integration 21/0, 16/0, 17/0.
- `tests/ready.test.ts` — 3 pass / 0 fail.
- Full openmuse-* family + agent-routes/registry + channel unit suites — ALL GREEN.
- `bun run typecheck` (tsc --noEmit) — clean. `biome check` on all 14 files — clean.
