# Mastra migration Orca continuation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement each assigned plan Task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continue the approved Mastra Intelligence migration from the current uncommitted, reviewed checkpoints without redesign or branch integration.

**Architecture:** Mastra owns durable thread history, memory and learning. OpenBot owns Agent execution, tools, approvals, pause/resume, SSE transport, Runner/API history, Run budgets and explicit output ceilings. This plan is an execution index over the approved detailed plans, not a new design.

**Tech Stack:** TypeScript, Bun, Hono, CopilotKit SSE, Mastra, Drizzle/PostgreSQL, Orca supervised Claude workers, OCR.

**Spec:** `docs/specs/superpowers/2026-10-11-mastra-intelligence-only-design.md`; DAG and acceptance map `docs/plans/mastra/intelligence/2026-10-11-mastra-intelligence-only-dag.md`; recovery plan `docs/plans/mastra/intelligence/2026-10-13-mastra-migration-recovery-execution.md`.

## Global Constraints

- Exact workspace: `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`; HEAD at recovery: `b1532dbe4ec4d2e64b58fd31c57a7c1863ffd155`.
- Preserve all existing user changes. No stage, commit, stash, reset, rebase, merge, push, PR, publish or worktree deletion.
- Do not start, reset, modify or access a local database service or production database. Database acceptance remains unverified until the isolated test database is explicitly ready.
- No Codex child worker. Orca dispatches Claude workers. A worker receives one Task, uses `superpowers:executing-plans`, and spawns no further agent. The coordinator owns independent validation and review dispatches.
- TDD for production behavior: test RED, smallest implementation, test GREEN. A test-only evidence repair records its actual first run and does not fabricate RED.
- Every Task freezes before/after hashes, full uncommitted increment including new files, test evidence, independent validation and separate Spec/quality review. Changed bytes invalidate the corresponding evidence.

## Review Focus

1. Trusted selected Bot/version and route refs must survive restart without accepting mutable or fabricated identity.
2. SSE admission must use authenticated thread scope and finalized Mastra intent; transport disconnect must not cancel a product Run.
3. Each Run uses its caller ceiling; malformed stream `type` cancels and settles unknown usage.
4. Message, memory and skill learning boundaries must preserve existing tools, approval and recovery behavior.
5. Import and cutover must prevent duplicate or cross-tenant history and dual writable backends.

## Recovery ledger and ready DAG

The parent Ledger is `.superpowers/sdd/2026-10-11-mastra-intelligence-only-dag/progress.md`. The Expert prerequisite Ledger is `.superpowers/sdd/2026-10-13-mastra-t2-expert-version-prerequisite/progress.md`. T1, route catalog Fix2, request failure Fix3, Expert catalog, Expert descriptor A-F1 and trusted admission B have prior independent DB-free evidence at their recorded exact hashes; do not reassign them. T2-SSE now has validator PASS and independent Spec/quality PASS at its exact four-file checkpoint, recorded in `.superpowers/sdd/2026-10-12-mastra-t2-runner-sse-admission/progress.md`. Current HEAD is unchanged. Isolated PostgreSQL gates are unverified.

| Node | Depends on | Status | Owner / validator | Plan and output |
| --- | --- | --- | --- | --- |
| A-F1 | Task A initial reviewed checkpoint | verified at test SHA256 `c7bc545c9bd9241186f43710da78d7a9bcfc98d4bce248a045c9b4cd38e262de` | backend implementer / backend validator | `.archive/runs/legacy-plans/2026-10-13-mastra/briefs/2026-10-13-mastra-t2-expert-descriptor-fix1.md`; test-only checkpoint closing A1/A2 |
| A-R | A-F1 frozen checkpoint | verified; Spec PASS / Quality PASS | independent reviewer | Separate report `task-a-fix1-reviewer-report.md` |
| B | A-R pass, Expert catalog Task 1 verified | verified for DB-free scope; Spec PASS / Quality PASS | backend implementer / backend validator | Task B of `docs/plans/mastra/intelligence/2026-10-13-mastra-t2-expert-admission-bridge.md`; distinct immutable Expert ref at Run admission |
| SSE | B reviewed checkpoint, request failure Fix3, route catalog Fix2 | verified DB-free; validator PASS, Spec PASS, Quality PASS | backend implementer / backend validator | `docs/plans/mastra/intelligence/2026-10-12-mastra-t2-runner-sse-admission.md`; mounted durable Runner/SSE and intent gate, database gates open |
| Remote tests | accepted Task A fail-closed ruling and SSE frozen checkpoint | verified DB-free; validator PASS, Spec PASS, Quality PASS | backend implementer / backend validator | `.archive/runs/legacy-plans/2026-10-13-mastra/briefs/2026-10-13-mastra-remote-stale-tests-fix1.md`; repaired 18 stale assertions without production edits; low evidence-format note in Ledger |
| T2-GOV | SSE reviewed checkpoint | success, route and built-in execution plans ready; first implementation pending | backend implementer / backend validator | `docs/plans/mastra/intelligence/2026-10-13-mastra-governed-run-success.md`, `docs/plans/mastra/intelligence/2026-10-13-mastra-governed-route-rebind.md`, `docs/plans/mastra/intelligence/2026-10-13-mastra-governed-built-in-execution.md` |
| T3-CORE | T1, SSE, T2-GOV reviewed code checkpoints | pending | backend implementer / backend validator | full-parts Mastra history and intents; DB acceptance separate |
| T2-HEADLESS | T2-GOV and T3-CORE reviewed code checkpoints | pending | backend implementer / backend validator | existing routine/responsibility/handoff consumers use OpenBot Runner/API and full-fidelity history |
| T4–T6 | parent DAG prerequisites and reviewed T3-CORE/T2-HEADLESS interfaces | pending | backend implementer / backend validator | memory, learning and execution adapters per parent plan; aggregate database gates remain open |
| T7–T8 | parent DAG prerequisites and frozen APIs | pending | frontend implementer for T7; backend implementer for T8 / matching validators | chat UI and staged import; parallel only with separate existing workspaces or demonstrably disjoint ownership and stable interfaces |
| T9–T10 | parent DAG prerequisites | pending | role-specific workers / validators and reviewer | dependency removal, acceptance map, final full-scope OCR |

