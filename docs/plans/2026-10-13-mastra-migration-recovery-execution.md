# Mastra Intelligence Migration Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume the approved Mastra migration from its exact reviewed checkpoints and complete remaining acceptance without losing existing work.

**Architecture:** Mastra owns durable thread history, memory and learning; OpenBot keeps Agent execution, tools, approvals, recovery, Runner and API. This plan coordinates the existing parent DAG and detailed slice plans. It changes no approved product boundary.

**Tech Stack:** TypeScript, Bun, Hono, CopilotKit SSE, Mastra, Drizzle/PostgreSQL, Orca supervised workers, OCR.

**Spec:** `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md`; DAG `docs/plans/2026-10-11-mastra-intelligence-only-dag.md`; parent plan `docs/plans/superpowers/2026-10-10-mastra-intelligence-migration.md`.

## Global Constraints

- Work only in `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`; preserve all user changes. No commit, stage, stash, reset, rebase, merge, push, PR, publish, or worktree deletion.
- Do not start, reset, modify, probe, or access the local database service or production database. Database acceptance uses only an explicitly configured isolated test database when ready; until then record it unverified.
- Every production change starts with a focused failing test, then implementation and focused green verification. Every frozen increment requires exact file hashes, protected-file comparison, independent validator and independent Spec/quality reviewer.
- Default implementation order is serial in this shared worktree. Parallel work is limited to read-only inspection or disjoint validation with no shared test state. Subagents do not spawn agents.
- Output ceiling comes from the caller per Run; each Run has its own budget. Runtime stream `type` fails closed: cancel stream, settle unknown and do not confirm usage.

## Review Focus

1. Request-owned failure must commit after its Run row becomes `failed`, while stale/expired ownership rolls back.
2. SSE production mount must use OpenBot's durable Runner and authenticated thread scope; helper-only tests do not prove production wiring.
3. Every model call must obey the remaining Run ceiling, and malformed stream `type` must cancel with unknown usage.
4. History, memory and learning must use authorized Mastra storage without replacing tools, approvals, pause/resume or skill learning.
5. Reconnect/import/cutover must prevent duplicate events, cross-tenant data, and two writable message backends.

## Recovery evidence and DAG

Read 2026-10-13 from the approved spec, parent DAG/ledger, Fix2/Fix3 plans, Briefs, implementer/validator/reviewer reports and Git. No Issue was supplied. HEAD is `b1532dbe4ec4d2e64b58fd31c57a7c1863ffd155`; 62 dirty/untracked paths existed at recovery. T1 is verified at its recorded checkpoint. Route catalog Fix2 is independently verified for DB-free scope and its current source/test SHA256 match `ca0050ceb582766167dc7329776906a46de96a2d46c0b41f763792771ced4dee` / `2dc43a6b19ab0e9f22407e0cf7a0b411cc5ed3049f2897776dbd65830336dfe3`. It is not re-dispatched. Failure API Fix2 has a valid High finding; its current source/test SHA256 match `5394210ecae3d531ddfcd860ffea287fc56ee521be557f5cbb94778ed92005da` / `e3b024f4c68a63dc62fe90229099f0145b643fe9949bbb5887ae75bb25643c04`. Fix3 is ready. Parent T2 is running; T3–T10 are pending.

`F3 repair → F3 validation → F3 review → trusted expert-version prerequisite → T2 Runner/SSE admission → T2 governed built-in model execution → T3-CORE full-parts history → T2 headless cutover → T2/T3 isolated DB gates → T4/T5 → T6 → T7/T8 → T9 → T10 → complete OCR`.

The approved parent DAG decides exact dependencies between T3–T10. A later Task starts only after all prerequisites are verified and integrated in this worktree. Read-only interface mapping for the next slice can run alongside F3; no concurrent source edits or DB tests.

## Task 1: Close request-owned failure High finding

**Depends on:** Fix2 frozen baseline. **Owner:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Owned files:** `server/src/enterprise/runs/store.ts`, `server/tests/enterprise/run-failure-contract.test.ts`, Fix3 report/checkpoint files. **Interfaces:** consumes `RunStore.transitionTerminal` and `RunnerRequestLease`; produces atomic `RunService.fail` behavior needed by SSE admission.

