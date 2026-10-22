# T04 Review Repair 01 — Keep Full Bot Profile Identity Readable

> **Execution:** scoped SDD repair for `docs/plans/reports/T04-review.md`, one `frontend_implementer`, no commits.

**Parent:** B1 T04; input delta SHA `fb6dfa2e0a51c120610e3ad97eaf8a345806fc522cc33e1752d78370c0b6503f`.

## Findings in scope

- **T04-S1 (medium):** Bot detail profile name/title/role description use `line-clamp-2`, hiding the full 120-character name/300-character description required by P07.
- **T04-Q1 (low):** no targeted automated check covers full profile identity text; add a source/DOM-level regression assertion while leaving actual computed layout to the browser pass.

## Task R1

- **Role:** `frontend_implementer`; independent validator and reviewer follow after implementation.
- **Files:** `app/src/components/bot-profile/profile.tsx`, `app/tests/bot-profile-active.test.tsx` only.
- **PRE:** `docs/verification/workspace-redesign/execution/checkpoints/t04-r1/PRE/`; capture source copies, hashes, full status, HEAD and staged/unstaged patches before edit.
- **Steps:**
  1. Remove the line clamps from the profile identity name/title/role description. Retain `break-words`, min-width handling, typography and spacing so content can wrap without pushing/overlapping actions.
  2. Add a native test using a 120-character name and 300-character description; assert the complete values are rendered and the identity text has no line-clamp utility. Keep action/name structure intact.
- **Verification:** run `bot-profile-active.test.tsx` via ADR0008; scoped Biome on the two files; PRE/POST exact reversible delta/hash. Browser focus/390px/200% overflow remains deferred to the user.
- **Acceptance:** all details remain present in DOM and unconstrained by line-clamp; no other P07 content changes. No API/navigation/permission changes or broad formatting.
- **Review focus:** exact full content, wrapping class, no action regression, no unrelated hunk.
