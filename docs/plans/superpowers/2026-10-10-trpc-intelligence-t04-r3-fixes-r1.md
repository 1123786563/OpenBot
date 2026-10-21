# T04-R3 Review Fixes R1 — SDD Plan

**Source:** T04-R3 checkpoint and independent reports `reports/r3-review.md` and `reports/r3-validation.md` under `.superpowers/sdd/2026-10-10-trpc-intelligence-t04-review-fixes-r1/`. This is a narrowly scoped repair plan; no Issue was supplied. User authorized end-to-end implementation and complete Intelligence replacement. T04-R3 remains unverified until the fixes pass validation and review.

## Global Constraints

- Workspace `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`; preserve HEAD `508800cf2c54f6eba2f3cf52ff897b198a92c714`, no commits/stash, do not touch `/Users/wuyongjun/trea/OpenBot`.
- Implement only gateway and focused gateway tests. No route mounting, contracts, PlanModel, migrations, Go, dependencies, or production auth scope changes.
- T04-R3-R01 remains binding: injected consumed invocation seam; no PlatformScope construction or body-derived authority.
- Preserve the per-Run token ceiling ruling. Keep all new errors generic and avoid key/token/provider-body exposure.
- Before/after content snapshots and an exact incremental review package bind implementation, tests, and reports. Tests must use synthetic credentials only.

## Task 1 — Repair gateway streaming, settlement, and protocol findings

**Status:** ready. **Depends on:** T04-R3 checkpoint. **Role:** backend_implementer; independent backend_validator and reviewer follow serially. **Owned files:** `server/src/enterprise/models/gateway.ts`, `server/tests/enterprise/model-gateway.test.ts`, this plan's `reports/` and `snapshots/` only. **Commit strategy:** uncommitted checkpoint; no commit/stash.

**Consumes:** T04-R3 brief and review/validation findings R3-REV-01..07. **Produces:** hardened gateway, focused failing-then-passing tests, implementation report, RED/GREEN logs, after snapshot and package.

Steps:
1. Record exact pre-task hashes/snapshot for owned source/test; add focused tests first. Cover secret redaction in OpenAI tool arguments and Anthropic partial JSON, malformed frames, authoritative Anthropic input/output usage, complete and split oversized frames, PlanModel actual string tool arguments in JSON and SSE, PlanModel timeout, and single attempted settlement on settlement failure. Add strict content/tool-shape rejection and supported Anthropic content mapping tests.
2. Implement safe SSE frame parsing with byte-bounded framing before decode/JSON parse; reject malformed/unsupported provider frames with generic stream failure. Redact every emitted provider-controlled string using streaming overlap state, including text and tool-argument deltas. Never pass through raw frames.
3. Track Anthropic input and output usage independently; confirm only after valid complete terminal sequence with authoritative usage. Missing/malformed/truncated usage marks unknown. Preserve original validated JSON argument strings from PlanModel and avoid double encoding in both response modes.
4. Use a shared request+timeout abort signal for native and PlanModel paths, propagate reader cancellation, and guard settlement attempts exactly once before awaiting settlement. Validate message content/tool schemas and map supported blocks faithfully; reject unsupported shapes before dispatch.
5. Run focused test suite, Biome, typecheck (report known unrelated probe failure only), whitespace checks; save complete command outputs and exact checkpoint package/hashes.

**Verification:** `cd server && bun --no-env-file test tests/enterprise/model-gateway.test.ts`; `bunx biome check` on owned TS; `bun run typecheck`; `git diff --check` and untracked whitespace check. Expected: focused tests all pass; source checks clean; only known unrelated `server/scripts/enterprise-runtime-probe.ts:63` type diagnostic may remain.

**Acceptance:** R3-REV-01..07 resolved or individually evidenced invalid; no key leaks through any normalized SSE field; no invented usage; bounded event cannot exceed 1 MiB; PlanModel tool arguments retain JSON shape; timeout/cancel and settlement are conservative and single-attempt; malformed request/provider frames fail safely.

**Failure handling:** If a finding cannot be fixed within owned seams, stop and report the exact interface/acceptance conflict; do not weaken acceptance or edit neighboring ownership.

## Review Focus

Secret handling across all SSE fields; byte-bound enforcement; provider protocol correctness; authoritative billing; cancellation and timeout; strict pre-dispatch schema; no scope/route/model authority from caller input; no changes outside owned files.
