# B5R Debt Repair Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` only after the shared coordination capability gate is cleared. Tasks use checkbox syntax.

**Goal:** Close the verified AC18 cleanup findings in #678–#680 in one reviewable PR without weakening company-account isolation or cleanup fail-closed behavior.

**Architecture:** Keep the existing cleanup-relation evaluator and its PostgreSQL integration suite as the single behavior boundary. Add real database RED→GREEN fixtures for each confirmed decision defect, then fix query evaluation and tighten fixture/test hygiene in the same PR. Issue #681 remains a triage record; only its explicitly scoped report corrections may accompany this work.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Bun compatibility test suite dispatched through the repository e2e runner, TypeScript compiler, Biome.

**Spec:** Approved #5 Bifrost Spec, AC18 (as indexed in `.archive/runs/2026-10-24-bifrost-5/audit/intake-2026-10-26.md` and GitHub #5); follow-on scopes #678, #679, #680. No approved Spec or ADR changes.

## Global Constraints

- Preserve AC18: cleanup only enumerated, verified obsolete test billing data; preserve user, Bot, conversation, knowledge, and company financial history; isolate unknown-owner rows; never duplicate legacy balances between personal and company accounts.
- Preserve strict payer ownership: company and personal balances remain separate; neither an insufficient balance nor a cleanup decision may move or erase financial liability.
- Preserve unknown and malformed ownership as fail-closed; do not widen deletion scope to make a fixture pass.
- All database claims require isolated real PostgreSQL integration evidence; mocks and static scans cannot establish transaction/FK behavior.
- Follow ADR 0008: official Bun-dependent suites run through the e2e dispatcher and its collection/reporting; direct `bun test` is diagnostic only.
- Keep source changes limited to `server/src/billing/cleanup-relations.ts`, `server/tests/cleanup-relations.integration.test.ts`, and the four #681 report corrections in the archived fix4/fix6 reports.
- One PR for #678/#679/#680; PR remains draft until full validation, independent Review, final OCR, and CI state are known.

## Review Focus

