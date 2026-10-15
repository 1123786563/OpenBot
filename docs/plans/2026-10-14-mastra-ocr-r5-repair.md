# OCR Round-5 Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans`, one Task at a time. Coordinator gates per task.

**Goal:** Repair the valid High/Medium from the final full-coverage OCR (`.superpowers/sdd/2026-10-14-mastra-ocr-r1-repair/reports/ocr-final-workspace.txt`) plus the opportunistic lows in the two files it actually covered. The 429-blocked remainder of that run is a coverage gap to re-run afterwards, not new findings.

**Spec:** same as the R1-R4 repair plan (`docs/plans/2026-10-14-mastra-ocr-r1-repair.md`) — every Global Constraint there applies verbatim (workspace, detached HEAD b1532dbe, uncommitted checkpoints, no git mutations, no DB access, TDD, scoped Biome/typecheck with the known baseline, fail-closed semantics never weakened).

## Finding adjudication

| ID | Severity | Location | Validity | Disposition |
| --- | --- | --- | --- | --- |
| R5-H1 | high | ai-sdk-v3-gateway-adapter.ts:129-138 single-toolCallId enforcement breaks parallel tool results | valid — verified: line 129 `toolCallId !== part.toolCallId → fail()`; AI SDK merges a step's tool results into one role:"tool" message with distinct per-part ids | Task 1 |
| R5-M1 | medium | ai-sdk-v3-gateway-adapter.ts:344-346, 388-390 non-2xx body discarded; every fault flattens to UNSUPPORTED_OR_INVALID_MODEL_GATEWAY_RESPONSE, defeating the M-k/M-j classification contract | valid — verified both sites | Task 1 |
| R5-L1 | low | adapter:521-522 second usage chunk silently overwrites terminalUsage | valid | Task 1 (same function region) |
| R5-L2 | low | adapter:319-331 4-level nested ternary finishReason | valid | Task 1 (same function region) |
| R5-L3 | low | adapter:~10 `as any` without rationale comments | valid | Task 1 (representative comments only) |
| R5-L4 | low | budget.ts:133-139 number|object 4th-param shim silently drops legacyOptions on misuse | valid; single caller (service.ts:243) already uses the options form → tighten the signature, delete the shim | Task 2 |

## Task 1: gateway adapter tool-result parity, error-body surfacing, usage equality

**Role:** backend implementer / coordinator gate.
**Files:** Modify `server/src/enterprise/models/ai-sdk-v3-gateway-adapter.ts`; Test `server/tests/enterprise/ai-sdk-v3-gateway-adapter.test.ts` (extend).

- [ ] Step 1 — RED. Cases (DB-free, existing fixture style): (1) `parallel_tool_results_each_become_their_own_tool_message` — a step message carrying two tool-result parts (distinct gateway-valid toolCallIds) serializes to two `{role:"tool", tool_call_id, content}` entries (fails today with UNSUPPORTED…). (2) `non_2xx_response_surfaces_gateway_code` — invoke against a 400 `{error:{code:"MODEL_ROUTE_UNAVAILABLE"}}` (fixture fetch) rejects with an error whose message contains `MODEL_GATEWAY_HTTP_400` and `MODEL_ROUTE_UNAVAILABLE` (doGenerate and doStream). (3) `second_usage_chunk_must_agree_or_fail` — SSE with two differing usage chunks rejects; identical second usage chunk accepted. (4) `finish_reason_mapping_still_strict` — length/tool_calls/content_filter/stop map, unknown rejects (behavior-locked for the mapping-table refactor).
- [ ] Step 2 — Implement. (a) tool branch: per-part validation unchanged (fail() stays), drop the shared-toolCallId check, return one entry per part; `requestMessages` maps then flattens. (b) `!response.ok` (both sites): read+parse the error body best-effort, `throw new Error(\`MODEL_GATEWAY_HTTP_${status}${code ? " " + code : ""}\`)` — fail-closed preserved (nothing streams on); classification text markers now reach classifyGovernedRunFailure. (c) usage chunk: if terminalUsage already set and totals differ → fail(); else overwrite. (d) finishReason via a frozen Record mapping; unknown → fail(). (e) 2-3 representative `as any` rationale comments.
- [ ] Step 3 — GREEN + static + freeze (before/after bytes+hashes, increment patch, report under task-r5/).

## Task 2: budget signature tightening

**Role:** backend implementer / coordinator gate.
**Files:** Modify `server/src/enterprise/models/budget.ts`; extend its test file if one exercises the shim; `server/src/enterprise/runs/service.ts` (call site — none expected to change).

- [ ] Step 1 — RED: a compile-level assertion — call with the object form (existing callers) and assert a legacy-number 4th arg no longer type-checks is not expressible in tests (tests outside typecheck include); instead: unit test that object-form options (`expiresAt`, `runCeiling`, `idempotencyKey`) all reach the reservation (guards against the shim's silent-drop mode), recorded as behavior lock.
- [ ] Step 2 — Implement: collapse to `options: ReserveModelBudgetOptions = {}`, delete `optionsOrLegacyLimit`/`legacyOptions`/`configuredLimitTokens` shim branches.
- [ ] Step 3 — GREEN + static + freeze.

## After R5

Re-run the full workspace OCR (same background text). If 429s persist, the remaining never-reviewed set is exactly: index.ts, app.ts, .mcp.json, intelligence-contracts.ts, db schema files, version-catalog.ts, drizzle 0066 (all else covered by r1-r3 or this final run) — record as a coverage blocker, do not claim full coverage.
