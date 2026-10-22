# Task Brief — T03 Skills draft lifecycle verification

**Plan:** `docs/plans/2026-10-21-t03-skills-draft-lifecycle.md`  
**Task:** 1  
**Worktree:** `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`  
**BASE:** `203d0f0244b2f898218fa12027089c631e8448d9`  
**Commit policy:** no commits; preserve all dirty baseline files.

## Objective

Add a native E2E regression that renders the actual `SkillsRoute` and proves its new-skill draft value and dirty state survive DetailPanel's 880→879→880 container-width transition.

## Owned files

- Implementer writes only `app/tests/skills-draft-lifecycle.test.tsx` plus its report.
- Production code is read-only unless the failing behavior proves a defect within the previously authorized T03 draft ownership/prop wiring. If so, stop and report affected production path before modifying; coordinator must record a serial transfer/checkpoint first.
- Validator may write only the assigned validation report and test/build caches.
- Reviewer is read-only and writes the assigned review report.

## Required behavior

- Use the real exported Skills file route, in-memory router, query cache values, and real `DetailPanel` observer path.
- Start with `/skills?new=true`; type into the new skill title through Testing Library's public input event.
- Assert title and dirty state, resize 880→879→880, then assert the same title and dirty state remain and the route stays open.
- Subscribe to the in-memory history after initial route resolution and assert the resize sequence emits zero navigation events.
- Do not use a fake draft owner, private React props, storage, server writes, or browser screenshots.

## Verification

```bash
bunx e2e run --config e2e.unit.config.ts app/tests/skills-draft-lifecycle.test.tsx
bunx biome check app/tests/skills-draft-lifecycle.test.tsx
git diff --check
```

The focused `e2e` report must show one file and at least one test collected and passed. If product code changes, rerun the relevant Skills and app gates and bind all evidence to the final POST hashes.

## Reports

- Implementation: `docs/plans/reports/T03-skills-draft-lifecycle-impl.md`
- Validation: `docs/verification/workspace-redesign/t03-skills-draft-lifecycle/independent-validation.md`
- Review: `docs/plans/reports/T03-skills-draft-lifecycle-review.md`
