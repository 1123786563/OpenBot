# Test Credit pilot ledger

The Test Credit service uses the Bifrost catalog's active publication for new reservations. The quote exposes the Credit type, Price Version, input and output rates in microcredits per million tokens, and maximum hold in microcredits. Balances and receipt amounts are decimal strings representing whole microcredits.

## Identity and entry points

The Web Conversation pilot resolves the signed-in Person through Better Auth's stored OIDC account link. The configured Casdoor issuer and provider ID select the link. The issuer and provider subject map to one Billing Account. A missing or ambiguous link makes the pilot unavailable to that Person.

A trusted provisioning caller enrolls Casdoor identities with a fixed batch UUID and integer amount. `POST /api/billing/claim` claims a pre-enrolled batch once. The signed-in Person can also read `/api/billing/balance`, `/api/billing/quote`, and `/api/billing/operations/:id`. The browser's session grants access to account routes. The public mount refuses execution calls. Controlled callers of `createTestCreditRoutes` can supply their own execution authenticator.

In a direct Conversation, the owner sees the published quote and confirms its route and Price Version. The server checks ownership before it claims the Run and persists the operation ID. The Run calls the ledger and controlled executor in the API process. The response includes the charge and released amount, and the Credits page can open the durable receipt. A browser replay and the Worker use the operation ID already recorded on the Run. The Worker can recover the stored reply after evidence arrives or settlement completes. An uncertain result stays pending without a second dispatch.

## Configure the Web Conversation pilot

Register Casdoor as an OIDC provider in the OpenBot deployment and provision the pilot accounts. Enable the pilot on an OpenBot server that uses local Better Auth sessions. Set `OPENBOT_TEST_CREDIT_CONVERSATIONS=enabled`, `TEST_CREDIT_CASDOOR_ISSUER` to the issuer exactly as it appears in the OIDC account link, and `TEST_CREDIT_CASDOOR_PROVIDER_ID` to the registered provider ID. The Worker uses these same three settings.

The API also needs `TEST_CREDIT_BIFROST_URL` for Chat Completions and `TEST_CREDIT_INPUT_METER_URL` for the request meter. Configure their scoped credentials in `TEST_CREDIT_BIFROST_TOKEN` and `TEST_CREDIT_INPUT_METER_TOKEN`. Use the publication's `TEST_CREDIT_GATEWAY_REVISION`, `TEST_CREDIT_GATEWAY_IMAGE_DIGEST`, and `TEST_CREDIT_METERING_REVISION`. Match these to the route verification report before enabling the pilot. The executor checks the meter's proof against the exact request bytes and sends `max_completion_tokens` with the published limit.

## Execution contract

| Endpoint | Request |
| --- | --- |
| `POST /v1/reserve` | Operation ID, route ID, quoted Price Version, and the original operation ID for an explicit rerun |
| `POST /v1/dispatch` | Operation ID, permit, and persisted text messages |
| `POST /v1/reconcile` | Operation ID |

The account transaction serializes claims, reservations, and settlement. An existing, untouched reservation can return the same permit with the original quote. Dispatch consumes that permit before invoking the executor. It releases a confirmed unsent hold if the route has become ineligible or the five-minute permit has expired. New reservation attempts also clear that account's expired, unconsumed holds. A replacement publication with the same verified execution revision preserves the original operation's locked rates.

Display the quote's `usageDisclosure` before submitting an operation. A failed, cancelled, or interrupted request with verified usage can still consume Test Credits.

The executor must enforce the frozen route's input and output limits, with gateway retries and fallbacks disabled. It returns the response and authoritative usage. A trusted executor can report confirmed zero cost, a confirmed platform failure, partial usage, or cancellation. An opaque error or missing usage leaves the outcome unknown. The service uses the original rates to price verified usage, rounds the combined amount half up once, and caps the user's debit at the original reservation. Confirmed zero cost and usage attributed to platform failure release the entire hold.

The deadline is 24 hours from durable dispatch admission. The ledger timestamps evidence on its own clock under the account lock. The first trusted terminal observation recorded before the deadline is eligible. Persist evidence separately from settlement so a restart can finish recording the debit. The server's maintenance loop checks for expired holds one minute after startup and one minute after each completed sweep. Each sweep selects up to 100 operations by dispatch time through a partial index and applies the cutoff under the account lock. A sweep skips accounts locked by another transaction so they can be retried on a later tick. Balance reads, receipt reads, admission, and reconciliation also apply the cutoff transactionally at or after the deadline. Unknown operations release their full user hold. Eligible unsettled operations retain only the amount needed to settle; the receipt shows both the retained and released amounts. Execution reconciliation can finish an eligible settlement at any time and is safe to replay.

Trusted adapters call `recordEvidence` with a stable source evidence ID and cumulative token counts for the same invocation. Replay with different contents is rejected. The ledger preserves late evidence and additional observations for platform accounting. `reconciliationCost` computes the platform share from the largest observed cumulative cost and the original user debit or eligible charge. An operation with unknown supplier cost has no observed platform cost yet. The ledger preserves a dispatched operation after its user hold is released so later trusted evidence can still be associated with it.

A retry keeps the operation ID and returns the existing receipt without sending another request. For an explicit rerun, persist a fresh execution identifier and pass the original operation as `rerunOf` to the managed model. The new request has its own permit, quote, and hold. Account authentication scopes the original operation lookup and the receipt shows the link.

## Cumulative execution budgets

Routine and persistent Task rows may bind to a confirmed Test Credit execution budget. Each managed-model step carries the budget ID and a stable step ID into reservation and dispatch. The ledger counts reserved, pending, and settled operations against the same budget, rejects unconfirmed or exhausted budgets, and rechecks the cumulative limit immediately before dispatch. Repeating one step with the same operation and step identity is idempotent. A managed-model result is stored on the operation so a paused task can resume from its completed result after the user confirms a larger limit.

The focused verification covers budget confirmation, cumulative-limit refusal, dispatch-time revalidation, repeated-step binding, and result preservation. The database-backed execution-budget test runs against an isolated PostgreSQL database and verifies that a budget can be confirmed and enlarged before the next step.

## Integration gates

The fixture test uses isolated PostgreSQL, signed Better Auth sessions, seeded Casdoor account links, and loopback gateway and meter endpoints. The same admission, settlement, and recovery code runs in the pilot. Live acceptance requires the #89 provider evidence, a controlled Bifrost executor, the approved input meter, and a Casdoor sign-in for pre-enrolled accounts. Personal SaaS onboarding issuance is tracked in #68. Real timeout and late-outcome acceptance is tracked in #91.

Deployment still needs an authenticated gateway evidence reader. The executor receives usage inline and sends `x-openbot-operation-id`. The catalog's verification reports attest to route probes. To recover usage after the inline response is lost, the gateway must durably correlate the dispatch to a unique upstream invocation, scoped to the authorized account and frozen route and metering revision. A read-only service credential must be able to retrieve that invocation's terminal status, authoritative cumulative usage, platform-fault attribution, and a stable evidence ID. The evidence must survive process restarts and remain available for late platform-cost reconciliation. A recovery adapter must persist qualifying evidence in the ledger before cutoff to retain the user hold. Evidence first recorded at or after cutoff goes to platform accounting. Supplier budget accounting and Lago export remain separate billing work.
