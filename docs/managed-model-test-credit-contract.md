# Managed model Test Credit contract

The OpenBot runtime can send Web direct-chat text turns through a single versioned model route using Test Credits. With the trial enabled, the authenticated Person, persisted Conversation and original Run determine the operation ID. The same server client can be used by Learning and Hindsight with a stable execution ID and step for each model call.

## Deployment settings

| Variable | Value |
| --- | --- |
| `OPENBOT_MANAGED_MODEL_TRIAL_URL` | HTTPS origin of the internal controlled entry point. Loopback HTTP is allowed for local contract tests. |
| `OPENBOT_MANAGED_MODEL_TRIAL_TOKEN` | Service credential scoped to OpenBot's Test Credit trial. |
| `OPENBOT_MANAGED_MODEL_TRIAL_ROUTE` | Published route key for one verified text model, including its Harness and Price Version. |

Set all three values on the OpenBot runtime deployment to enable the trial. The route applies to direct chat in that deployment. Account eligibility is checked by the controlled entry point. Chat sends server-persisted user and assistant text and returns the completed reply using the existing AG-UI stream. Other execution paths require their own integration with this client before they can use platform credentials.

## HTTP contract

OpenBot posts JSON with the configured service bearer token. Return typed business outcomes as HTTP success responses. An unsuccessful HTTP status, timeout or invalid response cannot grant a dispatch permit.

| Endpoint | Request | Response `state` |
| --- | --- | --- |
| `POST /v1/reserve` | `operationId`, `application: "openbot"`, `creditType: "test"`, `scope` (`personId`, `conversationId`, `botId`, `runId`, `source`), `step`, `route` | `reserved` with an opaque `permit`, `existing` for a recorded operation, or `denied` with `reason` |
| `POST /v1/dispatch` | `operationId`, `permit`, `messages` (roles and text) | `completed` with `text`, `reconciling` if the supplier may have been reached, or `denied` with `reason` |
| `POST /v1/reconcile` | `operationId` | `pending`, `settled`, `released` or `absent` |

Denial reasons are `insufficient_credits`, `execution_limit`, `not_authorized` and `route_unavailable`. Reconciliation accepts only an operation ID. Usage and prices come from trusted service records. OpenBot asks for reconciliation after dispatch, on ambiguous reservation responses and when an existing operation needs recovery.

## Direct-chat Run recovery

OpenBot stores a dispatch checkpoint on the Run before it calls the controlled entry point. An authorized replay request can resume a Run that has yet to cross that checkpoint. If dispatch might have occurred and the outcome is unknown, OpenBot blocks fresh turns in the Thread.

`POST /api/copilotkit/threads/:threadId/runs/:runId/reconcile?agentId=:agentId` checks the original operation. The control plane can include conclusive outcome evidence in its existing `/v1/reconcile` response.

| Response fields | OpenBot behavior |
| --- | --- |
| `state: "settled"`, `outcome: "executed"`, `text` | Records the verified reply in the original Run. |
| `state: "released"` or `"absent"`, `outcome: "not_dispatched"` | Clears the hold when the control plane guarantees the original operation never reached the supplier and can no longer dispatch. A new send creates a new Run and checks Test Credit admission again. |
| `state` alone | Reports settlement and keeps the unknown outcome. A released reservation can also represent an expired dispatched operation. |

`POST /api/copilotkit/threads/:threadId/runs/:runId/stop?agentId=:agentId` ends an active Run for the authorized owner. History preserves partial output and any outstanding unknown outcome.

## Service requirements for acceptance

1. The ADR 0008 ledger resolves the Person to the Billing Account, checks spending authorization and atomically reserves the bounded Test Credit charge against that account and the applicable execution limits. The reservation freezes the Price Version. Bind the permit and operation to the service identity, route, actor and reservation. Release confirmed unsent reservations when authorization or eligibility is lost or the permit expires.
2. The ADR 0007 controlled entry point rechecks eligibility and authorization and durably consumes the permit once before forwarding to Bifrost. Record the dispatch timestamp and any evidence of an uncertain send. Configure Bifrost with the verified supplier route, enforce input and output cost bounds, disable automatic retries and fallback, and restrict supplier credentials and network access to that controlled path.
3. The ledger's durable reconciler must recover operations even when OpenBot never receives a response or restarts. Record verified usage against the original reservation before `dispatch timestamp + 24 hours`. At the deadline release the unverified portion and settle eligible usage once, using the frozen price. Route late or unverified supplier costs to the platform's cost records. Keep confirmed unsent and uncertain dispatches distinct.
4. End-to-end acceptance needs a funded and authorized Test Credit account, the running controlled entry point and Bifrost/provider route, and access to their operation and ledger records. Use concurrent Web turns, replay after a lost dispatch response, and exercise both sides of the 24-hour cutoff using a controllable ledger clock. The local tests use an HTTP contract service and verify OpenBot behavior at that boundary.
