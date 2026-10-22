# Task Brief — P15 Textarea Regression Assertion

- **Task:** Address low finding T05-P15-TEXTAREA-Q1 with an explicit runtime `TEXTAREA` assertion.
- **Plan:** `docs/plans/2026-10-21-workspace-redesign-p15-textarea-review-fix.md`.
- **Owner:** `frontend_implementer` (only); no child agents.
- **Workspace:** `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`.
- **Files allowed:** `app/tests/bot-setup.test.tsx`, `docs/plans/reports/T05-P15-textarea-review-fix-impl.md`, and `docs/verification/workspace-redesign/p15-error-focus/checkpoints/textarea-review-fix/PRE/` only.
- **PRE test SHA:** `c733dccc4b875e212e94b333e65aadf968a9fafc96d3307a1a0d38402bdc308b`.
- **Source SHA (must remain unchanged):** `52319fee3fda9c9e916e3e0bf93b3d38947b549569d01d2a66a7a77d9b979b86`.
- **Acceptance:** assert `field.tagName` equals `TEXTAREA` before typing; `cd app && bun test ./tests/bot-setup.test.tsx` passes; scoped Biome and diff-check pass; capture task-specific diff and POST hash.
- **Preserve:** all unrelated worktree edits. No commit, dependency install, source change, server/API call, data write, OCR, or Git state operation. Do not format other hunks.
