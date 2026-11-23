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

Choose **Create using Credits** on the Routine form or **Use Credits** on a check-in item to start a text-only execution. The dialog shows the model rate and maximum hold per request. Choose Test Credits or Paid Credits, then confirm the cumulative cap in Credits. The server binds the budget to the published route and Price Version. API callers can get the same fields from `POST /api/billing/budgets/preview` with a Credit type and a limit in microcredits.

Each billed step uses the same reservation, dispatch, and reconciliation functions as Conversations. The step ID stays the same when a worker reclaims the execution. Before dispatch, the API checks the current Person, Bot, conversation, Billing Account, and effective budget. The executor checks access again before it binds the gateway request. A settled step reuses its saved result.

A balance or cap refusal records a resume point without placing a hold. Choose **Continue** on the original Routine run or Task and confirm the updated budget. The new cap includes earlier charges from that execution. If a request is still under reconciliation, **Continue** checks the original request and waits for a usable result. Adding Credits by itself leaves paused work waiting. Scheduled occurrences outside the grace period remain skipped.

The isolated PostgreSQL tests in `server/tests/resume-points.integration.test.ts` exercise the Routine store, durable Task queue, and fixture executor. They verify cumulative spend, explicit continuation, lost replies, and access revocation after reservation. The scheduler test in `server/tests/routine-sweep.integration.test.ts` verifies that a replacement worker reuses the same run ID.

Full #94 acceptance still requires a verified dispatch contract for tool-bearing Routine and Task runs, including connected-app actions and model calls after a tool result. The current Web flow meters the text reply. An unknown result without a recoverable reply stays blocked, and a released, unsent operation has no automatic replacement. Live acceptance requires the controlled #89 gateway, approved input meter, read-only evidence proxy, and pre-enrolled Casdoor identity.

## Integration gates

The fixture test uses isolated PostgreSQL, signed Better Auth sessions, seeded Casdoor account links, and loopback gateway and meter endpoints. The same admission, settlement, and recovery code runs in the pilot. Live acceptance requires the #89 provider evidence, a controlled Bifrost executor, the approved input meter, and a Casdoor sign-in for pre-enrolled accounts. Personal SaaS onboarding issuance is tracked in #68. Real timeout and late-outcome acceptance is tracked in #91.

## Recover lost replies from Bifrost

Run the Worker reader against the same isolated, digest-pinned gateway deployment that serves the API. On that gateway, enable durable Bifrost logging and retain the content and usage for at least seven days. Limit access to the contents to the billing recovery service and trusted operators. Keep the gateway on an isolated network, expose only authenticated inference to the API, and keep its management listener private. Configure a single upstream key per approved provider and disable caching, transformations, aliases, provider retries and request fallbacks.

Run `bun server/scripts/bifrost-log-proxy.ts` alongside Bifrost. Set `BIFROST_LOG_PROXY_UPSTREAM_ORIGIN` to Bifrost's loopback origin and inject a dedicated random `TEST_CREDIT_BIFROST_LOG_TOKEN`. The proxy listens on loopback port 4207 by default. Use `BIFROST_LOG_PROXY_PORT` to change it. Expose the proxy to the Worker through a private TLS listener. The proxy accepts only authenticated `GET /api/logs/<uuid>` calls and projects matching terminal log fields. It uses Bifrost's exact-ID log endpoint and does not pass Worker credentials to Bifrost.

Set `TEST_CREDIT_BIFROST_LOG_ORIGIN` to the private TLS origin and give the Worker the same `TEST_CREDIT_BIFROST_LOG_TOKEN`. Use a separate token from the inference and meter tokens. Set the Worker's gateway revision, gateway image digest and metering revision to the API's values. Keep the reader bound to that deployment's log store. Gateway rotation requires access to the prior deployment's store for any remaining outstanding invocations.

Before dispatch, OpenBot stores the one-time gateway request UUID and a SHA-256 digest of the exact request bytes. Bifrost logs that UUID, the operation and body digest labels, and a fingerprint of the frozen route and deployment revisions. The Worker reads at most 16 records per tick. It starts checking 90 seconds after binding, retries missing evidence at five-minute intervals, and stops checking seven days after dispatch. Reads have a four-second deadline and a 256 KiB body limit. The Worker corroborates the returned request against its durable binding, model, provider, revisions, terminal status and usage bounds. It stores the qualifying usage and reply together under the account lock. Evidence stored at or after the 24-hour cutoff affects platform accounting only. Recovery issues read requests exclusively.

The reader accepts successful non-streaming chat completions with a textual reply and consistent terminal usage. Missing or conflicting evidence, opaque errors and cancellation remain unknown. The Bifrost log does not independently prove provider-side cancellation, zero cost or platform fault. The existing #89 publication gate still requires live provider evidence.

To run the pinned-image acceptance test, start the image recorded in [the #89 build evidence](evidence/bifrost-zhipu-family-cap-fixed6.image.json) with a fresh log store. Point its single `zhipu/glm-5.3-flash` route at an isolated OpenAI-compatible fixture with the native `/api/paas/v4/chat/completions` path. Use a fixture key and return one assistant message with text `Recovered isolated reply.`, finish reason `stop`, and usage of two input and three output tokens. Set `TEST_PINNED_BIFROST_ORIGIN` to the gateway's loopback origin and run:

```sh
bun test --no-env-file --env-file=.env.test server/tests/bifrost-evidence.test.ts
```

The test drops the completed inference reply, reads the actual gateway log through the scoped proxy, and verifies that recovery leaves the inference dispatch count at one.