- [ ] Follow every step in `docs/plans/2026-10-13-mastra-run-request-failure-fix3.md` and `.superpowers/sdd/2026-10-13-mastra-run-request-failure/fix3-brief.md`: full baseline; test RED against current post-update status defect; minimal SQL repair; test GREEN, Biome/diff/type checks; exact uncommitted checkpoint.
- [ ] Backend validator checks same hash and repeats DB-free behavior/static checks. Reviewer returns separate Spec and quality verdicts on the increment. A valid High/Medium finding creates a numbered repair plan and repeats this gate.
- [ ] Mark only DB-free behavior verified. PostgreSQL transaction/RLS/concurrency remains unverified.

## Task 2: Establish trusted immutable expert version for Run admission

**Depends on:** Task 1 reviewed checkpoint and verified route catalog Fix2. **Owner:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Owned files/interfaces:** to be fixed in a scoped detailed plan after the read-only source audit at `.superpowers/sdd/2026-10-12-mastra-t2-runner-sse-admission/reports/expert-version-source-evidence.md` and architecture report.

- [ ] Identify the authorized selected Bot and its execution-relevant immutable configuration. Produce a server-owned `expertVersionRef` distinct from model `routeRef`, with restart-safe resolution and fail-closed drift/unknown-ref behavior. Do not substitute Bot ID, mutable `updatedAt`, or a fixture constant.
- [ ] Write and run DB-free RED tests for stable version identity, changed execution configuration, unauthorized Bot, cross-tenant/mismatched route, and restart resolution. Implement minimal version snapshot persistence/interface, then run GREEN, static checks, exact checkpoint and independent gates. Database durability/RLS remains pending isolated DB.
- [ ] Revise the T2 Runner admission Brief to consume this reviewed producer before starting a Run. The current `modelRouteFor(scope, threadId)` has no selected-Bot version source; do not call it with a fabricated value.

## Task 3: Resume production Runner and SSE admission

**Depends on:** Tasks 1–2 reviewed checkpoints. **Owner:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Owned files/interfaces:** exact ownership and consumes/produces contract in `docs/plans/2026-10-12-mastra-t2-runner-sse-admission.md` and its Task Brief.

- [ ] Recheck source signatures and all current/protected hashes; preserve the existing uncommitted work.
- [ ] Write and run RED tests for request-local authenticated scope, finalized intent, caller cap, selector/runId rejection, unavailable capability and mounted SSE behavior.
- [ ] Compose verified directory/data capabilities, durable Run/Event services and request-bound Runner. Use `RunService.fail` for admitted no-model refusal; a stale false result is failure. Mount actual CopilotKit SSE; never run an ungoverned model.
- [ ] Run focused GREEN, Copilot compatibility, changed-path typecheck, Biome and diff checks; freeze exact hashes. Validator and reviewer inspect the same checkpoint. DB-backed cases remain pending.

## Task 4: Finish T2 governed execution and headless cutover

**Depends on:** Task 3 reviewed checkpoint. **Owner:** backend_implementer. **Validator:** backend_validator. **Reviewer:** reviewer. **Owned files:** to be frozen in a continuation Brief from parent T2 ownership before edits; shared `copilot.ts` is serial. **Interfaces:** actor-authorized Bot, immutable `expertVersionRef`, model route catalog, AI SDK v3 gateway adapter, Run invocation capability, SSE event API.

- [ ] Consume the reviewed immutable expert version producer from Task 2 and pin it to the admitted Run; reject unresolved or changed versions.
- [ ] RED for Run aggregate budget equal to explicit caller cap, each invocation cap no greater than remaining budget, malformed stream `type` cancellation and unknown usage, remote refusal where enforcement/usage cannot be proven, and preserved tools/approval/recovery.
- [ ] Wire the governed built-in execution path; migrate headless consumers of Intelligence runner/history/thread lock to OpenBot APIs. Run focused GREEN, all affected Copilot/Run tests, static checks and independent gates. Do not begin headless cutover until governed execution and T3-CORE full-parts history checkpoints pass independent code gates. T3-CORE consumes the reviewed T1 and T2-SSE/T2-GOV interfaces; it is not gated on T2 aggregate completion. T2 aggregate remains incomplete until headless cutover and isolated database acceptance pass.

