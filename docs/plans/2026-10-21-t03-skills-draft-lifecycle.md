# T03 Skills draft lifecycle verification repair plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that the production Skills route preserves a dirty new-skill form draft across the DetailPanel's inline-to-Sheet-to-inline breakpoint transition.

**Architecture:** Exercise the real Skills route with a memory router and pre-seeded React Query cache. Drive the real DetailPanel ResizeObserver boundary and type through the public form input event. This is a test-only task unless the regression exposes a production defect; any production change must remain inside the existing T03 limited draft-state ownership/prop-wiring authorization.

**Tech Stack:** React, TanStack Router, TanStack Query, tester-army `e2e`, repository E2E compatibility layer, Happy DOM.

**Spec:** `docs/design/2026-10-20-workspace-redesign/handoff/refinement/implementation-detail.md` §4–6; `docs/plans/2026-10-20-workspace-redesign-b1.md` T03; `.archive/runs/2026-10-20-workspace-redesign-b1/verification/t08/page-acceptance.md` shared-layer smoke scope.

## Global Constraints

- Keep scope to the authorized T03 draft-lifecycle compatibility behavior; do not redesign P24 Skills or change create/save behavior.
- Do not add product dependencies or persist skill drafts to storage.
- Preserve all pre-existing uncommitted work; do not commit, push, merge, publish, or deploy.
- Use ADR 0008's `e2e` runner and report actual collected/executed counts; zero collection is not a pass.
- OCR is explicitly prohibited by the user; do not run it. Rendered browser acceptance remains deferred by the user.

## Review Focus

- **Draft value across branch remount:** edit a real Skills field, cross C=880→879→880, and assert the value remains.
- **Dirty-state propagation:** assert the production form's `data-dirty` state remains true after each branch transition.
- **Public input seam:** use a real Testing Library input event; do not call React private props.
- **Route-owned lifecycle:** render the production Skills route and use its actual search state, not a hand-written draft-owner substitute.
- **Side-effect boundary:** verify the resize transition emits no memory-history navigation event, closes no route, and clears no draft.

---

### Task 1: Cover production Skills draft retention across DetailPanel remount

**Dependencies:** Existing T03 implementation is verified; no production interface changes are expected.

**Role:** `frontend_implementer`; independent validator `frontend_validator`; independent Spec/quality reviewer `reviewer`.

**Files:**
- Create: `app/tests/skills-draft-lifecycle.test.tsx`
- Create: `.archive/runs/2026-10-20-workspace-redesign-b1/briefs/T03-skills-draft-lifecycle.md`
- Create: `.archive/runs/2026-10-20-workspace-redesign-b1/reports/T03-skills-draft-lifecycle-impl.md`
- Create: `.archive/runs/2026-10-20-workspace-redesign-b1/verification/t03-skills-draft-lifecycle/independent-validation.md`
- Create: `.archive/runs/2026-10-20-workspace-redesign-b1/reports/T03-skills-draft-lifecycle-review.md`

**Interfaces:**
- Consumes production `SkillsRoute` from `@/routes/_authed/_app/skills`, `pluginKeys.page()`, `authKeys.currentUser()` (or query option key), the public search contract `{ new: true }`, and `DetailPanel`'s 400px detail width / 480px main threshold.
- Produces one native `e2e` test that renders `/skills?new=true`, seeds the existing query cache, edits the title field using Testing Library, drives observed content width 880→879→880, and asserts visible field value and `data-dirty="true"` remain inside both branches. Subscribe to memory history after initial route resolution and assert the resize sequence emits no navigation event; also assert the route remains open at each width.

**PRE / ownership:**
- Before implementation, coordinator records HEAD/status and a PRE hash/copy of the new file path (absent state) in `.archive/runs/2026-10-20-workspace-redesign-b1/verification/execution/checkpoints/t03-skills-draft-lifecycle/PRE/`.
- Only this Task's implementer may create the test file. Production source is read-only unless the test demonstrates a defect in the already-authorized T03 state handoff; any such change requires an explicit bounded follow-up checkpoint and affected validation.

**Steps:**

- [x] Read ADR 0008, the current `SkillsRoute`, existing Skills test harness, and DetailPanel ResizeObserver helper.
- [x] Write the production route test using seeded query cache, memory router, and route singleton restoration.
- [x] Run focused native E2E; initial public input attempt exposed a React Aria synthetic-change limitation, then `userEvent.type` passed without production edits.
- [x] No production defect was demonstrated; no source change was made.
- [x] Focused native E2E passed (1 file / 1 test); scoped Biome and `git diff --check` passed on final R3 snapshot.
- [x] Independent validator confirmed final checkpoint hashes and behavior; reviewer returned separate Spec PASS and quality PASS on POST-R3.
- [x] POST-R3 hashes, checkpoint copies, verification and review reports are recorded in the main Ledger. Browser acceptance remains pending; OCR remains prohibited.

**Acceptance / failure handling:**
- PASS only if the test is collected and executed, the production route remains open throughout resize with zero resize-triggered history events, and the user-entered title plus dirty state survive both transitions.
- If Happy DOM cannot dispatch the public input event or the route harness cannot safely use the exported route singleton, report the exact failure and stop before using private React handlers or replacing the route with a synthetic owner.
- If the test reveals a production defect, fix only within the existing six-file T03 compatibility boundary and rerun applicable Skills, app typecheck, and affected app-native/driven validation. Do not claim browser geometry from this test.

## Consistency self-review

- **Spec coverage:** This plan closes a T03 evidence gap for the explicitly permitted Skills draft-ownership compatibility step; it does not claim browser or P24 visual acceptance.
- **Step scan:** Each step has one verifiable result; implementation, focused execution, static check, independent validation, review, and Ledger update are separately tracked.
- **Type consistency:** Test consumes existing Skills route/search/query contracts and emits no production interface.
- **Review focus:** The five failure modes above are pinned to the single production-route test and explicit review checks.
- **Proportion:** One test task, no product dependency or design expansion.
