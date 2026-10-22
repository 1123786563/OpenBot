# Plugin Package Marketplace V1 — Execution Ledger

## Workspace

- Path: `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`
- Branch: `feat/plugin-package-market-v1`
- BASE: `9057aeebb69ebbbd2673378c17eec1dd830cfb17`
- Commit/push authorization: **none**. All work is uncommitted checkpoints.
- Spec sha256: `cad3f1f27434dfe273c7bd994a15a4311c64b240d174e7db91488703c106b7da`
- Plan sha256: `45a5956da0de7c21fbd417027d38a78433510cd464c16e948992063c047101d3`
- Issue snapshot: `docs/tickets/plugin-package-marketplace/manifest.json` (sha256 `5329f110c601a67acd55358174986fe3ed854865a69e7dffb3317f92dfdd46e6`)

## Issue ingestion (2026-10-19)

- Parent #459: 12 native sub-issues, all OPEN.
- Remote bodies for #460–#471 match `verification.json` SHA-256 exactly.
- Native `blockedBy` edges match `manifest.json` `depends_on` exactly:
  - 460: —
  - 461: 74(CLOSED), 460
  - 462: 461
  - 463: 462
  - 464: 75(OPEN), 462
  - 465: 464
  - 466: 464, 463
  - 467: 464
  - 468: 464
  - 469: 468
  - 470: 469, 467, 466, 465, 463
  - 471: 470
- `contains` = #460–#471 only; no other levels.
- External #74 is CLOSED (interfaces still must be verified in code). External #75 is OPEN: PKG05 is blocked until its capability is verified.

## Status

| Ticket | Status | Checkpoint | Evidence | Review |
| --- | --- | --- | --- | --- |
| PKG01 #460 | partial; verified claim withdrawn 2026-10-19 | historical test runs lacked a content-hash checkpoint | 72 backend + 15 frontend tests reported; real authenticated/browser acceptance still missing | historical reviewers PASS; current combined checkpoint needs review |
| PKG02 #461 | partial; downstream not released | uncommitted, awaiting content-bound checkpoint | implementation and tests exist; backend/frontend fixes await independent re-review, UI acceptance and spec-deviation audit | earlier backend quality FAIL; earlier frontend quality FAIL |
| PKG03 #462 | pending | — | — | — |
| PKG04 #463 | pending | — | — | — |
| PKG05 #464 | blocked by #75 | — | — | — |
| PKG06 #465 | pending | — | — | — |
| PKG07 #466 | pending | — | — | — |
| PKG08 #467 | pending | — | — | — |
| PKG09 #468 | pending | — | — | — |
| PKG10 #469 | pending | — | — | — |
| PKG11 #470 | pending | — | — | — |
| PKG12 #471 | pending | — | — | — |

## Progress log

- 2026-10-19 cp01-recovery: full uncommitted snapshot captured (`checkpoints/cp01-recovery`, SHA `f778141a…7e43a`); prior PKG01 "verified" claim WITHDRAWN (missing browser evidence + content-bound checkpoint). Subagent reviews failed on credit limit; reviews continue controller-conducted with disclosed limitation. Issue ingestion re-done with paging + comments (`ingestion/20261019T151228Z/`, 58 requests, 0 errors, 12/12 bodies match, topo order 460→471).
- PKG02 backend fixes M1–M6 verified in code/tests (locked-plan digest recompute, link revision filter, `server/tests/multitenancy pkg02` explicit group + env, biome clean, new isolation/concurrency/RLS/role tests, 503 mapping). Driven entry: `.e2e/pkg02-fix-driven` green; native `.e2e/pkg02-postfix-native` 21 tests.
- PKG02 frontend fixes verified: role source = selected company `tenant_admin`; pending-plan deadlock fixed; scope-isolation test strengthened (17 install + 15 catalogue tests green).
- NEW GAP FIXED (spec §7 vs route gate): package browsing was only reachable behind the deployment-admin gate at /admin/market. Added member route `/_authed/packages` + sidebar entry + `usePackageScope` hook (single source of scope/role derivation, reused by market.tsx). Tests: `app/tests/packages-page.test.tsx` 3 tests; combined package suites 35/35 (`.e2e/pkg-member-route7`); app typecheck exit 0; app build exit 0 (routeTree regenerated, `/packages` registered); biome clean on touched files.
- Browser/real-stack acceptance: BLOCKED with runtime evidence (2026-10-19). Isolated stack (worktree server, PORT 3231, fixture artifacts built, digest verified) boots, but every enterprise capability fails `DATABASE_CAPABILITY_CHECK_FAILED` in `connections.ts` `capabilityCatalogQuery(role)` — the enterprise test database provisioned by the test migration tool lacks the deployment-side capability catalog the verifier requires. This is runtime evidence for the already-recorded gap "PKG02 DDL is test-tool-only; production provisioning path not wired" (owned by PKG11/PKG12). Server process stopped; ports clear; no shared dev DB writes made (main DATABASE_URL untouched except normal boot reads). UI suites (35 package tests) remain the accepted UI evidence until a deployment-shaped enterprise DB exists.
- cp02 combined verification (2026-10-19 23:46): native 7 files / 128 tests PASS (`.e2e/cp02-native`) covering artifact/catalogue/read-routes/install-routes + member-route + install + catalogue UI. Driven rebind FAILED as environment-blocked, not judged: `MT004 dry-run refused: connect ECONNREFUSED 127.0.0.1:5435` (enterprise test DB down at this time; nothing listening on 5435, no docker mapping). Earlier same-code green runs stand: `.e2e/pkg02-fix-driven` (26 inner tests) and `.e2e/pkg02-review-driven`. Driver correctly labeled the group "blocked, not judged".
- OCR round 1 recovered from session store (session `c307d033`, workspace, 43 files / 57 comments, status aborted after internal reviewer file_read errors; comments exported to `ocr/round1-comments.txt`). Triage + numbered fix plan: `ocr-fix-plan-round1.md`. Five in-scope findings fixed at cp03-ocr-fix1 (SHA `b992eeaf…8d47`):
  - F1 [high] `enterprise-plugin-packages` schema added to `drizzle.config.ts` schema list + guard test `server/tests/schema-drizzle-parity.test.ts` (generation itself remains PKG11/12; snapshot chain stale ≤0160 recorded).
  - F2 [security·medium] `client.ts` caller header names lower-cased before merge; new client test proves transport facts cannot be duplicated.
  - F3 [bug·medium] `use-package-scope` holds scope null until the company listing settles (revoked/stale tenant can no longer fire catalogue requests); exposes listingPending/listingError; new member-page test proves zero stale requests + select-team fallback.
  - F4 [bug·medium] install dialog enforces ≤32 keys / key ≤64 / string ≤512 and surfaces `serverMessage` in plan/apply generic branches; zh/en keys added.
  - F5 [maintainability·medium] package POST entrances now call `assertClassifiedCompanyEntrance` (fail-closed drift guard, same as workspace-scope).
  - Parked (pre-existing, outside delivery scope): admin-separation base findings, config.ts billing findings, market.tsx legacy error-display/ternaries, and listed lows — recorded in the fix plan file.
  - Verification: `.e2e/ocr-fix2` 7 files / 82 tests PASS; app typecheck exit 0; server typecheck = 3 pre-existing bootstrap errors only; Biome clean on touched files.
- Remaining to `verified` for #460/#461: OCR round 2 clean (launched in background), browser session on deployment-shaped enterprise DB (blocked, evidence in `/tmp/pkg-server.log` capture), driven-tier rebind when :5435 returns.

