# Credit paths

The paths credits travel are ledger state (migration `0108`): who may spend, on which resources, under which application, and what a restore from backup holds. Each rule below is a ledger method first. `server/tests/billing-paths.integration.test.ts` runs them against PostgreSQL.

## A suspended account

`suspendAccount(accountId, true)` is the Casdoor 停用 seam. While it holds, the account reserves nothing and dispatches nothing, in either Credit type, and both refusals answer `not_authorized`. A reservation made before the suspension is released, with its hold returned, when its runner arrives. A step already dispatched settles. Purchases stay paused as before, and refunds continue.

## Applications and Spending Authorizations

An application registers an identity, an operator (`platform` or `independent`) and the resources it may be authorized for, as a name prefix. Nothing is granted to it before `approveApplication(id, by)`. A person's Spending Authorization names the application, a prefix within that scope, an expiry, a limit in microcredits, and either `online` or `background` with exactly one task. `authorize` refuses an unapproved application, a prefix outside the registered scope, a limit of zero and an expiry already past. Asking again with the same ID answers with the first grant.

A reservation under an authorization carries `authorizationId`, `resourceId` and, for a background one, `taskId`. It is refused with `not_authorized` when the authorization is unknown to that account, revoked or expired, the application is unapproved, the resource is outside the prefix, the caller names another application, or the task does not match. A paused application answers `route_unavailable`. The hold or charge of each step counts against the authorization's limit, and a step past it is refused with `execution_limit`. That refusal is not a resume point: the limit is the person's to raise. Dispatch rechecks revocation, expiry and the pause, and releases a reservation that no longer qualifies.

A limit only rises and an expiry only extends (`amendAuthorization`). An application reads an account through `authorizationSummary` and `authorizedOperation` alone, and both answer nothing for an authorization granted to another application.

`pauseApplication(id, by)` refuses new reservations and releases undispatched reservations for that application. Other eligible applications can still reserve. Payment verification, refunds, and settlement continue for existing work. `paidPaths()` lists registered paid paths and their pause state. Each new sale also checks the signoffs that cover the buyer.

| Endpoint | Credential | Request |
| --- | --- | --- |
| `GET /applications` | Account session | |
| `GET /authorizations` | Account session | |
| `POST /authorizations` | Account session | `authorizationId`, `applicationId`, `kind`, `taskId` for a background one, `resourcePrefix`, `expiresAt`, `limitMicrocredits` |
| `POST /authorizations/:id/revoke` | Account session | |
| `POST /authorizations/:id/amend` | Account session | `limitMicrocredits`, `expiresAt` |
| `POST /v1/reserve`, `/v1/dispatch`, `/v1/reconcile` | Application credential | The `x-openbot-application` header, and `authorizationId` in the body |
| `GET /v1/spending-authorizations/:id` | Application credential | |
| `GET /v1/spending-authorizations/:id/operations/:operationId` | Application credential | |

A call that names an application is admitted by `authenticateApplication(request, applicationId)`, which the route factory takes as a dependency. Without it such a call answers 503. The application then acts as the person who granted the authorization it names.

## Channel evidence and the cutoff

`createPaidCreditLedger(database, clock, channels)` takes the deployment's currency and each channel's merchant. Once they are named, a channel result must match that merchant and that currency along with the order's own channel and amount. Any other result is refused and changes nothing: the order waits as it was placed, so a forged or misrouted callback cannot spoil the payment it imitates, and the real payment still verifies.

`pendingOrders(accountId?)` lists the orders still awaiting a channel result. `closeOrder(orderId, by)` closes one the channel says nobody paid. A payment the channel confirms afterwards still verifies it.

## Restore mode

`beginRestore(by)` starts a restore from backup. Until it ends, `restoreHolds` keeps new charges and new grants paused for every account, and reaches reservations made before it. A payment that lands meanwhile is refused with `ledger_restoring`, so the channel retries.

