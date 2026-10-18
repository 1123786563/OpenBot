# K03 — Claim and revoke a human-control lease: Task 0 mapping (§3 → file:line)

Ticket: GitHub issue #24 (catalog K03). Plan: `docs/superpowers/plans/tickets/K03-control-lease.md` (openmuse worktree).
Worktree: `/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base`, branch `v4/openbot-exec`. No commits.

Contract §3 (Computer control), quoted clause by clause. Line numbers from this worktree on 2026-10-13.

## 1. Clause → evidence table

| §3 clause | Status | Evidence (file:line) |
|---|---|---|
| `viewing → requesting → controlling → released` transitions | EXISTS | requesting: `agent-computer/src/control.ts:205-251` (requestHelp → status `waiting`, `expiresAt` = now+10min at :244); computer HTTP `agent-computer/src/index.ts:749-763`; server `server/src/computer/routes.ts:366-377` → `server/src/computer/gateway.ts:753-769`. controlling: `control.ts:252-278` (take → `taken`, holder `human`); HTTP `index.ts:870-886`; server `routes.ts:438-442` → `gateway.ts:771-783`. released: `control.ts:279-300` (release → `completed`, holder `bot`); cancel `control.ts:301-310`; interrupt `control.ts:166-182`. viewing: GET /control `routes.ts:353-364`; `requested` flag `control.ts:140`. |
| `expired` outcome | EXISTS | waiting past `expiresAt` → `expired`: `control.ts:111-128`; persisted status vocabulary incl. `expired`/`interrupted`: `agent-computer/src/control-store.ts:30-37`; pinned by `agent-computer/tests/control.test.ts:51` ("only waiting expires; taken control has no ten-minute limit"). |
| `refused` outcome (Policy refusal lands, lease released) | GAP | No `refused` status in the vocabulary (`control-store.ts:30-37`). A Policy refusal happens server-side (`gateway.ts:513+` govern → `ActionRefusedError` 403, `routes.ts:267-269`) and never reaches the computer's control state. No server→computer revocation endpoint exists; the only state-flipping computer endpoints are `/computers/stop`, `/computers/reset` (both stop the browser, `index.ts:966-984`) and `/control/{take,release,cancel}` — and `cancel` on a taken lease deliberately keeps holder `human` (`control.ts:301-310`, pinned `control.test.ts:101`). |
| Lease binds `leaseId` | EXISTS | `HandoffRequest.id` minted `control.ts:234` (uuid); idempotent take of the same id is the same lease `control.ts:254,264`. |
| Lease binds `botId` | EXISTS (implicit) | Bound by storage partition, not a field: per-Bot control store `control-store.ts:116-122` (`profiles/.control/{botId}.json`); per-Bot session map `agent-computer/src/sessions.ts:33`. |
| Lease binds `expiresAt` | EXISTS (claim deadline) / DIVERGES (held lease) | Waiting-phase claim deadline `control.ts:244`, enforced `control.ts:111-128`. Deliberately deleted on take (`control.ts:272`) — a held lease has no expiry; explicit release/logout/disconnect/policy are the only exits. Pinned by `control.test.ts:51`. Treating `expiresAt` as the claim window (per §3 "transfer requires explicit release or expiry") keeps this pin green; forcing expiry onto a held lease would break a pinned regression test. |
| Lease binds `userId` | GAP | The computer has no user identity by design (`routes.ts:30-39`); `take()` records no who (`control.ts:252-278`); the take POST from the server carries only `{requestId}` (`gateway.ts:771-774`, read `index.ts:876-885`). userId exists only in server audit rows (`writeControlEvent` actorUserId, `gateway.ts:763-805`). Consequence: a second user's take of the held lease succeeds silently (idempotent path, identity-blind). |
| Lease binds `streamId` | GAP (cross-process) | No stream identity anywhere in the lease. The WS is proxied by the server (`server/src/computer/stream-auth.ts:36-107`, upgrade in `server/src/index.ts`); the computer sees raw sockets claimed by object identity (`agent-computer/src/viewer.ts:148-160,201-213`). Binding it needs the upgrade path (not owned) + a WS protocol field — the plan's own example of a cross-process gap. |
| Input requires the active lease | EXISTS | WS: `index.ts:593-605` (`humanMayDrive()` else error, before `cast.send` at :613). HTTP: `index.ts:891-894` (409 `TAKE_CONTROL_FIRST`, before `performHumanInput` at :908). Authority: `control.ts:333-335` (holder `human` + barrier drained). Server transport maps to 409 (`routes.ts:1017` statusFor HumanHasControlError; `gateway.ts:964-985`). |
| Input requires a monotonic input sequence | GAP | No `seq` in the WS `InputMessage` (`agent-computer/src/request-validation.ts:110-169`) or the HTTP `/human/*` bodies (`routes.ts:505-570`, `index.ts:891-913`). A server-side per-process counter is wrong across the deployment's replicas; the single authority is the computer's per-Bot control state. |
| Two concurrent requests cannot both control | EXISTS | One active request at rest (`control-store.ts:98-112` validates only `currentRequestId` may be waiting/taken) and in motion (take drains the barrier then re-checks `control.ts:252-278`); a new request while one is active returns the existing one (`control.ts:223-230`). Sub-GAP: the duplicate take is identity-blind — see `userId` row. |
| Transfer requires explicit release or expiry | EXISTS | `requestHelp` refuses to open a second request while one is active/held (`control.ts:223-230`); take only from `waiting` (`control.ts:255-269`); release requires the holder (`control.ts:279-300`); waiting expiry `control.ts:111-128`. |
| Logout revokes the lease | GAP | No logout→control wiring exists on either side. |
| Disconnect revokes the lease | EXISTS (browser lifecycle) / PARTIAL (screen socket) | Browser stop/reset/replace/restart interrupt: `index.ts:968-970` (stop), `index.ts:982-984` (reset), `sessions.ts:173-184` (renewRun), `control.ts:183-191` (restart with active handoff). A dropped *screen socket* releases only the cast claim (`index.ts:641-649`, `viewer.ts:201-213`); the lease deliberately survives for reconnect (session sweep keeps held sessions, `sessions.ts:96-107`). |
| Policy refusal revokes the lease | GAP | See `refused` outcome row — no path from a policy decision to the control state. |
| Later keyboard/mouse event returns 403/409 and is not delivered | EXISTS (conditional on a revocation having flipped the state) | Both input paths gate on `humanMayDrive()` before any dispatch: WS `index.ts:602-605` (error frame, no `cast.send`), HTTP `index.ts:892-893` (409, returns before touching the page). After `interrupt`/release/expiry the holder is `bot` and the request is terminal, so the gate refuses. 409 satisfies §3's "403/409". Needs zero-delivery pinning tests (fake downstream counting deliveries). |
| Audit records actor, Bot, lease, decision | PARTIAL → GAP (lease) | Actor/Bot/decision: `gateway.ts:753-805` writes `computer.help_requested` / `computer.control_taken` / `computer.control_released` / `computer.help_cancelled` with payload `{bot, actor, reason}` + `actorUserId` (`writeControlEvent`). GAP: no control audit payload names the lease (`requestId`) — take/release/cancel rows cannot say which lease they were about. |

