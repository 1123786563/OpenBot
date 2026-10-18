# MT001 Inventory Completeness Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three independently verified Medium findings in MT001 so the inventory does not understate known external dependencies, background programs, or deployed service surfaces before it becomes an A11/MT132 coverage source.

**Architecture:** Keep the existing inventory schema and truthful evidence model. Extend static source extraction for actual repository paths and program forms, then make deployed-but-unassembled service surfaces explicit in inventory and gap output rather than silently omitting them. Add regression tests for each finding and regenerate the MT001 checkpoint against the changed snapshot.

**Tech Stack:** TypeScript, Bun, Hono, Node filesystem/source scanning, existing MT001 JSON/Markdown inventory output.

**Spec:** `docs/specs/2026-10-14-company-team-multitenancy-design.md` (A11 and §8 coverage matrix); source issue snapshot `docs/plans/2026-10-15-company-team-multitenancy-execution/github-intake.json` (#44, #6); original implementation plan `docs/plans/2026-10-15-company-team-multitenancy-execution.md`; independent findings `archive/plans/multitenancy-execution/reports/MT001-review.md`.

## Global Constraints

- Follow accepted ADR 0004 and ADR 0002/0003 plus root `CONTEXT.md`; do not infer isolation or ownership that source evidence does not establish.
- Keep MT001's static inventory distinct from live database verification; a missing `TEST_DATABASE_URL` must never fall back to `DATABASE_URL`, and skipped stages remain explicitly skipped.
- Inventory evidence must identify its source and distinguish assembled/verified surfaces from static candidates or known unassembled surfaces.
- Preserve the existing JSON contract fields consumed by later coverage tasks; add fields only compatibly and document any additive contract.
- No commit, push, merge, production data migration, deploy, tenant enablement, or release. Use an uncommitted hash-backed checkpoint.

## Review Focus

- Wrong or stale source paths: regression tests prove actual `src/kb/config/index.ts` is scanned and dependencies appear.
- Non-standard daemon forms: regression tests prove loop/BullMQ/cron entry points are represented with source evidence.
- Services outside the four current app assemblies: output must explicitly show each known deployed service surface and its coverage status, not imply complete route coverage.
- False positive ownership: new evidence is `unowned`/unverified until an explicit ticket owner is provided.
- No test database: existing refusal/no-fallback and explicit-skip tests continue to pass.

---

## File map

- `server/scripts/multitenancy/inventory.ts`: external dependency, background program, and service-surface extraction/output.
- `server/tests/multitenancy/inventory.test.ts`: regressions for the three review findings and contract/digest stability.
- `archive/plans/multitenancy-execution/reports/MT001.md`: append repair evidence and changed inventory digest; retain the original report history.
- `archive/plans/multitenancy-execution/checkpoints/MT001-fix/`: complete uncommitted checkpoint and hash manifest for this review-fix round.

## Task 1: Repair MT001 A11 inventory completeness gaps

**Depends on:** Original MT001 source snapshot and independent review Task `task_dd99d9577f09` / Dispatch `ctx_a5c5b74f62f3`; no downstream consumer may start until this task is implemented, independently reviewed, and integrated.

**Role:** `backend_implementer`; independent `reviewer` after implementation. Both launched only through Orca with `--agent pi`.

**Owned files:** The two MT001 source/test files above and the MT001 report/checkpoint paths listed above. Do not edit any other product file, later Ticket, Spec, ADR, or MT132 implementation.

**Consumes:** Existing `CoverageInventory` shape from the original MT001 report and package; actual deployed sources identified in `MT001-review.md` findings 1–3. The review findings are requirements to verify, not instructions to blindly copy code.

**Produces:** A compatible inventory whose external dependency set includes Redis, Qdrant, Ollama, and WeChat Pay where repository configuration establishes them; background program entries include the known routines worker loop, BullMQ KB worker, and cron scripts with file/line evidence; and service-surface output/gap reporting explicitly lists supervisor, go-runtime, agent-computer, and agent-sandbox as statically known but not app-assembled/route-enumerated unless real assembly extraction can be safely added within the existing seam. The report must distinguish these unassembled surfaces from complete coverage and preserve unowned status.

- [ ] **Step 1: Add failing regression tests** for each finding: actual KB config path and Redis/WeChat env naming produce dependencies; worker loop/BullMQ/cron sources produce background-program entries with stable IDs and evidence; known extra deployment services appear in a dedicated, explicit service-surface coverage section and affect digest.
- [ ] **Step 2: Run focused tests and confirm RED.** Run `bun test server/tests/multitenancy/inventory.test.ts`; expected: new assertions fail specifically because known dependencies/programs/service surfaces are absent.
- [ ] **Step 3: Implement the minimal extraction and explicit coverage representation** in `inventory.ts`. Use actual source paths and patterns verified against source. Do not claim HTTP route enumeration for processes that are merely listed; if route assembly cannot be safely created, represent them as `unassembled`/`not_enumerated` surfaces in JSON and the human-readable report.
- [ ] **Step 4: Run focused tests and full task checks.** Run `bun test server/tests/multitenancy/inventory.test.ts`, `cd server && bun run typecheck`, and `bunx biome check server/scripts/multitenancy/inventory.ts server/tests/multitenancy/inventory.test.ts`; expected: all pass, no skips in the static inventory suite, with existing database-stage skips still explicit when TEST_DATABASE_URL is absent.
- [ ] **Step 5: Regenerate and inspect inventory artifacts.** Run the inventory CLI to temporary JSON/report outputs; verify Redis/Qdrant/Ollama/WeChat Pay and known background programs appear; verify all four extra service surfaces are visible and honestly marked; verify deterministic digest across two runs; verify no secrets/URLs with credentials were written.
- [ ] **Step 6: Update the MT001 report and create a complete fix-round checkpoint.** Record exact commands/results, current HEAD, full source diff, staged/unstaged/untracked files and hashes, generated inventory/report, and changed digest. Do not rewrite or erase the original pre-fix checkpoint/package.
- [ ] **Step 7: Self-review scope and send worker_done** with report/checkpoint paths and hash manifest; do not commit.

**Verification expected:** focused suite passes, typecheck and Biome pass, deterministic regenerated inventory reports all verified examples, no silent omissions for the three findings, existing no-fallback and explicit-skip behavior remains covered, checkpoint hashes recompute cleanly.

**Failure handling:** If a service surface cannot be safely enumerated, report it as an explicit uncovered surface and retain the Medium finding as unresolved; do not mark MT001 verified. If a source cannot be reached or environment blocks a check, mark it blocked rather than passed.

## Consistency preflight

- This is a focused repair wave for only the three Medium findings; it does not redesign tenancy, change the Spec, or implement MT132.
- File ownership is confined to the MT001 source/test and its evidence package; no active task shares those files.
- The inventory contract remains additive and names the service surface coverage distinction explicitly; its final exact type/field is to be fixed by the implementer and recorded in the report before handoff.
- No downstream DAG node is released by this plan alone. MT001 must pass a fresh independent Pi review and be integrated before MT003, MT013, MT131, or other consumers may run.
