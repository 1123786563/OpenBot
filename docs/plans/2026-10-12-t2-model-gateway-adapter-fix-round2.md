# T2 ModelGateway AI SDK Adapter Fix Round 2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two remaining findings from the F1–F7 adapter repair review: rejection of the real gateway's terminal placeholder and an abort/listener-registration race.

**Architecture:** Preserve the strict SSE parser and ModelGateway-owned settlement. Recognize the exact gateway-generated terminal placeholder only after a valid finished choice and authoritative terminal usage, immediately before the single `[DONE]`. For cancellation, install the abort listener and synchronously recheck the signal before any awaited read; on abort cancel reader and error the SDK stream, then remove listener on every exit.

**Tech Stack:** TypeScript, Bun, AI SDK v3 `streamText`, actual `createModelGateway` with fake upstream model stream.

**Spec:** Approved design §§3–5, 8; F1–F7 adapter fix plan; independent repair review `.superpowers/sdd/2026-10-12-t2-model-gateway-ai-sdk-adapter-fix/reports/task-1-independent-review.md`.

## Global Constraints

- Modify only `server/src/enterprise/models/ai-sdk-v3-gateway-adapter.ts` and its focused test.
- Preserve gateway sole capability resolution and usage settlement; no production composition or new settlement call.
- Do not weaken validation for other choice frames or trailing stream bytes.
- The terminal placeholder is accepted only in the gateway's canonical last-frame position, with no choice index and no content beyond empty delta; require earlier complete finish/usage and one trailing `[DONE]`.
- Abort always cancels a stalled gateway reader and rejects the consuming SDK stream even if abort races with capability issuance/gateway response creation.
- No DB service operation, protected file edits, stage/commit/stash/reset/rebase/merge/push.

## Review Focus

- Reproduce actual `createModelGateway` output through the adapter and actual `streamText`; successful generation reaches finish with usage.
- Reject the same unindexed placeholder before terminal usage, with non-empty delta, in non-terminal position, or followed by duplicate/trailing data.
- Abort race regression stalls `reader.read()`, aborts between invocation and listener registration, and proves prompt rejection plus upstream/body cancellation.
- All fix-round-1 findings remain resolved.

### Task 1: Fix terminal placeholder and abort race

**Files:**
- Modify: `server/src/enterprise/models/ai-sdk-v3-gateway-adapter.ts`
- Modify: `server/tests/enterprise/ai-sdk-v3-gateway-adapter.test.ts`

**Consumes:** Frozen round-1 repair source/test hashes and reviewer findings: High terminal placeholder rejection; Medium abort before listener registration.

**Produces:** Minimal parser/abort correction plus real gateway/SDK regression tests.

- [ ] Capture exact before hashes/snapshots for both owned files and verify round-1 frozen bytes plus protected baseline.
- [ ] Add RED tests first: real `createModelGateway` stream through adapter and pinned `streamText`, including gateway placeholder; race abort while a response body is stalled before listener registration; rejection of malformed placeholder variants.
- [ ] Implement narrowly: permit only canonical placeholder at terminal position after completed choices and usage; after listener registration immediately check `signal.aborted`, cancel reader, and propagate rejection; remove abort listener on every path.
- [ ] Run focused adapter suite, scoped Biome and diff check; ensure real gateway stream and race tests pass without loosening other protocol checks.
- [ ] Freeze exact snapshots/manifests/increment and report hashes; independent backend validation and reviewer assess the same checkpoint.

**Acceptance:** Both findings resolved with behavioral evidence and all earlier F1–F7 regressions still pass. No production route composition or DB operation is added.
