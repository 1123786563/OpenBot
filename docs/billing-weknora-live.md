# Live WeKnora ingestion acceptance

This record covers #93's live acceptance: the real WeKnora Go worker uploading
a TXT document through the managed-embeddings endpoint, charged on the
uploader's Test Credit account inside a Spending Authorization.

## Wiring

- `server/scripts/weknora-live.ts` serves the WeKnora worker's contract
  (`POST {subject, authorizationId, resourceId, operationId, input[]}` →
  `{vectors, receipt}`) on top of `createWeKnoraIngestionBilling` and
  `createTestCreditLedger`. The pilot catalog is seeded with the live
  embedding route (`openai`/`BAAI/bge-small-en-v1.5`, input 500k per million)
  through the same configure → verify → publish flow the admin uses.
- Embeddings run through the pinned local Bifrost deployment; input metering
  calls the provider's own tokenizer, and the settled charge uses the
  gateway-reported `prompt_tokens`.
- The worker side is the real WeKnora ingestion machinery
  (`CreateKnowledgeFromFile` → `ProcessDocument`) driven by its acceptance
  test with `OPENBOT_WEKNORA_*` pointing at this endpoint.

## Acceptance result

| Step | Result |
| --- | --- |
| WeKnora worker uploads `managed.txt` (one chunk, 384-dim KB) | PASS — chunk embedded and indexed (`weknora-live.log`) |
| Metering | tokenizer bound 14 tokens = gateway `prompt_tokens` 14 |
| Settlement | operation `d82c4abd…` settled: 256 reserved → 7 microcredits charged, balance 8192 → 8185 (`receipts-final.json`) |
| Resource outside the authorization (`kb-other`) | 403 `not_authorized` |
| Subject without an enrolled account | 403 `not_authorized` |
| Authorization past `expiresAt` | 410 `authorization_expired` |
| Authorization revoked after the upload | 410 `authorization_revoked` |
| Wrong service token | 401 |

Evidence lives in [`evidence/billing-weknora-live/`](./evidence/billing-weknora-live/);
the running deployment's artifacts stay outside the checkout at
`/Users/wuyj/.local/share/openbot/billing-93`.
