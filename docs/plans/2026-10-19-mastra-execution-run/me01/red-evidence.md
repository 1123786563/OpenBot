# ME01 RED evidence (persisted after the fact from the live session)

The brief required a persisted RED artifact; the initial RED was captured only in-session
(fixes were applied iteratively while the RED cycle was running). This file records the
actual observed failures verbatim-faithful, in order, with the exact commands. It is not a
re-run: re-running RED would require reverting working code, which was rejected as theater.

1. `bun test server/tests/mastra-agent-resume-process.test.ts`
   → `error: Cannot find module '../tests/support/bun-test-compat'` (wrong relative depth; fixed to `../../tests/support/bun-test-compat`).

2. Same command
   → `error: Cannot find package 'pg' from '.../server/tests/support/me01-fixture.ts'`
   (fixture redesigned: `docker exec psql` bootstrap + store-pool queries, so no direct driver import).

3. Same command
   → `AGENT_CONSTRUCTOR_MODEL_REQUIRED: LanguageModel is required to create an Agent`
   (counting Proxy wrapper exposed `.model` as undefined; wrapper reshaped to `{ model, doStreamCalls }`).

4. Same command
   → `expect(await countReceipts(...)).toBe(1)` received 0, and
   → `expect(finishReason).toBe("suspended")` received `"stop"`
   (instrumented execute showed first arg = raw inputData and options without `suspend`;
   core inspection: agent tool suspension only engages via the durable toolCallStep —
   tool-level `requireApproval: true` routes there. Fixture reworked accordingly.)

5. First GREEN attempt: `bunx e2e run ...` on the new file
   → `COLLECTION_ERROR ... Received protocol 'bun:'` (native Node collection cannot load
   the bun-test-compat chain) — resolved by regenerating the driven manifest via
   `scripts/e2e-file-audit.mjs` + `scripts/e2e-bun-manifest.mjs` per ADR 0008.

Final GREEN: see `report.md` command table (resume 3/3 → 4/4 after review fixes; compat 5/5).
