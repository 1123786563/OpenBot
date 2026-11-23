# Credit paths

The paths credits travel are ledger state (migration `0108`): who may spend, on which resources, under which application, and what a restore from backup holds. Each rule below is a ledger method first. `server/tests/billing-paths.integration.test.ts` runs them against PostgreSQL.

## A suspended account

`suspendAccount(accountId, true)` is the Casdoor 停用 seam. While it holds, the account reserves nothing and dispatches nothing, in either Credit type, and both refusals answer `not_authorized`. A reservation made before the suspension is released, with its hold returned, when its runner arrives. A step already dispatched settles. Purchases stay paused as before, and refunds continue.

## Applications and Spending Authorizations

An application registers an identity, an operator (`platform` or `independent`) and the resources it may be authorized for, as a name prefix. Nothing is granted to it before `approveApplication(id, by)`. A person's Spending Authorization names the application, a prefix within that scope, an expiry, a limit in microcredits, and either `online` or `background` with exactly one task. `authorize` refuses an unapproved application, a prefix outside the registered scope, a limit of zero and an expiry already past. Asking again with the same ID answers with the first grant.

A reservation under an authorization carries `authorizationId`, `resourceId` and, for a background one, `taskId`. It is refused with `not_authorized` when the authorization is unknown to that account, revoked or expired, the application is unapproved, the resource is outside the prefix, the caller names another application, or the task does not match. A paused application answers `route_unavailable`. The hold or charge of each step counts against the authorization's limit, and a step past it is refused with `execution_limit`. That refusal is not a resume point: the limit is the person's to raise. Dispatch rechecks revocation, expiry and the pause, and releases a reservation that no longer qualifies.

A limit only rises and an expiry only extends (`amendAuthorization`). An application reads an account through `authorizationSummary` and `authorizedOperation` alone, and both answer nothing for an authorization granted to another application.

`pauseApplication(id, by)` refuses that application's new reservations. Other applications and first-party steps keep working, and payments, refunds and settlements already in flight finish. New orders are refused with `no_paid_path` while every approved application is paused; `paidPaths()` lists which are open.

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

## Still gated on a deployment

Querying and closing orders on the real channel needs the test merchant. The restore and rollback drills above run against the ledger; the deployment drill that starts an older build is separate. An application's credential, and the controlled executor behind `/v1/dispatch`, are mounted by a deployment. The WeKnora adapter in `server/src/billing/weknora-ingestion.ts` keeps its own in-memory authorization map and has not moved onto this contract.

OpenBot's own model calls make the ledger's reservation. The adapter wired into the server (`server/src/managed-model-trial.ts`), for Web direct chat and the auxiliary calls beside it, reads `GET /v1/quote`, reserves on that Price Version as the app `openbot` with Test Credits, and sends `resumable: false`, since nothing retries a chat turn by its operation ID. `server/tests/managed-model-routes.integration.test.ts` runs it against these routes and the real ledger.

What that leaves to a deployment is the credential. The entry point resolves the person from the credential and never from the body, and the runtime holds one service token for everybody, so a deployment has to give the entry point a way to tell people apart. The Bifrost executor behind `/v1/dispatch` is mounted by the same deployment.
