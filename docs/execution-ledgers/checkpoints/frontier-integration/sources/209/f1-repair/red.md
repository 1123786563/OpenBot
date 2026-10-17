# F1 Repair — RED evidence

Command (against the dedicated #209 test DB only):

```bash
TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5569/openbot_test \
  bun test server/tests/gateway-conversion-rate.integration.test.ts
```

Result: **12 pass / 1 fail** — the new test
`competing concurrent saves commit distinct, strictly increasing versions` FAILS on the
un-fixed store, deterministically reproducing review finding F1:

```
error: expect(received).toEqual(expected)

  [
    2,
-   3,
+   2,
  ]
  at <anonymous> (.../gateway-conversion-rate.integration.test.ts:247:13)
(fail) conversion rate store (admin write path) > competing concurrent saves commit distinct, strictly increasing versions [37.09ms]

 12 pass
 1 fail
 41 expect() calls
Ran 13 tests across 1 file. [261.00ms]
```

Interpretation: with both competing saves parked on a held row lock after completing
their reads, the store's plain SELECT → client-side `+1` → constant-version upsert let
both saves commit rateVersion 2 (received `[2, 2]`), violating the documented
"admin saves start at 1 and strictly increment" contract. This is the failure of
functionality (not of test wiring): the 12 pre-existing tests in the file still pass.
