# T04-R3 Review Fixes R2 — SDD Plan

**Source:** Fix R1 independent review `.superpowers/sdd/2026-10-10-trpc-intelligence-t04-r3-fixes-r1/reports/review.md`, findings R3-FIX-R1-REV-01 and R3-FIX-R1-REV-02. This repair scope contains only those two findings.

## Global Constraints

- Workspace `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`; preserve HEAD `508800cf2c54f6eba2f3cf52ff897b198a92c714`; no commits/stash; do not touch the original repo.
- Own only `server/src/enterprise/models/gateway.ts`, `server/tests/enterprise/model-gateway.test.ts`, and this plan's reports/snapshots/packages.
- Preserve R3 consumed invocation boundary, route/token trust, all resolved R3-R1 findings, and per-Run ceiling decision.
- Run RED before implementation, exact snapshot/package, then independent validator and reviewer. Do not weaken assertions.

## Task 1 — Canonical allowlist output and streaming tail fidelity

**Status:** ready. **Depends on:** Fix R1 checkpoint. **Role:** backend_implementer, then backend_validator and reviewer. **Commit strategy:** uncommitted; no stash.

**Consumes:** original Task 3 brief, R3 Fix R1 plan/brief/review and current source. **Produces:** allowlisted OpenAI-compatible response construction for JSON/SSE, correct tail flushing, behavior tests, reports and exact package.

Steps:
1. Snapshot current source/test hashes. Add RED tests for provider JSON with synthetic credential as a property key, unrecognized fields, and upstream error object; same for streaming frames. Add stream reconstruction tests where content, OpenAI tool arguments, Anthropic text/tool identifier/name end in a secret-prefix suffix but not the entire secret, and assert exact canonical text/argument equality.
2. Build canonical OpenAI output from allowlisted validated fields only. Validate provider error/unsupported shapes and return/stream only generic failures; never forward raw body, unknown keys, or error objects. Sanitize values in supported string fields, and reject/normalize invalid structures before output.
3. Flush buffered overlap tails at logical field/block end before finish/[DONE], preserving tool index and exact original content. For OpenAI, track each pending field path and emit final residual deltas when stream completes. For Anthropic, flush text and tool name/id/arguments at appropriate terminal boundaries.
4. Run focused gateway suite, Biome, typecheck (known unrelated probe error only), whitespace. Save RED/GREEN outputs, report, complete after snapshot/package/hash manifest.

**Verification:** `cd server && bun --no-env-file test tests/enterprise/model-gateway.test.ts`; Biome; typecheck; diff and untracked whitespace checks.

**Acceptance:** no arbitrary provider fields or keys reach JSON/SSE; malformed/error frames fail generically; all pending redaction suffixes are faithfully emitted at the logical boundary; tests prove exact content/tool argument preservation and absence of synthetic secret.

**Failure handling:** Stop and report if a finding requires changing a neighboring module or relaxing original Task 3 behavior.

## Review Focus

Only allowlisted canonical protocol fields leave the gateway; upstream errors remain generic; secret detection and content preservation work at all delta/block boundaries; no regression to prior seven findings.
