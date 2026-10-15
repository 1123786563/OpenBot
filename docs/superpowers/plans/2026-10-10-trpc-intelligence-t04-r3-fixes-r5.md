# T04-R3 Review Fixes R5 — SDD Plan

**Source:** independent Fix R4 review `.../2026-10-10-trpc-intelligence-t04-r3-fixes-r4/reports/review.md`, finding R3-FIX-R4-REV-01.

## Global constraints

- Work in `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`, HEAD `508800cf2c54f6eba2f3cf52ff897b198a92c714`; no commits/stash; preserve unrelated changes.
- Own only gateway source, gateway tests, and this plan's evidence/snapshot/package files.
- Preserve all R1–R4 accepted behavior, the T04-R3-R01 auth seam, per-Run ceiling, terminal/EOF semantics, redaction, allowlisting, usage and bounds.
- TDD RED first, immutable exact checkpoint, then independent validator/reviewer.

## Task 1 — Preserve same-event OpenAI finish output order

**Status:** ready. **Role:** backend_implementer → backend_validator → reviewer. **Commit strategy:** uncommitted.

1. Snapshot the exact current source/test hashes. Add RED test with one OpenAI choice event containing content and tool-argument deltas ending in a prefix of the synthetic key plus the same event's non-null finish reason. Reconstruct content and arguments from all canonical chunks; assert exact original sequence and finish follows both. Include id/name fields if the sanitizer buffers them in this path.
2. Correct OpenAI canonical chunk construction to emit current sanitized values before flushed overlap tails; emit finish only after all deltas/tails for that choice. Preserve output allowlist and avoid emitting full secret.
3. Run focused Bun gateway suite, Biome, typecheck (only known unrelated probe error allowed), whitespace. Save RED/GREEN reports and exact package/snapshot/hash manifest.

**Acceptance:** exact content/tool args preserved for same-event finish; no secret appears; finish comes after all content; R1–R4 regressions remain passing.

## Review focus

Canonical SSE delta order and finish ordering under overlap redaction; ensure no security, billing, EOF or prior protocol regressions.
