# T08 Preview Activity and On-Demand Coding Wake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Repository authorization and review rules govern execution.

**Goal:** A preview a person is actually using keeps its OpenShell coding sandbox running; known background polling does not, and an authorized later open wakes the same persistent coding sandbox with a fresh generation.

**Architecture:** OpenBot's authenticated preview face remains the only user entry. T08 adds a generation-bound preview activity ledger at that face, an idle coordinator above T07's coding lifecycle, and an explicit preview wake path that starts the protected webapp process after the sandbox is running. T04 owns admission; T07 owns persistent stop/resume; T08 owns only the preview activity decision and its interaction with that lifecycle.

**Tech Stack:** TypeScript, Bun, Hono, OpenShell coding adapter from T03/T07, Playwright, Kubernetes, tester-army `e2e`.

**Spec:** [Spec v1 A04](../../specs/2026-10-30-openshell-sandbox.md#验收映射) and [D9](../../specs/2026-10-30-openshell-sandbox.md#已批准决定), with [D7–D8](../../specs/2026-10-30-openshell-sandbox.md#已批准决定); [ADR 0013](../../adr/0013-openshell-sandbox-substrate.md); [ticket breakdown T08](ticket-breakdown.md#t08--预览活动维持编码沙箱闲置后按需恢复); GitHub [Issue #742](https://github.com/1123786563/OpenBot/issues/742). Issue #742 is open and genuinely blocked by #738 (T04) and #741 (T07); both were also open at plan time. No T03 or T04 plan file exists in this tree yet, so their final interfaces must be read from verified implementation, not inferred from this plan.

## Global Constraints

- This draft and Issue #742 are not implementation authorization. Before editing, re-read the issue, approvals, Git baseline and verified T04/T07 results in the execution workspace; blocked dependencies cannot be bypassed.
- T04 must already prove authenticated HTTP, SSE, WebSocket and preview admission for the actual execution scope. Reuse its actor, preview pass/ticket and route contracts. T07 must already prove stop/resume, generation change and preservation; reuse its actual `status`, `ensureRunning`, `stop` and active-work/stream interfaces. Reconcile names with those implementations before changing files.
- D9 activity criterion: an authenticated preview document navigation, authenticated state-changing preview action, or an authenticated open HMR/application socket represents document presence and prevents idle stop. An in-flight task or active event stream also prevents idle stop through T07. Known status polls, readiness probes, passive asset loads, HMR frames and timer heartbeats never create or extend activity; closing the last presence socket starts idle judgment from the last navigation/action, not from the last frame.
- Stop preserves coding disk state (D8/A03/A04). Resume starts new processes and returns a new generation; it never promises RAM, unsaved editor state, or unchanged browser login state. An old preview credential or generation reference must fail after reset/resume and require a new authorized entry.
- Full execution scope is mandatory (ADR 0006): tenant, workspace, Bot, coding environment and generation. A bare global Bot ID is never the activity or sandbox key.
- OpenShell mode only. Do not change legacy deployment, shared-container, `createDevServers`, `BotRuntimes.reapIdle`, computer capacity or shared computer culling behavior. `server/src/computer/capacity.ts` is only a reference for conservative idle decisions, not code to reuse for coding previews.
- Idle threshold and sweep cadence must be configurable and selected from live measurement. This plan deliberately sets no default millisecond value; an unmeasured number may not be committed or documented as verified.
- If implementation adds or changes person-visible preview status or retry text, read and follow `.agents/skills/openbot-copy/SKILL.md`; no such copy is authorized by this planning file.
- This is a full-tier change. It requires independent behavior acceptance, Spec/quality review and applicable OCR. Final commands, collected counts, versions and no-unexplained-skip evidence belong under `.archive/runs/<run-key>/verification/`.

## Review Focus

1. A status poll or timer heartbeat keeps a sandbox awake forever and exhausts capacity; Task 1 and Task 2 pin `webapp-info`, `preview-origin-live`, readiness probes and HMR keepalives as non-activity, and Task 3 repeats it in a real browser.
2. A preview a person is viewing is stopped and becomes a white screen; Task 2 keeps an authenticated open application socket/user action awake and Task 3 holds a real preview open across the idle window.
3. An in-flight task or active SSE stream is mistaken for idle and interrupted; Task 2 consumes T07's active-work/stream signal and `CodeRunGateway.startStreaming`/`SandboxClient.subscribeEvents` behavior in tests.
4. Reopening with an old preview pass or generation reads reset state; Task 1 binds credentials to generation and Task 2/Task 3 reject stale generation before wake or preview serving.
5. An unauthorized caller wakes another user's or scope's sandbox through the preview URL; Task 2 requires T04 admission before any lifecycle call and Task 3 probes cross-user, cross-Bot and stale URLs with zero wake side effects.

## File map and dependency contract

Verified current facts: the production preview face is Craft's `server/src/craft/preview-origin.ts` and `server/src/craft/webapp-proxy.ts`, assembled by `createCraftPreview` in `server/src/craft/preview.ts`; `server/src/workshop/preview.ts` is presently an unmounted module and is not the integration target. Existing useful symbols are `PreviewOrigin.handlePreviewRequest`, `PreviewOrigin.verifyPass`, `PreviewPassBinding`, `createPreviewProxy`, `resolvePreviewWebappHmrUpgrade`, `webappDevServerReady`, `webappHmrSocketHandlers`, `CraftStore.getSession/findSession/listIdleSessions/markSessionIdleIfStillIdle/updateSessionActivity`, `TurnStateStore.getActiveTurn`, `CodeRunGateway.startStreaming`, `SandboxClient.subscribeEvents/abortSession`, and `createCraftIdleReaper`. Existing `agent-sandbox` symbols (`createDevServers`, `BotRuntimes.reapIdle/markActivity/noteStreamOpen/noteStreamClose`, `SANDBOX_UPSTREAM_IDLE_MS`, `SANDBOX_DEVSERVER_MAX`) are shared-mode references only.

T08-owned files:

- Create `server/src/openshell/preview-activity.ts`: classify signals, retain generation-bound activity, expose snapshots to later capacity tickets.
- Create `server/src/openshell/preview-lifecycle.ts`: serialize wake and idle-stop decisions above the actual T07 lifecycle adapter.
- Modify the actual T07/T03 OpenShell coding adapter (expected `server/src/codesandbox/openshell-provider.ts`; reconcile path): add preview-process start and expose only scoped lifecycle operations.
- Modify `server/src/craft/preview-pass.ts`, `preview-ticket.ts`, `preview-origin.ts`, `webapp-proxy.ts` and `preview.ts`: generation binding and activity/wake hooks without weakening existing pass, origin, CSP, no-store or ownership checks.
- Modify the OpenShell configuration owner established by T01 (expected `server/src/config.ts`; reconcile path): require positive `OPENBOT_OPENSHELL_PREVIEW_IDLE_MS` and `OPENBOT_OPENSHELL_PREVIEW_SWEEP_INTERVAL_MS` in OpenShell preview mode, with no implicit numeric fallback until live measurement approves one.
- Modify `server/src/craft/routes.ts` only to wire the T08 seams into the one assembled preview face.
- Add `scripts/openshell-preview-acceptance.ts` and tests named below. Live outputs go only to `.archive/runs/<run-key>/verification/`.

Consumes from T03/T04/T07:

- T03: full coding scope resolver, persistent storage identity, scoped OpenCode/file/service boundary.
- T04: actual authenticated route actor, preview ticket/pass issuance and verification, HTTP/WS admission, and rejection surfaces for foreign user/Bot/team.
- T07: `status(scope): Promise<"running"|"stopped"|"starting"|"unreachable">`, `ensureRunning(scope): Promise<{url:string;generation:string}>`, `stop(scope): Promise<{wasRunning:boolean}>`, plus its actual active task/SSE predicate and serialization lock. If verified names differ, map to those names and record the reconciliation in the run Ledger.

Produces for T13/T16:

```ts
type CodingPreviewIdentity = {
  tenantId: string;
  workspaceId: string;
  botId: string;
  environment: "coding";
  sessionId: string;
  generation: string;
};

type PreviewActivitySignal =
  | { kind: "document_navigation"; at: Date }
  | { kind: "user_action"; at: Date }
  | { kind: "application_socket_open"; socketId: string; at: Date }
  | { kind: "application_socket_close"; socketId: string; at: Date };

type PreviewActivityClassification =
  | PreviewActivitySignal
  | {
      ignored: "background_poll" | "passive_asset" | "hmr_frame";
    };

function classifyPreviewActivity(input: {
  request: Pick<Request, "method" | "headers">;
  appPath: string;
  socketEvent?:
    | "hmr_open"
    | "hmr_close"
    | "hmr_frame"
    | "application_open"
    | "application_close";
  now: Date;
}): PreviewActivityClassification;

type PreviewActivityLedger = {
  record(input: {
    identity: CodingPreviewIdentity;
    actorId: string;
    signal: PreviewActivitySignal;
  }): "recorded" | { ignored: "background_poll" | "passive_asset" | "unverified" | "stale_generation" };
  snapshot(identity: CodingPreviewIdentity): {
    lastUserActivityAt: Date | null;
    openApplicationSockets: number;
    generation: string;
  };
  replaceGeneration(input: { identity: CodingPreviewIdentity; newGeneration: string }): "replaced" | "not_found";
};

type PreviewLifecycleCoordinator = {
  ensurePreviewRunning(input: {
    identity: CodingPreviewIdentity;
    actorId: string;
    cause: "ticket_entry" | "document_navigation";
  }): Promise<
    | { ok: true; generation: string; target: { host: string; port: number } }
    | { ok: false; reason: "unauthorized" | "not_found" | "starting" | "failed" }
  >;
  shouldStopIdle(input: { identity: CodingPreviewIdentity; now: Date; idleMs: number }): Promise<boolean>;
  stopIfIdle(input: { identity: CodingPreviewIdentity; now: Date; idleMs: number }): Promise<{ stopped: boolean; generation: string | null }>;
};
```

`PreviewPassBinding` must gain the current generation (or T04's equivalent generation claim); `redeemPreviewTicket` and `verifyPass` must return `{ userId, generation }`. A pass or ticket minted for generation N is invalid for N+1 even if its MAC and token index entries remain valid.

---

### Task 1: Generation-bound activity semantics

**Files:**

- Create: `server/src/openshell/preview-activity.ts`
- Modify: `server/src/craft/preview-pass.ts`, `server/src/craft/preview-ticket.ts`
- Test: create `server/tests/openshell-preview-activity.test.ts`; extend `server/tests/craft-preview-pass.test.ts`, `server/tests/craft-preview-ticket.test.ts`

**Interfaces:**

- Consumes: existing `PreviewPassBinding = { sessionId; userId }`, `PreviewTickets.issuePreviewTicket/redeemPreviewTicket`, `PreviewOrigin.verifyPass(sessionId, request)`, and the verified T04 admission contract.
- Produces: `classifyPreviewActivity`, `PreviewActivitySignal`, `PreviewActivityLedger` and generation-bearing pass/ticket bindings in the file map. Classification is pure and never reads a timer or performs I/O; it is called only after T04 verification.

- [ ] **Step 1: Write failing tests.** Using `tests/support/e2e-compat.ts`, add cases named `background_status_polls_and_readiness_probes_never_record_activity`, `hmr_keepalive_and_passive_assets_never_record_activity`, `document_navigation_user_action_and_open_application_socket_record_activity`, `socket_close_removes_presence_without_extending_last_user_activity`, `stale_generation_cannot_record_or_verify`, and `generation_replacement_invalidates_old_pass_and_ticket`. Cover `GET /sessions/:id/webapp-info`, `GET /sessions/:id/preview-origin-live`, HMR `/_next/webpack-hmr`, HTML document navigation, POST/PUT/PATCH/DELETE user actions, and non-HMR application socket open/close.
- [ ] **Step 2: Run RED.** `E2E_UNIT_OUTPUT=.e2e/<run-key>/T08-task1-red e2e run --config e2e.unit.config.ts server/tests/openshell-preview-activity.test.ts server/tests/craft-preview-pass.test.ts server/tests/craft-preview-ticket.test.ts`. Expected: every new case is collected and fails on the missing module/generation field; exit is nonzero; record the actual file/case count, and any skip must be named and justified or fixed before proceeding.
- [ ] **Step 3: Implement minimally.** Put signal classification and a process-local ledger in `preview-activity.ts`, matching the existing in-process preview pass/ticket single-replica contract; bind preview passes and tickets to the current generation without changing cookie/ticket secrecy, TTL, atomic redemption, MAC verification, no-store behavior or existing refusal copy. The ledger must key by full `CodingPreviewIdentity`, not session ID alone. If T04 introduces a shared pass store, reconcile this decision before implementation instead of adding a second authority.
- [ ] **Step 4: Run GREEN.** Repeat the command with output `.e2e/<run-key>/T08-task1-green`; expected result is all named cases pass with the same actual file/case count as RED. Run `bun run --cwd server typecheck` and retain its exit code and count-bearing output.
- [ ] **Step 5: Commit.** At implementation time, after the repository review gate, commit only Task 1 files with a T08-scoped message. Planning execution does not commit.

### Task 2: Authenticated wake and idle coordination

**Files:**

- Create: `server/src/openshell/preview-lifecycle.ts`
- Modify: actual T07/T03 OpenShell coding adapter; the T01 OpenShell configuration owner; `server/src/craft/preview-origin.ts`, `server/src/craft/webapp-proxy.ts`, `server/src/craft/preview.ts`, `server/src/craft/routes.ts`
- Test: create `server/tests/openshell-preview-lifecycle.test.ts`; extend `server/tests/config.test.ts`, `server/tests/codesandbox-gateway.test.ts`, `server/tests/craft-preview-origin.test.ts`

**Interfaces:**

- Consumes: T07 lifecycle and active-work contracts; T04 authenticated routes and generation-bearing pass verification; Task 1 `PreviewActivityLedger`; existing `resolvePreviewWebappHmrUpgrade`, `webappHmrSocketHandlers`, `createPreviewProxy`, `webappDevServerReady`, `TurnStateStore.getActiveTurn`, `CodeRunGateway.startStreaming` and `SandboxClient.subscribeEvents`.
- Produces: `PreviewLifecycleCoordinator` from the file map and adapter method `ensurePreviewProcess(scope, sessionId, generation): Promise<{host:string;port:number}>`. This method may invoke only the protected session `start-webapp.sh` contract; it must not accept a caller command, host, port or URL.

- [ ] **Step 1: Write failing tests.** Using `tests/support/e2e-compat.ts`, cover: authorized stopped-scope ticket entry wakes once and returns a new-generation ticket; concurrent entry shares one wake; `webapp-info` and `preview-origin-live` never call wake; an open authenticated application socket, later user action, queued/running `startStreaming` turn or live `subscribeEvents` stream blocks stop; only background polls after socket close stop at the configured threshold and call T07 `stop`, not reset; coding disk marker survives; a later authorized open yields a new generation and serves the marker; old generation pass/ticket and direct URL fail; other user/Bot/team gets the existing T04 refusal with zero lifecycle calls; legacy/shared modes retain their current route and reaper behavior.
- [ ] **Step 2: Run RED.** `E2E_UNIT_OUTPUT=.e2e/<run-key>/T08-task2-red e2e run --config e2e.unit.config.ts server/tests/openshell-preview-lifecycle.test.ts server/tests/config.test.ts server/tests/codesandbox-gateway.test.ts server/tests/craft-preview-origin.test.ts`. Expected: every new case is collected and fails; record the actual file/case count; no listed file is silently omitted by the Bun-driven manifest.
- [ ] **Step 3: Implement minimally.** Put wake/idle serialization in `preview-lifecycle.ts`. Authorization and scope resolution happen before any T07 call. Ticket entry and a pass-verified document navigation may wake; ordinary assets, status reads and HMR keepalives may not. HMR socket open/close updates presence only after `verifyPass` and the existing same-origin gate; no HMR frame refreshes `lastUserActivityAt`. Idle stop rechecks task/stream state immediately before T07 `stop` and leaves storage untouched.
- [ ] **Step 4: Run GREEN and regressions.** Repeat with `.e2e/<run-key>/T08-task2-green`, then run `E2E_UNIT_OUTPUT=.e2e/<run-key>/T08-task2-regression e2e run --config e2e.unit.config.ts server/tests/openshell-preview-activity.test.ts server/tests/openshell-preview-lifecycle.test.ts server/tests/config.test.ts server/tests/craft-preview-pass.test.ts server/tests/craft-preview-ticket.test.ts server/tests/craft-preview-origin.test.ts server/tests/codesandbox-gateway.test.ts`. Expected all named cases pass, RED/GREEN and regression actual counts are recorded, and no skip is unexplained. Run `bun run --cwd server typecheck`. Preserve old mode behavior exactly.
- [ ] **Step 5: Commit.** At implementation time commit only the reviewed Task 2 increment; do not include generated reports.

### Task 3: Real browser and isolated OpenShell acceptance

**Files:**

- Create: `scripts/openshell-preview-acceptance.ts`
- Test/collector: add `scripts/openshell-preview-acceptance.test.ts` for fixture/preflight assertions only; the live script remains the acceptance authority
- Evidence: `.archive/runs/<run-key>/verification/`

**Interfaces:**

- Consumes: verified T01 deployment/version bundle, T03 coding sandbox, T04 authenticated main-site and preview origins, T07 persistent lifecycle, Task 2 coordinator, real Playwright Chromium, real protected webapp process and real SSE/WS paths.
- Produces: `runOpenshellPreviewAcceptance(input: { runKey: string; outputRoot: string }): Promise<{cases:Array<{name:string;outcome:"pass"|"fail"|"blocked"|"skipped";evidence:string}>}>` for T16 aggregation. `blocked` and `skipped` require a concrete environmental reason and still produce nonzero delivery status for T08.

- [ ] **Step 1: Add the live case matrix.** Cases: `authorized_open_keeps_preview_running`, `background_polling_stops_after_configured_idle`, `workspace_survives_idle_stop`, `authorized_reopen_wakes_new_generation`, `old_generation_url_fails`, `foreign_user_and_scope_cannot_wake`, `sse_and_task_remain_active`, and `hmr_socket_is_presence_not_heartbeat`. Use a real fixture app with a unique disk marker, real preview document and real HMR socket.
- [ ] **Step 2: Run fixture RED.** `E2E_UNIT_OUTPUT=.e2e/<run-key>/T08-task3-red e2e run --config e2e.unit.config.ts scripts/openshell-preview-acceptance.test.ts`; expected the new collector/preflight assertions fail before the script exists or before it binds versions/resources. Record the actual collected file/case count.
- [ ] **Step 3: Run isolated live acceptance.** Execute `bun scripts/openshell-preview-acceptance.ts --run-key <run-key> --output-root .archive/runs/<run-key>/verification`. Before start, prove namespace/resource owner, source-tree hash/dirty state, OpenShell/controller/CNI/storage/Chromium/server/sandbox revisions, ports and isolated database/object-store scope. Inject only explicit test configuration: shortened idle/sweep values and test fixture identities; record every injection. Do not mock OpenShell, browser, disk, SSE or WS.
- [ ] **Step 4: Verify the behavior.** With the real preview open, advance beyond the shortened threshold and assert compute stays running. Close the preview/document, continue only production-equivalent `webapp-info`/`preview-origin-live` polling, and assert stop after the configured threshold plus one sweep. Read the disk marker through the authorized coding file boundary, actively reopen from the main site, assert a fresh generation and visible marker/HMR, then reject old generation and foreign-scope URLs with zero wake side effects. Run one live SSE/task case through `startStreaming`/`subscribeEvents` and assert no stop while active.
- [ ] **Step 5: Archive and gate.** Save command lines, exit codes, browser traces/screenshots, observed generation/storage identity, case counts, teardown receipt, source/version manifest and sanitized logs. Run `E2E_UNIT_OUTPUT=.e2e/<run-key>/T08-final-unit e2e run --config e2e.unit.config.ts server/tests/openshell-preview-activity.test.ts server/tests/openshell-preview-lifecycle.test.ts server/tests/config.test.ts server/tests/craft-preview-pass.test.ts server/tests/craft-preview-ticket.test.ts server/tests/craft-preview-origin.test.ts server/tests/codesandbox-gateway.test.ts scripts/openshell-preview-acceptance.test.ts`, then `bun run --cwd server typecheck`, independent behavior/Spec/quality review and applicable OCR against the final authorized increment. A live environment failure is a blocked T08 capability, not a unit-test pass.

## Independent acceptance

| Required outcome | Task/test evidence | Passing condition |
| --- | --- | --- |
| Issue #742: valid user access keeps preview | Task 2 lifecycle cases; Task 3 `authorized_open_keeps_preview_running`, `hmr_socket_is_presence_not_heartbeat` | Authenticated document presence/open application socket/user action prevents stop in unit and real browser behavior. |
| Issue #742: only heartbeat/polling stops by config | Task 1 background cases; Task 2 poll/no-wake cases; Task 3 `background_polling_stops_after_configured_idle` | Known polls/probes/HMR keepalives never record activity; with no task/stream/presence the sandbox stops after the configured measured threshold. |
| Issue #742: reopen wakes and authorization holds | Task 2 wake/stale/foreign cases; Task 3 reopen, old-generation and foreign-scope cases | Only authorized full scope wakes, disk remains, generation changes, preview works, and old generation/foreign access fails without lifecycle side effects. |
| A04 preview-specific D9 conditions | Tasks 1–3 | Valid preview access remains available, background traffic cannot renew forever, active task/SSE is preserved, reopen wakes, and all preview paths remain behind T04 admission. |
| A03/D8 disk boundary | Task 2 marker case; Task 3 `workspace_survives_idle_stop` | Idle stop calls stop only; coding marker survives; no reset/delete is used to reclaim capacity. |
| A04 old-generation safety | Task 1 stale credential tests; Tasks 2–3 old URL tests | Generation mismatch fails before serving or waking and forces a new authorized entry. |
| D3/D19 old modes | Task 2 regression suites | Legacy and shared-container preview/reaper behavior is unchanged. |

Blocked gates: T04 or T07 not verified in the same tested tree; actual authenticated preview or T07 lifecycle interfaces cannot be reconciled; valid document presence cannot be distinguished from known polling; live isolated OpenShell/browser/storage evidence is unavailable; or idle defaults cannot be chosen from measurement. Any such gap blocks T08 and the A04 preview claim rather than allowing a mock or longer polling window to stand in for activity.
