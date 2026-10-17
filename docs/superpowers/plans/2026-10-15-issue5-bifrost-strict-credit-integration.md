# OpenBot Issue #5 Bifrost Strict Credit Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Tasks are Orca-supervised Pi Dispatches. Each Dispatch uses a fresh child worktree, a self-contained Task Brief, a complete uncommitted checkpoint, and independent Pi review before downstream release.

**Goal:** Implement the approved Issue #5 and all 151 implementation Tickets with strict, payer-stable Bifrost admission and settlement, while keeping any unproven capability unavailable.

**Architecture:** OpenBot remains the identity, authorization, payer, credit ledger, reservation and settlement authority. Bifrost synchronously gates every provider attempt on a durable OpenBot reservation and returns usage through an idempotent settlement path. Company workbench calls bind to trusted company payer context; external Bot grants bind to the individual payer. Capability adapters are enabled only when complete pricing, reliable usage and enforceable maximum cost are evidenced.

**Tech Stack:** TypeScript/Bun, PostgreSQL/Drizzle, Go/Bifrost plugins, React, deterministic provider fakes, dedicated PostgreSQL test databases, Orca structured orchestration, Pi workers, independent Pi reviewers, and outer open-code-review.

---

## Sources and Constraints

- Issue snapshot: `docs/issue-snapshots/2026-10-15-issue5.json` (GitHub REST/GraphQL, read 2026-10-15 UTC).
- DAG: `docs/issue-snapshots/2026-10-15-issue5-dag.json` (151 unique tickets; formal `contains` 100; comment `index_membership` 51; dependencies from Ticket `Blocked by` sections).
- Acceptance mapping: `docs/issue-snapshots/2026-10-15-issue5-ac-map.md`.
- Approved Spec: `docs/specs/2026-10-14-bifrost-integration-design.md`, `docs/specs/2026-10-14-bifrost-github-spec.md`; domain terms: `CONTEXT.md`; decisions: ADR 0002/0003/0004.
- Cross-Spec resolution: company workbench always uses trusted company payer; external personal-authorized Bot always uses personal payer; insufficient balance never changes payer; personal Keys convey no company content/tool rights; company financial history is preserved. Issue #6 is an interface dependency only; its full multitenancy scope is excluded.
- No local commits, push, merge, production data cleanup/migration, deployment, enabling gateway capabilities, or release/publish. Cleanup implementation may inventory, classify, dry-run, hash, and rehearse only on dedicated test data.
- Strict admission requires complete enforceable cost maximum before provider work. Missing price, unreliable usage, unknown outcome, missing enforcement, or unverifiable provider bounds leave the capability unavailable. Do not use Bifrost periodic budgets as strict credit admission.
- All database cleanup/transaction verification uses a dedicated test database. Never fall back to development or production database. No tests are considered passed when skipped or using in-memory substitutes for transaction guarantees.
- Preserve unrelated user changes. Worker edits are limited to Ticket write scope. Each ticket checkpoint includes BASE/HEAD, staged/unstaged diff, all in-scope untracked file contents and hashes, commands/results, and Review Package. Cross-worktree integration transfers explicit increments and validates hashes.
- Each task is sequentially released only after same-snapshot verification, independent Spec-compliance and code-quality review, and integration in this worktree. Within a ready wave, dispatch immediately when files, interfaces, database, service instances, ports and build outputs do not conflict.

## Shared interfaces and integration order

- Wave 1 has the only four zero-Ticket-dependency roots: #207 GatewayEndpointConfig, #209 explicit immutable conversion rate, #215 PayerRef account mapping, #234 BotServiceRecord. Their ticket scopes must be checked for actual file overlap before concurrent start. Each has a separate child worktree.
- Shared core financial contracts are owned once: #215 establishes discriminated `PayerRef` and stable payer mapping. Downstream consumers do not redefine payer IDs or infer payer from client input.
- Subsequent consumers start only after their declared prerequisites have been verified, independently reviewed, and integrated. Ticket body dependencies are authoritative; implementation evidence may add a documented edge when a consumed interface or data model is not yet stable. The current Issue #6 company wallet/provisioning is external and remains a blocker for company-wallet acceptance where required; do not build it in this scope.
- The source DAG has no cycles, but it has 151 nodes and broad fan-in at #352. Continue with small readiness waves and do not schedule all tasks merely because GitHub lists them together.

