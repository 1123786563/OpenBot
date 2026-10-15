# T04-R3 Review Fixes R4 — SDD Plan

**Source:** Fix R3 independent review `.superpowers/sdd/2026-10-10-trpc-intelligence-t04-r3-fixes-r3/reports/review.md`; findings R3-FIX-R3-REV-01 and REV-02.

## Global Constraints

- Workspace `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`, HEAD `508800cf2c54f6eba2f3cf52ff897b198a92c714`; no commit/stash; preserve unrelated changes.
- Own only gateway, focused gateway tests, this plan's task reports/snapshots/packages.
- Preserve T04-R3-R01 seam, per-Run limit, allowlist/redaction/bounds/usage correctness and prior verified behavior.
- TDD, exact snapshots/package, independent backend validation and review required.

## Task 1 — Delay success until clean EOF and enforce Anthropic message order

**Status:** ready. **Depends on:** Fix R3 checkpoint. **Role:** backend_implementer → backend_validator → reviewer. **Commit strategy:** uncommitted checkpoint.

**Consumes:** original T04-R3 brief and all findings through R3-FIX-R3-REV-02. **Produces:** state-machine fix, regression tests, logs and exact package.

Steps:
1. Snapshot source/tests. Add RED tests for OpenAI valid finish/usage/`[DONE]` followed by another frame, malformed frame or truncated bytes; assert no canonical `[DONE]`, no confirmation, generic stream error, exactly one unknown settlement. Add equivalent Anthropic `message_stop` followed by event/truncated bytes.
2. Add RED for Anthropic `message_delta` with finish reason while any block is open, ensuring no finish is emitted, no block tail appears after finish, and settlement is unknown once.
3. Model provider terminal markers as pending state. Continue bounded parsing until clean EOF; any frame or non-whitespace bytes after terminal, truncated frame, cancellation or timeout must fail generically and settle unknown. Emit canonical `[DONE]` and confirm authoritative usage only after clean EOF.
4. For Anthropic require every started block to stop before a terminal `message_delta`, require valid message lifecycle, and reject block events after message terminal transition. Keep tail flush before a valid finish.
5. Run focused tests, Biome, typecheck, whitespace; report and package every owned change and check output.

**Verification:** focused Bun gateway suite, Biome, server typecheck, `git diff --check` plus untracked-file whitespace scan.

**Acceptance:** canonical completion and usage are emitted only after clean source EOF; trailing bytes/events or truncation fail closed and mark unknown once; Anthropic block tails never appear after finish; all earlier findings remain passing.

**Failure handling:** stop on any need to broaden ownership or weaken original protocol guarantees.

## Review Focus

Terminal-state machine, clean EOF proof, generic failure and settlement semantics, ordering of all Anthropic blocks/deltas/finish, preservation of prior secret redaction and canonical allowlists.