Reconcile each account against the channel and the trusted usage, then `resumeAccount(accountId)`. Everything recorded after the backup is rebuilt by its original ID:

- An order the backup never had is put back with `restoreOrder`, by the ID the channel knows. Its payment then verifies by its channel reference.
- A dispatched call is reserved and dispatched again by its operation ID, and its trusted usage is recorded again by its evidence ID.

Running either replay again changes nothing. An account with a difference is simply not resumed, and stays paused. `beginRestore` called again during a restore keeps the earlier start, so accounts already resumed stay resumed. `endRestore` ends it.

A service rollback needs no ledger change. A step is priced from the route frozen on its own operation, so work dispatched before the rollback settles at the original price after the catalog changes. A reservation on a route that is no longer published is refused at dispatch and released, and a new reservation needs the current Price Version.

## Operating

```
DATABASE_URL=… bun scripts/billing-paths.ts apps
                        register <id> --name <name> --operator platform|independent --prefix <prefix>
                        approve <id> --by <who> | pause <id> --by <who> | resume <id>
                        pending [--account <id>] | close <order id> --by <who>
                        restore begin --by <who>
                        restore order <order id> --account <id> --product <code> --cents <amount> --channel alipay|wechat
                        restore resume --account <id> | restore end
```

Registering and approving applications is an operator action. The Credits page shows a person their authorizations, lets them grant one to an approved application whose path is open, and revoke it.

### Independent application Test Credit pilot

Register the application as `independent` with the CLI above. Keep its
resource prefix narrow, and approve it before the user grants access. On the
Billing API set `TEST_CREDIT_APPLICATION_BINDINGS` to a JSON object of
application IDs and lowercase SHA-256 digests. Generate a distinct random
bearer of at least 32 URL-safe characters for each application. Give the
application its bearer and retain only the digest on the Billing API.

Configure the Billing API's Casdoor issuer/provider and the existing
`TEST_CREDIT_BIFROST_*` gateway, revision, digest, and meter settings. The
application uses `X-OpenBot-Application` and `Authorization: Bearer …` on
`/api/billing/v1`. It can read its own active grant and append `/quote` to
`spending-authorizations/<id>` for the published route and hold. Reserve
through `/reserve` with the grant, resource, operation ID, route, and price
version. Send the grant, operation ID, returned permit, and text messages to
`/dispatch`. A background reservation includes the task in the grant. Poll
`spending-authorizations/<id>/operations/<operation-id>` for the receipt.
The named application's account access is separate from the user's bill.

This entry spends the Credit type in the person's grant. Paid Credits
require an explicit Paid Credit grant and a signoff for the selected path.
Local PostgreSQL and HTTP fixtures cover the application credential,
scoped authorization, metered dispatch, and paid receipt.


## Set the shared provider-cost ceiling

Apply migration `0119_shared_pilot_provider_cost` before deploying the updated API and Worker. Run these commands from `server/` with the operator's database credentials.

```sh
bun scripts/billing-paths.ts provider-cost
bun scripts/billing-paths.ts provider-cost set --microcredits 1000000 --by pilot-lead
```

The first command shows the configured ceiling, cumulative exposure, and remaining headroom. The second sets the absolute ceiling and records the previous value, new value, operator, and time. Use the operator's own identifier in `--by`.

The shared ceiling covers all pilot reservations across billing accounts and model routes, including operations created before the migration. Each reservation counts at its frozen upper bound until trusted evidence reports cost. Unknown dispatched operations keep the bound after their user reservation releases, including after evidence polling ends. Confirmed usage replaces the bound. A confirmed unsent operation frees its share. Existing limits for individual routes still apply.

The database checks the ceiling in the reservation transaction. Pausing a route blocks new admissions while dispatched operations continue to settle. If trusted evidence exceeds the frozen bound, the ledger records the observed cost and can report negative headroom.

