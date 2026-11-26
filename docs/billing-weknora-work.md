# WeKnora Test Credit paths

Each resource path is opt-in. The OpenBot deployment can set
`OPENBOT_WEKNORA_CHAT_ROUTE`, `OPENBOT_WEKNORA_RERANK_ROUTE`, and
`OPENBOT_WEKNORA_MAINTENANCE_ROUTE` independently. Set
`OPENBOT_TEST_CREDIT_WEKNORA=enabled`, the WeKnora service token, the Casdoor
issuer/provider, and the gateway and meter revisions and credentials. Chat and
maintenance use `TEST_CREDIT_BIFROST_URL`. Reranking uses
`TEST_CREDIT_RERANK_BIFROST_URL` and requires a published rerank route qualified
with terminal input-token and pre-dispatch limit evidence. Configure the meter
to cover the exact wire format of each enabled path.

Configure WeKnora with `OPENBOT_WEKNORA_WORK_URL` pointing to
`/api/weknora/work`, the same WeKnora service token, and
`OPENBOT_WEKNORA_OIDC_ISSUER`. The service credential stays on the server.

For one accessible shared knowledge base, create a Spending Authorization
on the requester's OpenBot account. Use the knowledge base owner's tenant in
the exact resource scope `weknora:tenant:<owner>:kb:<id>:<path>`. Use an online
grant for `chat` or `rerank`. Send its ID on WeKnora's normal
`POST /api/v1/knowledge-chat/:session_id` or `POST /api/v1/knowledge-search`
endpoint as `X-OpenBot-Authorization-Id` and a new UUID as
`X-OpenBot-Operation-Id`. Repeat the same UUID only to retry the same input.
These paths use keyword retrieval so no separate embedding charge is incurred.
Managed chat is text-only and emits the answer once the gateway reply settles.

For Wiki index maintenance, set `OPENBOT_WEKNORA_MAINTENANCE_RESOURCE` to the
base resource without the suffix, and set the task, grant, and payer's Casdoor
subject in `OPENBOT_WEKNORA_MAINTENANCE_TASK`,
`OPENBOT_WEKNORA_MAINTENANCE_GRANT`, and
`OPENBOT_WEKNORA_MAINTENANCE_SUBJECT`. The background grant includes the same
task ID and the exact resource with the `:maintenance` suffix. The periodic
housekeeping pass queues Wiki finalize. The worker keeps the pending finalize
rows when the paid step cannot proceed.

Instead of a person's grant, the deployment can fund maintenance from a
platform budget: set `TEST_CREDIT_WEKNORA_MAINTENANCE_BUDGET_ID` to a
confirmed Test Credit budget on the platform Billing Account with issuer
`openbot:platform` and subject `weknora-maintenance` (enroll and claim that
account with the trusted ledger provisioning API, then call `createBudget`),
leave `OPENBOT_WEKNORA_MAINTENANCE_GRANT` unset, and set
`OPENBOT_WEKNORA_MAINTENANCE_SUBJECT=weknora-maintenance` so the worker sends
no `authorizationId`. A missing or exhausted budget pauses the charged step
with `execution_limit` before any gateway request.

## Local cross-service test

Build the WeKnora test binary from its checkout:

```sh
go test -c -o /tmp/weknora110-joint.test ./internal/application/service
```

From the OpenBot worktree, with an isolated migrated PostgreSQL database:

```sh
WEKNORA_110_TEST_BINARY=/tmp/weknora110-joint.test \
  bun test --no-env-file --env-file=.env.test server/tests/weknora-work.integration.test.ts
```

The test uses a loopback gateway and meter, and fills the WeKnora caller
context and retrieval, queue, and Wiki storage with fixtures. The billing
receipt records the route, price version, reserved maximum, terminal usage,
charge, and application. Target deployment, provider qualification, and paid
pilot signoff remain separate acceptance steps.

## Fixture results

| Path | Published fixture route | Input tokens | Output tokens | Maximum hold | Charge |
| --- | --- | ---: | ---: | ---: | ---: |
| Shared knowledge chat | `text` | 3 | 2 | 16 | 5 |
| Knowledge search reranking | `rank` | 3 | 0 | 12 | 3 |
| Wiki index maintenance | `text` | 3 | 2 | 16 | 5 |

Holds and charges are in Test Credit microcredits. The online fixture uses a
caller from a different tenant than the knowledge base, with viewer access.
Each successful operation reserves and dispatches once, returns a WeKnora
receipt, and settles against the named payer. The three service calls debit
13 microcredits from the shared account.

Wrong app credentials, requester subject, or resource scope were denied.
An exhausted cap, absent maintenance grant, revoked grant during metering,
and expired grant caused no gateway request. An unanswered request stayed
in reconciliation when retried and caused one gateway dispatch.
