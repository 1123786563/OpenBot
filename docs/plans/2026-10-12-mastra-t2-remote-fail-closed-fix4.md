# T2 Remote Fail-Closed — Review Fix 4

> **For agentic workers:** make only one test name and its adjacent comment accurate. No behavior or assertion changes.

**Goal:** Close remaining Low review observation F3-1 in remote fail-closed Fix3.

**Source:** Fix3 reviewer report `.superpowers/sdd/2026-10-12-mastra-t2-remote-fail-closed-fix3/reports/task-1-review-report.md`; parent T2 design/ruling.

**Role:** mechanical_worker. **Validator:** backend_validator. **Reviewer:** reviewer. **Only file:** `server/tests/copilot.test.ts`, baseline SHA256 `5c0eb409375bddf0c54a7143e0f5074777ca876f2f7a0a49de26f32b00aa9371`.

Change the test title around line 800 from language implying a standing role is delivered/order-tested to language saying remote execution is refused when standing-role history is present. Rewrite the adjacent “second copy” comment to say refusal prevents observing transmission/deduplication, while retaining the fixture that includes standing-role history. Do not change setup/assertions, source, or any other test name.

Run full `bun test tests/copilot.test.ts`, scoped Biome, and `git diff --check`. Record exact before/after hashes and report at `.superpowers/sdd/2026-10-12-mastra-t2-remote-fail-closed-fix4/reports/task-1-implementer-report.md`.

**Acceptance:** only the one title/comment change; all 73 tests pass.