Keep migration `0117` applied during a binary rollback. Its trigger still caps new reservations. An older API image may return a generic error on a capped reservation. In the deployment drill, verify the operator's database role can inspect and edit the ceiling, then test a full cap and an in-flight settlement with the rollback API and Worker images against the migrated database.

## Record paid pilot signoff

Apply migrations through `0126_billing_paid_path_policy`. Run the operator CLI from the repository root with `DATABASE_URL` set to the target ledger.

```sh
bun server/scripts/billing-paths.ts signoff record --file application-signoff.json
bun server/scripts/billing-paths.ts signoff record --file channel-signoff.json
bun server/scripts/billing-paths.ts signoff list
bun server/scripts/billing-paths.ts provider-cost set --microcredits <shared-amount> --by <operator>
bun server/scripts/billing-paths.ts provider-cost set --route <route-id> --microcredits <amount> --by <operator>
bun server/scripts/billing-paths.ts provider-cost --route <route-id>
bun server/scripts/billing-paths.ts pause <application-id> --by <operator>
bun server/scripts/billing-paths.ts channel pause alipay --evidence deployment --by <operator>
bun server/scripts/billing-paths.ts resume <application-id>
bun server/scripts/billing-paths.ts channel resume alipay --evidence deployment
```

Each JSON file contains `kind`, `id`, `evidence`, `deploymentId`, `buildVersion`, `imageDigest`, `deploymentRef`, `approvedBy`, `pauseOwner`, and `accountIds`. Use Billing Account UUIDs for `accountIds`. Use an immutable `sha256:<digest>` from the running API image. Keep the referenced evidence in the pilot's records.

| Record | Additional fields |
| --- | --- |
| `kind: "application"` | The registered application ID in `id`. Set `pathRef`, `rampRef`, and `sharedSupplierCapMicrocredits`. Each item in `routes` has the released route `id`, `revision`, and `provider`, plus its own `pathRef`, `resourceType` (`chat`, `embedding`, `rerank`, or `maintenance`), `reconciliationRef`, `reconciliationWindowSeconds`, `supplierCapMicrocredits`, and `maxOperationMicrocredits`. Use decimal strings for microcredits and a positive integer for seconds. |
| `kind: "channel"` | Set `id` to `alipay` or `wechat`. Set `merchant`, `maxOrderCents` as an integer, and `paymentRef`, `refundRef`, `reconciliationRef`, and `rulesRef`. |

The running API requires `deployment` evidence matching `DEPLOYMENT_ID`, `OPENBOT_BUILD_VERSION`, and `OPENBOT_BILLING_IMAGE_DIGEST`. The operator verifies the image digest against the running container before configuring it. Fixture signoffs qualify only a ledger running with an explicit fixture scope. The existing loopback checkout adapter also requires fixture scope for new sales.

Approve each registered paid application with the existing `approve` command. The first-party application ID is `openbot`. A paid reservation needs a matching application signoff for the account and released route. Both the route ceiling and the shared pilot ceiling must be configured within the signed caps. The ledger acquires the shared exposure and user hold in one transaction. Dispatch rechecks the signoff and releases a reservation that no longer qualifies. A sale needs at least one eligible application path and a matching channel signoff for the buyer, merchant, and amount. Recording new evidence for a paused channel preserves its pause. Update the signed route list to enable or withdraw one resource path. Maintenance and chat can share a gateway route and still require separate entries.

At dispatch, the ledger freezes the signed reconciliation deadline on each paid operation. Existing operations and Test Credit requests keep their original 24-hour rule. Re-record application signoffs from before migration `0126` with the verified per-resource windows and shared ceiling.

People choose the credit type in the Conversation confirmation or on their Spending Authorization. External callers cannot change the type in a grant. Existing grants remain Test Credit grants in the pilot.

### Verify on the target deployment before opening sales

