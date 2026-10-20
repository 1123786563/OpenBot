# T04-R4 OCR Medium Findings Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two valid Medium findings from final T04-R3 workspace OCR: protect migration preflight counts from concurrent writes, and provide a secret-backed signing/verification factory for authorized conversation bindings.

**Architecture:** In both the fresh-install 0063 migration and forward 0065 migration, acquire `SHARE ROW EXCLUSIVE` locks on Run and budget-reservation tables before counting rows, then retain them through constraint creation; keep existing message-table lock ordering and protections. In the Mastra contract module, create a server-side binding authority from a private configured HMAC secret; it issues bindings from trusted `PlatformScope` and verifies signature, tenant/workspace/principal, and expected conversation before accepting a candidate.

**Tech Stack:** PostgreSQL, Bun, TypeScript, Node.js `crypto`, Drizzle ORM.

**Spec:** `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md`; final OCR source `.superpowers/sdd/2026-10-11-mastra-ocr-r3-fix3-resolve-clock/reports/outer-ocr-workspace-final-2026-10-11.md` findings 1 and 14.

## Global Constraints

- Preserve the approved Mastra Intelligence-only boundary: OpenBot remains authoritative for identity, conversation authorization, execution, tools, approvals, pause/resume, Run state, and budgets.
- Use only the dedicated PostgreSQL fixture pinned to 127.0.0.1:5434; never use `DATABASE_URL`, shared or real databases.
- Keep history unchanged: no commit, reset, stash, push, merge, migration against real data, or deployment.
- Keep transaction-safe locks until migration constraint validation completes; do not weaken, remove, or defer invariant constraints.
- Binding signatures use a server-configured secret and constant-time comparison; no secret enters binding fields, responses, tests logs, or error messages.
- Execute tasks serially in DAG order and freeze/verify each checkpoint before dispatching the next task.

## Review Focus

1. A writer cannot insert/update an invalid Run ceiling or reservation while either migration counts pre-existing rows and later adds constraints.
2. A valid authorized binding can be minted only by code holding the server signing key and is rejected after any signed identity field changes.
3. Verification is scoped to the current PlatformScope and expected conversation, so a valid binding cannot be replayed for another tenant, workspace, principal, or conversation.
4. Failed verification does not disclose keys, signatures, or canonical signed payloads.
5. Existing conversation-contract validation and migration writer tests remain green.

---

## Task DAG and Acceptance Mapping

| ID | Source | Acceptance | Depends on | Owner | Validator | Owned files | Interfaces | Verification | Status |
|---|---|---|---|---|---|---|---|---|---|
| R4-1 | Workspace OCR Medium: migration preflight count/write race | 0063 and 0065 lock `enterprise_runs` then `enterprise_model_budget_reservations` before the corresponding count queries; integration test proves a concurrent invalid writer waits until migration commits and is then rejected by the new constraint; diagnostics identify 0065 accurately | none | backend_implementer | backend_validator | `server/drizzle/0063_restore_schema_invariants.sql`, `server/drizzle/0065_restore_schema_invariant_guards.sql`, `server/tests/enterprise/schema-migration-r2.integration.test.ts` | Existing migration order and constraint names unchanged | isolated migration suite, static order assertions, writer barrier behavior, journal/snapshot integrity | verified at checkpoint `r4-1-after` |
| R4-2 | Workspace OCR Medium: authorized binding brand cannot be minted or verified | Contract exports a factory that requires a configured >=32-byte secret, mints HMAC-signed bindings only from trusted scope plus binding-specific fields, and verifies signature plus expected scope/conversation using constant-time comparison; tampering/wrong-scope/wrong-conversation fail | R4-1 verified | backend_implementer | backend_validator | `server/src/mastra/intelligence-contracts.ts`, `server/tests/enterprise/intelligence-contracts.test.ts` | Keeps `IntelligenceService.resolve(scope, conversationId)` and `AuthorizedConversationBinding`; adds authority factory interface for future service implementation | focused contract tests, strict targeted typecheck, Biome and diff | verified after repair checkpoint `r4-2-f1-after` |

### Shared-file/interface and task consistency preflight

- R4-1 owns migration SQL and migration integration fixture only. R4-2 owns Mastra contract and its unit test only. No file ownership overlaps.
- Both tasks touch previously reviewed delivery files but are dispatched serially. R4-2 begins only after R4-1 exact checkpoint is independently validated and reviewed.
- The signing authority stores a copy of the configured secret in closure scope; only a branded binding value and boolean/type-guard verification cross its interface. Consumers must verify against the live caller scope and expected conversation before using a binding.

### Task 1: Serialize migration preflight against Run and reservation writers (R4-1)

**Depends on:** none. **Roles:** backend_implementer → backend_validator → reviewer.

**Files / ownership:** Modify `server/drizzle/0063_restore_schema_invariants.sql`, `server/drizzle/0065_restore_schema_invariant_guards.sql`, and `server/tests/enterprise/schema-migration-r2.integration.test.ts` only.

**Interfaces:** Keep existing constraint names, transaction shape and migration journal unchanged. Preserve the order of existing Mastra intent/attachment locks and add the Run/reservation table locks before both preflight counts, in this order: `enterprise_runs`, then `enterprise_model_budget_reservations`. Keep all locks until transaction completion. Change only the 0065 preflight error prefix from `0063` to `0065` while in that file.

