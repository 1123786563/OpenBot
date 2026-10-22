# ✗ bun runtime suite server/tests part 4

`tests/bun-suites.test.ts` · failed · 6.1s

**ASSERTION_FAILED**

```text
server/tests part 4: 4 of 5 failing file(s) are still red run alone
server/tests/cleanup-guards.integration.test.ts: 9 of 11 — seeding: four keys, one carrying a reserved and an unknown hold, one only an unknown hold: Error: no probe spec for legacy table billing_account_resolutions&#10; at probeRows (server/src/billing/cleanup-relations.ts:359:24)&#10; at server/src/billing/cleanup-relations.ts:809:38&#10; | the guard&apos;s default scope is exactly the fresh safe candidates and touches nothing protected: Error: no probe spec for legacy table billing_account_resolutions&#10; at probeRows (server/src/billing/cleanup-relations.ts:359:24)&#10; at server/src/billing/cleanup-relations.ts:809:38&#10; | the estate wall refuses every table outside the legacy billing estate before probing rows: Error: no probe spec for legacy table billing_account_resolutions&#10; at probeRows (server/src/billing/cleanup-relations.ts:359:24)&#10; at server/src/billing/cleanup-relations.ts:809:38&#10;
server/tests/cleanup-rehearsal.integration.test.ts: 1 of 1 — (unnamed): Error: no probe spec for legacy table billing_account_resolutions&#10; at probeRows (server/src/billing/cleanup-relations.ts:359:24)&#10; at server/src/billing/cleanup-relations.ts:809:38&#10;
server/tests/cleanup-relations.integration.test.ts: 1 of 1 — (unnamed): Error: no probe spec for legacy table billing_account_resolutions&#10; at probeRows (server/src/billing/cleanup-relations.ts:359:24)&#10; at server/src/billing/cleanup-relations.ts:809:38&#10;
server/tests/conformance-evidence-extended.test.ts: 1 of 8 — every admitted 22.4-family entrance is covered, by the same store 22.3 uses: AssertionError: expect(received).toEqual(expected)&#10;&#10;- []&#10;+ [&#10;+ {&#10;+ &quot;detail&quot;: &quot;server/src/copilot.ts changed since the evidence was recorded&quot;,&#10;+ &quot;id&quot;: &quot;conformance.runtime&quot;,&#10;+ &quot;reason&quot;: &quot;fingerprint-mismatch&quot;,&#10: expected 4 to be 0
```

Look at: `tests/support/e2e-compat.ts:132`  

<sub>e2e 0.20.0 · run `01a1635e-52e2-77e7-a013-225c83cd9f49` · the whole run is in `report.json`</sub>
