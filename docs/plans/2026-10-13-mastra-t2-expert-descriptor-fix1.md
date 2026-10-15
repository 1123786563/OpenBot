# T2 Expert Descriptor Loader Evidence Fix1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the reviewed authorized Expert descriptor receives provenance from the production loader and shares exact normalized prompt bytes with the built-in Agent.

**Architecture:** Extend the focused Task A test with an injected DB-free loader fixture that records selected columns, joins and actor predicate and returns controlled rows through `createRuntimeAgentLoader`. Add an off-roster resolver assertion and inspect the constructed built-in prompt through the existing runtime/test seam. Keep Task A source and all other user files byte-identical.

**Tech Stack:** TypeScript, Bun test, Drizzle query compilation or the established runtime-loader fake in `server/tests/picked-harness-auth.test.ts`.

**Spec:** Approved Mastra design; Task A in `docs/plans/2026-10-13-mastra-t2-expert-admission-bridge.md`; A1 Medium and A2 Low in `.superpowers/sdd/2026-10-13-mastra-t2-expert-version-prerequisite/reports/task-a-reviewer-report.md`.

## Global Constraints

- Preserve the dirty worktree. No stage/commit/stash/reset/rebase/merge/push/PR/publish/worktree deletion.
- Own only `server/tests/agents/expert-descriptor.test.ts` and Fix1 report/checkpoint files. Preserve Task A source hashes: `runtime-agents.ts` `5f245e0a538c220eb8345129cdb6cc1f10cfc4c245041d1f2f03ea38335830a5`; `agent-resolver.ts` `9ed4a92e0345fc6b3d883adafbbfee766852880311c8122c8a30ad2fbfb5e27c`; `copilot.ts` `50f01736eb09b831737cabcff04bd246f37897290ae3023e85a7e0523ae8b8ff`.
- No database access or service operations. SQL execution, actor filtering and RLS remain unverified until the isolated database is ready.
- This is test evidence repair; run the new tests first and record the actual result. Do not manufacture a failing RED when reviewed production already satisfies an assertion. If a real product defect is exposed, stop and make a scoped source-fix plan before editing production.

## Review Focus

1. The loader test must call `createRuntimeAgentLoader`, observe the actual selected `packageId`, `ownerUserId` and publication join, and verify the actor visibility/tombstone query predicates have not been dropped.
2. Controlled package/user/team rows yield the correct `expertSource`; ambiguous or unclassified rows produce no Expert descriptor, while existing ordinary Bot registration remains available.
3. Off-roster requested ID rejects despite another authorized Bot in the roster.
4. The descriptor's `systemPrompt` equals the normalized prompt field passed to the constructed built-in execution Agent, byte-for-byte; generated guidance is outside Expert identity.

## Task 1: Add loader and prompt identity behavior tests

**Depends on:** Task A frozen patch SHA256 `b66ab816dfeb0a06e8b2c78669df57194a04d767ca7419ae56194a9d55fbfe81`. **Owner:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Owned file:** focused test only plus reports. **Consumes:** `createRuntimeAgentLoader`, `createActorAgentResolver`, existing built-in runtime config/test seam. **Produces:** DB-free evidence closing A1/A2. **Commit strategy:** uncommitted checkpoint.

- [ ] **Preflight:** Confirm HEAD and focused test baseline SHA256 `32524ef32930bea9ff19c4a08f0abe9a5792a15572a62d89a811fb27e831963d`; capture complete before/protected inventory and exact test copy.
- [ ] **Test first:** Add an injected loader fixture modeled on `server/tests/picked-harness-auth.test.ts` that drives production `createRuntimeAgentLoader`, records query projection/join/predicate from the builder, and returns package, owned, published and ambiguous rows. Assert actual mapped `expertSource` and actor-visible roster behavior, with publication from the trusted table. Add off-roster resolver rejection when another Bot is present. Run focused tests and record each result.
- [ ] **Prompt identity:** Use an existing built-in test seam or a controlled constructor/runtime spy to capture the normalized system-prompt value consumed by built-in construction. Assert exact equality with `definitionFacts.systemPrompt` from the same resolved Agent; assert appended guidance is not part of the Expert definition. Avoid a test that merely compares the injected fixture to itself.
- [ ] **Verify:** Run focused descriptor and existing resolver tests, scoped Biome and `git diff --check`; compare protected hashes. If the production code fails a valid new assertion, report it without editing unowned source.
- [ ] **Freeze:** Save before/after test copies and hashes, exact test-only patch and commands/exits. Backend validator and independent reviewer inspect the same hash and separate Spec/quality conclusions.

**Acceptance:** A1/A2 have public loader and constructed prompt evidence; no production source changed. Live database behavior remains unverified.
