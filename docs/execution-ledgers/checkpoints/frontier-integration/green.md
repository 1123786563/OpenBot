# GREEN Evidence — integrated state (2026-10-15)

State: all 25 reviewed files transferred byte-identical; config.ts 3-way merged (verified: = #207 source + exactly #209's additions and vice versa, 0 deletions); schema/index.ts + drizzle.config.ts three-way merged; journal rebuilt (125 entries, idx 0–124, monotonic when, terminal newline restored); snapshots 0123/0124 chained onto #207's 0122 (payer subtree drizzle-authored in /tmp sandbox; bot subtree = #234-reviewed, both validated deep-equal against drizzle output).

Note: an earlier draft of this file recorded the first post-merge run where the two unit files failed on a merge seam (missing closing brace for gatewayEnvConfig); the seam was fixed and every command below is the final rerun.

```
$ bun test tests/gateway-endpoint-config.test.ts

 16 pass
 0 fail
 45 expect() calls
Ran 16 tests across 1 file. [303.00ms]

$ TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_207 bun test tests/gateway-endpoint-config.integration.test.ts

 9 pass
 0 fail
 33 expect() calls
Ran 9 tests across 1 file. [317.00ms]

$ bun test tests/gateway-conversion-rate.test.ts

 45 pass
 0 fail
 136 expect() calls
Ran 45 tests across 1 file. [316.00ms]

$ TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5569/openbot_test bun test tests/gateway-conversion-rate.integration.test.ts

 13 pass
 0 fail
 46 expect() calls
Ran 13 tests across 1 file. [526.00ms]

$ bun test tests/payer-ref.test.ts

 9 pass
 0 fail
 24 expect() calls
Ran 9 tests across 1 file. [270.00ms]

$ TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_frontier_215 bun test tests/payer-account.integration.test.ts

 9 pass
 0 fail
 32 expect() calls
Ran 9 tests across 1 file. [460.00ms]

$ TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_frontier_234 bun test tests/bot-service-registry.integration.test.ts

 7 pass
 0 fail
 36 expect() calls
Ran 7 tests across 1 file. [474.00ms]
```
