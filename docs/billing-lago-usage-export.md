# Lago usage export

Settling a Test Credit operation writes one durable `lago_usage_events` row in the same database transaction. Its event ID is stable for the account and operation, so retries cannot create a second ledger settlement or a second logical usage event.

The exporter sends only the event ID, OpenBot operation ID, model resource, token counts, microcredit amount, and UTC occurrence time. Account identity and Billing Account mapping remain inside OpenBot.

Lago outages leave rows in `pending` for replay. A response with a different event ID, token count, or amount moves the row to `paused` and requires operator review before retrying that path.

The automated evidence covers outage retention, recovery replay, idempotent replay, and mismatch pausing. Live Lago deployment acceptance remains an environment-level check.
