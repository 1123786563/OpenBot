# T2 ModelGateway AI SDK v3 Adapter Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone, tested AI SDK v3 LanguageModel adapter that translates existing model calls to the strict OpenBot ModelGateway without choosing production route, ceiling, or budget defaults.

**Architecture:** The adapter is an isolated protocol seam. It receives explicit server-owned route identity, positive per-call `maxOutputTokens`, abort signal, a capability issuer, and the ModelGateway `handle(Request)` function through injected dependencies. The gateway remains the sole owner of capability resolution and authoritative usage settlement; the adapter must not independently confirm/release usage. Production Run admission and consumer wiring remain out of scope until a route/budget source is confirmed. Unsupported or malformed prompt/stream shapes fail closed. Cancelling the returned SDK stream cancels the gateway response body so the gateway can mark use unknown.

**Tech Stack:** TypeScript, Bun tests, AI SDK v3 `LanguageModel`, existing OpenBot ModelGateway wire contract.

**Spec:** `docs/superpowers/specs/2026-10-11-mastra-intelligence-only-design.md` §§3–5, 8; `.superpowers/sdd/2026-10-11-mastra-intelligence-only-dag/briefs/task-2.md` model-governance requirements; architecture evidence `.superpowers/sdd/2026-10-11-mastra-intelligence-only-dag/reports/t2-model-governance-seam-architecture.md` and `reports/t2-r12-route-contract-architecture.md`.

## Global Constraints

- Preserve the existing Agent selection/execution, tools, approvals, pause/resume and skill learning behavior.
- Keep this adapter disconnected from production until the authoritative server-owned route and Run budget source is resolved; do not invent defaults or accept client-supplied route/budget/ceiling.
- Require explicit positive `maxOutputTokens` on each model call and pass it to the gateway unchanged; do not exceed the injected persisted invocation maximum.
- Exactly one capability owner: the ModelGateway resolves each one-use capability and settles authoritative usage/unknown. The adapter only issues a capability and transports it.
- Any unsupported prompt field, malformed gateway response, unknown stream event type, or missing terminal usage fails closed; cancel the underlying response stream on failure/cancel.
- Do not access, start, migrate, reset or modify any database service. Do not touch protected migrations or dirty integration suites.
- Do not stage, commit, stash, reset, rebase, merge, push, publish or delete the worktree.

## Review Focus

- Correct AI SDK v3 prompt/tool/call-settings translation to the gateway's strict canonical chat request; reject unsupported fields instead of silently dropping semantics.
- Gateway is the sole capability resolver and settlement authority; exactly one capability is minted and consumed per generate/stream call.
- Explicit output ceiling is mandatory and bounded by the injected invocation maximum; no global-model or ungoverned provider fallback exists.
- `doGenerate` and `doStream` preserve canonical outputs/usage; stream cancellation, malformed/unknown `type`, error, and missing terminal usage cancel/fail closed and leave settlement unknown at the gateway.
- No production callsite is added in this slice.

### Task 1: Add the isolated AI SDK v3-to-ModelGateway adapter

**Files:**
- Add: `server/src/enterprise/models/ai-sdk-v3-gateway-adapter.ts`
- Add: `server/tests/enterprise/ai-sdk-v3-gateway-adapter.test.ts`
- Read-only: `server/src/enterprise/models/gateway.ts`, `server/src/enterprise/contracts.ts`, `server/src/mastra/model.ts`, locked AI SDK v3 declarations.

**Consumes:** `ModelGateway.handle(Request)`, an injected capability issuer returning one unique one-use token per invocation, an explicit model route reference, positive maximum tokens, and request abort signal.

**Produces:** a `LanguageModelV3` implementation speaking only the gateway's validated canonical request/SSE formats. The adapter never resolves a route from client input and never settles usage itself.

- [ ] Write focused failing tests for generate/stream request translation, mandatory and bounded `maxOutputTokens`, unique capability per invocation, tool/prompt translation, abort propagation, response parsing, malformed/unknown stream `type`, missing usage, and body cancellation.
- [ ] Implement the smallest adapter API that passes the tests. Present the one-use capability only in `Authorization: Bearer <capability>` to the injected gateway handler; adapter tests prove the resolver can extract exactly that token and reject missing/duplicate authorization. Do not add an HTTP production route or alter provider execution behavior as part of this task.
- [ ] Make the gateway the sole settlement owner. Prove tests do not call a second `confirmUsage`/`markUnknown` wrapper and that response-body cancel/error reaches the gateway handler.
- [ ] Run focused adapter tests, scoped Biome, and `git diff --check`; record actual commands/results and note all unsupported SDK features.
- [ ] Freeze exact before/after manifests and source snapshots, then obtain independent backend validation and Spec/code-quality review against the same hashes.

**Acceptance:** Focused tests prove the adapter faithfully uses the strict gateway contract, one capability per model request, explicit bounded output ceiling, authoritative gateway usage semantics, and fail-closed stream behavior. This standalone slice does not verify T2 production composition, route/budget policy, remote enforcement, DB/RLS/two-instance acceptance, or full migration completion.
