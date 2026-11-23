# Managed model Test Credit contract

The OpenBot runtime can send direct-chat text turns and voice requests delegated to the Conversation Bot through a versioned model route using Test Credits. The authenticated Person, persisted Conversation and original Run determine the operation ID. Direct-chat Learning and Hindsight Reflect use the same client with a stable execution ID and step for each model call.

## Deployment settings

| Variable | Value |
| --- | --- |
| `OPENBOT_MANAGED_MODEL_TRIAL_URL` | HTTPS origin of the internal controlled entry point or its `/api/billing` endpoint. Loopback HTTP is allowed for local contract tests. |
| `OPENBOT_MANAGED_MODEL_TRIAL_PERSON_CREDENTIALS` | Server-side JSON object mapping persisted OpenBot Person IDs to distinct bearer credentials issued for their Billing Accounts. |
| `OPENBOT_MANAGED_MODEL_TRIAL_TOKEN` | Single-user deployments only. Billing must verify this bearer as the single user's execution identity. |
| `OPENBOT_MANAGED_MODEL_TRIAL_ROUTE` | Published route key for one verified text model. The client reads the active Price Version before each reservation. |

Set the URL and route with the applicable credential setting. Provision the credential mapping as a deployment secret from verified Person-to-Billing Account bindings. Set the same tokens on the Billing server in `TEST_CREDIT_RUNTIME_BINDINGS` as a JSON array of entries with `personId` (the Person ID in Billing’s database), `subject` (the verified Casdoor subject) and `token` (at least 32 characters). Billing rechecks the Person’s verified Casdoor link for every request. When rotating a Person's credential, keep it bound to the same Billing Account so retries and recovery can find the original reservation.

The runtime selects the bearer from the persisted Person in the execution scope. That scope comes from the authorized Conversation Run, the Learning scope or the Hindsight Reflect session. The runtime denies execution before contacting Billing if the Person has no bound credential. It uses the Person's credential for quote, reserve, dispatch and reconciliation, including worker recovery. Missing credentials leave existing unknown-outcome Runs unresolved. Billing's durable reconciler can still settle them.

The configured origin must verify the runtime bearer and resolve it to the Person's Billing Account. The OpenBot runtime uses the first-party execution path. It supplies the OpenBot bill attribution and derives the operation ID from the persisted execution scope. Current product authorization still governs foreground and scheduled runs. External applications' task-scoped Spending Authorizations use Billing's separate application-authenticated path.

## HTTP contract

OpenBot sends the executing Person's bound bearer token on every request. The control plane returns typed business outcomes as HTTP success responses. An unsuccessful HTTP status, timeout or invalid response cannot grant a dispatch permit.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /v1/quote` | No body | Published default `route` and publication `priceVersion`. The ledger checks the configured route against that version at reservation. |
| `POST /v1/reserve` | `operationId`, `applicationId: "openbot"`, `creditType: "test"`, `route`, `priceVersion`, `resumable: false` | `reserved` with an opaque `permit`, `existing` for a recorded operation, or `denied` with `reason` |
| `POST /v1/dispatch` | `operationId`, `permit`, `messages` (roles and text) | `completed` with `text`, `reconciling` if the supplier may have been reached, or `denied` with `reason` |
| `POST /v1/reconcile` | `operationId` | `pending`, `settled`, `released` or `absent` |

Denial reasons are `insufficient_credits`, `execution_limit`, `not_authorized`, `route_unavailable`, `pilot_closed` and `unavailable`. Reconciliation accepts only an operation ID. Usage and prices come from trusted service records. OpenBot asks for reconciliation after dispatch, on ambiguous reservation responses and when an existing operation needs recovery.

## Direct-chat Run recovery

OpenBot stores a dispatch checkpoint on the Run before it calls the controlled entry point. An authorized replay request can resume a Run that has yet to cross that checkpoint. If dispatch might have occurred and the outcome is unknown, OpenBot blocks fresh turns in the Thread.

`POST /api/copilotkit/threads/:threadId/runs/:runId/reconcile?agentId=:agentId` checks the original operation. The ledger can include conclusive outcome evidence in the `operation` receipt returned by `/v1/reconcile`. OpenBot checks that the receipt belongs to the original operation and agrees with the response state.

| Response fields | OpenBot behavior |
| --- | --- |
| Settled receipt with a dispatch timestamp, `outcome: "completed"` and `resultText` | Records the verified reply in the original Run. |
| Released receipt with null `outcome` and null `dispatchedAt` | Clears the hold when the control plane guarantees the original operation never reached the supplier and can no longer dispatch. A new send creates a new Run and checks Test Credit admission again. |
| `state` alone | Reports settlement and keeps the unknown outcome. A released reservation can also represent an expired dispatched operation. |

`POST /api/copilotkit/threads/:threadId/runs/:runId/stop?agentId=:agentId` ends an active Run for the authorized owner. History preserves partial output and any outstanding unknown outcome.

## Service requirements for acceptance

1. The ADR 0008 ledger resolves the Person to the Billing Account, checks spending authorization and atomically reserves the bounded Test Credit charge against that account and the applicable execution limits. The reservation freezes the Price Version. Bind the permit and operation to the service identity, route, actor and reservation. Release confirmed unsent reservations when authorization or eligibility is lost or the permit expires.
2. The ADR 0007 controlled entry point rechecks eligibility and authorization and durably consumes the permit once before forwarding to Bifrost. Record the dispatch timestamp and any evidence of an uncertain send. Configure Bifrost with the verified supplier route, enforce input and output cost bounds, disable automatic retries and fallback, and restrict supplier credentials and network access to that controlled path.
3. The ledger's durable reconciler must recover operations even when OpenBot never receives a response or restarts. Record verified usage against the original reservation before `dispatch timestamp + 24 hours`. At the deadline release the unverified portion and settle eligible usage once, using the frozen price. Route late or unverified supplier costs to the platform's cost records. Keep confirmed unsent and uncertain dispatches distinct.
4. End-to-end acceptance needs a funded and authorized Test Credit account, the running controlled entry point and Bifrost/provider route, and access to their operation and ledger records. Use concurrent Web turns, replay after a lost dispatch response, and exercise both sides of the 24-hour cutoff using a controllable ledger clock. The local tests use an HTTP contract service and verify OpenBot behavior at that boundary.
