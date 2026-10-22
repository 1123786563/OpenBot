# ✗ bun runtime suite server/tests part 9

`tests/bun-suites.test.ts` · failed · 12.9s

**ASSERTION_FAILED**

```text
server/tests part 9: 2 of 4 failing file(s) are still red run alone
server/tests/memory-store.integration.test.ts: 1 of 1 — (unnamed): PluginRefusedError: GRANT_TOOL_NAME_INVALID: mcp__memory-46a30694-d332-49ed-9f34-f88f032889c6-connector__read_documents cannot be offered to a model (a tool name is 1-64 characters of A-Z, a-z, 0-9, &quot;_&quot; and &quot;-&quot;; the server and tool halves of the ref spell it).&#10; at grant (serv
server/tests/ocr-pricing.test.ts: 17 of 18 — the mapping bills exactly the three upstream OCR sides, on the vocabulary&apos;s own members: TypeError: ocr-pricing fixture: dims.video_input is known but its amount is not an exact non-negative decimal string.&#10; at assertPriceSnapshotDims (server/src/gateway/price-snapshot.ts:292:9)&#10; at server/tests/ocr-pricing.test.ts:120:13&#10; | a document request certifies the flat side at the PAGE count and the image side at 0: TypeError: ocr-pricing fixture: dims.video_input is known but its amount is not an exact non-negative decimal string.&#10; at assertPriceSnapshotDims (server/src/gateway/price-snapshot.ts:292:9)&#10; at server/tests/ocr-pricing.test.ts:133:13&#10; | duplicate page entries are billed as sent — the ceiling covers every named page: TypeError: ocr-pricing fixture: dims.video_input is known but its amount is not an exact non-negative decimal string.&#10; at assertPriceSnapshotDims (server/src/gateway/price-snapshot.ts:292:9)&#10; at server/tests/ocr-pricing.test.ts:146:13&#10;: expected 2 to be 0
```

Look at: `tests/support/e2e-compat.ts:132`  

<sub>e2e 0.20.0 · run `01a163b4-7111-7223-b07f-75d5a4bc15a1` · the whole run is in `report.json`</sub>
