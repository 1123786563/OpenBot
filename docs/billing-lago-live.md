# Live Lago outbox acceptance

This record covers #97's live acceptance against a self-hosted Lago community
edition, driven through the durable `lago_usage_events` outbox.

## Deployment

Lago CE `v1.57.0` (compose from `getlago/lago`) runs locally: `db`, `redis`,
`migrate`, `api`, `front`, `api-worker`, `api-clock`, `pdf`. Two deployment
notes for whoever repeats this:

- `LAGO_RSA_PRIVATE_KEY` must be the **base64 of the PEM** — compose
  interpolation destroys literal newlines, and the application decodes base64
  itself (`config/initializers/rsa_keys.rb`).
- The events API takes `timestamp` as **epoch seconds**, rejects ISO strings and
  fractional seconds, and attributes aggregation per
  `external_subscription_id`; `external_customer_id` alone is not stored on the
  event row.

The organization also needed the `postgres_enriched_events` feature flag for the
api-worker to enrich ingested events (default off for a fresh org).

## Wiring

- `server/src/billing/lago-client.ts` implements the outbox's `LagoUsageClient`
  against `POST /api/v1/events`: the outbox `eventId` becomes Lago's
  `transaction_id` (Lago's own idempotency key), the billing account id becomes
  `external_customer_id` plus `external_subscription_id` via a supplied mapping,
  and the integer microcredits travel as the `microcredits` property. Units map
  onto a `sum_agg` billable metric (`model-usage`); money stays zero on a
  zero-amount plan charge.
- The outbox projection now carries `accountId` so the client can attribute
  events without any other lookup.
- `server/scripts/lago-live.ts` drives the acceptance: `seed` (account, outbox
  rows, Lago customer and subscription), `flush` (exporter run with row states),
  `usage` (Lago aggregation query).

## Acceptance result

| Step | Result |
| --- | --- |
| Seed three pending events (50, 57, 64 microcredits) | `live3-seed.json` |
| Stop the Lago API, flush | `{sent: 0, paused: 0}`, all rows stay `pending` (`live2-outage.json`) |
| Restart the Lago API, flush | `{sent: 3, paused: 0}`, all rows `accepted` (`live3-recovery.json`) |
| Flush again | `{sent: 0, paused: 0}` — replay is idempotent |
| Lago audit by transaction id | each event stored exactly once, attached to the account's subscription |
| Money | invoice/usage amounts stay `0` cents |

Evidence files live in [`evidence/billing-lago-live/`](./evidence/billing-lago-live/);
the running deployment's artifacts are kept outside the checkout at
`/Users/wuyj/.local/share/openbot/billing-97`.

## Remaining Lago-side gap

Enrichment runs (one enriched row per event once the org flag is on), but
`quantified_events` — the table behind `current_usage` units — stays empty in
this deployment: v1.57's high-volume `events-processor` service is not part of
the default compose and upstream documents it as requiring ClickHouse and
Redpanda. Raw-event ingestion, idempotency, outage retention and replay are all
verified above; showing aggregated units in Lago's own `current_usage` response
needs that service deployed alongside.
