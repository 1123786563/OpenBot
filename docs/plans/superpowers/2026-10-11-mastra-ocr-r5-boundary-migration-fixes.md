# T04-R5 OCR Boundary and Migration Findings Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve verified Medium findings from complete T04-R4 workspace OCR while preserving OpenBot's execution, authorization, usage-accounting, and self-hosted migration contracts.

**Architecture:** Apply HMAC verification to every capability-consuming operation, make the untrusted Mastra message parser snapshot/copy/fail closed before branding, and ensure the forward schema-guard migration is actually tested against a legacy schema. Keep schema backfill and `NOT VALID` constraint installation in the writer-locked migration transaction, then validate constraints in a subsequent migration so full-table validation scans occur after the preflight locks are released.

**Tech Stack:** TypeScript, Node.js crypto, Bun, PostgreSQL, Drizzle migrations.

**Spec:** `docs/superpowers/specs/2026-10-11-mastra-intelligence-only-design.md` §§3–4; complete OCR evidence: `.superpowers/sdd/2026-10-11-mastra-r4-2-proxy-verification-fix/reports/outer-ocr-workspace-final-2026-10-11.md` and `outer-ocr-migration-retry-2026-10-11.md`.

## Global Constraints

- OpenBot remains authoritative for identity, conversation authorization, Agent execution, approvals, pause/resume, Runs, model capabilities, and budgets.
- Use only the dedicated disposable PostgreSQL fixture at `127.0.0.1:5434/openbot_enterprise_r2_codex_20261009`; unset `DATABASE_URL` and pass explicit test URLs.
- Preserve the externally advanced local HEAD `b1532dbe4ec4d2e64b58fd31c57a7c1863ffd155` and its committed T04-R4 implementation; do not reset, amend, rebase, stash, push, merge, deploy, or access a production/shared database. R5 work remains uncommitted.
- Preserve migration constraint names and invariant semantics. New writes remain constrained immediately after the 0065 transaction; 0066 validates all existing rows.
- Parse hostile message input from one captured/copy snapshot. No original getter/Proxy or nested mutable reference may affect the returned branded value after validation.
- Use the plan's task ownership and serial checkpoints. Review and validator run against exact frozen hashes.

## Review Focus

1. Forged capability digests cannot authorize resolve, confirmUsage, markUnknown, or release.
2. Message parser exceptions, getters, Proxy disagreement, nested mutation, symbols, malformed V1 helper arrays, and non-serializable values fail closed or are detached before branding.
3. A recorded legacy migration path genuinely reaches 0065's preflight, string backfill, and constraint-install branches; invalid data identifies the 0065 diagnostic.
4. New constraints enforce writes before commit and 0066 validates the legacy rows after the long writer-lock window has ended.
5. Existing fresh 0063 and forward 0065 race-protection paths, budget settlement, Mastra message round-trips, journal, and snapshot checks stay green.

## Task DAG and Acceptance Mapping

