# Test Credit pilot ledger

The Test Credit service uses the Bifrost catalog's active publication for new reservations. The quote exposes the Credit type, Price Version, input and output rates in microcredits per million tokens, and maximum hold in microcredits. Balances and receipt amounts are decimal strings representing whole microcredits.

## Identity and entry points

The integration target for account authentication is Personal SaaS at `d95e3c87` and `2b8953fc`. Its server verifies Casdoor's issuer and subject on sign-in, stores the unique pair, checks the server-side session, and revalidates the Casdoor account. Adapt that authorization path to return the verified pair to `createTestCreditRoutes`. Billing maps the pair to its own account ID. Email, Bot ID, Person ID, and HTTP request fields do not establish this mapping.

A trusted provisioning caller enrolls approved pairs with a fixed batch UUID and integer amount. `POST /claim` issues the enrollment once. `GET /balance`, `GET /quote`, and `GET /operations/:id` use the verified account-session credential. The route factory separates account and execution authentication. The deployment adapter must require a credential attesting to the verified owner of the persisted execution for execution routes. A browser session alone does not grant execution access. Host only the account routes on an account-facing origin, enforce the application's same-origin policy for mutations, and keep execution routes on a controlled origin.

The server client in `server/src/managed-model.ts` derives the operation ID from the persisted execution scope and step, using the same identifier as the #32 candidate at `e393335b`. The direct-chat integration should call it after claiming the persisted Run and checking Conversation access. A worker should use the actor and execution identifiers from its persisted job, and recheck authorization on recovery. Both supply the pinned quote and obtain execution credentials from the verified owner rather than accepting identity fields from the caller.

## Execution contract

| Endpoint | Request |
| --- | --- |
| `POST /v1/reserve` | Operation ID, route ID, and quoted Price Version |
| `POST /v1/dispatch` | Operation ID, permit, and persisted text messages |
| `POST /v1/reconcile` | Operation ID |

The account transaction serializes claims, reservations, and settlement. An existing, untouched reservation can return the same permit with the original quote. Dispatch consumes that permit before invoking the executor. It releases a confirmed unsent hold if the route has become ineligible or the five-minute permit has expired. New reservation attempts also clear that account's expired, unconsumed holds. A replacement publication with the same verified execution revision preserves the original operation's locked rates.

The executor must enforce the verified route's input and output limits before or during execution, with gateway retries and fallbacks disabled. It supplies text and authoritative usage to the service. The service sums exact input and output costs and rounds the combined amount half up once, recording both the debit and the amount released. A lost response, invalid usage, or settlement failure after permit consumption leaves the operation pending and the hold intact. Retry returns the existing state. The reconciliation endpoint reads that state. Applying trusted late usage, the cutoff, and attribution of the supplier outcome are part of #91.

## Integration gates

The ledger migration and fixture verification run on the billing branch. Mounting the account routes, displaying the quote and receipt in Personal SaaS, and connecting the persisted Conversation and Worker entry points require the accepted #53 authorization path and the #32 caller integration. When combining migrations, reconcile the billing migration and journal with Personal SaaS's existing `0089` and `0090`. The client in this branch changes the candidate's execution credentials and reservation payload, so wire those together in the same integration.

Live acceptance still needs the separately tracked #89 provider verification, a bounded controlled executor, and an authenticated Casdoor trial with enrolled accounts. Run concurrent turns against a funded account and verify the real Bifrost execution and settled receipt. The PostgreSQL integration test exercises the HTTP boundary with fixture credentials and execution outcomes.
