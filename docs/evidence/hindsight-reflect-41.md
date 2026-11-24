# Hindsight Reflect acceptance for OpenBot #41

The isolated checkout started at `4769ba422`, the local tip of
`integration/intelligence-replacement-acceptance` and the merge of PR #113.
The verification ran on November 24, 2026. Both Reflect probes used the
published self-hosted `hindsight-api-slim` 1.2.0 service, disposable migrated
PostgreSQL, and synthetic Memory records. Embeddings, model completions, and
model usage were fixtures. The Test Credit ledger and its HTTP execution
routes ran real OpenBot code against PostgreSQL.

| Criterion | Observed result |
| --- | --- |
| Reflect with a verifiable source | The Bot's `reflect_personal_memory` tool returned a synthesis with exactly the approved Memory ID and version. The revised version was cited after a fresh sync. |
| Revocation and scope | The stale projection produced local search while the new version was waiting for sync. Revoking the connected app tool grant and removing the Memory each produced an empty local result. A different Person using the owner's Bot received no Memory. An adjacent fixture test supplied foreign evidence and false source text and verified that both were discarded in favor of an authorized local match. |
| Test Credit and model route | Five callbacks from the real Hindsight process settled distinct operations on the published test route. Each receipt recorded OpenBot, Test Credit, 2 microcredits charged, and zero remaining hold. The account showed 10 microcredits charged and zero reserved. An unpublished route was refused before the executor. The publication evidence and the completion executor in this probe were fixtures. |

The Web `/reflect` regression exercised the authenticated Run scope with an
injected Reflect response. The real Hindsight probes exercised the Bot tool
and the ingestion-to-callback path. Those probes used synthetic model
responses throughout.

## Provider acceptance

Provider-backed routing and billing remain open. Both checked-in Zhipu
reports are version 2. On this tree, publishing an active chat route requires
version 3 evidence, including a provider-issued terminal cancellation
record. The catalog suite confirmed that both historical reports are
readable and ineligible for a current publication. An isolated deployment
needs a qualified route with enough capacity for Hindsight's structured
replies, its approved meter, and a verified Test Credit identity. The
independent deployment qualification is tracked in issue #158.

## Verification runs

| Run | Result |
| --- | --- |
| Native Reflect against Hindsight 1.2.0 and PostgreSQL 18.6 | 1 passed, 7 assertions |
| Managed Reflect against Hindsight 1.2.0 and PostgreSQL 17 | 1 passed, 20 assertions |
| Bifrost catalog checks | 22 passed |
| Authenticated Web `/reflect` regression | 1 passed |
| Memory, callback, config, and managed-model regression sweep on PostgreSQL 18.6 | 214 passed, 3 skipped, 1 failed. The unchanged billing replay test expects `settled`. The adapter returns the stored completion. |
| Repository test typecheck | 34 errors outside the frozen baseline in unchanged direct-chat, personal-approval-cutoff, and routines-store tests. The modified test added no diagnostics. |

Use the repository test environment with a disposable `TEST_DATABASE_URL`.
In `server/tests/memory-store.integration.test.ts`, run the two opt-in
`self-hosted Hindsight Reflect` tests separately so each starts with fresh
Memory owners. Set `TEST_HINDSIGHT_REFLECT_API_URL` for native Reflect. For
managed Reflect, set `TEST_HINDSIGHT_MANAGED_REFLECT_API_URL`,
`TEST_HINDSIGHT_MANAGED_REFLECT_CALLBACK_PORT`, and
`TEST_HINDSIGHT_SYNTHETIC_MODEL_URL`. Point the managed Hindsight Reflect
provider at the corresponding loopback callback under
`/internal/hindsight/v1`. The fixture model must implement Hindsight's
structured JSON response format and return synthetic usage.