## Shared files/interfaces consistency preflight

- Ticket #207 owns gateway endpoint persistence/config seams; #208 consumes it for encrypted credentials. #209 owns explicit ratio validation; #210 owns versioning/locking. Separate worktrees avoid concurrent edits while stable interfaces are not yet integrated.
- #215 alone establishes payer type and stable-ID mapping. #216–#220 consume this contract. Company payer routing remains trusted business context and external #6 interface; never accept a client-selected payer.
- #234 owns bot service registry; #235+ own authentication and user authorization. Service registration is not a user grant and carries no credit or content rights.
- #224 owns the versioned multidimensional `PriceSnapshot`; all capability families consume it and fail closed on unknown dimensions.
- #252–#263 own durable reservation and settlement contracts. #264+ may not implement parallel holds or redefine reservation idempotency.
- Bifrost Go plugin interfaces and OpenBot TypeScript contracts must be frozen by their producer Ticket and documented in its report before consumers start.
- Shared database fixtures are serialized where they share a DB/schema; dedicated isolated databases are used for concurrent PostgreSQL tests, never a shared mutable test database.

## Task 0: Worktree and source capture (Coordinator)

**Files:**
- Create: `docs/issue-snapshots/2026-10-15-issue5.json`
- Create: `docs/issue-snapshots/2026-10-15-issue5-dag.json`
- Create: `docs/issue-snapshots/2026-10-15-issue5-ac-map.md`
- Create: `docs/execution-ledgers/2026-10-15-issue5-ledger.md`

- [x] Verify GitHub source, parent comment pagination, official sub-issue count, index range and statuses.
- [x] Build unique graph from 100 formal children and 51 indexed Tickets.
- [x] Validate no holes, duplicates, unresolved dependency IDs, or cycles.
- [x] Create an Orca child worktree from BASE `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`.
- [ ] Save check-pointed source files and plan in the execution worktree. No commit.

Expected: all 151 tickets represented, with distinct `contains`, `index_membership`, and `depends_on` facts; DAG nodes retain each issue's full body and acceptance text.

## Ticket Task Template (repeat for each ready Ticket #207–#357)

**Files:** Exactly those listed in the Ticket `Write scope`; the worker must list paths before editing and stop/ask if any shared path is already owned by a live Dispatch.

- [ ] Read this Ticket body, approved Spec/ADR/context, and verified integrated predecessor reports.
- [ ] Write a failing public-boundary or database-backed test for the listed observable acceptance. Confirm RED.
- [ ] Implement only the Ticket result. Persist payer and reservation ownership; do not create secondary ledgers or provider bypasses.
- [ ] Test insufficient balance, supplier dispatch count, usage provenance, retry/replay, revocation, and unknown results where relevant. Use a dedicated database and deterministic provider fault injection.
- [ ] Run exact Ticket verification, typecheck, lint, relevant Go tests/race tests/build. Record exact command and exit result; skipped checks remain unverified.
- [ ] Inspect complete diff, API/error semantics, changed files, migrations and cleanup boundary. Produce independent checkpoint manifest with SHA-256 for every file.
- [ ] Submit checkpoint to a fresh independent Pi reviewer, who returns separate Spec compliance and code quality results and cannot edit files.
- [ ] If findings are valid, dispatch a focused repair to the implementation Pi, rerun affected checks and same-snapshot independent review.
- [ ] Integrate only after both reviews and validations pass; compare copied file hashes; update this ledger and unlock eligible successors.

Expected: Ticket acceptance is observable and evidenced; implementation and tests are uncommitted, with no production data or external capability enabled.

## Task 1: Frontier ready wave

Tickets: #207, #209, #215, #234.

**Dependencies:** none among implementation Tickets. They are individually stated as immediately startable. Actual write paths must be shown disjoint from current Git tree and one another before parallel dispatch.

**Role:** Pi implementer in four independent Orca child worktrees. Independent Pi reviewer after each checkpoint.