## 2. Boundary findings (plan §Failure handling)

The gaps split by where the fix must land:

1. **In-scope surgical (owned files):** state-machine lease identity (`take(requestId, {userId})` binding + second-user refusal + `takenBy` exposure in `control.ts`/shared DTO); revoke semantics already exist as `interrupt()` on the computer.
2. **`server/src/computer/gateway.ts` (not in the owned list, but named by the plan's Task 2):** threading `userId` on the take POST, adding `requestId` to control audit payloads, and a `revokeControl(botId, {reason})` gateway method all live here — `routes.ts` delegates every control call to the gateway and writing audit from routes would bypass the governance seam.
3. **`agent-computer/src/index.ts` (not owned):** reading `userId` on `/control/take`, a `/control/revoke` endpoint, and a `seq` check in the WS/HTTP human-input handlers. Without this file, userId binding and sequence enforcement cannot be observed end-to-end — the state-machine seam can be proven, the transport cannot.
4. **Genuinely cross-process (defer):** `streamId` binding (upgrade path + WS protocol) and WS-frame sequencing (app protocol change).

Escalated to the coordinator before GREEN: whether bucket 2/3 files are granted, per the plan's "STOP and report the boundary question" clause.

**Coordinator decision (Option A, granted):** `server/src/computer/gateway.ts` AND `agent-computer/src/index.ts` added to the owned files (the plan's "NO app.ts/index.ts" meant the server's `src/app.ts` + `src/index.ts` assembly). Scope: userId end-to-end (server injects the authenticated actor's id; client payload stays `{requestId}`), `/control/revoke` + `revokeControl` landing a `refused` outcome, lease ids in audit payloads, monotonic seq in the computer's human-input handlers. streamId binding and WS-frame seq explicitly deferred to K04.

## 3. RED → GREEN matrix (results)

RED recorded before GREEN: `agent-computer/tests/control-lease.test.ts` 1 pass / **9 fail** (only the expired-outcome pin passed — existing behavior); `server/tests/control-lease-routes.test.ts` 2 pass / **4 fail** (the two transport pins passed). Every failure mapped to a Task 0 GAP clause; no failure was an existing behavior.

| Matrix item (plan §Task 1) | Seam | Outcome |
|---|---|---|
| 1. viewing→requesting→controlling→released, observable | state machine | PIN (existed) |
| 2a. expired outcome lands, released | state machine | PIN (existed) |
| 2b. refused outcome lands, released | state machine | GAP → GREEN: `interrupt(reason, "refused")` |
| 3. two concurrent takes, exactly one winner | state machine | GAP (identity-blind) → GREEN: `take(requestId, {userId})` |
| 4. input without lease 409; stale sequence 409/400, not delivered | state machine + routes | GAP → GREEN: `admitHumanInput({seq})` + route seq shaping |
| 5. revoke then input 409, zero delivery, audit names actor+bot+lease | routes (fake computer) | GAP → GREEN: `/control/revoke` + `revokeControl` + `computer.control_revoked` row |
| 6. second user's take while first holds → refused | both | GAP → GREEN: `takenBy` binding + 409, transported by the server |

## 4. What changed

| File | shasum (sha256) | Change |
|---|---|---|
| `shared/computer-control.ts` | `cd856c4a…9ab6b9` | `HandoffStatus` gains `refused`; `HandoffRequest` gains `takenBy?` |
| `agent-computer/src/control.ts` | `6d9b6547…dc2b747` | `take(requestId, {userId})` binds `takenBy` and refuses a different holder's re-take (409); `interrupt(reason, outcome)` can land `refused`; `admitHumanInput({seq})` gate (lease + per-lease monotonic sequence, 400/409); input sequence resets on take |
| `agent-computer/src/control-store.ts` | `0d652806…0b9c45b` | `refused` in the persisted status vocabulary; `takenBy` validated |
| `agent-computer/src/index.ts` | `96844575…b94c994` | `/control/take` reads the server-injected `userId`; `/control/revoke` endpoint; HTTP `/human/*` gates through `admitHumanInput` (WS path unchanged — deferred) |
| `agent-computer/tests/control-lease.test.ts` | `d4a2356b…74ec68` | new: §3 matrix, state-machine seam (10 tests) |
| `server/src/computer/gateway.ts` | `c325e1ce…644c3aa2` | take POST carries `userId: actor.id`; `requestHelp`/`take`/`release`/`cancel` audit rows carry `lease`; new `revokeControl` (POST `/control/revoke` + `computer.control_revoked` row with the lease) |
| `server/src/computer/routes.ts` | `ecc17f6b…922c77e` | `POST /:botId/control/revoke`; `/human/:kind` shapes `seq` (400 for non-integer/`<1`) |
| `server/src/computer/schema.ts` | `df6eb48b…fcf6412a` | `HumanInput` carries `seq?` |
| `server/src/audit.ts` | `aa5f49c3…4751882` | `computer.control_revoked` in the event registry |
| `server/tests/control-lease-routes.test.ts` | `7195d2a2…ddd3d5f7` | new: §3 matrix, route seam with a stateful fake computer (6 tests) |
| `server/tests/computer-handoff-contract.test.ts` | `a151bce1…da4372b` | updated pin: take body is `{requestId, userId}` (the actor's id, not the client's) — the intended contract change |

## 5. Verification

```
agent-computer: bun test
  392 pass / 45 skip / 0 fail (baseline before this ticket: 382 pass / 45 skip / 0 fail; +10 new)

server: bun test tests/control-lease-routes.test.ts tests/stream-auth.test.ts
  14 pass / 0 fail
server (wider regression surface, 15 files incl. handoff-contract, human-input, refusal e2e,
computer-routes, gateway, policy/download/exec/page-frame/scroll/snapshot/fleet):
  185 pass / 0 fail

typecheck: server `tsc --noEmit` clean. agent-computer: 4 errors on the untouched baseline
(playwright/spiffe types not installed in this unit lane — verified identical by stashing the
change and re-running; my files typecheck clean).
biome: `bunx biome check` clean on all 11 touched files (after `--write` formatting pass).
```

No commits made.

## 6. F-CONTROL-1 mapping note

F-CONTROL-1 (gate-level live card) is the deployment-level verification of §3 computer control; this ticket's proof is the unit matrix at the two sanctioned seams — the state machine (`agent-computer/tests/control-lease.test.ts`) decides every clause, and the route half (`server/tests/control-lease-routes.test.ts`) pins what travels (actor-injected userId, seq, revocation) and what comes back (statuses, zero delivery, audit rows naming actor/Bot/lease). A live-card run against the real stack remains the gate-level check.

## 7. Deferred (K04 follow-ups, with reasons)

- **streamId binding** — cross-process by the plan's own example: the upgrade path (server `src/index.ts`) mints no stream identity and the computer's WS carries none; binding needs a protocol change on both ends.
- **WS-frame-level input sequence** — the live screen's input frames have no `seq` field (app protocol change); the HTTP gesture path is enforced now.
- **Logout/policy auto-triggers** — `revokeControl` is the sanctioned path, but logout is handled in `server/src/app.ts` (excluded from this ticket's grant) and auto-revoking inside `govern()` was deliberately not done: policy refusals meet only *waiting* leases (bot actions cannot run while a lease is held), and cancelling a pending human sign-in request on an unrelated bot-action refusal changes pinned refusal semantics. Wiring is one call at each trigger.
- **App-side `refused` prompt** — `app/src/components/computer/{needs-you.ts,computer-controls.tsx}` prompt on `interrupted` only; a `refused` lease leaves the same `recoveryRequired` state without a prompt. No `refused` lease can occur until the auto-triggers above land; the app catch-up belongs to the same follow-up.