| ID | Source | Acceptance | Depends on | Owner | Validator | Owned files | Interfaces | Verification | Status |
|---|---|---|---|---|---|---|---|---|---|
| R5-1 | Complete OCR Medium: sibling capability settlement paths trust mutable digest only | Every capability operation validates digest lookup plus constant-time HMAC reconstruction from the stored binding; forged digest is rejected by `resolve`, `confirmUsage`, `markUnknown`, and `release` | none | backend_implementer | backend_validator | `server/src/enterprise/runs/model-capability.ts`, `server/tests/enterprise/runs.integration.test.ts` | Existing capability service signatures and error codes unchanged | Focused Run integration cases, Biome, scoped strict typecheck/diff | verified |
| R5-2 | Complete OCR Medium: hostile parser TOCTOU and exceptions escape contract | Parser captures own data properties once, clones supported nested message payload before validation/branding, rejects accessors/proxy exceptions/cycles or unsupported shapes, validates V1 tool helper arrays, and returns invalid-input for thrown untrusted behavior | none | backend_implementer | backend_validator | `server/src/mastra/intelligence-contracts.ts`, `server/tests/enterprise/intelligence-contracts.test.ts` | `parseMessageInput(value): IntelligenceResult<MessageInput>` remains unchanged | Focused contract/compat tests, strict tsc, Biome, diff | pending |
| R5-3 | Complete OCR Mediums: 0065 performance lock window and missing legacy-path branch coverage | Legacy fixture omits 0063 guard body with checked replacements; tests prove 0065 fail-fast, string backfill, and constraint installation; preflight uses bounded set-based SQL statements independent of legacy row count (no per-intent loop issuing holder queries); 0065 adds constraints NOT VALID under writer locks; generated 0066 validates them after 0065 commits; fixture journals match copied files and cleanup does not await blocked writers before releasing/closing | R5-1, R5-2 | backend_implementer | backend_validator | `server/drizzle/0065_restore_schema_invariant_guards.sql`, generated 0066 validation migration + metadata, `server/tests/enterprise/schema-migration-r2.integration.test.ts` | Constraint names and effects unchanged; 0065 holds required table locks through preflight/backfill/NOT VALID additions; 0066 validates all three | Dedicated migration integration, journal/Drizzle check, validation state assertions, invalid-writer race, Biome/diff | implementation complete; validator/review pending |

### Shared-file/interface and task consistency preflight

- R5-1, R5-2, R5-3 have disjoint files and run serially in DAG order; no shared file edits overlap.
- Migration lock order remains `enterprise_runs` → `enterprise_model_budget_reservations` → `mastra_message_intents` → `mastra_message_intent_attachments`. `NOT VALID` checks enforce new tuples at 0065 commit, and 0066 only validates extant rows.
- Capture each uncommitted before/after manifest and exact scoped patch. Do not use `BASE..HEAD` to represent uncommitted work.
- Existing unrelated typecheck failure in `server/scripts/enterprise-runtime-probe.ts:63` is not within these task owners; report it unless a targeted check shows otherwise.

### Task 1: Authenticate every capability-consuming operation (R5-1)

**Depends on:** none. **Roles:** backend_implementer → backend_validator → reviewer.

**Files / ownership:** Only `server/src/enterprise/runs/model-capability.ts` and `server/tests/enterprise/runs.integration.test.ts`.

**Consumes:** Existing `createCapability(secret,row)`, `loadByCapability(tx,scope,capability)`, and public capability service methods.
**Produces:** One shared authenticity assertion used after digest lookup by `resolve`, `confirmUsage`, `markUnknown`, and `release`; preserve method signatures and current invalid-capability errors.

