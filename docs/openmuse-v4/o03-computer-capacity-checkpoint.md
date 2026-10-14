# O03 — Bound private computer capacity: checkpoint

Issue #90 · ticket O03 · plan `docs/superpowers/plans/tickets/O03-computer-capacity.md` (openmuse worktree).
Worktree: `/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base`, branch `v4/openbot-exec`. No commits, per dispatch.

## Task 0 — citations (file:line, this worktree, 2026-10-13)

| Seam | Citation |
|---|---|
| Where a computer **starts** | `ComputerGateway.locate` → `provider.locate(botId)` — `server/src/computer/gateway.ts:342-344` (locate decl + the new reserve call); per-Bot start = the supervisor's `/computers/:botId/ensure` — `server/src/computer/supervisor.ts:209-222` ("starting it if it is not already up"). `locate` is the one call every acting path makes (`post` gateway.ts:374-390, `locateForAction` gateway.ts:400-406), so it is the capacity gate. |
| Active count | `provider.list()` — `server/src/computer/supervisor.ts:111-131` (GET /computers) / `provider.ts:96`; `ComputerLocation.status/startedAt` — `provider.ts:14-22`. |
| Where **workspace writes** land (F09's seam) | `ComputerGateway.writeFile` — `server/src/computer/gateway.ts:1262-1277` → `POST /files/write` (route `server/src/computer/routes.ts:728`) → agent-computer `workspace.write` (F09 checkpoint: `agent-computer/src/workspace.ts:332`, utf8 text, 1,000,000-byte `writeBytes` cap at `workspace.ts:95`). The only server write seam into a workspace (F09 Task 0). |
| Idle/holder state (K03's seams) | Control state: `ComputerControlState { holder, since, request.updatedAt }` — `shared/computer-control.ts:33-44`, readable via gateway `control(botId)` → `GET /control` (gateway.ts:872-878; K03: routes.ts:353-364). Run state: `ComputerLocation.startedAt` off `provider.list()` — read by listing, never by `/ensure`, which would wake every idle Bot (the constraint `supervisor.ts:189-194` states for `sessionOf`). Workspace persists on stop: the provider's own stop semantics (supervisor stop keeps the container volume, `supervisor.ts:243-248`; shared stop keeps state, `provider.ts:240-248`). |
| Disk usage seam | **None**: `ComputerProvider` (`server/src/computer/provider.ts:82-121`) exposes no usage/du method → per the plan's failure clause, the disk cap counts **recorded byte totals** through the write seam, approximation recorded (see below). |

## The deployment-wide-cap reading (§10 row 1, recorded)

§10's row 1 ("Active private computers · Maximum 20") lives under "Reference deployment configuration" for the 1–20 active-user profile whose goal (user story 42) is "one user's work cannot exhaust the installation": the bound belongs to the **installation, not the user**. So the cap is a **global deployment-wide count over `provider.list()`** — every user's running computers share it, and the 21st start (whosever) is refused. Cross-user effects run one way only: other users' computers count against the shared cap, but no other Bot's identity or workspace content crosses to a refused caller (the error names the count and the env, never a Bot), and workspaces stay per-Bot by provider isolation (`provider.ts:61-66`).

## What changed

| File | shasum (sha256) | Change |
|---|---|---|
| `server/src/computer/capacity.ts` | `e26bb4b6…c8f81a0` | new: `computerCapacity` limiter — `reserve` (deployment-wide active-count check + sweep-on-contention before refusal), `sweepIdle` (idle stop, consults run/control seams), `chargeWrite`/`resetUsage` (per-Bot disk budget); typed `ComputerCapacityError` (code `computer_capacity_exceeded`) and `WorkspaceQuotaError` (code `workspace_quota_exceeded`); envs `OPENMUSE_MAX_ACTIVE_COMPUTERS`/`OPENMUSE_COMPUTER_IDLE_MINUTES`/`OPENMUSE_COMPUTER_DISK_GIB` default 20/15/2 |
| `server/tests/computer-capacity.test.ts` | `0df8b823…efe70226` | new: §10 matrix with fakes (21st/20th/freed-slot+sweep, idle 16/14min, human-hold/control/run clock resets, quota over/under/per-Bot/reset, cross-user global count + no-displacement, env defaults) — 15 tests |
| `server/src/computer/gateway.ts` | `f23140de…d0c4712d` | minimal wiring: `options.capacity?` (absent → built from provider, so index.ts needs no change); `locate` reserves before `provider.locate`; `writeFile` charges inside the govern closure (quota refusal lands an audited failure row, no write sent); `resetComputer` resets the disk budget with the wiped workspace |
| `server/src/computer/routes.ts` | `106071fe…a99b1fa` | typed surfacing: `statusFor` → 503 (capacity) / 413 (quota); `errorBody` carries the stable `code` |
| `scripts/openmuse-v4-baseline.sh` | `9e183e78…f032b9f4` | comments only: the three OPENMUSE_* envs documented in `baseline_env` (documented not set — a single-user baseline never contends them; no new service) |

## Design notes (recorded readings)

- **Idle-stop trigger is contention, not a timer**: the sweep runs inside `reserve` when the cap is full (and is exported for direct use). §10 row 2's "15 minutes without run or human control" is enforced the moment it matters — the 21st start frees idle computers before refusing — with no background service, per the plan's "(no new service)".
- **Run activity = a gateway action**: every action of a Bot locates, and `reserve` records the touch; the sweep takes the latest of run-start (`startedAt`, read from the list), the touch, `control.since`, and `control.request.updatedAt`. A held human lease (`holder === "human"`) is never swept, however long held.
- **Fail open, hold what it can answer**: if `provider.list()` is unreadable the start is admitted with a warning (a capacity bound must not become a new way for every action to fail while `/ensure` still answers); the refusal itself always throws.
- **Disk approximation** (per the plan's failure clause): no provider du seam exists, so the cap counts bytes written through the gateway seam only (`writeFile` today; F09/attachment transfers when they wire) — not browser downloads or shell-created files inside the container — and over-counts a charged write that later fails. Both errors are conservative for a bound. In-process per replica, like the supervisor's session map.
- **Recursion is closed**: the sweep's control consult rides the gateway's own `GET /control`, which locates first; that locate reserves a Bot the list already shows running, and a running Bot's reserve is an early pass that cannot re-enter the sweep.

## Verification

```
server: bun test tests/computer-capacity.test.ts tests/stream-auth.test.ts
                tests/control-lease-routes.test.ts tests/ready.test.ts
  32 pass / 0 fail
agent-computer: bun test tests/control-lease.test.ts
  10 pass / 0 fail
server seam regressions (computer-routes, computer-gateway, handoff-contract,
  human-input, download-routes, exec-timeout, fleet-route):
  126 pass / 0 fail (78 pass / 0 fail re-run after biome format)
typecheck: server `tsc --noEmit` — 0 errors in this ticket's files; remaining errors are
  in src/openmuse-deletion/ + openmuse-connectors (D03 concurrent worker's untracked files)
biome: `bunx biome check` clean on all 4 touched TS files (after --write format pass)
bash -n on the baseline script: clean
```

RED was recorded before GREEN: `tests/computer-capacity.test.ts` → 0 pass / 1 fail (module missing) before `capacity.ts` existed; after GREEN, 15 pass / 0 fail.

## S42 (live card) — deferred

S42 ("Start 20 private computers; request a 21st; …exceed a Bot's 2 GiB disk limit; advance 15 idle minutes") is the deployment-level acceptance card: it needs the live baseline stack with a real supervisor and 20 running computers. This ticket's proof is the unit matrix at the limiter seam plus the wired gateway/routes; the live-card run belongs to acceptance signoff (as with F-CONTROL-1 for K03).

No commits made.