- [ ] **Step 1 — RED:** Add a writer-window assertion for 0063 and 0065. Seed one valid Run and reservation, then pause migration after preflight counts but before data repair/constraint creation. From separate connections, set the Run maximum and reservation token limit to 0; assert both writers are blocked until migration proceeds, then fail with SQLSTATE 23514 and their exact named constraints. Capture failure before locks are added.
- [ ] **Step 2 — RED verification:** Run `ENTERPRISE_TEST_R2_MIGRATION_MODE=fresh bun test tests/enterprise/schema-migration-r2.integration.test.ts` from `server/` using only the dedicated loopback test URLs; confirm the new behavior fails because the writer commits during the unprotected preflight window or the expected lock assertions fail.
- [ ] **Step 3 — GREEN:** Add ordered Run and reservation `SHARE ROW EXCLUSIVE` locks ahead of the counts in 0063 and 0065; keep all existing Mastra intent/attachment locks, scans, repairs, and constraints. Correct the 0065 diagnostic label.
- [ ] **Step 4 — GREEN verification:** Rerun the complete isolated migration suite; expect fresh 0063 plus recorded-0063 forward 0065 tests to pass, including both blocked/rejected Run and reservation writers and the existing valid Mastra writer commit.
- [ ] **Step 5 — Static checks:** Assert source ordering for both migrations (Run lock < reservation lock < Run count < reservation count; existing intent and attachment locks precede message scan/backfill). Run Drizzle journal/snapshot validation, Biome and `git diff --check`.
- [ ] **Step 6 — Self-review:** Confirm lock order is consistent in 0063/0065 and no DDL, grants, constraints, unrelated migration or application code changed.

**Failure handling:** If the existing synthetic migration fixture does not contain a valid Run row at the writer barrier, seed exactly one valid row before starting migration and preserve the test's synthetic-only database discipline. Never relax the writer-block/rejection assertion.

### Task 2: Sign and verify authorized conversation bindings (R4-2)

**Depends on:** R4-1 verified. **Roles:** backend_implementer → backend_validator → reviewer.

**Files / ownership:** Modify `server/src/mastra/intelligence-contracts.ts` and `server/tests/enterprise/intelligence-contracts.test.ts` only.

**Interfaces:** Keep `IntelligenceService.resolve(scope, conversationId)` and the private unique-symbol brands. Add an exported `createAuthorizedConversationBindingAuthority(secret: string)` that rejects secrets shorter than 32 UTF-8 bytes and returns a frozen authority with:

- `mint(scope: PlatformScope, input: { conversationId: string; threadId: string; resourceId: string; authorizationEpoch: number }): AuthorizedConversationBinding`, deriving `tenantId`, `workspaceId`, `principalId`, `memberEpoch`, and `aclEpoch` from scope, signing a canonical versioned representation with HMAC-SHA256/base64url, and freezing the branded result.
- `verify(scope: PlatformScope, conversationId: string, value: unknown): AuthorizedConversationBinding | undefined`, validating an exact serialized binding shape, matching tenant/workspace/principal/memberEpoch/aclEpoch and expected conversation, then comparing the recomputed and supplied signature with `timingSafeEqual` on equal-length buffers. On success it returns a newly constructed frozen value with the module-private brand, so JSON round-trips are supported without trusting caller-supplied object identity.

Do not export the raw brand or any helper that signs caller-supplied arbitrary identity fields without a trusted `PlatformScope`. Do not include the secret or canonical payload in binding output or diagnostics.

- [ ] **Step 1 — RED:** Add tests proving the authority factory rejects short keys; valid binding mint/verify succeeds; a structurally forged object, JSON round-trip of a valid value, tampering each signed field while keeping the original signature, wrong secret, wrong scope, and wrong expected conversation all have the required result (only the valid signed value verifies).
- [ ] **Step 2 — RED verification:** Run focused `bun test tests/enterprise/intelligence-contracts.test.ts` and capture the expected missing export/type errors before implementation.
- [ ] **Step 3 — GREEN:** Implement the factory, canonical signer, opaque binding construction, and scope/conversation verifier in the contract module. Preserve the current `IntelligenceService` method shape and do not wire unused runtime consumers into this task.
- [ ] **Step 4 — GREEN verification:** Run `bun test tests/enterprise/intelligence-contracts.test.ts` and relevant compatibility tests; expect all binding and existing message/error contract assertions to pass.
- [ ] **Step 5 — Static checks:** Run strict targeted TypeScript check, Biome on both files and `git diff --check`.
- [ ] **Step 6 — Self-review:** Confirm the factory does not accept caller-controlled tenant/workspace/principal, runtime brand is required, wrong-context replay is rejected, and no signature or key is logged.

**Failure handling:** If the expected HMAC verification contract cannot be represented without exporting a forgeable signer, keep the secret-required closure authority and report the precise type/runtime issue; do not fall back to TypeScript casting as a workaround.

## Verification and completion gates

- Freeze each task's uncommitted before/after manifests and exact incremental patch; record SHA256 values and exact command outputs.
- Run validator and reviewer against the same frozen increment. R4-2 cannot start until R4-1 is `verified` and its reviewed checkpoint is the current workspace state.
- Preserve final workspace OCR as the source finding report. After both repairs, rerun workspace OCR over the complete uncommitted delivery and bind the result to final source hashes. A finding with valid critical/high/medium severity must receive its own scoped SDD repair plan; low observations receive explicit rulings.
- The final committed-range report remains bound to BASE `c14d5191ff0938c3e6eb00858e89a3847ff02b34` → HEAD `8d6b9bd71a810556ab46b5dffa9f72f0427f5289`; rerun that range if HEAD changes.
