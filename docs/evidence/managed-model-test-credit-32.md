# Managed model Test Credit evidence for OpenBot #32

On November 27, 2026, the tests ran at `609103fde` on
`integration/spec3-completion`. The run used a fresh PostgreSQL 17 database
with pgvector, migrated from that commit. The ledger and application ran
OpenBot code. The provider, input meter, and gateway log responses in the
product tests were fixtures.

| Acceptance case | Observed result |
| --- | --- |
| Concurrent product requests | Signed Conversation requests competed for the same Casdoor-linked Test Credit balance. Only the Run with a reservation reached the model executor. |
| Duplicate request and recovery | A lost model response left the original operation pending. Replaying the request and running recovery kept the same operation ID. Recovery settled verified usage once and restored the original reply to Conversation history. |
| Cutoff and outage | At 24 hours the ledger released the unverified hold. Late evidence recorded platform cost and left the user's balance unchanged. When the ledger became unavailable, new model calls stopped and Conversation history remained readable. The companion Conversation and voice test also verified basic Memory access during a billing outage. |
| Learning and Hindsight | The Learn now product tests verified that concurrent requests join the same analysis and reuse its reservation. The earlier [self-hosted Reflect run](hindsight-reflect-41.md) settled five callbacks through the PostgreSQL Test Credit ledger using synthetic model replies. |

The focused run passed 102 tests across seven files. A second run passed
31 tests across Memory, personal Learning, and Bifrost evidence. The second
run skipped three opt-in self-hosted Hindsight tests and the opt-in pinned
Bifrost test.

## Provider-backed acceptance

The [billing pilot matrix](../billing-pilot-matrix.md) recorded real Zhipu
completions through Bifrost and settled them as Test Credit. Its balance race
used the reserve endpoint. The current Conversation tests cover the race
through the product API with a fixture provider.

A provider-backed rerun of the current product flow remains open. The
[archived publication reports](bifrost-publication/) use version 2, and
the current catalog requires version 3 with a provider-issued terminal
cancellation record. The archived November 23 direct-provider probes for
both Zhipu routes returned HTTP 400 validation errors. A fresh run needs an
approved Bifrost deployment and meter, a route with current publication
evidence, and a funded Casdoor-linked Test Credit identity. The reported
opt-in recovery test also requires the documented fixed6 Bifrost image,
whose digest was absent from the local image store.
