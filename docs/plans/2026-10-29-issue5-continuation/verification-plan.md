# Issue #5 Continuation: Verification-First Closure Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify, fix, and progress the 44 open #5 follow-up tickets (#307–#344, #352–#357) whose implementations were already merged to main by orca-dag-wave3/run_68e96a7ff1c9, plus the B5R debt leftovers (#679.5, #680 remainder, #681 triage items).

**Architecture:** All 44 tickets carry "已实施并集成，等待人工审核" delivery comments; only #325/#341 have verification-passed comments. The work is therefore evidence-driven verification against current main (origin/main a9b502fc7), gap-fixing only what verification falsifies, then issue/PR closure per delivery gates. Verification runs read-only in the main checkout; fixes land serially on the integration branch `1123786563/issue-5-continuation` in workspace `~/orca/workspaces/OpenBot/issue-5-continuation`, then one PR per coherent wave.

**Tech Stack:** TypeScript (Bun runtime, Drizzle), PostgreSQL (isolated container `issue5-cont-pg` :5591, DBs `openbot_test`/`openbot_v2`/`openbot_v3`/`openbot_v4`), Go (bifrost submodule `bifrost/plugins/governance` at b3662eed), Biome, e2e dispatcher per ADR 0008.

**Spec:** #5 approved Spec (docs/specs/2026-10-14-bifrost-github-spec.md, ADR 0002/0003/0004); ticket ACs are the authoritative per-slice acceptance (snapshots in `.archive/runs/2026-10-29-issue5-continuation-08f13a2e/issues/`). Issue bodies cached at /tmp/iss5/*.json.

## Global Constraints