- A row in the candidate's deletion root is itself protected by an anchor, kept-class, live in-flight, or ownership verdict; assert it cannot appear in the safe deletion set.
- A row reachable through both SET NULL and RESTRICT/NO ACTION remains a blocker; blocker precedence must not be erased by shared visitation state.
- `ON DELETE SET DEFAULT` matches PostgreSQL's real mutation behavior or fails closed; it must never be silently omitted from the manifest.
- A child outside the estate whose second-hop CASCADE reaches another non-estate row is represented or safely blocked before execution.
- Composite FKs are evaluated atomically with PostgreSQL matching semantics or rejected fail-closed; partial composite matches cannot become deletion evidence.
- Re-evaluating unchanged data yields the same deterministic manifest/hash projection; generation time is metadata only.
- A candidate removal caused by retained FK evidence reports `deletion_blocked_by_retained_reference` accurately, with no permanently-zero reason counter.
- Cleanup fixture identifiers remain unique across parallel processes; test cleanup is scoped to those identifiers and cannot remove another run's rows.
- The four protected-key cases (company, personal non-test, quarantined, and unknown-shape/registered-outside-personal as scoped by #680) have direct persisted-row assertions for account, ledger, and reservation shelter behavior.

## DAG and Acceptance Mapping

| Node | Source Issue | Owned files | Acceptance | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| T1 `b5r-cleanup-core` | #678, #679 | `server/src/billing/cleanup-relations.ts`, matching DB cases in `server/tests/cleanup-relations.integration.test.ts` | All thirteen source findings have an explicit disposition; every behavior change has DB RED→GREEN evidence; seven-suite baseline 78/0/1155 is accounted for | Shared coordination capability, issue claim, test DB claim | blocked |
| T2 `b5r-cleanup-fixtures` | #680 | `server/tests/cleanup-relations.integration.test.ts` | All eleven source findings have an explicit disposition; structural changes preserve behavior; protected-key arms verify persisted rows; run IDs use `crypto.randomUUID()` | T1 verified checkpoint | blocked |
| T3 `b5r-closeout-evidence` | #681 items 7–10 only | Archived `audit/fix4-report.md`, `fix6-report.md` | Four scoped factual corrections verified; #681 items 1–6 remain triage findings with a code-based disposition, without demand changes | T1/T2 verified checkpoint | blocked |
| T4 `b5r-final-gates` | #678–#680; AC18 aggregate evidence | Verification and review artifacts only | Typecheck, Biome, fresh-PostgreSQL suite, independent Spec/quality Review, complete final OCR, and checks bound to the exact PR head | T1, T2, T3 | blocked |

### Finding-to-evidence map

| Issue item | Planned disposition | Required evidence |
| --- | --- | --- |
| #678.1 unclassified row fail-open | Return retained for unclassified touched rows, matching the file contract | Directly inserted unknown row; baseline RED and repaired manifest shows retained impact |
| #678.2 `set_default` omitted | Include it in the mutation analysis or fail closed if exact effect cannot be represented | Real FK with non-null default; verify resulting SET DEFAULT behavior or explicit evaluator refusal |
| #678.3 protected candidate root ignored | Apply protection to the root as well as descendants, with anchor self-reference handled | Candidate root in protected class/live state; prove it is absent from safe candidates |
| #678.4 shared `visited` hides blocker | Track delete blockers independently and give blocking precedence over mutation | Same child reached through SET NULL and RESTRICT/NO ACTION; blocker remains in manifest |
| #678.5 quarantine comment ambiguity | Clarify that the existing fail-closed behavior intentionally protects quarantined keys | Comment review plus unchanged existing quarantine DB regression |
| #678.6 dimension-table estate guard | Apply the same `tableTouchesEstate` gate before probing dimension breakdown rows | No-edge schema/table fixture avoids probing; existing dimension protection case stays green |
| #679.1 second-hop CASCADE omitted | Enumerate all cascade edges reachable from the estate or fail closed on incomplete graph | Real estate→outside child→outside grandchild FK chain; grandchild is named or evaluation refuses |
| #679.2 composite FK split into columns | Preserve FK constraint grouping and PostgreSQL MATCH semantics, or fail closed | Real composite FK with full, partial, and null key variants |
| #679.3 `generatedAt` breaks determinism | Keep generation metadata outside the deterministic hash projection | Two unchanged DB evaluations have identical documented hash inputs |
| #679.4 dead blocked-removal enum | Either emit the reason for blocked removal or remove the unreachable reason from the contract | Fixture with a blocker; byReason count and removed-candidate reason agree |
| #679.5 duplicate reach and serial N×M probes | Reuse reach results and group `WHERE IN` probes by parent table, bounded by measured fixture size | Query-count/shape evidence on representative multi-candidate estate; same output manifest |
| #679.6 raw table-name array | Bind each allow-listed table value using the repository's supported `sql.join` pattern | Query parameters contain the names; result edge set equals the current declaration set |
| #679.7 duplicate kept-key predicate | Reuse one key derivation/filter for mapping shelter and evidence | Candidate/row key mismatch fixture; verdict and evidence use one identical key |
| #680.1 repeated estate setup | Extract `insertLegacyEstate(db, { prefix, keys, scope, status })` returning named records | Before/after persisted-row and manifest comparison |
| #680.2 weak run suffix | Use `crypto.randomUUID()` consistently in this suite | Parallel invocations produce distinct fixture prefixes; cleanup remains prefix-scoped |
| #680.3 duplicate evaluation helpers | Reuse the file-level evaluation/safety helpers in the later describes | Typecheck and unchanged assertions against both returned manifests |
| #680.4 unchecked `impact!` | Assert existence before reading each impact entry | Missing-impact mutation fails at the explicit assertion |
| #680.5 positional `slice(0,4)` | Replace positional slices with named Path A IDs | Path A cleanup assertion names its own payer/order IDs |
| #680.6 copied personal key format | Derive the external key from the production constructor/export, or use an explicit helper shared with production | Key format test refers to one source of truth |
| #680.7 misleading comments | Correct only statements contradicted by fixture state/outbox count | Review comments against inserted rows and persisted statuses |
| #680.8 vacuous round trip | Compare the actual deterministic serialization/hash projection, stripping only documented metadata | Test fails under a changed deterministic field |
| #680.9 fabricated-source setup | Assert the classification precondition before testing evaluator refusal | Mutated fixture proves the intended missing-row branch was reached |
| #680.10 fixture leakage | Ensure teardown deletes every row written by each describe, keyed only by this run UUID | Fresh DB before/after row inventory and a second suite run |
| #680.11 incomplete protected-key arms | Add direct persisted assertions for each key shape requested by the ticket; include account/ledger/reservation rows claimed protected | Real DB RED before behavior support and GREEN after; no cross-suite/customer row loss |
| #681.1 tests excluded from typecheck | Triage only: measure current TS config and consumer impact; do not widen project typecheck without an approved child scope | Current config/test compiler boundary evidence and disposition |
| #681.2 `matchedRows` contract | Triage only: trace all producer/consumer semantics and decide if a separate ticket is warranted | Call-site map and disposition |
| #681.3–6 historical low/info debts | Triage each against the current tree; close, reject, or split only within approved scope | Current code evidence per item; no inherited “deferred” status |
| #681.7–10 report corrections | Apply only against byte-verified report source; if reports are unavailable in the owning checkout, record the gap and do not reconstruct them | Exact source/report hashes and corrected archived bytes |

Edges: `T1 → T2 → T3 → T4`. T1 and T2 share one test file and a production interface; they are intentionally serial. T3 follows final implementation so report claims reference final code and verification. Parent #5 remains closed; no state change to it is authorized or needed.

## Implementation Steps (blocked until capability gate clears)

### Task 1: Repair cleanup relation decisions

**Files:**
- Modify `server/src/billing/cleanup-relations.ts`
- Test `server/tests/cleanup-relations.integration.test.ts`

- [ ] Add real-PG regression rows and assertions for each #678 correctness item: unclassified touched rows, SET DEFAULT edges, a protected root, and the SET NULL plus blocker overlap. Run each new assertion on the unmodified baseline and preserve the exact RED output.
- [ ] Add real-PG regressions for each #679 item: second-hop CASCADE, composite-FK matching (using actual PostgreSQL catalog/data), deterministic hash projection, blocked-removal reason accounting, bounded query count/shape, parameterized catalog table arrays, and a single kept-key predicate.
- [ ] Make the smallest production changes that make the RED cases pass. Preserve the ownership pass, estate boundary, and fail-closed behavior for unknown shapes.
- [ ] Run the affected cleanup integration suite against a fresh isolated database, then run all seven cleanup suites in the same isolated environment; record actual collected/pass/fail/skip counts and cleanup receipts.
- [ ] Run `cd server && bun run typecheck` and Biome on the changed TypeScript files; record baseline diagnostics separately.

### Task 2: Make the real PostgreSQL fixtures safe and explicit

**Files:**
- Modify `server/tests/cleanup-relations.integration.test.ts`

- [ ] Replace every `Math.random()` run suffix in this file with `crypto.randomUUID()`; verify no caller supplies or interprets the prior suffix shape.
- [ ] Add and verify an `insertLegacyEstate(db, { prefix, keys, scope, status })` helper returning named per-key records; migrate the three repeated estate fixtures without changing their persisted rows or test behavior.
- [ ] Share the local manifest predicates/helpers instead of retaining parallel `evaluationIn`/`isSafeIn` implementations; use named candidate groups rather than positional `slice(0, 4)` assumptions.
- [ ] Add `expect(impact).toBeDefined()` before every relevant non-null assertion; derive the “other personal key” from the production key format or a production export.
- [ ] Replace the deterministic round-trip-only claim with equality over the documented hash projection; make fabricated-source fixtures fail if fixture construction no longer meets the intended precondition.
- [ ] Correct comments to match persisted states and counts; make afterAll cleanup comprehensive and identifier-scoped.
- [ ] Add direct persisted-row assertions for each #680 protected-key arm, including account, ledger, reservation, grant, and mapping rows where each scope claims protection.
- [ ] Re-run the seven cleanup suites and typecheck/Biome after the fixture refactor; compare the baseline behavior counts with 78/0/1155, adding only the explicitly intended regression cases.

### Task 3: Correct scoped closeout reports

**Files:**
- Modify archived `audit/fix4-report.md` and `audit/fix6-report.md` through the evidence-owning archive; copy the corrected bytes and hashes into this Run's evidence.

- [ ] Correct the `Checked 3 files` statement to the observed two TypeScript files, with Markdown ignored by Biome.
- [ ] Disclose the measured `credit_ledger` size difference rather than claiming all table magnitudes stayed unchanged.
- [ ] Complete the bidirectional mapping-key validation statement, tied to the new direct DB test where applicable.
- [ ] Restore the complete failing assertion excerpt in the RED transcript.
- [ ] Run markdown/source references against final archived report bytes and verify SHA-256 before accepting the corrections.

### Task 4: Review, OCR, and prepare one PR

**Files:**
- Evidence only under `.archive/runs/<run-id>/reviews`, `ocr`, `verification`, and `checkpoints`.

- [ ] Freeze exact source tree and manifests; obtain independent Spec-compliance and code-quality review by a different agent/session.
- [ ] Resolve every valid finding within the authorized Issues; tie each repair to a new checkpoint and re-run affected DB tests.
- [ ] Run one complete final OCR over the final changed-file set, including TypeScript, test, and report files; record tool omissions as findings, not exclusions.
- [ ] Re-scan #678–#681 bodies, labels, confirmed discussion, dependency relations, parent #5, applicable policies, and current `origin/main` before delivery writes.
- [ ] Run required target-SHA checks and standard CI; if a repository-wide baseline job fails, record the exact failure and keep the PR draft.
- [ ] Create/update one draft PR for #678–#680 with acceptance mapping, exact verification results, review/OCR evidence, uncovered scope, and risks. Use `Refs #678`, `Refs #679`, `Refs #680`; do not close Issues or push main.

## Capability Blocker and Recovery

Current evidence at 2026-10-28: default `~/.local/state/openbot/coordination/v1/` is absent; no verified host override, `config.json`, unique `transaction(request)` adapter, or adapter conformance receipt was found. The repository contains the protocol and schema only. Orca can register workspaces and Runs but has no shared resource-claim transaction command. Therefore Issue/ref/worktree/database/output claims cannot be safely acquired and no write/test/GitHub side effects may start.

Resume only after the host owner makes the existing approved coordination capability available without creating a per-Run substitute: identify the one persistent coordination root, `host.json`, `registry.guard`, schema-v3 claims and repo daily ledger; provide the configured adapter absolute path/version/content hash/schema compatibility plus passing acquisition, idempotent replay, crash recovery, and fairness receipts. Then acquire the issue write set `{#678,#679,#680}` and aggregate #5 relation snapshot, local ref and workspace claims, and isolated PostgreSQL/database, port, Docker, cache, and runner-output resources atomically. Re-scan the frozen Issue/policy/base snapshots and continue T1 in this worktree.

---

**Known evidence boundary:** No implementation, test, typecheck, lint, code review, OCR, PR, or Issue write has been performed in this blocked Run.