The shared workspace runs source edits serially. Read-only mapping and disjoint, non-database validation may overlap a source worker after its file set is frozen. Database tests, shared test outputs and `copilot.ts` edits never overlap. The refined code dependency order is `T2-SSE → T2-GOV → T3-CORE → T2-HEADLESS`; the parent T2 and T3 aggregate acceptances retain their database gates. For each row, the coordinator checks the previous row's hashes and independent verdict before releasing the dependent row. A failed review becomes a numbered, narrow plan and a fresh worker attempt; it does not restart verified work.

## Task 1: Close Expert descriptor evidence A1/A2

**Files:** Test `server/tests/agents/expert-descriptor.test.ts`; protect `server/src/agents/runtime-agents.ts`, `server/src/agents/agent-resolver.ts`, `server/src/copilot.ts`.

**Interfaces:** Consumes `createRuntimeAgentLoader`, `createActorAgentResolver`, the built-in Agent prompt seam and the reviewed Task A descriptor. Produces evidence that loader provenance, actor filtering, off-roster denial and prompt identity are exercised.

- [ ] Confirm baseline hashes, save complete before inventory and focused file content.
- [ ] Follow every step and assertion in `.archive/runs/legacy-plans/2026-10-13-mastra/briefs/2026-10-13-mastra-t2-expert-descriptor-fix1.md` and `.superpowers/sdd/2026-10-13-mastra-t2-expert-version-prerequisite/task-a-fix1-brief.md` using `superpowers:executing-plans`.
- [ ] Run the new focused test before any product edit and record the actual result. If it reveals a product defect, stop and report for a new source-fix plan.
- [ ] Run focused descriptor/resolver checks, scoped Biome and diff check. Save after hashes, exact increment, command outputs and implementation report. Do not access a database.
- [ ] Coordinator dispatches independent backend validation and review against the same hash. Only Spec PASS and Quality PASS close A1/A2; otherwise create a numbered fix plan and repeat.

## Task 2: Continue Expert admission and production T2

**Files:** Use the exact ownership in the Task B and SSE plans and Briefs; no ownership is inferred from this index.

**Interfaces:** Task B consumes Task A's authorized immutable Expert descriptor and Expert catalog; produces a distinct Expert ref for Run admission. SSE consumes that ref, the reviewed route ref, fenced Run request failure and Event service; produces mounted request-bound Runner/API.

- [ ] Recheck the preceding frozen hashes and the current protected-file inventory before each dispatch.
- [ ] Dispatch Task B, then its backend validator and independent reviewer. Repair valid findings with numbered plans and fresh checkpoints.
- [ ] Dispatch SSE only after Task B passes; enforce RED → GREEN for the stated mounted request and fail-closed cases, then freeze, validate and review.
- [ ] Continue parent T2's governed built-in and headless cuts as narrow serial briefs. Each has its own RED/GREEN, checkpoint, validator and reviewer. Keep database acceptance open until the isolated database exists.

## Task 3: Complete parent DAG and outer review

**Files:** Follow parent DAG T3–T10 ownership. **Interfaces:** Frozen T2 Run/Runner/history/Expert contracts feed later slices.

- [ ] Run each ready slice in topological order; use frontend specialists for T7 and frontend T9, backend specialists for backend slices. Do not dispatch a dependent Task from an unreviewed checkpoint.
- [ ] Map every design acceptance to exact tests and frozen hashes. Record unresolved isolated database cases as unverified.
- [ ] Once SDD tasks pass, run `ocr review --audience agent --background <approved migration context> --output <round-report>` in workspace mode for all staged, unstaged and untracked deliverables. Verify selected files and failed/skipped files. If committed delivery has changed since original BASE, separately review BASE..HEAD.
- [ ] For every valid Critical/High/Medium finding, write a numbered `writing-plans` repair plan, dispatch a specialist worker through Orca, validate/review the new checkpoint, then rerun complete OCR. Do not claim completion until OCR covers the full delivery and no such finding remains.

## Preflight and self-review

Task A-F1 shares no writable source with read-only interface mapping. Task B consumes Task A's descriptor; SSE consumes Task B's immutable Expert ref. Parent T2's `copilot.ts` and T6's execution adapter are strictly serial. T7 and T8 can form a ready wave only after frozen API and separate ownership; shared worktree edits stay serial. The parent DAG covers design acceptance; this continuation adds no independent product requirement. No cyclic edge or orphan acceptance is introduced.
