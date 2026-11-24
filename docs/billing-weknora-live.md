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

## OpenBot server integration

The OpenBot server can serve the worker contract at
`POST /api/weknora/embeddings`. Set `OPENBOT_TEST_CREDIT_WEKNORA=enabled`,
`OPENBOT_WEKNORA_ROUTE` to a published embedding route ID, and
`OPENBOT_WEKNORA_SERVICE_TOKEN` to the service credential shared with the worker.
Set `TEST_CREDIT_EMBEDDINGS_BIFROST_URL` to the pinned gateway's
`/v1/embeddings` URL. The gateway token, gateway revision, image digest,
input meter URL and token, metering revision, and Casdoor issuer and provider ID
use the existing `TEST_CREDIT_*` settings. This mount requires OpenBot with
local OIDC sessions. Configure the worker's `OPENBOT_WEKNORA_EMBEDDINGS_URL`
and `OPENBOT_WEKNORA_OIDC_ISSUER` to match.

An admin approves the platform application with
`POST /api/admin/bifrost/applications/weknora/approve` and uses the existing
catalog workflow to configure, verify, and publish the route. Embedding routes
set `purpose: "embedding"` and have zero output tokens and output price,
with tools disabled. Verification imports embedding evidence from the
configured evidence directory. A publication with only an embedding route has
`defaultRoute: null`.

OpenBot's Credits page previews the WeKnora rate when the uploader authorizes
an app. The signed-in uploader can also read the rate and per-operation
reservation bound at `GET /api/billing/weknora/preview` and create a
background grant with `POST /api/billing/authorizations`. Supply a fresh UUID
as the authorization ID, the exact tenant and knowledge base resource ID,
a deadline, and the cumulative limit. The existing worker carries a fresh
grant UUID with the upload and uses that UUID as the task ID. Issue a fresh
grant for each upload when using that worker. A client with a
separate task ID sends it on the request, along with the preview's
`priceVersion` when it needs to pin the displayed price. Passing the
authorization ID to the preview also returns the grant's cap and usage.

The worker reads an operation by its original ID at
`GET /api/weknora/authorizations/:id/operations/:operationId` with its
service credential. A capped ingestion waits at its original ID. To continue,
the signed-in uploader chooses **Raise upload limit** on the Credits page.
The API accepts the new limit, Test Credit budget ID, and authorization ID at
`/api/billing/resume-points/:operationId/confirm`. The worker must retry the
original operation with the same input. Previously settled batches replay
their recorded vectors and receipts.

The existing WeKnora client turns non-success HTTP responses into status-code
errors. The
WeKnora upload page still needs to carry the grant into the multipart upload
and surface the pause reason. A manual retry must preserve the original
batch IDs to consume the confirmed continuation. Personal SaaS uses its own account-suspension
and deadline flow from #116. The fixture-provider upload exercised the
OpenBot handler and the normal Go upload and worker services. It used an
isolated Postgres database, an injected session boundary, fixture storage and
indexing, and a loopback fixture meter and embedding gateway.
