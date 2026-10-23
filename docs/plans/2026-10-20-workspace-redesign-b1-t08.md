# T08 Implementation — B1 Final Verification and Review Gate

- **Parent plan:** `docs/plans/2026-10-20-workspace-redesign-b1.md` Task 8.
- **Scope:** evidence and review for T01–T07 and P01–P23 only. No production or test source edits; bounded corrections require a new scoped SDD plan and ownership record.
- **Facts:** accepted refinement handoff, `CONTEXT.md`, ADR 0008, task ledger, T01–T07 PRE/POST packages, implementation reports and independent reviews.
- **Owner/sequence:** coordinator produces full app verification and page matrix; independent validator checks evidence; independent reviewer returns Spec and quality verdicts; coordinator runs OCR workspace review. No commits.
- **PRE:** `.archive/runs/2026-10-20-workspace-redesign-b1/verification/execution/checkpoints/t08/PRE/` captures HEAD/status/staged+unstaged patches and T07 final checkpoint hash before T08 evidence generation.

## Required work

1. Reconcile P01–P23 individually against `route-acceptance.json`; record source/test verdict, required browser status, evidence references, and exact outstanding evidence. Since the user reserved browser testing for later, rendered/runtime rows must remain `pending user testing`, never `pass`.
2. Re-run full app native e2e unit partition and all app tests driven groups (`app/tests` selector, plus `app/src` group), with unique output directories; run e2e coverage audit, final app typecheck/build, changed-path Biome where code changed since prior tasks, and `git diff --check`. Preserve complete outputs/counts/warnings and exact final source checkpoint hashes.
3. Independent reviewer must separately state Spec and code-quality conclusions for the whole final B1 delta; validator verifies the same final hashes and test evidence.
4. Run OCR workspace review with `--audience agent`, background business context and `--output`; record scope/provider/coverage/skips/warnings/exit. The interim failed attempt is not a pass. Any valid finding requires a bounded repair plan, SDD implementation, affected verification, independent re-review and OCR rerun.
5. Record final range, source-only gate, browser-pending gate, full app checks, code review/OCR status, and preserved existing baseline. Do not commit, push, merge, publish, deploy or install product dependencies.

## Finish criteria

T08 can certify source/test implementation only if all T01–T07 source tasks have verified status, final app checks and independent review pass, and OCR covers the workspace delivery. B1 rendered acceptance remains pending until the user completes the requested browser checks; do not claim overall B1 complete while those rows are pending.
