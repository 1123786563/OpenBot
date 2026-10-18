# RED Evidence — unintegrated state (2026-10-15)

State: all 25 reviewed production/test files transferred byte-identical; shared files still at BASE; journal at 122 entries (through 0121); fresh DBs openbot_frontier_{int,215,234} migrated to 0121 only. openbot_207 already carries the #207 checkpoint's 0122 (used only for GREEN).

```
$ bun test tests/gateway-endpoint-config.test.ts   # unit: config.ts gateway block not merged
(pass) gateway configuration routes > a timeout too large for the database is refused with the reason, before any write [0.09ms]

 11 pass
 5 fail
 38 expect() calls
Ran 16 tests across 1 file. [352.00ms]

$ bun test tests/gateway-conversion-rate.test.ts   # unit: config.ts bifrostConversionRate block not merged
(fail) boot-time configuration (loadConfig) > a valid rate reaches the config as an exact rational [0.18ms]

 27 pass
 18 fail
 119 expect() calls
Ran 45 tests across 1 file. [227.00ms]

$ TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_frontier_int bun test tests/gateway-endpoint-config.integration.test.ts   # gateway_configs table missing at 0121

      at wrapPostgresError (internal:sql/postgres:176:27)
      at onRejectPostgresQuery (internal:sql/postgres:204:33)
(fail) (unnamed) [1.13ms]

 0 pass
 2 fail
Ran 2 tests across 1 file. [250.00ms]

$ TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5569/openbot_test bun test tests/gateway-conversion-rate.integration.test.ts   # designated #209 DB; store files present → expected to pass pre-merge (source RED in 209 red.md)
(pass) conversion rate store (admin write path) > competing concurrent saves commit distinct, strictly increasing versions [59.78ms]

 13 pass
 0 fail
 46 expect() calls
Ran 13 tests across 1 file. [392.00ms]

$ bun test tests/payer-ref.test.ts   # pure module, transferred → expected to pass pre-merge (source RED in 215 red.md)

 9 pass
 0 fail
 24 expect() calls
Ran 9 tests across 1 file. [272.00ms]

$ TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_frontier_215 bun test tests/payer-account.integration.test.ts   # payer_accounts table missing at 0121

      at wrapPostgresError (internal:sql/postgres:176:27)
      at onRejectPostgresQuery (internal:sql/postgres:204:33)
(fail) (unnamed) [10.01ms]

 0 pass
 10 fail
Ran 10 tests across 1 file. [759.00ms]

$ TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_frontier_234 bun test tests/bot-service-registry.integration.test.ts   # bot_services table missing at 0121

      at wrapPostgresError (internal:sql/postgres:176:27)
      at onRejectPostgresQuery (internal:sql/postgres:204:33)
(fail) (unnamed) [1.82ms]

 0 pass
 2 fail
Ran 2 tests across 1 file. [420.00ms]
```