- [ ] **Step 1 — RED:** Extend `data role cannot forge a model capability by replacing its digest` or add focused companion cases. Create independent reserved/consumed rows for `release`, `markUnknown`, and `confirmUsage`; replace each stored digest with SHA-256 of a forged 43-character token under the existing dedicated test role. Assert each sibling operation rejects 401 `MODEL_CAPABILITY_INVALID`, and assert statuses/usage/reservation remain unchanged. Include the existing resolve assertion.
- [ ] **Step 2 — RED verification:** From `server/`, run with only the dedicated `127.0.0.1:5434/openbot_enterprise_r2_codex_20261009` roles and `DATABASE_URL` unset: `env -u DATABASE_URL ENTERPRISE_TEST_SETUP_DATABASE_URL='postgres://enterprise_setup:enterprise-setup-only@127.0.0.1:5434/openbot_enterprise_r2_codex_20261009' ENTERPRISE_TEST_DIRECTORY_DATABASE_URL='postgres://enterprise_directory_login:enterprise-test-only@127.0.0.1:5434/openbot_enterprise_r2_codex_20261009?options=-c%20role%3Dob_ent_directory' ENTERPRISE_TEST_DATA_DATABASE_URL='postgres://enterprise_data_login:enterprise-test-only@127.0.0.1:5434/openbot_enterprise_r2_codex_20261009?options=-c%20role%3Dob_ent_data' ENTERPRISE_TEST_OPERATOR_DATABASE_URL='postgres://enterprise_operator_login:enterprise-test-only@127.0.0.1:5434/openbot_enterprise_r2_codex_20261009?options=-c%20role%3Dob_ent_operator' bun test tests/enterprise/runs.integration.test.ts`. Expected: new sibling-operation assertions fail before fix while the original resolve forgery case remains green.
- [ ] **Step 3 — GREEN:** Extract one constant-time comparison helper that recomputes HMAC capability from the stored row and closure secret. Use it on every capability-consuming service path after digest lookup and before any idempotent early return or state mutation. Keep digest indexed lookup as row selection; do not treat digest as authentication.
- [ ] **Step 4 — GREEN verification:** Rerun the same exact isolated Run integration command. Expected: all targeted capability tests and the existing Run suite pass; forged token does not alter settlement state.
- [ ] **Step 5 — Static checks:** Run Biome on the two files, strict targeted `tsc` for `src/enterprise/runs/model-capability.ts`, and `git diff --check`.
- [ ] **Step 6 — Self-review:** Enumerate all public methods taking a capability and prove the shared HMAC check runs before state-dependent returns/writes. Record file hashes and exact test output.

**Failure handling:** Do not widen DB permissions or weaken the forged-digest assertions. If the test role cannot reproduce digest replacement, first inspect the current CI grants fixture; report the exact privilege/fixture boundary without changing production grants.

### Task 2: Snapshot and materialize untrusted Mastra messages (R5-2)

**Depends on:** none. **Roles:** backend_implementer → backend_validator → reviewer.

**Files / ownership:** Only `server/src/mastra/intelligence-contracts.ts` and `server/tests/enterprise/intelligence-contracts.test.ts`.

**Consumes:** Existing `parseMessageInput(value: unknown)` contract and R4-2-F1 descriptor-snapshot approach.
**Produces:** Same public result signature. Parsing operates on one validated own-data snapshot, deeply detaches the message payload before return, validates V1 helper-array shapes, and collapses untrusted reflection/getter/clone exceptions to branded `invalid-input`.

- [ ] **Step 1 — RED:** Add cases for throwing top-level getter, throwing `ownKeys`/descriptor Proxy, top-level getter-versus-descriptor disagreement, nested object mutation after parse, cycle/non-serializable content, unexpected symbol selector, malformed V1 `toolCallIds`, `toolNames`, and `toolCallArgs`. Assert hostile throws become `ok:false/invalid-input`; returned content does not share nested mutable references; invalid helper arrays/symbol fields fail closed.
- [ ] **Step 2 — RED verification:** From `server/`, run `bun test tests/enterprise/intelligence-contracts.test.ts`; expected new cases expose exception escape, TOCTOU/shallow aliasing, or unchecked shape acceptance before the fix.
- [ ] **Step 3 — GREEN:** Capture top-level own data descriptors once, reject accessors/unexpected keys/symbols, detach nested supported content into a persistence-safe clone, then validate that clone and build the branded result from it. Wrap all untrusted reflection/materialization in a catch that returns the existing safe invalid-input failure. Validate V1 helper arrays and elements. Do not add an arbitrary byte/ID cap without an approved policy.
- [ ] **Step 4 — GREEN verification:** Run focused contract and `bun test tests/enterprise/mastra-compatibility.test.ts`; expected all prior signed-binding, V1/V2 preservation, and new hostile-input cases pass.
- [ ] **Step 5 — Static checks:** Strict targeted `tsc` for the two files, Biome, and `git diff --check`.
- [ ] **Step 6 — Self-review:** Confirm no post-capture reads from caller-owned objects feed validation or return values, and no nested mutable caller references survive. Record exact hashes/results.

