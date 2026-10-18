# F1 Repair — GREEN Evidence (Task 2, after implementation)

- **Worktree**: `/Users/wuyongjun/orca/workspaces/OpenBot/issue5-207-timeout`, HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` (unchanged; no commits)
- **Date**: 2026-10-15

## Implementation (minimal code to pass the RED tests)

`server/src/gateway/endpoint.ts` — the shared rule, in the one place both paths read:

- New error sentence: `GATEWAY_ENDPOINT_ERRORS.timeoutMaximum = "requestTimeoutMs must be no greater than 2147483647, the largest value a PostgreSQL integer column can store."`
- `const REQUEST_TIMEOUT_MS_MAX = 2_147_483_647;` (int4 max, documented: the `request_timeout_ms` column is an int4)
- `parseRequestTimeoutMs` now rejects `raw > REQUEST_TIMEOUT_MS_MAX` with that sentence, after the unchanged positive-integer check. All existing rejections (zero/negative/fractional/non-numeric) and acceptances (any positive integer ≤ max) are otherwise identical.

`server/src/config.ts` — `gatewayEnvConfig` only (the #209 `bifrostConversionRate` block does not exist in this worktree; verified by grep):

- Import extended to `parseGatewayBaseUrl, parseRequestTimeoutMs`.
- The inline `Number.isInteger(value) || value <= 0` check is replaced by the shared parser: `parseRequestTimeoutMs(Number(timeoutRaw))`, throwing `GATEWAY_REQUEST_TIMEOUT_MS: ${timeout.error}` — the same `VARIABLE: shared sentence` pattern the same function already uses for `GATEWAY_BASE_URL`. The only behavioral changes: values above int4 max now stop start-up with the shared reason, and low-value rejections now carry the parser's sentence wording.

No other production file changed. `routes.ts` needed no change: `PUT /endpoint` already maps `parseGatewayEndpointInput` failures to 400, so the shared bound closes the DB path.

## Verify GREEN — all commands run serially from `server/`

```
$ bun test tests/gateway-endpoint-config.test.ts
 16 pass
 0 fail
 45 expect() calls
Ran 16 tests across 1 file. [189.00ms]        (exit 0)

$ TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_207 bun test tests/gateway-endpoint-config.integration.test.ts
 9 pass
 0 fail
 33 expect() calls
Ran 9 tests across 1 file. [176.00ms]         (exit 0; only database touched: openbot_207; gateway_configs left at 0 rows by afterAll)

$ bun run typecheck
tsc --noEmit                                    (exit 0)

# from repo root:
$ bunx biome lint --error-on-warnings server/src/gateway/endpoint.ts server/src/config.ts server/tests/gateway-endpoint-config.test.ts server/tests/gateway-endpoint-config.integration.test.ts
Checked 4 files in 27ms. No fixes applied.     (exit 0)
```

`bunx biome format` on the 4 files still reports diffs, but every remaining flagged region is pre-existing checkpoint drift (verified: the byte-identical source files produce the same flags — `parseGatewayBaseUrl`'s multiline `if`, `config.ts`'s `gatewayEnvConfig` signature and unrelated LAGO sections, `appFor` signatures, `listener.listen`). Every line added or edited by this repair is format-clean; reformatting the pre-existing regions was deliberately left out of scope to keep the delta exactly F1.

Regression check: `bun test tests/config.test.ts` → 140 pass / 1 fail, the single failure being the documented pre-existing BASE failure ("enables Google authentication when its complete deployment contract is present"), identical to the reviewed checkpoint baseline. No new failures introduced.

## Review-focus resolution

| Focus | Result |
|---|---|
| Max int4 (`2_147_483_647`) accepted; one above rejected before DB | Unit boundary test passes; route unit test's untouchable DB proves refusal precedes any write |
| Admin PUT above limit → 400, reason, row/configVersion unchanged, never 500 | Integration test passes against real PostgreSQL (the same request that produced `PostgresError: integer out of range` → 500 in RED) |
| Env parity | `GATEWAY_REQUEST_TIMEOUT_MS=2147483648` stops start-up via the same shared parser and sentence |
| Ordinary positive values unchanged | All 12 pre-existing unit + 8 pre-existing integration tests still pass |
| Zero/negative/fractional/non-numeric still rejected | Existing rejection test passes with its original sentence |