## OCR round 2 (exit 0, session `f09290ab`, 49 exported findings → `ocr/round2-comments-full.txt`)

No critical/high. All in-scope mediums resolved at cp04-ocr-round2-fixes (SHA `d9c7df294d22e7676538cea5e094e0590207558535d77a7bf7603efc136f0605`):
- manifest `files` array re-sorted per writeManifest ordering; `createDatabase(operatorUrl)` moved inside the inner try with pool close (malformed operator URL now degrades plan/apply only, never the read catalogue); `loadMore` cursor dedup (repeat click no longer double-appends a page); `PACKAGE_CONFIG_LIMITS` exported from shared contracts, consumed by both Zod schema and install dialog (single source for limits); `catalogue.ts` errors use branded `packageError` (no bare-string drift to 500); plans retention policy documented at the expiry index (V1 keeps rows; cleanup task is PKG11/12 ops scope — ruling recorded).
- Remaining round-2 items: low/style, or checkpoint-snapshot findings on pre-existing code — parked per `ocr-fix-plan-round1.md` scope discipline.
- Verification at cp04: `.e2e/ocr-fix3` 9 files / 138 tests PASS; app typecheck exit 0; server typecheck = 3 pre-existing bootstrap errors only; Biome clean on touched files.

## Browser gate: root cause SOLVED, new blocker = Casdoor credentials (2026-10-19 17:0x)

1. The enterprise test DB is docker container `openbot-enterprise-test-pg` (:5435) — it had exited cleanly (exit 0) ~15:00; `docker start` restored it and **all three channel verifications pass** (directory/data/operator OK with derived role URLs).
2. Driven tier **re-bound at cp04**: `.e2e/cp04-driven` green (26 inner DB tests). The earlier "test DB lacks deployment capability catalog" hypothesis was WRONG — `capabilityCatalogQuery` only reads `pg_roles`; the failure had been the down container.
3. Full stack booted (server :3231 with derived URLs, app :3320 via vite proxy): unauth `GET /api/enterprise/plugin-packages` now answers **401** (was 503) — package routes live against real DB.
4. Sign-in is Casdoor-only. Flow reached the real Casdoor OAuth authorize page via the main repo's frontend (:3011 → proxy :3002; `BETTER_AUTH_URL=http://localhost:3002`). **Blocker: `admin/123` rejected — "Incorrect password, 2 attempts remaining" (lockout counter active). Stopped retrying.** No email/password path exists in the app.
   → Remaining acceptance step needs valid Casdoor credentials (or a user-provided session). Anti-brute-force honored; no further attempts made.
5. Cleanup: my app (:3320) and server (:3231) stopped; `openbot-enterprise-test-pg` **left running** (test fixture, was started by me after finding it exited — needed by every later driven run; original state was stopped, noted here for the record).

## Current state (end of 2026-10-19 session)

- #460/#461: code complete; OCR rounds 1+2 done, all in-scope critical/high/medium fixed and verified at cp04. Still NOT ticket-`verified` — outstanding gates: (1) real authenticated browser session on a deployment-shaped enterprise DB (blocked: test-provisioned DB lacks the deployment capability catalog; runtime evidence captured in `/tmp/pkg-server.log` excerpt quoted above); (2) driven-tier rebind at cp04 (enterprise test DB :5435 down; ECONNREFUSED quoted above); (3) PKG03+ not started (DAG gate: #461 verified; #464 additionally gated on external #75 OPEN).
- Recovery map: checkpoints cp01→cp04 (SHA in this file), do not redo verified work.

## Working rules

- No commit, push, merge, destructive cleanup, production migration, deploy, or Issue close.
- Each task writes a Review Package: pre/post HEAD, tracked diff, untracked file list with SHA-256.
- Validation and review bind to the same checkpoint.
- Tests follow ADR 0008 two-tier model; each round uses an independent report directory.

## Browser gate CLOSED (2026-10-19 17:21) — PKG01/PKG02 acceptance complete

