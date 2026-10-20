# T2 ModelGateway AI SDK v3 Adapter Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all valid findings from the first independent review of the isolated AI SDK v3→ModelGateway adapter, preserving the no-production-wiring boundary.

**Architecture:** Keep the adapter's injected route/capability/gateway boundary, with the gateway as the sole capability resolver and usage-settlement owner. Validate and serialize the complete call payload before minting a capability; after issuance, dispatch immediately through the gateway using the validated Bearer token, allowing gateway error/abort paths to conservatively settle unknown. The adapter must preserve AI SDK v3 text/tool stream lifecycle, generated tool-call input strings, actual finish reasons, strict unsupported-field behavior, abort, and exactly one terminal frame.

**Tech Stack:** TypeScript, Bun, AI SDK v3 `LanguageModelV3`/`streamText`, OpenBot ModelGateway canonical chat-completions response and SSE stream.

**Spec:** `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md` §§3–5, 8; `.superpowers/sdd/2026-10-12-t2-model-gateway-ai-sdk-adapter/task-1-brief.md`; independent review `.superpowers/sdd/2026-10-12-t2-model-gateway-ai-sdk-adapter/reports/task-1-independent-review.md`.

## Global Constraints

- Fix only valid findings F1–F7 in the adapter source/test; do not add production composition or route/budget defaults.
- Preserve one capability per invocation and gateway-only resolution/settlement. Adapter performs no `confirmUsage`/`markUnknown` settlement call.
- Validate/serialize prompt, settings, tools, route input, and output ceiling before capability issuance. Capability service returns a canonical 43-character base64url token; validate this contract and dispatch immediately to the gateway after issuance.
- Do not put `routeRef` into the optional provider model hint. The gateway resolves frozen route from the capability.
- Conform strictly to pinned AI SDK v3 event and tool-call shapes. Every valid stream text/tool segment has complete lifecycle. Fail closed on unknown/malformed input, unsupported semantics, contradictory terminal data, missing authoritative usage, or non-whitespace data after `[DONE]`; cancel the reader on error or abort.
- Do not access/start/migrate/reset/modify databases or DB services. Do not touch protected user files.
- No stage, commit, stash, reset, rebase, merge, push, publish, PR, or worktree deletion.

## Review Focus

- F1: route reference is not a provider-model hint; a contract test uses distinct route and provider model IDs.
- F2: AI SDK v3 text-start/delta/end lifecycle works in actual `streamText` consumer.
- F3: generated tool-call `input` is a JSON string; streams accumulate fragmented ID/name/arguments by stable choice/tool index and emit completed tool events consumable by an actual SDK tool call.
- F4: invalid call semantics consume no capability; exactly one valid capability immediately reaches gateway. Failure/abort is conservatively resolved by gateway, not double-settled by adapter.
- F5: preserve `stop`, `length`, `tool_calls`→`tool-calls`, and `content_filter`→`content-filter` finish reasons.
- F6: abort listener cancels a stalled response reader; exactly one `[DONE]` is accepted and trailing non-whitespace data is rejected/cancelled.
- F7: reject unmapped file metadata and nested tool-result provider options.

### Task 1: Repair the adapter protocol translation

**Files:**
- Modify: `server/src/enterprise/models/ai-sdk-v3-gateway-adapter.ts`
- Modify: `server/tests/enterprise/ai-sdk-v3-gateway-adapter.test.ts`
- Read-only: `server/src/enterprise/models/gateway.ts`, `server/tests/enterprise/model-gateway.test.ts`, pinned AI SDK v3 declarations/runtime consumer.

**Consumes:** Frozen Task 1 hashes (source `827e765e4464cc2e0b3c56962cd03a544ce2be24275c8dbd43055c0683440f2c`, tests `16843c827b55e44f23f0e98d9b14ec450e956912ce11e85a7fc7b758461104c7`) and findings F1–F7 in the review report.

**Produces:** Corrected standalone adapter; tests demonstrate actual pinned SDK stream consumption, gateway-compatible route/tool requests, terminal behavior, and fail-closed paths.

- [ ] Refresh exact source baseline against the frozen Task 1 files and verify all unrelated/protected paths unchanged. Write failing regressions for F1–F7 before changing production adapter code.
- [ ] Remove request `model` hint; real gateway contract test proves route reference and provider model ID remain distinct and capability determines the selected route.
- [ ] Emit complete text lifecycle. Track every tool by stable `(choice index, tool index)`, validate consistent IDs/names and complete JSON argument object, and emit v3 required start/delta/end/final tool-call forms. Keep generated `tool-call.input` a validated JSON string. Verify via actual AI SDK v3 `streamText`/tool execution consumer.
- [ ] Preserve all supported gateway finish reasons and reject contradictory/missing finish reasons.
- [ ] Validate all call inputs and serialize request before capability issuance. Validate canonical capability token and invoke gateway immediately; keep settlement solely in gateway.
- [ ] Add abort listener that promptly cancels a stalled reader; validate a unique terminal marker and reject/cancel trailing non-whitespace bytes, malformed frames, incomplete UTF-8, provider errors, and absent usage.
- [ ] Reject unsupported filename and nested tool-result provider metadata rather than silently dropping them. Keep all other unsupported fields fail-closed.
- [ ] Run focused tests, scoped Biome and `git diff --check`; record exact results. Freeze snapshots/manifests/increment and require independent validator/reviewer against exact hashes.

**Acceptance:** Findings F1–F7 are each resolved with tests. Gateway remains sole usage/capability settlement owner. No production composition or database operation is added. This only verifies the standalone adapter slice, not full T2 or migration completion.