## Task 5: Complete parent DAG T3–T9

**Depends on:** T3-CORE code work consumes reviewed T1/T2-SSE/T2-GOV checkpoints; its database acceptance remains unverified until the isolated database is ready. All other parent prerequisites remain binding; T4–T9 require their exact parent interfaces/checkpoints. T2 aggregate acceptance includes the later headless consumer and database gates. **Owners:** backend_implementer for T3–T6/T8/server T9, frontend_implementer for T7/frontend T9. **Validators:** matching backend/frontend validator plus reviewer. **Owned files/interfaces:** exact per-task sections in `docs/plans/2026-10-11-mastra-intelligence-only-dag.md`.

- [ ] For each task, prepare one narrow Brief from its existing plan section; verify current hashes and prior interfaces. Execute RED → GREEN → REFACTOR, checkpoint, validation, Spec/quality review, repair loop. Serialize all shared-file edits.
- [ ] T3 covers single writable Mastra history and intent receipts; T4 authorized memory/revocation; T5 skill learning; T6 three execution sources; T7 chat UI; T8 staged import/CAS cutover; T9 remove Intelligence setup/dependencies without removing remote Mastra execution.
- [ ] Keep DB-backed acceptance unverified until the user-configured isolated database is available. Do not infer readiness from environment variables alone or retry against an unknown target.

## Task 6: Final acceptance and OCR

**Depends on:** T1–T9 verified. **Owner:** coordinator for gates, validators/reviewer for independent evidence. **Owned files:** test evidence, ledger, OCR reports and scoped fixes only.

- [ ] Map every approved design acceptance to a tested Task and checkpoint. Run necessary focused/integration/type/lint/build checks and review complete diff; record environment blockers honestly.
- [ ] Run `ocr review --audience agent --background <approved migration context> --output <full report>` in workspace mode to cover staged, unstaged and untracked delivery. If committed scope changed since original BASE, separately review BASE→HEAD. Check exit, selected/failed files and warnings; no partial coverage passes.
- [ ] For every valid Critical/High/Medium finding, write a numbered scoped repair plan, dispatch correct specialized implementer for RED/GREEN, revalidate and independently review, then rerun full OCR. Continue until complete coverage with no valid blocking finding.
- [ ] Record final hashes, test results, Review/OCR rulings and isolated DB status in the persistent ledger. Do not claim full migration complete while database acceptance is blocked.

## Shared interface and ownership preflight

Task 1 writes only failure store/test; read-only Task 2 interface mapping may overlap source reading. Tasks 2–4 share production composition and therefore edit serially. T3 supplies history receipts to T4/T5/T6; T7 and T8 consume frozen APIs and are serial by default in this worktree. T9 removes dependencies only after consumers are migrated. No cycles or orphan acceptance are introduced by this recovery plan; parent DAG remains authoritative for detailed acceptance mapping.

## Execution-order ruling — full-parts headless history (2026-10-13)

Ruling: the old aggregate edge produces the cycle `T2 aggregate → headless fidelity → T3 history → T2 aggregate`. Evidence at `.superpowers/sdd/2026-10-12-mastra-t2-production-cutover/reports/headless-history-dependency-ruling-evidence.md` (SHA256 `044ecb1eac2308321a8d955cb48ff161311702cb918337609f711eb1a5337312`) proves current MessageDTO/text-only writer cannot preserve toolCalls/toolCallId/activityType. Split execution into T2-SSE, T2-GOV, T3-CORE, and T2-HEADLESS; the parent T2 remains an aggregate acceptance node, not the prerequisite for its own downstream history producer. No design acceptance is removed: T3 keeps single writable Mastra full-parts history and intents; T2 keeps successful browser/headless execution and governance. Temporary refusal is not headless completion. Shared source edits remain serial. DB-free checkpoints can be reviewed and consumed in this worktree, while PostgreSQL persistence/RLS/concurrency/restart checks stay unverified. Cost if wrong: additional interface refinement at the headless consumer gate; no migration completion can be claimed from disabled consumers or flattened history.