- Payer ownership is fixed: company workbench → company account, external personal grants → personal account; never switch on insufficient balance (ADR 0004).
- Unknown price/usage/bounds ⇒ not enabled: fail closed, no estimate-based settlement, no unauthorized release of pending-settlement holds (未知结果保持占用).
- Settlement is idempotent: replayed reports of the same result settle exactly once; every attempt/unit/job has stable identity.
- Real-provider evidence gates capability enablement; conformance-family tickets (#354–#355) stay honest about missing vendor evidence — capability remains non-enabled without it.
- DB-claiming tests run only against the isolated test DBs; never the dev database (server/tests/support/database.ts enforces TEST_DATABASE_URL).
- Verification agents are read-only on code; they write reports only to the run archive. Fixes are integrated by the sole coordinator, serially.
- Per user ruling 2026-10-20: no OCR scans per ticket; full-scope OCR once before the final delivery commit of this effort.
- Do not re-implement what is already merged (PR #689/#693 speech; PR #691 B5R debt T1); do not close issues without gate-complete evidence.

## Review Focus

- Speech settlement with fractional seconds (25.5s of a 60s cap) settles exact scaled amounts and releases the remainder — the fraction path once broke nine-digit scale (commit aa069f224).
- Duplicate/completion-notify replays across concurrent pollers must collapse to one settlement (async #327/#329; batch itemId fence #336).
- Unknown/lost terminal states keep the full reservation (async-cancel no_usage lane #331; providerJobID loss #327) — no timeout-based release.
- Realtime serial gating: a live unit stays usable, in-flight is refused, exhaustion stops later units (#316–#318) — ordering regressions silently double-bill or strand.
- Every capability not backed by bounded, priced evidence stays refused end-to-end (audio paths #313, video tiers #338, tool surcharges #342/#344) — an enablement leak anywhere in the chain is the highest-risk failure class.

## Waves (P ≤ 4 concurrent verification; each writes verification/<wave>.md)

### Task V1 — Speech chain #307 #308 #309 (DB: openbot_test)
Tests: `server/tests/speech-settlement.integration.test.ts` (21 pass baseline confirmed), `speech-interruption.integration.test.ts`, `speech-tail-availability.test.ts`, `speech-pricing.test.ts`, admin audioPaths surface (`server/src/gateway/admin-routes.ts` + UI). Map each AC line to test names; confirm the two user-mandated scenarios exist and pass. Go: `cd bifrost/plugins/governance && go test ./...` if ticket Verification lists it (G1/G2 no-tests-to-run caveat is documented, not a regression).

### Task V2 — Transcription + audio paths #310–#313 (DB: openbot_v2)
Tests: transcription-pricing/settlement suites, `audio-capability-evidence.test.ts`, `audio-path-admission.test.ts`. AC map per ticket; check metadata-mismatch audit event path and that unverified paths remain refused.

### Task V3 — Realtime + WebRTC #314–#324 (DB: openbot_v3)
Tests: realtime_sessions/units/input-gating suites, migrations 0193–0206 applied-state sanity, Go gating chain (`go test ./...` with GOMODCACHE/GOTOOLCHAIN=local recipe), wsrealtime seam, UI read faces. 11 tickets — group by sub-chain.

### Task V4 — Async 17.x #325–#332 (DB: openbot_v4)
Tests: async-job-submit/identity/recovery/status/cancel/terminal, async-jobs-view. #325 already has 验收通过 comment — re-confirm cheaply, spend effort on #326–#332.

### Task V5 — Batch 18.x #333–#336 + Video 19.x #337–#340 (after a slot frees; DB: reuse openbot_v2)
Tests: batch-reservation/settlement/partial-success/partial-cancel integration suites; video tier/spec availability suites.

### Task V6 — Surcharge 20.x #341–#344 (DB: openbot_v3)
#341 already verified-passed; focus #342 governance tool gate (Go), #343 dimension split ledger invariants, #344 bypass-block + company tool isolation.

### Task V7 — Conformance 22.x #352–#357 (last; depends on V1–V6 outcomes)
Tests: entrypoint-catalog/entrypoint-gate-audit/acceptance-matrix/conformance-evidence. #356's 12 partial-reds need re-attribution against today's main (baseline drift may have moved); #357 lists OCR as pending final gate — keep as final-commit obligation, per user ruling.

### Task B5R — Debt leftovers
Diff PR #691 scope vs plan findings: confirm #678.1–6, #679.1–4/6/7, #680.* dispositions actually landed; assess #679.5 (serial probing) and the four #680 UUID-truncation items; #681 items 1–6 are triage-only (code-evidence dispositions, no scope widening), items 7–10 report corrections need the archived reports (absent locally ⇒ record gap, do not fabricate).

### Fix tasks (F-*)
One F-task per confirmed critical/high/medium finding, ordered by dependency; each follows RED→GREEN on its own failing case, lands on the integration branch via the coordinator, targeted suites + typecheck + biome rerun. Low findings are logged with disposition, not auto-deferred.

### Closure tasks
- Evidence comments on each verified ticket (AC map, commands, counts, gaps) — GitHub writes serial by coordinator.
- PR per wave on `1123786563/issue-5-continuation` (+task branches), draft until gates; reference issues.
- Issue closure only where delivery-gates.md is fully satisfiable (target SHA = main after PR merge; required checks verified); otherwise `integration_pending` with evidence.

## Verification step template (every wave)

- [ ] Read ticket bodies/ACs (snapshot + live rescan of state/labels).
- [ ] Locate code + tests for each AC; list per-AC: file, test name, verdict.
- [ ] Run the suites: `TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5591/<db> bun test <files>` (diagnostic execution truth; e2e dispatcher run happens at final gates).
- [ ] Go where ticket says: `cd bifrost/plugins/governance && GOTOOLCHAIN=local GOMODCACHE=<cache> go test ./...` (root-package ui-embed red is a documented environmental BASE condition).
- [ ] Typecheck touched packages (`bun run --filter server typecheck`), biome on changed files (fix waves only).
- [ ] Solo-rerun any failure that smells like cross-suite interference before calling it real.
- [ ] Write `.archive/runs/2026-10-29-issue5-continuation-08f13a2e/verification/<wave>.md` with per-ticket verdicts: verified / gap(list) / blocked(reason).