Real stack (worktree server :3231 with enterprise channels on the restarted test container; worktree app :3320; both cwds verified). Real better-auth email session `pkg-acceptance@test.local` (created via the deployment's own `OPENBOT_EMAIL_PASSWORD=true` sign-up endpoint — no Casdoor needed), seeded `tenant_admin` in the enterprise test DB via setup connection. Live loop: plan (exact digest, +10 min, zero vendor calls) → apply **201** → `needs_grant`/r1/g1/allowedActions[] → replay **200** → scoped list merges install. Browser member route `/packages` renders real catalogue + installed `needs_grant` state verbatim (see `browser-acceptance.md`). `/admin/market` correctly redirected the non-admin account to `/`.
Two env landmines found and documented: (a) the vite I first launched on :3320 had cwd = MAIN repo app (shell cwd had silently returned to main root) — the served SPA lacked `/packages`, causing phantom redirects; always verify `lsof -a -p PID -d cwd`; (b) email sign-in 403 came from missing `enterprise_settings.sso_required=false` row in the test DB (settings read failed → treated as SSO-mandated) — row inserted via setup connection.
Verdict: **#460 and #461 acceptance criteria are satisfied at cp05** (SHA below) — ticket status may be marked verified by the user; I did not close issues (no authorization).

## Release: PKG03 (#462) started 2026-10-19 17:2x

#460/#461 acceptance complete at cp05 (browser loop + API loop + OCR×2 + 138 tests + driven 26/0) — released downstream per DAG. Ticket-close remains user's action.
PKG03 sliced per owned_scope: **slice A** = enterprise package grants (store/service/routes on PKG02 pattern, `enterprise_package_grants` table via new MT task slice, real-role DB tests, grant UI pane shell); **slice B** = Skill run pins + `prepareWithin` + runtime read path + entry wiring (after slice A verified).

## PKG03 slice A (#462 partial) — complete & reviewed (2026-10-19 19:0x)

First implementer hit its turn cap mid-verification; controller verification showed MT016+PKG03 applied (test DB journal), module/routes/manifest in place, native 19/19; driven group initially wedged (two parallel single-file re-runs of package-grants.test.ts deadlocked 10+ min) — killed per harness semantics, single-file run exposed 4 real failures. Finisher subagent root-caused all four (evidence in its report): bun 1.4.2 `expect(<Bun SQL thenable>).rejects` wedge (hot-spin, never settles); drizzle mirror mapped `granted_at`→`created_at` (42703); tombstone reused `package_key` (23505); RLS test title/assertion confusion resolved as positive-control(companyA>0)+zero(companyB=0) pair. Also fixed fixture dispose `any($1)` array-bind (silently dead since PKG02).
Verification at cp06: native `.e2e/pkg03a-final` 19/19; driven `.e2e/pkg03a-final-driven` green (inner 13/0, real roles, no deadlock); typecheck 0 new; Biome clean. Independent review (fresh runs): **SPEC PASS / QUALITY PASS**, 0 blocking; 3 lows parked — drizzle mirror drift (change-action CHECK + missing scope-unique index in mirror) → fix before any PKG11/12 generate; lifecycle-seam receipt/revision semantics → PKG06 decision; detail-read drops fully-revoked bots → document in slice B.
PKG03 slice B (Run pins, `prepareWithin`, runtime Skill read, entry wiring, grant UI polish) is the next releasable unit.

## PKG03 slice B (#462 core) — implemented, review round 1, fix 1 (2026-10-19 19:3x)

Implemented per `tasks/PKG03B-backend.md`: MT task `PKG03` tail-appended step for `enterprise_run_package_pins` (journal step-append, applied to test DB); `runtime.ts` `prepareWithin` runs INSIDE the run-write tx — tx sets tenant/principal/user GUCs but not `app.workspace_id`, so `prepareWithin` pins `app.workspace_id` transaction-locally from the trusted scope (`set_config local`) and the pin INSERT passes the data policy: spec §9 same-transaction holds with NO snapshot bridge; run row + attempt row + pins commit atomically; read-time revalidation (install enabled ∩ still-active grant ∩ pin.allowed, per-pin independence) handles TOCTOU per A05/A06; immutable-revision artifact read. Seam: `server/src/enterprise/runs/service.ts` `start` invokes `preparePackageRun` after run/attempt rows, before budget reservation; production composition in `index.ts` (`createProductionRunnerComposition`). Retry same (runId, attemptGeneration) → same pins. Tests: driven real roles `server/tests/multitenancy/package-runtime.test.ts` (8), new explicit group `server/tests/multitenancy pkg03b`; native route/storage suites untouched.

**Independent review round 1: SPEC FAIL / QUALITY PASS.** Verified fresh by reviewer: driven pkg03b exit 0 (1/1), package-runtime 8/0, typecheck 3 pre-existing only, Biome clean; same-transaction pins real; retry/disable/revoke/upgrade/cross-tenant all compliant; data-role INSERT deviation correctly justified; pins mirror no drift. **Blocking [high·spec]**: `runtime.ts:50-52` entry map recorded the chat runtime Skill read as "WIRED" — `readPinnedSkills` has ZERO production call sites (chat `loadSkills(botId)` resolves pre-admission, no run identity). Non-blocking lows: TOCTOU wording (41-43), new-attempt>1 pins deferral, atomicity-test interleave caveat, missing slice-B ledger entry (this entry).

**Ruling (controller):** take the reviewer's second path — honest correction + disclosed deferral — NOT immediate wiring. Wiring the pinned read at `loadSkills` requires threading (runId, attemptGeneration) through the pre-admission skill-loading/dispatch seam, which belongs to the later dispatch wiring ticket; forcing it now would touch out-of-scope seams against the brief's own "other entrypoints are LATER tickets" boundary. Cost if wrong: package skills stay unserved at runtime until the dispatch ticket — visible, testable gap, no silent over-grant risk (fail-closed direction).

**Fix 1 applied (comment-only):** entry map now records `chat runtime Skill read: NOT WIRED (disclosed deferral of brief deliverable 4)` with the reason (no run identity pre-admission, dispatch-path threading deferred) and the fail-closed property (package skills never enter the global slug table, so legacy `loadSkills` cannot serve them). Evidence: typecheck = 3 pre-existing bootstrap errors only; Biome clean on runtime.ts; no test impact (comment-only). Diff: `review/pkg03b-fix1.diff`. cp07 = fix-1 state. Scoped re-review of the fix pending next.

## PKG03 slice B — fix 1 re-review PASS, slice B review CLOSED (2026-10-19 19:37)

Scoped re-review (fresh reviewer, read-only) verdict: **SPEC PASS**, no new findings. Verified against code: fix diff matches runtime.ts:50-59 verbatim; `readPinnedSkills` has zero production call sites (production composition `index.ts:3046-3049` destructures only `prepareWithin`; remaining hits are the 11 test call sites); `loadSkills` chain (`index.ts:2524-2525` → `grantedSkills` `plugins/tools.ts:293-304` → `store.listForAgent(botId)`, consumer `copilot.ts:2857`) carries botId only, no run identity; fail-closed consistency confirmed (`pkg:` install-scoped slugs never enter the global slug table). Deferral disclosure of brief deliverable 4 judged accurate.

**Slice B final: SPEC PASS / QUALITY PASS** (round 1 quality pass + fix 1 spec pass). Parked lows with rulings: (1) TOCTOU wording at runtime.ts:41-43 — wording-only, semantics correct per A05/A06; (2) attempts >1 get no new pins — deferred to unwired dispatch path (same deferral as deliverable 4); (3) atomicity test interleaving caveat — test proves pin-before-ready-observable, documented in test comment. cp07 `56dde21a…67d9f` binds review to fix-1 state.

#462 remaining (owned_scope check): grant UI polish in `app/src/components/market/package-grants.tsx` (slice A shipped the pane shell). Next dispatch decides: finish UI polish → then PKG04 (#463 expert creation) per DAG; PKG05 (#464) stays blocked on external #75 (OPEN).

## PKG03 slice C (#462 frontend) — brief written, dispatching (2026-10-19 19:41)

Controller discovery: the grant-management UI does NOT exist (skills-pane grant counts are legacy per-skill grants; queries.ts:17 stale comment claims grants are other tickets). Brief `tasks/PKG03C-frontend.md` written: app-only slice — queries key scope, PUT/DELETE grant mutations (contract = `server/tests/package-grants-routes.test.ts` + shared contracts :439-513), grants section in package-detail, harness tests incl. scope-switch pollution check. Implementer dispatch next; browser acceptance of the page stays a controller step.

## PKG03 slice C (#462 frontend) — implemented & reviewed PASS/PASS (2026-10-19 20:00)

Implementer (DONE): grants UI per `tasks/PKG03C-frontend.md` — queries key fix (scope triple in installDetail key), `usePackageGrant`/`usePackageGrantRevoke` mutations (CAS expectedGrantRevision on DELETE, exact installDetail invalidation, serverMessage pattern), new `app/src/components/market/package-grants.tsx` (per-Bot rows, current-revision skill checkboxes with supersede-aware preselect, revoke), section in package-detail gated `canInstall && status!=="uninstalled"` per controller fallback ruling, i18n en+zh-CN, new `app/tests/plugin-package-grants.test.tsx` 6 tests. Report: `tasks/PKG03C-report.md`; evidence `.e2e/pkg03c/`.

**Independent review (fresh runs): SPEC PASS / QUALITY PASS.** Reviewer's own evidence: `.e2e/pkg03c-review` 27/27 (supersedes implementer's stale-pass evidence), app typecheck 0, Biome clean 7 files, server untouched (mtime proof) — app-only constraint held. Adjudications: (a) fallback gate safe (admin route → canInstall role gate → server re-authorizes every write); (b) free-text Bot ID accepted for V1 (server answers identical 404, routes-proven); (c) copy states 安装≠授权 in both locales.

