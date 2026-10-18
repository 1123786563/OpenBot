# F1 Repair — RED Evidence (Task 2, before implementation)

- **Worktree**: `/Users/wuyongjun/orca/workspaces/OpenBot/issue5-207-timeout`, HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`
- **Date**: 2026-10-15
- **State**: transferred checkpoint (byte-identical, see `transfer.md`) + new failing tests ONLY. Production files (`server/src/gateway/endpoint.ts`, `server/src/config.ts`) still unmodified from the reviewed checkpoint.

## RED tests added

`server/tests/gateway-endpoint-config.test.ts` (unit, no database):

1. `parseGatewayEndpointInput > accepts the largest timeout the database can store, and refuses one millisecond more` — `2_147_483_647` accepted; `2_147_483_648` rejected with the sentence `"requestTimeoutMs must be no greater than 2147483647, the largest value a PostgreSQL integer column can store."`
2. `gateway environment configuration > the largest storable timeout is accepted from the environment; one more stops the server with the shared reason` — `GATEWAY_REQUEST_TIMEOUT_MS=2147483647` accepted; `"2147483648"` throws `/GATEWAY_REQUEST_TIMEOUT_MS: requestTimeoutMs must be no greater than 2147483647/`
3. `gateway environment configuration > an illegal timeout stops the server` — regex updated to the shared-sentence form `/GATEWAY_REQUEST_TIMEOUT_MS: requestTimeoutMs must be a whole number of milliseconds greater than zero/` (env path switches to the shared parser's wording, matching the existing `GATEWAY_BASE_URL: ${parsed.error}` precedent)
4. `gateway configuration routes > a timeout too large for the database is refused with the reason, before any write` — admin PUT `requestTimeoutMs: 3_000_000_000` must be 400 with the reason; the app's database is the untouchable proxy, so any write attempt fails the test

`server/tests/gateway-endpoint-config.integration.test.ts` (dedicated `openbot_207`):

5. `gateway configuration HTTP surface > a timeout above the largest integer the column can store is refused as 400, never a 500, and changes nothing` — admin PUT `requestTimeoutMs: 3_000_000_000` → 400 + reason; stored row and `configVersion` unchanged (`readGatewayEndpoint` equal to `before`)

## Command 1 — unit (serial)

```
$ cd server && bun test tests/gateway-endpoint-config.test.ts
 12 pass
 4 fail
 41 expect() calls
Ran 16 tests across 1 file. [313.00ms]
```

The 4 failures, each for the expected reason (feature missing, not a typo):

- `parseGatewayEndpointInput > accepts the largest timeout ... refuses one millisecond more` — `error: expect(received).toEqual(expected)` (current parser accepts `2_147_483_648`)
- `gateway environment configuration > an illegal timeout stops the server` — `error: expect(received).toThrow(expected)` (env path still uses its own inline wording)
- `gateway environment configuration > the largest storable timeout ... one more stops the server` — `error: expect(received).toThrow(expected)` (env accepts `2147483648`, no throw)
- `gateway configuration routes > a timeout too large ... before any write` — `error: the gateway routes touched the database` (proxy threw inside `saveGatewayEndpoint` → Hono 500) then `Expected: 400 / Received: 500`

## Command 2 — integration (serial, dedicated DB)

```
$ cd server && TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_207 bun test tests/gateway-endpoint-config.integration.test.ts
 8 pass
 1 fail
 31 expect() calls
Ran 9 tests across 1 file. [221.00ms]
```

The single failure reproduces reviewer finding F1 verbatim:

```
PostgresError: integer out of range
    errno: "22003",
 severity: "ERROR",
     file: "int8.c",
    routine: "int84",
error: expect(received).toBe(expected)
Expected: 400
Received: 500
(fail) gateway configuration HTTP surface > a timeout above the largest integer the column can store is refused as 400, never a 500, and changes nothing [3.81ms]
```

All pre-existing tests in both files still pass (12 unit + 8 integration). The 4+1 failures are exactly the new boundary/parity assertions — RED verified.
