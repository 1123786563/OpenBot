# T08 Opik Port and HTTP Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give all server-side Opik requests one typed port and one manifest-backed HTTP adapter whose bounded failures never change a successful Agent result into a failure.

**Architecture:** Keep the consumer-facing `OpikPort` in `opik-port.ts`; keep URL construction, serialization, fetch, response parsing, deadline handling, and verified-contract enforcement in `opik-http.ts`. Inject transport and clock/deadline dependencies for deterministic adversarial tests. Use T04's verified contract evidence and T07's trusted scope/binding interfaces; never treat Opik metadata or returned locators as authority.

**Tech Stack:** TypeScript, Bun tests, Biome 2.5.10, existing server fetch/AbortSignal support.

**Spec:** `docs/specs/2026-10-14-opik-integration-design.md` (especially §§4–6, 8, 10, A1/A4/A10/A13); Issue #14 snapshot at `docs/plans/evidence/2026-10-15-issue4/issue-tree.json`; dependencies T04, T05, T07 in `docs/plans/2026-10-15-opik-issue4-dag.json`; `reference/opik-contract.md` and `docs/plans/evidence/2026-10-15-issue4/opik-contract/47-manifest.json`.

## Global Constraints

- All content that can reach Opik passes through T05's allowlist projection; do not add a bypass or duplicate weaker serializer.
- Only a verified T04 contract may authorize an HTTP operation, endpoint, payload shape, response mapping, or supported body size.
- Only trusted T06 scopes and T07 bindings establish OpenBot authority; upstream IDs, project/workspace names, metadata, and caller-supplied locators do not.
- Opik is optional; offline, slow, timeout, 5xx, malformed, partial, or ownership-drift responses must remain explicit and bounded, and must not block normal Agent completion.
- Do not add tenant tables, tenant headers, hidden fallbacks, latest image/version references, new dependencies, commits, stash, push, merge, or publish.

## Review Focus

- Transport timeout / never-resolving fetch: operation settles within a fixed bounded deadline and reports a typed failure; never hangs.
- 5xx, malformed JSON, and partial success: caller sees explicit failure/partial state; never convert to an empty success result.
- Ownership / project / scope mismatch after an upstream response: mark the adapter unsafe for writes and surface an alertable typed error; do not continue writes.
- Missing, stale, or unverified contract fields: reject before network I/O, without guessing endpoint or serialization behavior.
- Adversarial credential, raw attachment, or malformed response values: do not echo secret-bearing request/response values into errors or logs; consume T05 projection outputs only.

---

### Task 1: Define the typed port and implement the manifest-backed adapter

**Files:**
- Create: `server/src/ai-observability/opik-port.ts`
- Create: `server/src/ai-observability/opik-http.ts`
- Test: `server/tests/opik-port.test.ts`

**Ownership:** This Task exclusively owns the three paths above. Do not edit dependency files or downstream consumer files. No shared DB, service, port, or build output is required.

**Consumes:**
- T04 verified service/SDK contract, precise endpoint semantics, ID mapping and deletion evidence.
- T05 `projectSafeText` / `projectSafeUrl` output and safe projection types.
- T06 `ObservationScope` identity and T07 authoritative run-binding contract. The port accepts trusted scope/binding values explicitly where a request needs them.

**Produces:**
- One consumer-facing `OpikPort` interface with typed outcomes that distinguish success, unavailable/timeout, upstream failure, malformed or partial result, and ownership drift.
- One `createOpikHttpPort` factory. It owns every Opik HTTP call and accepts injected `fetch`, clock/deadline and verified contract values for tests.
- A fail-closed adapter: no request is sent unless the supplied contract is verified and covers that operation. API IDs and returned project/workspace values are validated against the authorized binding/scope before follow-on writes.

**Contract boundaries:**
- Implement only operations supported by the verified T04 manifest and needed by current parent tasks; do not create speculative operations or duplicate T04's live runner.
- Keep request/response JSON shapes and route selection aligned with `reference/opik-contract.md` and the T04 evidence. Do not copy endpoint strings or body schemas into consumers.
- Pass only values that are already safe projections; error objects carry stable error codes and safe status/operation metadata, never raw bodies, headers, credentials, or untrusted identifiers.
- Apply an explicit finite timeout to every network request and cap request body bytes at the verified bound; a missing verified limit refuses oversized/unknown payloads.
- On ownership drift, stop subsequent writes for the affected scope and return a typed alertable failure. Do not report empty success or retry against another project.

**Steps:**
1. [ ] Add contract tests for the public port: exact operation outcome union; verified-contract refusal before transport; required identity/scope/binding inputs; no raw upstream body in surfaced errors.
2. [ ] Run `bun test tests/opik-port.test.ts`; confirm these new contract cases fail before implementation (RED).
3. [ ] Add minimal interface types and factory seams in the two owned source files; do not export an unverified constructor or raw fetch escape hatch.
4. [ ] Add injected transport cases for request serialization derived from verified contract, exact application route, safe projection-only payload, ID mapping, scope/binding validation and response parsing.
5. [ ] Add adversarial tests for never-resolving transport, abort/timeout, 5xx, invalid JSON, truncated/partial response, wrong project/scope, stale contract, and secret-bearing error body; assert bounded completion and typed non-success outcomes.
6. [ ] Run targeted tests and confirm GREEN; refactor duplication while preserving the same behavior and rerun tests.
7. [ ] Run `bun run typecheck`, `bunx biome check src/ai-observability/opik-port.ts src/ai-observability/opik-http.ts tests/opik-port.test.ts`, and relevant existing redaction/scope/bindings/contract tests. Record exact exit codes, duration and test counts.
8. [ ] Capture final Task patch, all owned file SHA256 values, test logs and implementation report under `docs/plans/evidence/2026-10-15-issue4/T08/`; include no commit and bind evidence to exact candidate hashes.
9. [ ] Stop at worker self-review; a separate read-only Claude reviewer must decide Spec compliance and code quality. After coordinator-authorized repair and independent re-review, transfer only the reviewed checkpoint and re-run the gates in the integration worktree.

**Failure handling:** Keep exact failing output and hashes. Missing contract fields or an unavailable live upstream are explicit blocked/unavailable evidence, never a passing result. Do not expand file ownership; ask the coordinator through Orca if a required interface change touches another task's files.

**Acceptance:** Each Issue #14 criterion is mapped to one or more tests: single port and manifest-backed serialization; injected timeout/5xx/partial/ownership drift; bounded completion without impacting normal Agent completion; write suspension plus alertable ownership-drift failure. No real production Opik instance is used for T08 tests; live end-to-end verification remains assigned to #43.