1. Read back the running API and Worker images. Link their digests to the build and source commit. Verify the controlled entry, credential isolation, account allowlist, maximum order size, and provider-cost caps on that build. Record the readback in `deploymentRef`.
2. For each supplier and resource type, confirm the cost boundary and reconciliation window. Attach that evidence to the corresponding route revision. Capture path-specific evidence for the application. Use the separate WeKnora evidence from [#110](https://github.com/1123786563/OpenBot/issues/110) for chat, reranking, and maintenance. Verify each independent application under the contract in [#111](https://github.com/1123786563/OpenBot/issues/111).
3. For each proposed channel, verify its merchant, applicable refund rules, financial reconciliation procedure, and channel limits. Complete a small real payment and a refund through the original channel. Reconcile the order, the channel's funds, and the resulting Credits and entitlement. Store the four references in that channel's record. Real merchant checkout requires the target payment integration.
4. Rerun the concurrency, failure, and account isolation cases on the deployed entry. Pause one application and check that new reservations and undispatched work stop. Verify another signed path still runs, and that in-flight payments, original-channel refunds, and dispatched usage still complete. Pause each proposed channel and verify new checkout stops while earlier payments and refunds reconcile. Link the results in `rampRef` before the pilot lead signs off.

The local PostgreSQL tests in `server/tests/billing-paths.integration.test.ts`
use fixture signoffs and payment results. They check that a mismatched build,
image, account allowlist, order maximum, or provider-cost ceiling prevents
admission. Pausing one application stops its held and metering work while the
other signed application can dispatch and settle. Pausing Alipay leaves
WeChat available. After switching the pause to WeChat, Alipay can open new
orders. In-flight fixture orders on both channels still verify and refund on
their original channel. Signoff readback includes the path, rollout, payment,
refund, reconciliation, and rules references.

Target deployment acceptance remains open for all four steps.

## Still gated on a deployment

Querying and closing orders on the real channel needs the test merchant. The restore and rollback drills above run against the ledger; the deployment drill that starts an older build is separate. An application's credential, and the controlled executor behind `/v1/dispatch`, are mounted by a deployment. The WeKnora adapter in `server/src/billing/weknora-ingestion.ts` keeps its own in-memory authorization map and has not moved onto this contract.

OpenBot's own model calls make the ledger's reservation. The adapter wired into the server (`server/src/managed-model-trial.ts`), for Web direct chat and the auxiliary calls beside it, reads `GET /v1/quote`, reserves on that Price Version as the app `openbot` with Test Credits, and sends `resumable: false`, since nothing retries a chat turn by its operation ID. `server/tests/managed-model-routes.integration.test.ts` runs it against these routes and the real ledger.

What that leaves to a deployment is the credential. The entry point resolves the person from the credential and never from the body, and the runtime holds one service token for everybody, so a deployment has to give the entry point a way to tell people apart. The Bifrost executor behind `/v1/dispatch` is mounted by the same deployment.

## Payment disputes

Run these commands from the repository root in the billing operator environment with `DATABASE_URL` set. Use channel or finance record IDs as references. Record the operator's identity with `--by`.

```sh
bun --no-env-file server/scripts/billing-paths.ts dispute open <order-id> --by <operator> --reference <channel-case-id>
bun --no-env-file server/scripts/billing-paths.ts dispute status <order-id>
bun --no-env-file server/scripts/billing-paths.ts dispute confirm-reversal <order-id> --by <operator> --reference <channel-reversal-id>
bun --no-env-file server/scripts/billing-paths.ts dispute reconcile <order-id> --by <operator> --reference <finance-record-id>
```

Open a case when the channel reports a payment dispute. The disputed order stops funding new reservations and dispatches. Work already sent can settle against its original allocation. Other eligible sources remain available.

Use `confirm-reversal` after verifying the reversal with the original channel. The ledger revokes the order's remaining credits and keeps the original usage. After the affected holds settle or release, run `status` to get the RMB amount to reconcile. Use `reconcile` after recording the reconciliation in the finance system. Repeating a command preserves the existing case and evidence. The customer's orders and usage statement show the same dispute ID and progress.
