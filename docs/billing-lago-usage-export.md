# Lago usage export

OpenBot writes the Lago outbox row in the same transaction as the Test Credit
settlement. For a bound Bifrost call, the Bifrost request ID is also the outbox
event ID and Lago transaction ID. For other settlements, OpenBot derives an
opaque ID from the account and operation. The row keeps the original operation
ID, model, verified input and output token counts, charged microcredits, and
dispatch time. Token counts and microcredits travel as decimal strings so the
JSON transport preserves integers above JavaScript's safe integer limit.

## Configure the worker

Create a dedicated customer and subscription in your self-hosted Lago
organization. Use an opaque deployment reference for each. The customer's
applicable timezone must be UTC. The subscription must use a dedicated plan
with a zero base price, no fixed charges or minimum commitment, and one
unfiltered standard charge priced at zero. Set its metric code to
`model-usage`, aggregation type to `sum_agg`, and field to `microcredits`.
Use a non-recurring metric with no expression, rounding function, or filters.

Set these variables on the worker. Both deployment Compose files pass them
through from the Compose environment.

| Variable | Value |
| --- | --- |
| `LAGO_URL` | Origin of the self-hosted Lago API on a trusted network |
| `LAGO_API_KEY` | Lago key with access to read the destination and read and create events |
| `LAGO_USAGE_SUBSCRIPTION_ID` | The dedicated subscription's external ID |

The worker verifies the destination before draining pending rows. Lago gets
one subscription reference for the deployment, with no Billing Account IDs,
account mapping, authorization credentials, provider keys, prompts, or
responses. Account-level joins use OpenBot's outbox and ledger. The exporter
sets the event's precise money amount to zero and uses whole UTC epoch seconds.

## Reconcile an event

Use the operation ID to find its outbox event in OpenBot. Compare that event
ID to the Bifrost request ID and Lago transaction ID. Compare the token
counts to authenticated Bifrost evidence and the exported integer
microcredits to the OpenBot settlement. In Lago, use the dedicated
subscription's current usage to check UTC period boundaries, summed
microcredits, and zero cents.

The worker reads Lago's stored event before writing and checks it again
after sending a missing event. Outages keep new rows pending. A discrepant
or rejected event is paused and its reason stays on the OpenBot outbox row.
Other events can still export. A destination with unsafe pricing, timezone,
or metric configuration stops the export until the configuration is corrected.

Run the command below in the OpenBot deployment with the same worker
settings and `DATABASE_URL`. Keep the appended JSON records in an
operator-controlled location.

```sh
bun --no-env-file server/scripts/lago-live.ts reconcile "$event_id" >> lago-reconciliation.jsonl
```

The command checks the existing record and replays a missing one with its
original ID and timestamp. A conflicting Lago record requires correction in
Lago before another attempt. Replay updates only the outbox. Any user
charge adjustment follows OpenBot's trusted evidence, reservation and cutoff
rules. If upstream evidence shows that a Bifrost route is untrustworthy,
pause its admission through the pilot controls.

Old `lago:<account>:<operation>` IDs contain Billing Account IDs. The new
exporter pauses them before sending any event data. Keep those rows for
review against the original deployment before migrating the historical
records, since changing a Lago transaction ID can count its usage twice.