**Failure handling:** Preserve legal V1/V2 content fields. If a clone strategy rejects a currently supported Mastra content form, add an explicit valid round-trip test for that form before narrowing the accepted contract. Do not catch programmer errors outside the untrusted parser boundary.

### Task 3: Bound forward-migration locks and exercise legacy 0065 paths (R5-3)

**Depends on:** none. **Roles:** backend_implementer → backend_validator → reviewer.

**Files / ownership:** `server/drizzle/0065_restore_schema_invariant_guards.sql`, new generated custom migration `server/drizzle/0066_validate_schema_invariant_guards.sql`, generator-managed `server/drizzle/meta/_journal.json` and new snapshot, and `server/tests/enterprise/schema-migration-r2.integration.test.ts` only. Do not edit 0063 in this task.

**Consumes:** Existing migration names/constraints and dedicated test container. **Produces:** A legacy fixture whose copied 0063 guard body is explicitly and assertively stripped, a bounded set-based 0065 preflight preserving diagnostic categories and holder/UUID semantics, immediate enforcement via `NOT VALID` constraints, and a generated 0066 custom migration validating those three constraints.

- [ ] **Step 1 — RED:** Add checked fixture transformations: every target fragment must occur exactly once, otherwise throw. The through-64 legacy fixture strips 0063's guard/preflight/backfill/constraint statements while retaining its journal timestamp and filename. Filter the copied journal to exactly copied SQL files. Add tests proving (a) legacy string attachment IDs with a matching holder are converted by 0065, (b) missing/mismatched holders fail with `0065 preflight blocked` and the correct counter before mutation, (c) after 0065 each of the three constraints is present with `convalidated=false` and rejects invalid new rows, and (d) after 0066 all three are `convalidated=true`. Add a SQL-structure assertion that fails if 0065 restores the per-intent PL/pgSQL loop or performs correlated holder statements once per row. Before implementation, run the isolated migration integration and capture expected failures.
- [ ] **Step 2 — RED verification:** From `server/`, with `DATABASE_URL` unset and explicit setup URL `postgres://enterprise_setup:enterprise-setup-only@127.0.0.1:5434/openbot_enterprise_r2_codex_20261009`, directory URL `postgres://enterprise_directory_login:enterprise-test-only@127.0.0.1:5434/openbot_enterprise_r2_codex_20261009?options=-c%20role%3Dob_ent_directory`, data URL `postgres://enterprise_data_login:enterprise-test-only@127.0.0.1:5434/openbot_enterprise_r2_codex_20261009?options=-c%20role%3Dob_ent_data`, and operator URL `postgres://enterprise_operator_login:enterprise-test-only@127.0.0.1:5434/openbot_enterprise_r2_codex_20261009?options=-c%20role%3Dob_ent_operator`, run `env -u DATABASE_URL ENTERPRISE_TEST_SETUP_DATABASE_URL='<setup>' ENTERPRISE_TEST_DIRECTORY_DATABASE_URL='<directory>' ENTERPRISE_TEST_DATA_DATABASE_URL='<data>' ENTERPRISE_TEST_OPERATOR_DATABASE_URL='<operator>' ENTERPRISE_TEST_R2_MIGRATION_MODE=fresh bun test tests/enterprise/schema-migration-r2.integration.test.ts`. Expected: tests fail because 0065 does not reach the intended legacy backfill/failure/NOT VALID states.
- [ ] **Step 3 — Generate 0066:** From repository root, run `bun run --filter server db:generate -- --custom --name=validate_enterprise_schema_invariant_guards`. Inspect the generated index/name and journal/snapshot. Do not hand-edit generator metadata or a generated migration. Implement only the generated custom 0066 data/validation statements in its generated migration file. If generator changes unrelated files or cannot create a custom migration, stop this task with exact output and do not fabricate journal metadata.
- [ ] **Step 4 — GREEN 0065:** Replace the legacy-row loop with set-based staging/aggregation in a bounded number of SQL statements independent of row count. Preserve counts for non-array, malformed JSON, invalid UUID/duplicates, holder mismatch, Run ceilings, and reservation budgets. Under the existing ordered locks, backfill valid legacy values, then add missing named constraints `NOT VALID`; keep Run default removal. Ensure a NOT VALID check immediately protects all new/updated tuples after transaction commit.
- [ ] **Step 5 — GREEN 0066:** In the generated custom migration, `VALIDATE CONSTRAINT` for the attachment array, reservation token, and Run maximum checks. It must perform no broad data mutation. Validation occurs after 0065 transaction releases its four writer locks.
- [ ] **Step 6 — GREEN verification:** Rerun the exact isolated migration integration command. Expected fresh 0063 race case remains green; forward legacy 0065 failure, backfill, intermediate `convalidated=false`, invalid-write rejection, and 0066 validation to true all pass. Run `bun test tests/migration-journal.test.ts` and `DATABASE_URL='<setup URL>' bunx drizzle-kit check --config=drizzle.config.ts` from `server/`; expect journal and schema checks pass.
- [ ] **Step 7 — Static checks:** `bunx biome check tests/enterprise/schema-migration-r2.integration.test.ts`; assert lock order and absence of a per-row SQL loop; run `git diff --check` on scoped files. Check copied fixture journal indexes exactly equal copied migration SQL indexes for each window.
- [ ] **Step 8 — Failure-path cleanup/self-review:** In test helpers, close/cancel blocked writer connections before awaiting their promises; factor the repeated blocked-writer activity query into one helper. Confirm future journal entries are filtered in every copied fixture. Ensure no test uses any database outside loopback port 5434.

