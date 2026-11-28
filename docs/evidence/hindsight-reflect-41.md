# Hindsight Reflect acceptance for OpenBot #41

Both Reflect probes ran again on November 25, 2026, at `97c4c2283` on
`integration/intelligence-replacement-acceptance`, with main `4a989395d`
merged. They used the published self-hosted `hindsight-api-slim` 1.2.0
service, disposable migrated PostgreSQL 17.12, and synthetic Memory records.
Embeddings, model completions, and model usage were fixtures. The Test Credit
ledger and its HTTP execution routes ran real OpenBot code against
PostgreSQL.

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

All runs below are from `97c4c2283` on November 25, 2026.

| Run | Result |
| --- | --- |
| Native Reflect against Hindsight 1.2.0 and PostgreSQL 17.12 | 1 passed, 7 assertions |
| Managed Reflect against Hindsight 1.2.0 and PostgreSQL 17.12 | 1 passed, 20 assertions. Five callbacks settled five operations at 2 microcredits each, with no hold left. |
| Bifrost catalog checks | 22 passed, 45 assertions |
| Authenticated Web `/reflect` regression, inside the direct-chat suite | 53 passed, 1768 assertions |
| Memory, callback and managed-model sweep, ten suites | 96 passed, 3 skipped, 0 failed, 399 assertions. The three skips are the opt-in Hindsight tests, run separately above. |
| Repository test typecheck | Clean against the frozen baseline of 196 known errors. |

The November 23 run, at `989e834ed`, used an earlier managed probe against a
fixture gateway and recorded 38 assertions. Commit `c54f1560b` replaced that
gateway with the Test Credit ledger and its HTTP execution routes; the
checked-in probe records 20. Native Reflect recorded 7 on both days. That
run's sweep had one failure in a billing replay test whose assertion has
since been updated, and 34 typecheck errors outside the baseline that have
since been fixed. The sweep and the typecheck above are the current results.

Use the repository test environment with a disposable `TEST_DATABASE_URL`.
In `server/tests/memory-store.integration.test.ts`, run the two opt-in
`self-hosted Hindsight Reflect` tests separately so each starts with fresh
Memory owners. Set `TEST_HINDSIGHT_REFLECT_API_URL` for native Reflect. For
managed Reflect, set `TEST_HINDSIGHT_MANAGED_REFLECT_API_URL`,
`TEST_HINDSIGHT_MANAGED_REFLECT_CALLBACK_PORT`, and
`TEST_HINDSIGHT_SYNTHETIC_MODEL_URL`. Point the managed Hindsight Reflect
provider at the corresponding loopback callback under
`/internal/hindsight/v1`, with the callback's own token as the provider key.
The fixture model must implement Hindsight's structured JSON response
format and return synthetic usage. Hindsight needs a Reflect model
configured: with `HINDSIGHT_API_LLM_PROVIDER=none` and no Reflect provider,
its Reflect endpoint answers 400 and OpenBot returns local retrieval
instead of a reflection. The running `hindsight-api` 1.2.3 container in the
local middleware stack is in that state, so it is not a Reflect target for
these probes.
