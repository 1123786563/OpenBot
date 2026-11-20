# Test Credit pilot ledger

The Test Credit service uses the Bifrost catalog's active publication for new reservations. The quote exposes the Credit type, Price Version, input and output rates in microcredits per million tokens, and maximum hold in microcredits. Balances and receipt amounts are decimal strings representing whole microcredits.

## Identity and entry points

The integration target for account authentication is Personal SaaS at `d95e3c87` and `2b8953fc`. Its server verifies Casdoor's issuer and subject on sign-in, stores the unique pair, checks the server-side session, and revalidates the Casdoor account. Adapt that authorization path to return the verified pair to `createTestCreditRoutes`. Billing maps the pair to its own account ID. Email, Bot ID, Person ID, and HTTP request fields do not establish this mapping.

A trusted provisioning caller enrolls approved pairs with a fixed batch UUID and integer amount. `POST /claim` issues the enrollment once. `GET /balance`, `GET /quote`, and `GET /operations/:id` use the verified account-session credential. The route factory separates account and execution authentication. The deployment adapter must require a credential attesting to the verified owner of the persisted execution for execution routes. A browser session alone does not grant execution access. Host only the account routes on an account-facing origin, enforce the application's same-origin policy for mutations, and keep execution routes on a controlled origin.

The server client in `server/src/managed-model.ts` derives the operation ID from the persisted execution scope and step, using the same identifier as the #32 candidate at `e393335b`. The direct-chat integration should call it after claiming the persisted Run and checking Conversation access. A worker should use the actor and execution identifiers from its persisted job, and recheck authorization on recovery. Both supply the pinned quote and obtain execution credentials from the verified owner rather than accepting identity fields from the caller.

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

## Integration gates

The ledger migration and fixture verification run on the billing branch. Mounting the account routes, displaying the quote and receipt in Personal SaaS, connecting the persisted Conversation and Worker entry points, and wiring user confirmation for explicit reruns require the accepted #53 authorization path and the #32 caller integration. When combining migrations, reconcile billing migrations `0089` through `0091` and the journal with Personal SaaS's migration sequence. The client in this branch changes the candidate's execution credentials and reservation payload, so wire those together in the same integration.

Live acceptance still needs the separately tracked #89 provider verification, a bounded controlled executor, and an authenticated Casdoor trial with enrolled accounts. Run concurrent turns against a funded account and verify the real Bifrost execution and settled receipt. The PostgreSQL integration test exercises the HTTP boundary with fixture credentials and execution outcomes.

Deployment still needs an authenticated gateway evidence reader. The executor receives usage inline and sends `x-openbot-operation-id`. The catalog's verification reports attest to route probes. To recover usage after the inline response is lost, the gateway must durably correlate the dispatch to a unique upstream invocation, scoped to the authorized account and frozen route and metering revision. A read-only service credential must be able to retrieve that invocation's terminal status, authoritative cumulative usage, platform-fault attribution, and a stable evidence ID. The evidence must survive process restarts and remain available for late platform-cost reconciliation. A recovery adapter must persist qualifying evidence in the ledger before cutoff to retain the user hold. Evidence first recorded at or after cutoff goes to platform accounting. Supplier budget accounting and Lago export remain separate billing work.