**Failure handling:** If set-based decoding cannot preserve malformed JSON diagnostics safely, use a set-based immutable helper that returns a parse status per row; never silently reinterpret invalid values as valid arrays. Keep preflight failure atomic and preserve 0065 diagnostic categories. If any lock-order test detects reversal, stop before broad test runs and correct the ordering in this task.

## Rulings for other complete-OCR comments

- Ruling: the 0063-in-place finding does not establish a Drizzle hash-mismatch defect. Locked local `drizzle-orm` migrator source skips by `created_at` timestamp, and `docs/development.md` explicitly says `drizzle-kit check` does not validate journal-directory identity or database hashes. Existing environments get the forward 0065 locks; fresh installs receive the extra 0063 locks, with the same final constraints. Cost if an external deployment system independently audits historical checksums is an environment-specific warning; no such system or applied-production state is evidenced here. Keep the current lock addition and preserve its before/after evidence.
- Ruling: the 0065 low diagnostic label `invalid_run_ceiling_count` is retained for compatibility with 0063's error format and existing operations/test consumers; document this stable cross-migration label in the SQL comment.
- Ruling: retain explicit `forbiddenSelectors` as defense in depth beside the allowlist and comment the intent.
- Ruling: compare canonical public binding context without changing protocol semantics; existing HMAC comparison remains the secret authenticator. If needed, use equal-length `timingSafeEqual` for same-sized canonical buffers.
- Ruling: factor the duplicated blocked-writer `pg_stat_activity` query into one local test helper while editing the migration integration file. This lowers drift between polling and final assertions; cost if wrong is one extra helper without behavioral change.
- Ruling: defer unrelated low findings on lease-constant deduplication, application-clock test helper extraction, Plan-token empty guard (configuration already rejects blank tokens), dead timer cleanup branch, request preflight timeout policy, parser size cap (no approved common cap for internal/batch callers), signal role downstream projection (history consumer task), and constant test-fixture tautology unless they are touched by a Medium repair. Each is recorded with this cost: future maintenance or caller-specific policy refinement may be needed; none defeats the assigned acceptance.