**Interfaces:**
- #207 produces `GatewayEndpointConfig { baseUrl, requestTimeoutMs, configVersion }`, `saveGatewayEndpoint`, `readGatewayEndpoint`.
- #209 produces required positive decimal conversion-rate validation and fail-closed billing readiness.
- #215 produces discriminated `PayerRef` plus unique stable mapping create/read contracts.
- #234 produces unique `BotServiceRecord`, registry queries, admin-only management; registration itself confers no credential/credit authority.

**Verification:** run each Ticket's exact tests/typecheck/lint and dedicated-DB integration test. Do not count an existing historical commit/worktree as this task's evidence; its branch is not based on the selected BASE and has not been integrated or reviewed for this run.

## Task 2+: Dependency-ready waves

For each iteration, compute tasks whose dependency set is verified in this execution worktree. Partition by disjoint file ownership, stable consumed interfaces, and isolated external resources; launch all compatible tasks as new-child Pi Dispatches. Maintain a maximum concurrency equal to verified nonconflicting work, not an arbitrary fixed wave size. Shared financial/API contracts stay single-owner. If a frontier task reveals dependency mismatch, hold its consumers and record the evidence-driven edge before scheduling more work.

## Parent aggregate: AC01–AC19 evidence

- [ ] AC01 personal account isolation and idempotent provisioning under concurrency.
- [ ] AC02 distinct per-Bot Keys share one personal balance.
- [ ] AC03 authenticated confirmation and anti-forgery/replay binding.
- [ ] AC04 competing maximum-8 reservations against balance 10 admit exactly one provider attempt.
- [ ] AC05 admission/service failures never dispatch provider work; no bypass.
- [ ] AC06 unknown price/usage/bounds reject; explicit free differs from unknown.
- [ ] AC07 streaming, cancellation/failure, duplicate delivery and restart settle without loss/duplication.
- [ ] AC08 15-minute key renewal/revocation, with liabilities surviving expiration.
- [ ] AC09 preferences resolve by precedence; unavailable model fails explicitly.
- [ ] AC10 5-minute sync/15-minute freshness defaults, scope preservation, no repricing in-flight holds.
- [ ] AC11 deletion/disable/drift detected; manual Keys remain unmanaged and gated.
- [ ] AC12 explicit ratio required; new versions only affect new requests; fractional remainder accurate.
- [ ] AC13 trusted company payer for company workbench, personal payer for external Bot, no fallback, no cross-scope tools/content, clear subscription harness path.
- [ ] AC14 personal orders/grants/rewards/subscriptions/callbacks are persisted and isolated by ownership.
- [ ] AC15 expiration during admitted work settles; expired remainder not resurrected; unknown holds remain unavailable.
- [ ] AC16 realtime bounded-unit reservation/stop and async full-job reservation/query no double charge.
- [ ] AC17 durable unknown-result recovery, alerting, evidence-based resolution and retained liability.
- [ ] AC18 cleanup dry-run/hash and dedicated-test-data rehearsal only; company history and business objects preserved; no production deletion.
- [ ] AC19 user/admin access and no raw Keys in browser/messages/ordinary logs.

For each AC record source Ticket IDs, concrete test/check or code evidence, snapshot hash, exact verifier command, result, reviewer decision, and any capability explicitly kept unavailable due to missing supplier evidence. Do not mark unknown conformance as pass.

## Final review and outer OCR

- [ ] Independent strongest available Pi worker reviews full original BASE to final delivery snapshot, with Spec and quality findings separated. Verify actual Pi model and thinking configuration from runtime evidence; do not infer from requested arguments. Focus on immutable payer, revocation, pre-provider admission, complete max cost, atomic reserve, idempotent settlement, unknown holds, payer remainder, callback ownership and cleanup boundaries.
- [ ] Run OCR with configured strongest available provider, `--audience agent`, Bifrost background and unique round report. Review all uncommitted files in workspace mode and (only if commits later exist, which are not authorized here) BASE-to-HEAD separately. Record model/provider, warnings, exit, budget and file coverage.
- [ ] Route valid critical/high/medium findings through a focused repair plan and Pi Dispatch, validation, independent review, then rerun OCR until full scope passes.
- [ ] No final claim of completion unless every deliverable node is verified, all required checks passed, full review passed, full OCR coverage passed, and no valid critical/high/medium finding remains. Any external authorization or evidence blocker remains explicit.
