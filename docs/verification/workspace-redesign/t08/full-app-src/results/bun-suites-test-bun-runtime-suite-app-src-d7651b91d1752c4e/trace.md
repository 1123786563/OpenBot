# ✗ bun runtime suite app/src

`tests/bun-suites.test.ts` · failed · 295ms

**ASSERTION_FAILED**

```text
app/src: 1 of 1 failing file(s) are still red run alone
app/src/lib/i18n/ai-observability.test.ts: 1 of 7 — all four are registered, so a lazy fallback chain cannot strand them in English: Error: ai-observability-evaluations key parity&#10;&#10;@@ -109,13 +109,11 @@&#10; &quot;sample.judgeFailed&quot;,&#10; &quot;sample.judgeScored&quot;,&#10; &quot;sample.passedRules_one&quot;,&#10; &quot;sample.passedRules_other&quot;,&#10; &quot;sample.scoreUnavailable&quot;,&#10;- &quot;sample.sho: expected 1 to be 0
```

Look at: `tests/support/e2e-compat.ts:132`  

<sub>e2e 0.20.0 · run `01a15a76-cfc7-7b6b-99bb-41a78c0ce92c` · the whole run is in `report.json`</sub>