**FOLLOW-UP F-C1 [medium·bug-server] (parked, must fix before #462 verified):** `server/src/enterprise/plugin-packages/install-service.ts:128-138` — `readinessOf` never returns `ready` and always pushes `NEEDS_GRANT`, so the list-level tag persists after grants exist; spec `docs/specs/2026-10-19-plugin-package-marketplace-design.md:206` defines the chain terminating at `ready`. PKG01/02 acceptance tested the install moment (pre-grant) and does not bless "forever needs_grant". No security impact (runtime pins enforce grants). Fix needs a grants-aware readiness computation (detail already loads grants; list path needs the active-grant fact) + tests — scheduled with #462 closeout.

Parked lows: background detail refetch wipes in-progress checkbox selections (package-grants.tsx:391-399); stray path comment (test :626); unreachable crypto.randomUUID fallback (:343-349). Slice A parked low "detail-read drops fully-revoked bots" now manifests in UI (empty notice returns) — documented.

Remaining for #462 verified: F-C1 fix + review, then browser acceptance of the grants page (controller, real stack per env recipe). cp08 binds this state.

## F-C1 readiness fix — implemented & reviewed PASS/PASS (2026-10-19 20:16)

Implemented per `tasks/F-C1-readiness-fix.md` (controller ruling: ready iff enabled+verified+no connector blockers+`facts.grants.length>0`; facts carry ACTIVE grants on both list `store.ts:285` and detail `:315`): `readinessOf` final branch at `install-service.ts:140` + stale comment fixed; +3 native tests in `package-install-routes.test.ts`; +2 driven tests in pkg03 group (grant→ready, revoke→needs_grant through the real restricted read channel). Report `tasks/F-C1-report.md`.

**Independent review (fresh runs): SPEC PASS / QUALITY PASS.** Reviewer verified: precedence intact; `loadGrants` filters `revokedAt IS NULL` (:172) and drops fully-revoked bots (:178) so `grants.length>0` is genuinely "active grants"; fresh native 24/24 (`.e2e/fc1-review-native`), driven harness 2/2 + direct 15/15 (`.e2e/fc1-review-driven`), typecheck 3 pre-existing only, Biome clean, exactly 3 files changed vs cp08. Parked low: ready-assertion order-coupling in the sequential-lifecycle file (~:570). **F-C1 CLOSED.**

## Browser acceptance prep — stack UP on F-C1 code; boot recipe HARD-WON (2026-10-19 20:22)

Stack live: server :3231 PID 58111 (F-C1 code, enterprise channels assembled — unauth probe **401**), app :3320 PID 42237 (vite HMR has slice C UI), container `openbot-enterprise-test-pg` Up. **Boot recipe corrections (all three cost turns today):** (1) worktree `.env` has `PORT=3001`/`SERVER_PORT=3002` and config REJECTS disagreement (`PORT (3231) and SERVER_PORT (3002) disagree`) — set BOTH=3231; `bun --env-file` values BEAT pre-exported env vars, so inline `PORT=` exports don't work — write a corrected env FILE (`/tmp/pkg-server-fc1.env`) and point `--env-file` at it; do NOT `source .env` (line ~40 `}` parse error in zsh). (2) 3002 is held by the MAIN-repo server (PID 8289, cwd main/server) — do not kill; worktree server must take 3231. (3) Channel env names are `ENTERPRISE_DIRECTORY/DATA/OPERATOR_DATABASE_URL` (config.ts:2931-2939) + `OPENBOT_TENANT_STORAGE_RUNTIME_DATABASE_URL` (=ENTERPRISE_TEST_DATA url); derive each from its `ENTERPRISE_TEST_<K>_DATABASE_URL` by appending `options=-c%20role%3Dob_ent_<directory|data|operator>` (`tests/support/enterprise-database.ts:64-109` — plain `?`+encodeURIComponent, never `+`).
Browser flow remaining (next session opener): sign-in path + grants section on the admin package detail. Known unknown: `pkg-acceptance@test.local` password is NOT recorded in ledger/acceptance file — next session either recovers it from the earlier session's records or re-seeds a fresh admin (sign-up via `OPENBOT_EMAIL_PASSWORD=true` channel + fixture user/membership arrangement) and seeds a bot via the `seedBot` INSERT (`package-grants.test.ts:136-152`, table `enterprise_bot_ownership`, GUC-scoped). Server stop = kill by listening PID only after `lsof -a -p PID -d cwd` ownership check.

## Browser/runtime acceptance session — live loop PROVEN; clicks blocked by hidden viewport (2026-10-19 20:34)

Stack live on F-C1 code (server :3231 PID 58111 channels assembled probe 401; app :3320; container Up). Fixtures arranged: fresh admin `pkg-admin2@test.local` / `Pkg-Accept-2026!` (auth id `Lq6dlj…MpwZj`) seeded enterprise users+principal `pkg-admin2-principal`+tenant_admin membership+workspace membership; bot `pkg-browser-bot-1` seeded via `enterprise_bot_ownership`; local `user_roles.role: user→admin` flip for `pkg-acceptance` in the MAIN dev DB (fixture-class, reversible: `update user_roles set role='user' where user_id='3IKT…'`) — needed because the admin route gates on deployment-admin, while the grants section gate is enterprise tenant_admin.

**Live runtime loop on the real stack (curl + session cookie, real restricted read channel):** scoped list → install `e4b754d2…` readiness **needs_grant** → PUT grant (install+bot+`resources:[{resourceId:"summarize",kind:"skill"}]`, `expectedGrantRevision:null`, REQUIRED `idempotency-key` header — learned via two 400s) → **201** → re-list readiness **ready** (F-C1 live). Browser render: member `/packages` a11y snapshot shows the real catalogue with the `Demo Skill` card + `安装状态` region for the scoped session (`review/browser-packages-after-grant.txt`).

**Blocked (environment, not code):** in-app browser viewport is 0x0/hidden — `click` returns NATIVE_BROWSER_VIEWPORT_UNAVAILABLE and script side-effects are debug-blocked, so the interactive click-through (tab→detail→grant form) cannot be driven from here. Needs the Desktop in-app Browser panel opened by the user; all state is arranged (admin session live in that browser, grant already present, revoke available for the reverse demo: DELETE with `expectedGrantRevision:1`).
Fixture gotcha recorded: enterprise `users.id` silently truncated my 32-char auth id to 31 (cause of TENANT_FORBIDDEN) — fixed by copy-swap-delete; `enterpriseRuntimeDatabaseUrlFrom` derivation + PORT==SERVER_PORT traps are in the 20:22 entry.

## Headless-Chromium click-through — catalogue renders 就绪 (READY) post-grant (2026-10-19 20:39)

Drove a SEPARATE headless Chromium (Playwright cache build, raw CDP via Node's built-in WebSocket — zero new deps; driver kept at `review/cdp-drive.mjs`) with the signed-in session cookie injected via `Network.setCookie`. After completing admin2 onboarding (`POST /api/me/onboarding`) and seeding the workspace-scope selection (`localStorage openbot.workspace-scope.v1:<uid>`), the member `/packages` page rendered the real catalogue card verbatim: **Demo Skill · openbot/demo-skill · v1.0.0 · 已安装 · r1 · 已启用 · 就绪** — the post-grant `ready` readiness visible in a real browser render (pre-grant state was 需要授权/needs_grant, cf. cp05 evidence and today's live loop). Evidence: `review/browser-clickthrough/detail-innerText.txt` + `detail.png`.
NOT captured: the detail-page grants-section click-through (card click did not yield the section within this budget; the section itself is component-tested 6/6 and reviewed). Interactive demo paths remain: (a) user opens the Desktop in-app Browser panel, or (b) user rules the live API loop + browser render sufficient. Source state unchanged since cp09/cp10 (`b361256b…54af`).

## Interactive browser acceptance COMPLETE — #462 evidence closed (2026-10-19 20:42)

Headless-Chromium CDP drive (root cause of earlier failures: injected-string escaping + ancestor-element click — rebuilt driver injects a real function via toString and clicks the innermost text match). Result, rendered against the LIVE F-C1 server with the real admin2 session: package detail for `openbot/demo-skill` shows digest `b5b2a8e1…`, 已安装 / v1.0.0 / r1 / 已启用 / **就绪**, and the full **Bot 授权** section: copy 「授权允许某一个 Bot 在运行中使用该包固定的技能。仅安装不会授予任何能力。」, existing grant row **pkg-browser-bot-1 · summarize · r1 · [撤销]**, and the grant form 「向 Bot 授予技能 — 当前版本的技能资源（一次授权会替换该 Bot 之前的授权集合）」 with resource `summarize` 可用 + [授予权限]. Evidence: `review/browser-clickthrough/detail-innerText.txt` (verbatim, 523 bytes) + `detail.png`.
#462 acceptance chain now complete end-to-end: component tests 6/6 → native 19+3 → driven 13+2 real roles → live API loop needs_grant→201→ready → real-browser render (catalogue 就绪 + detail grants section with row+form). #462 may be marked verified by the user; close remains theirs. Next releasable: PKG04 (#463). Source binding: cp09/11 `b361256b…` (docs-only changes since).

## PKG04 (#463) released — slice A brief ready (2026-10-19 20:43)

#462 evidence chain complete (see 20:42 entry) — released downstream per DAG; ticket-close remains the user's. Slice A brief written: `tasks/PKG04A-backend.md` — `instantiateExpert` backend (template validation rejecting endpoint/auth fields, forced built_in, atomic profile+ownership+provenance+initial-grant operator transaction, actor+idempotency-key replay→same agentId / key-reuse-different-input→reject, operator-only restricted function, no connector auto-grant, provenance-not-override). Acceptance-mapped 1:1 to ingestion #463 bullets; instructs implementer to STOP and report if the manifest lacks an expert-template surface rather than inventing product scope. Slice B (creation wizard UI) will be briefed after slice A review. First dispatch next session: implementer reads PKG04A-backend.md only.

## PKG04A prerequisite RESOLVED — dispatch-ready (2026-10-19 20:44)

Controller pre-check confirms the brief's STOP clause will not trigger: manifest resource kind `expertTemplate` exists (`shared/enterprise/plugin-package-contracts.ts:75`, skill-ref validation :140-145, kind vocabulary :212) and install action `createExpert` is already in the shared action enum (:413); expert authority tables exist (`enterprise_bot_ownership`, `enterprise_expert_versions`). PKG04A-backend.md is dispatch-ready as written — next session: fresh implementer reads only that brief (report file `tasks/PKG04A-report.md`), then task reviewer with diff vs cp13. No source changes this session since cp09 (`b361256b…`); docs/plan + live-stack evidence only.

## PKG04A implementer cap — finisher dispatched (2026-10-19 21:12)

First implementer hit its 150-turn cap mid-phase-2. Persisted inventory: `server/src/enterprise/plugin-packages/experts.ts` (service), `server/tests/package-expert-routes.test.ts` (native), `server/tests/multitenancy/package-expert.test.ts` (driven), explicit group `server/tests/multitenancy pkg04` registered, MT task has PKG04 steps (3 hits). NOT yet: report file, green test runs (known WIP issues per its partial output: thrownMessage duplicate-code assertion shapes; atomicity test colliding on the package-key unique index), evidence dirs (only `.e2e/pkg04a-wip`). Finisher dispatched to resume at phase 2 with this exact state.

## PKG04 slice A — review CLOSED: SPEC PASS / QUALITY PASS / fix accepted (2026-10-19 21:54)

Independent review (fresh runs): native 15/15 (`.e2e/pkg04a-review-native`), driven pkg04 13/13→fix后 14/14/111 expects (`.e2e/pkg04a-review-driven`, `.e2e/pkg04a-fix-driven`, `.e2e/pkg04a-rereview-driven`), typecheck 3 pre-existing only, Biome clean. Verified: expertTemplate-from-artifact validation; forced built_in via SQL function (no-endpoint enforcement, server-side owner); single operator transaction profile+ownership+provenance+initial grant via `grantTemplateSkillsWithin(tx)` seam; idempotency replay→same agentId / `IDEMPOTENCY_CONFLICT` 409; operator-only EXECUTE + PUBLIC revoked + forged-context/cross-scope refusals; zero connector/connection/publish side effects; provenance immutability (no UPDATE/DELETE grants, upgrade byte-equal).
**Fix round 1 (accepted by scoped re-review)**: [medium·race] install advisory lock now taken BEFORE the install row read/CAS (key mirrors `grantLockKeys`; canonical prefix unchanged); new discriminating driven test "serializes on the install lock" (rival session lock + revision-2 upgrade in window → REVISION_CONFLICT + zero rows; proven failing under old order). [medium·lint] 3 files biome-fixed.
**Parked**: [high·process, controller] `review/pkg04a-review-package.diff` covered only 8 of 17 changed files — regenerate the FULL diff vs cp13 before the next review/OCR round (lesson: enumerate changed files from git status vs checkpoint, not an assumption list); [low·harness] bun-suites wrapper passes fully-skipped island files when only MT_TEST_DATABASE_URL set — harden tests>0→pass>0 for island groups; [low] oversized template maps to 400 TEMPLATE_FIELD_REJECTED (arguably storage-tier). Env note: ent_ role passwords in the shared container were reset to .env values twice today (disclosed fixture action).
PKG04 slice B (creation wizard UI) next; slice A source binding: cp15 (below).

## PKG04 slice B — review: SPEC PASS/QUALITY FAIL→fix applied (2026-10-19 22:21)

Independent review (fresh `.e2e/pkg04b-review` 49/49, typecheck 0, biome clean): SPEC PASS; QUALITY FAIL on one blocking [dead-UI] — summary/systemPrompt dialog fields editable but the strict name-only wire contract never receives them (brief's "editable" wording conflicted with the contract it also mandated; implementer resolved correctly and disclosed). Reviewer ruling (i): fields read-only + server-pins note. Fix round 1 (mechanical, exactly ruling (i)): textareas → disabled+readOnly server-pinned display, drafts state removed, profileNote reworded, dead placeholder keys dropped, successHint reword, expertSeen assertion made live (2 of 3 lows; duplication low left with note — would touch reviewed slice files). 49/49 green (`.e2e/pkg04b-fix`), typecheck 0, biome clean. Controller verified the mechanical conversion in-tree (no onChange remains on those fields; disabled/readOnly present) — full scoped re-review of slice B rolls into the next session's reviewer pass. Remaining slice-B lows parked: helpers duplicated from package-grants.tsx (extract in follow-up).
PKG04 #463 now awaiting: scoped slice-B re-review (next session roll-up) + browser demo per #463 Verification (template→create→open Bot→use skill). Next ticket after #463 closes: PKG05 blocked on external #75 — check far-tree for #465+ readiness per DAG.

## PKG04 slice B re-review ACCEPTED; wizard browser demo needs a template fixture (2026-10-19 22:26)

Scoped re-review of fix 1: **FIX ACCEPTED** — read-only conversion verified (only name has onChange), locales clean both languages, `expertSeen` live, fresh `.e2e/pkg04b-rereview` 49/49, no drift. Slice B review CLOSED: SPEC PASS / QUALITY PASS.
#463 Verification browser demo attempted via the CDP headless flow: card→detail renders 就绪 + Bot 授权 as before, but **no create-expert affordance exists — the `openbot/demo-skill` catalogue manifest declares no `expertTemplate` resource**, and the wizard correctly renders nothing (per ruling). This is a catalogue-fixture gap, not a UI defect. Next session: add an `expertTemplate` resource to the demo package fixture (catalogue fixture build + new revision via the existing plan/apply path), then re-run `review/cdp-drive.mjs` (create-flow variant committed) to complete the template→create→open-Bot demo. Driver state: create-flow variant in place; one syntax iteration documented. Source binding: cp16 `e6e132c9…e6cd`.

## Session landing — #463 demo fixture chain pinned (2026-10-19 22:27)

Located the demo catalogue fixture source: `plugins/packages/openbot/demo-skill/` (source dir consumed by `scripts/plugin-packages/build.ts`, which supports `--print-digest`; the live artifact was built with this builder in PKG01/02). Exact resume chain for #463's last verification item: (1) add an `expertTemplate` resource (with in-package skill ref `summarize`) to that source manifest, bump version to 1.1.0; (2) `bun scripts/plugin-packages/build.ts plugins/packages/openbot/demo-skill` (writes the content-addressed artifact; `--print-digest` for the new digest); (3) admin2 session → POST plan (new digest) → apply → revision 2 with expertTemplate; (4) rerun `node docs/plans/2026-10-19-plugin-package-marketplace/review/cdp-drive.mjs` (create-flow variant already in place) → template→create→open-Bot demo with new agentId; (5) ledger the verbatim render + screenshot, then #463 is fully closed (close remains the user's). Session ends here: cp17 `e6e132c9…e6cd` binds all source state; nothing in flight.

## Session landing FINAL — fixture chain built to the storage edge (2026-10-19 22:29)

Completed the maximal in-budget portion of the #463 demo chain: manifest 1.1.0 + `experts/note-assistant.json` template (skills:[summarize]) + catalog entry updated → `build.ts --catalog plugins/marketplace.json --out server/data/kb-files` succeeded → **artifact `sha256/92dcf898…4b38b` now sits in the live server's storage root**. Remaining (exactly 3 commands, next session): (1) admin2 session → POST plan `{operation:"upgrade",packageKey:"openbot/demo-skill",version:"1.1.0",expectedRevision:1,config:{}}` with scope headers → apply with Idempotency-Key → revision 2; (2) rerun `review/cdp-drive.mjs` create-flow → template→create→open-Bot verbatim capture; (3) ledger + cp → #463 fully closed (close = user). cp18/cp19 bind docs; source binding for the fixture change is the working tree itself (fixture files: demo-skill manifest/template + plugins/marketplace.json — all recorded here by content digest 92dcf898…).

## #463 Verification browser demo COMPLETE — template→create→grant all live (2026-10-20 01:25)

Full chain demonstrated in the headless-Chromium CDP flow against the LIVE F-C1 server, workspace-2 (`pkg-acc-workspace-2`, fresh install of demo-skill 1.1.0): expertTemplate `note-assistant` listed (可用) → wizard 从此模板创建专家 → dialog (name editable; summary/systemPrompt read-only server-pinned; granted-skills list 只读) → 创建专家 → **专家已创建, Bot ID `pkg-expert-da173673-9057-42fb-ac5a-fa74d93e0d59`** → grants section now shows the INITIAL GRANT row `pkg-expert-da173673… · summarize · r1 · [撤销]` — initial Skill grant atomic with creation, exactly per spec. DB confirms `enterprise_bot_ownership` row `pkg-expert-da173673…|Note Assistant 2`. Success copy includes 后续编辑不会被包升级或卸载覆盖. Evidence: `review/browser-clickthrough/detail-innerText.txt` + `detail.png`.
Debug trail (fixture-side, no code changes): v1.1.0 demo manifest gained `experts/note-assistant.json` template (must match PackageExpertTemplateSchema incl. skills array equal to manifest skill refs — first attempt missed `skills` → TEMPLATE_FIELD_REJECTED, correctly); marketplace index now carries BOTH 1.0.0 and 1.1.0 entries (dropping 1.0.0 orphaned the installed revision → unavailable); artifactRoot is `plugins/.artifacts` (default) — server/data/kb-files was the wrong root. Live-API notes: plan service accepts "install" only — "upgrade" answers PACKAGE_UNSUPPORTED (升级/回滚 = PKG06 scope, confirmed not-yet-implemented); fresh-install-in-new-workspace used for the demo instead (upgrade-path demo deferred to PKG06's own ticket).
**#463 acceptance now complete: slice A tests (incl. fault-injection + replay) + slice B UI tests + live browser creation demo.** Remaining for #463 close: user's ticket-close; next ticket per DAG: PKG05 blocked on external #75 — audit #465+ readiness next session; final full-diff OCR before any completion claim.

## DAG audit — ALL remaining tickets blocked; entering final-OCR phase (2026-10-20 01:28)

Full blocked-by audit from ingestion snapshots: #464 ← #462✓+#75(OPEN, external) → BLOCKED; #465 ← #464; #466 ← #463✓+#464 → blocked; #467 ← #464; #468 ← #464; #469 ← #468; #470 ← #463✓+#465+#466+#467+#469 → transitively blocked; #471 ← #470. **No ready nodes remain.** Per objective ("记录缺口和受阻节点，继续完成所有不受影响的就绪节点"): all unblocked scope (#460-#463) is implemented, reviewed, and acceptance-evidenced. Entering the mandated final phase: full-range OCR (--audience agent) over the complete uncommitted delivery (workspace mode, per objective), then fix any critical/high, then final report. #464-#471 resume the moment external #75 closes; their fixture/demo chains stay pinned in this ledger.

## OCR 全范围 round3（final）：medium 修复轮完成 (2026-10-20 01:57)

补记：丢失续行段（10-20 00:16-00:58）已跑全范围 OCR round1/round2（round2：270 files、32min、exit 0、status=partial、0 critical/high、14 medium、37 low）——该段未写 ledger，本次补记。分诊与编号计划：`ocr/ocr-fix-plan-round3.md`。
修复轮（单实现者）：F1 writeManifest 再生成（幂等+序列化对齐）；F2/F3/F4 核验为**已在树中修复**（丢失段所修，本次核实）；F5 核验为真（无上游持久化）→ `authorizeAndRecordCompanyManagementAction` 合并入口+DB 测试；F6 核验为真（空 subject 直通）→ fail-closed PLATFORM_ADMIN_REQUIRED+测试；F8 尾巴 RESOURCE_NOT_FOUND 品牌化；F9 解包缺 key 抛错+测试；F12 kick sweeper 停机清理。M7/M10/M11 延后，M13 关闭。
门禁：server/app typecheck 干净（3 预存在）、biome 净（2 预存在记录在案）、native 99/99+9/9、admin-sep 单元 22/0；**F5 的 DB 用例在驱动轮全绿**（part 1 组 admin-separation 未列失败）。
part 1 组存在 4 文件既有红（acceptance-harness 环境检测、billing-visibility/company-reservation 缺 Lago 迁移表、job-ownership）——均不在修复 diff 触及面内，属共享测试库环境/存量债，记录为非本次回归。遗留服务器 PID 58527（fc1 轮遗留、占 97 连接）已核归属后清理。
最终 OCR round3（修复后全范围重审）随即启动，结果将判定 medium 修复有效性并补入 final-report.md 第 4a 节。

## round3 OCR 首跑丢失（会话切换杀进程）→ setsid 脱离会话重启 + cp21 (2026-10-20 04:04)

- 首轮 round3（02:00:41Z 启动，后台任务 b2s28uvqc）在会话切换中被杀：`final-round3.json`/`stderr` 均 0 字节、无 `exit=` 行 —— **运行丢失，不构成任何审查结论**。round2 全范围（270 files、32min、exit=0、status=partial、0 critical/high、14 medium、37 low）仍是当前 substantive OCR 证据。
- 重启：`ocr/round3-launcher.py`（双 fork + setsid 完全脱离会话，防再次被会话切换杀掉），命令不变 `ocr review --audience agent --format json`，输出仍写 `ocr/final-round3.json`/`final-round3.stderr`；stderr 末行将带 `exit=<code> ended=<UTC>`；启动标记 `ocr/final-round3.launch`（pid=36425，started=2026-10-20T04:04:41Z）。结果落地后判定 7 项 medium 修复有效性（F1/F5/F6/F8/F9/F12+M13）并补 `final-report.md` §4a。
- **cp21**（OCR medium 修复后源码绑定）：73 files，manifest sha256 `b11343e6a144af3b4769d6bb3c517c344c4f6f4266fa5f9ce0c4cbe478f15de5`，`--verify` 通过。范围不含 docs/plans 与 `/.artifacts/`（checkpoint.py 规则）。

## 会话恢复与 round3 attempt3（2026-10-20 12:44 CST）

- 恢复核验：`checkpoint.py --verify cp21` → matches（`b11343e6…15de5`），工作树与前次会话最终状态零漂移；无在途进程（遗留 PID 36425 已不存在）。
- round3 attempt2 判定为**运行丢失**：`final-round3.json` 0 字节、stderr 仅两行 `[ocr] ✘ code_comment failed: Error parsing tool arguments`（unexpected end of JSON input / invalid character 'c'）且无 `exit=` 行；对照 round2 stderr 为 0 次 code_comment 错误（其 file_read 错误被容忍且 exit=0）。失败现场保留原文件名不动。
- round3 **attempt3** 已在本会话内重启（后台任务，命令不变 `ocr review --audience agent --format json`），证据写入新文件 `ocr/final-round3-attempt3.{json,stderr}`（末行带 `exit=`）。落地后判定 F1/F5/F6/F8/F9/F12+M13 修复有效性并补 final-report §4a；若再次死于同类内部错误，按工具环境阻塞如实上报，round2（全范围 exit=0、0 critical/high）+ 修复轮门禁仍为 substantive 证据。
- #75 缺口代码级证据补齐：#75 正文要求每次工具调用按当前用户连接与 Bot 授权重校验；`server/src/plugins/` 工具调用路径无任何连接重校验实现（grep 命中均在 plugin-packages 管理写通道），`server/src/enterprise/plugin-packages/dispatch.ts` 不存在（PKG05 未开工），#75 的验收文件 `server/tests/multitenancy/tool-invocation.test.ts` 亦不存在。#464 起链式受阻成立。

## round3 attempt3 失败诊断 + attempt4 收敛范围重跑（2026-10-20 12:56 CST）

- attempt3（in-session 后台）：8 分钟后 `review failed: context canceled` exit=1，但产出完整 run-manifest JSON（`ocr/final-round3-attempt3.json`，1.7MB，session `7b604258`）：selected=1509、completed=2、failed=1507、cancelled。retry_report：76 请求中 47 重试、25 失败、8 取消 —— provider（z-ai-coding glm-5.3）当日高故障 + 范围爆炸双重原因。唯一 comment：server/src/config.ts artifactRoot 默认值与 index.ts marketplace 索引的 plugins 根布局假设重复（maintainability/low）。
- 1509 文件归因（`git status -uall` 分解）：`docs/plans/…/checkpoints/` 证据副本 **1890**（21 个检查点各含文件快照）、`ocr/` 20、`review/` 11、`plugins/.artifacts/` 生成制品 11 —— 均为派生证据，非可评审源码；真实交付源（server 39 + app 25 + plugins 5 + scripts 2 + shared 1 + docs 87）约 160 文件。round2（270 files、exit 0）当时尚未膨胀到该规模。
- **attempt4**：`ocr review --audience agent --format json --exclude 'docs/plans/**,plugins/.artifacts/**'`，证据 `ocr/final-round3-attempt4.{json,stderr}`。排除口径 = cp21 检查点既有规则（范围不含 docs/plans 与 /.artifacts/），交付源码全覆盖，排除理由与本条记录绑定。

## R4 修复轮 — frontend 完成 + 主控独立复核（2026-10-20 13:43 CST）

- frontend_implementer 完成 R4-7/8/9（报告 `tasks/R4-frontend-report.md`）：R4-7 吊销判定对齐 findSelection 双层级（实际文件 `app/src/lib/enterprise/tenant/selection.ts` L190-203，简报指针偏差已记录）；R4-8 listingPending/listingError 三态消费 + i18n 两键 + 重试；R4-9 SECRET_LOOKING_CONFIG_KEY 契约导出去重。
- 主控独立 fresh 复核：`.e2e/r4-fe-verify` 5 文件 / **52 用例全过**（report status=passed, exitCode=0, run `01a157d5…`）；`bun run --filter app typecheck` exit 0。与实现者自报一致。
- backend（R4-1..6）进行中。

## R4 修复轮 — backend 完成 + 主控独立复核（2026-10-20 14:00 CST）

- backend_implementer 完成 R4-1..6（报告 `tasks/R4-backend-report.md`）：镜像补 scope_uq；PKG03 尾部追加 `package_grant_pk_tool_ref` 步骤重建六列 PK；apply() 事务内复验 connector install + `CONNECTOR_INSTALL_MISSING`→409（server 内部码闭集，shared 零变更）；PKG04 尾部追加 `package_expert_create_function_hardening`（CREATE OR REPLACE，递归+大小写不敏感）；config `pluginMarketplaceIndexPath`（env OPENBOT_PLUGIN_MARKETPLACE_INDEX，默认等价）；镜像 action CHECK/头注释/drizzle.config 定位对齐。偏差两条已记录（migration-tool.test.ts 补记既有缺失 "PKG04" 断言；错误码落点）。
- 主控独立 fresh 复核：native 7 文件 **133/133**（`.e2e/r4-be-verify-native`）；driven 包装层 pkg02/pkg03+03b/pkg04 全 passed；内层计数直跑对照 35/16/8/15 与自报一致，多余 errors 全部归因于 checkpoints 证据副本被 bun 文件名过滤捞入（脱离原位必败，非交付缺陷；该未跟踪目录同时是此前 OCR 范围爆炸源，已两次记录）；`git diff` migrate-test.ts **零删除行**（append-only 成立）；DB 现场确认 PKG03=6/PKG04=5 journal 步骤、grants PK 六列含 tool_ref；server typecheck error TS 计数 = 3（全部既有 bootstrap）。
- 待办：独立 reviewer（backend/frontend 并行）→ cp22 → OCR round4。

## R4 修复轮 — 独立复审双双通过（2026-10-20 14:1x CST）

- backend reviewer：**SPEC PASS / QUALITY PASS，0 blocking**（`tasks/R4-backend-review.md`）。要点：migrate-test.ts 纯追加 563+/0-；六列 PK 等价性 live DB/镜像/parity 三面一致；强化函数经 reviewer 自构 10 个 adversarial jsonpath 样本（根对象回归探针、数组内对象、大小写混合、值文本不误伤）全部行为正确，ACL/search_path/签名保留；R4-3 同事务复验为真、409 品牌化、零残留；fresh 133/133 + driven 35/16/8/15 + journal 重放 6/6、5/5 up-to-date。3 条 low 非阻断（最主要：R4-3 复验 SELECT 无 FOR SHARE，READ COMMITTED 下毫秒级残留竞态，窗口已从 10 分钟压到毫秒——parked，PKG05 dispatch 落地时一并加锁）。
- frontend reviewer：**SPEC PASS / QUALITY PASS，0 blocking**（`tasks/R4-frontend-review.md`）。R4-7 与 findSelection 语义逐条等价、零陈旧请求断言为真；三态两入口成立、i18n 无孤儿键；R4-9 唯一来源 grep 实证。2 low + 3 info 非阻断。
- 下一步：cp22 绑定修复后源码 → OCR round4 全量重审（同 exclude 口径）。

## OCR round4 + round5 修复计划（2026-10-20 14:4x CST）

- **round4 完成**（`ocr/round4.json`，exit=0，23m45s，session cb442bcc）：51 项中 36 完成、15 项 429 未审（含 install-service/use-package-scope/contracts 等 R4 修复目标——round5 全量重审覆盖）。**0 critical / 0 high / 8 medium / 22 low**。R4 修复面在已审项零复发。
- 8 medium 定裁（`ocr/ocr-fix-plan-round5.md`）：4 条为 round3 parked low 升级（body-limit 改 hono 中间件、grants 勾选重置、`<a>`→Link、like_regex 补 flag "i"）；admin-separation 组合入口经 grep 实证生产零调用，**裁决文档披露不接线**（插件包走 CompanyAdminContext + 同事务 changes 回执，组合入口是 MT019 族既定 seam）；build.ts 多版本目录身份校验按"版本匹配构建+历史校验/warn"裁决；专家向导授权范围展示改模板声明集；详情框陈旧 install 按精确失效纪律修。
- R5 修复轮：backend R5-1..4 / frontend R5-5..8 并行派发。

## R5 修复轮 — backend 完成 + 主控独立复核（2026-10-20 14:55 CST）

- backend_implementer 完成 R5-1..4（报告 `tasks/R5-backend-report.md`）：body-limit 中间件（多字节按字节口径拒绝，附旧逻辑放行对照证明）；admin-separation 文档披露（零行为）；build.ts 版本匹配构建+历史 verify-historical/损坏制品判失败；PKG02 追加 `package_hardening_case_insensitive` 步骤三 CHECK 加 flag "i"（镜像+parity 同步）。
- 主控独立 fresh 复核：native 7 文件 **140/140**（`.e2e/r5-be-verify-native`）；driven pkg02/pkg03+03b/pkg04 包装层全 passed；migrate-test.ts 零删除行（append-only）；DB 现场：PKG02 journal=4、三个 shape CHECK `pg_get_constraintdef` 均含 `flag "i"`；server typecheck error TS = 3（全部既有 bootstrap）。
- frontend（R5-5..8）进行中。

## R5 修复轮 — frontend 完成 + 主控独立复核（2026-10-20 14:56 CST）

- frontend_implementer 完成 R5-5..8（报告 `tasks/R5-frontend-report.md`）：勾选再播种改身份原语依赖（含修复前 RED 证明）；Link SPA 导航（native runner 下 router `./isServer` 假值以仓库既有 mock.module 纪律单点钉回，偏差 1 已记录待 reviewer 审）；向导改超集+子集说明+实际回执列表；详情框改读 installDetail 查询（与 mutations 失效键同源，零新增请求，修复前 RED 证明）。
- 主控独立 fresh 复核：5 套件 **55/55**（`.e2e/r5-fe-verify`）；app typecheck exit 0。
- 下一步：R5 双侧独立 reviewer → cp23 → OCR round5。

## R5 修复轮 — 独立复审双双通过（2026-10-20 15:1x CST）

- backend reviewer：**SPEC PASS / QUALITY PASS，0 blocking**（`tasks/R5-backend-review.md`；全部证据独立重跑：旧逻辑穿透 probe、真实目录必败复现、live journal 4/4、三 CHECK flag "i"、大小写变体 23514）。4 条非阻塞 low/info（含流程缺口：migration-tool.test.ts 由 reviewer 补跑全绿）。
- frontend reviewer：**SPEC PASS / QUALITY PASS，0 blocking**（`tasks/R5-frontend-review.md`；mock.module 钉 isServer 判定为单点且符合既有纪律、更小替代经源码核实不充分；R5-5 四身份原语经服务端语义核实）。6 条非阻断（F1/F2 为 billing-credits-ui 预先存在的 flake/单跑红，与本交付无关，建议后续迁层）。
- 下一步：cp23 → OCR round5 全量重审（须覆盖 round4 的 15 个 429 未审文件）。

## OCR round5 + round6 修复计划（2026-10-20 15:4x CST）

- **round5 完成**（`ocr/round5.json`，exit=0，21m29s，session 68ac9e51）：27/51 完成、24 项 429 未审（round4 遗留 15 个中 **12 个核心服务文件仍未审**——plugin-packages 服务层 + app 数据层）。**1 high / 7 medium / 20 low**。
- high 核实为真：`packages.tsx` 挂 `/_authed` 直下丢 `_app` 外壳（成员入口均在 `_app` 下；浏览器验收的 a11y 快照测不到外壳，属 cp02 成员路由补洞时引入的回归）。
- round6 定裁（`ocr/ocr-fix-plan-round6.md`）：路由移 `_app`（URL 不变）；operator 降级日志；build.ts 两处（storeArtifact 错误处理、历史分支身份校验）；artifact.ts 两处安全加固（目录上限、realpath-then-open）；index.ts 两处注释/行为对齐；专家向导只读字段来源改 verified 模板。
- OCR 覆盖债对策：round6 以 `--concurrency 4` 降 429 压力 + `--resume` 链式补审，直至欠审文件清零。
- R6 修复轮：frontend R6-1/R6-8、backend R6-2..R6-7 并行派发。

## R6 修复轮 — 配额击杀 + controller 接管收口（2026-10-20 16:2x CST）

- 两实现者 15:52/53 被 provider 5 小时上限（429，19:24:26 重置）杀死于验证前；死亡现场盘点：六项生产改动+三份测试扩展已全部落树。controller 逐行审查 diff（完整、符合 round6 裁决）后接管：fresh 验证 backend native **147/147**、frontend native **57/57**、driven 三包装层全过、server typecheck 3 既有、app 0、biome 仅 index.ts 5 条既有。合并报告 `tasks/R6-report.md`（含 R6-4 取 512 的论证认可、reviewer 配额受限的 controller-conducted 披露）。
- 待配额重置（19:24:26）后：OCR round6 `--concurrency 4` 全量 + resume 链，直至 12 个欠审文件清零；结果落地后判定收口。

## OCR 循环终止（用户指令）与收口（2026-10-20 18:05 CST）

- **用户指令：不再使用 OCR 进行扫描。** 待触发的 round6 启动器（pid 18477，原定 19:26:30）已终止并清除 launch 标记；round6 无任何输出，不构成任何结论。
- OCR 证据链定格为：round1（aborted）/round2（**全范围 substantive**：exit=0、270 files、0 critical/0 high、14 medium）→ 修复轮（round3-fix）→ round3 attempt4（exit=0，40/51，1 high/10 medium）→ R4 修复+双侧复审 → round4（exit=0，36/51，8 medium）→ R5 修复+双侧复审 → round5（exit=0，27/51，1 high/7 medium）→ R6 修复（controller 接管+fresh 验证全绿，cp24）。历轮 high/medium 全部进入编号修复计划并落地；未再出现的遗留仅剩各轮 parked low（均有裁决留痕）。
- 已知残差（如实记录）：round4/5 的 429 未审文件中有 12 个核心服务文件在**修复后状态**下未经 OCR 复扫（它们在 round2 全范围中均被审过且当时的 critical/high=0，后续触碰均有逐任务独立复审或 controller 逐行审查 + 测试覆盖）。后续 OCR 轮次按用户指令不再执行。
- 收口基线 = cp24 `b340ddc8…8667`（73 files，--verify 通过）。
