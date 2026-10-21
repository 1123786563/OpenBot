# T04-R3 Review Fixes R3 — SDD Plan

**Source:** Fix R2 independent review `.superpowers/sdd/2026-10-10-trpc-intelligence-t04-r3-fixes-r2/reports/review.md`; findings R3-FIX-R2-REV-01 and REV-02.

## Global Constraints

- Work only in `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`; preserve HEAD `508800cf2c54f6eba2f3cf52ff897b198a92c714`; no commits/stash; preserve unrelated work.
- Own only gateway implementation, focused gateway tests, and this plan's reports/snapshots/packages.
- Preserve approved T04-R3-R01 seam, per-Run ceiling, all earlier resolved findings and full canonical output allowlist.
- RED first; snapshot/package every source change; independent backend validation and reviewer required.

## Task 1 — Validate authoritative usage and provider terminal lifecycle

**Status:** ready. **Depends on:** Fix R2 checkpoint. **Role:** backend_implementer → backend_validator → reviewer. **Commit strategy:** uncommitted checkpoint.

**Consumes:** original Task 3 brief and review reports R3-REV-01..07, R3-FIX-R1-REV-01..02, and R3-FIX-R2-REV-01..02. **Produces:** tests-first fixes, focused evidence, exact checkpoint and reports.

Steps:
1. Snapshot owned source/test hashes. Add RED regressions: OpenAI JSON and SSE where `total_tokens` disagrees with prompt+completion; Anthropic JSON/SSE safe-integer components whose aggregate overflows; OpenAI content delta secret-prefix → finish → post-finish suffix → DONE (must fail closed, never reconstruct secret); Anthropic message_stop before content_block_stop with pending text/arguments (must fail and settle unknown). Preserve normal-terminal suffix reconstruction tests.
2. Require OpenAI usage components to be valid nonnegative safe integers and require supplied total to exactly equal a safely computed sum before confirmation. Invalid/missing usage remains unknown; malformed response is handled generically.
3. Require Anthropic component and aggregate counts to be safe nonnegative integers. Track OpenAI per-choice finish state and reject any post-finish data. Track Anthropic open content-block lifecycle and require valid block stop before message_stop. Protocol violations fail with generic stream error and mark unknown once.
4. Run focused gateway tests, Biome, typecheck, whitespace checks. Save untruncated RED/GREEN/checks, report, before/after snapshots, full package and hash manifest.

**Verification:** `cd server && bun --no-env-file test tests/enterprise/model-gateway.test.ts`; Biome; `bun run typecheck`; `git diff --check` plus owned-file whitespace scan.

**Acceptance:** no invalid or overflowing usage is confirmed; OpenAI data after finish cannot leak or emit; Anthropic terminal message cannot confirm before all blocks close; unknown outcomes settle conservatively once; all previous finding regressions pass.

**Failure handling:** Stop on any need to broaden module ownership or weaken protocol/settlement guarantees.

## Review Focus

Usage arithmetic invariants; state-machine terminal ordering; generic failure and one-time unknown settlement; preserve normal provider stream semantics and all prior security fixes.
