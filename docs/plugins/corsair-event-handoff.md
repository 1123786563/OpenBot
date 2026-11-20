# Reconcile Corsair Goal event delivery

Keep both signed endpoints active during observation. The legacy GitHub webhook or Slack OpenTag event path creates Runs. Corsair records its receipt and candidate Trigger outcomes in the same PostgreSQL storage. Each source has its own handoff.

## Verify and transfer a source

1. Use the repository's numeric ID as the GitHub source. Use `teamId/channelId` for Slack. Keep `CORSAIR_GITHUB_ISOLATED_EVENT_SOURCES` for repositories with no legacy Trigger.
2. As a deployment admin, call `GET /api/corsair/events/receipts?provider=github&source=123`. Check that each event appears under both ingress paths and that the legacy path accounts for every candidate Trigger. GitHub correlates exact signed body hashes. Slack correlates provider event IDs. A delivery whose identity differs across the paths requires investigation.
3. Compare the report with provider delivery history and verify equivalent Trigger configuration, source permissions, and Goal ownership. Reconcile failed deliveries and any gaps around the intended cutoff. Record the evidence reference. If the provider history cannot account for a gap, use `POST /api/corsair/events/incidents` with `provider`, `source`, and `historyRef`. Use the same source query with `GET /incidents` under the event operations path to read recorded incidents.
4. Call `POST /api/corsair/events/handoff` with `provider`, `source`, the reconciled `eventKeys`, the `triggerPairs` array of `{ legacy, corsair }` IDs, and `providerHistoryRef`. The server requires matching persisted receipts, accounting for each Trigger, and at least one legacy Run. A `409` leaves dispatch on the legacy path. A successful request returns the UTC cutoff.
5. Compare receipts immediately before and after the cutoff. Ask GitHub to redeliver a failed webhook to the path that owned it. Redeliver a successful event to both paths and verify the existing Run count. Verify OpenTag replies separately from Goal dispatch.

## Recover delivery

Corsair retries transient authorization or dispatch failures through the existing sweeps. Events first received more than five minutes after occurrence require corroborating historical evidence. Use `POST /api/corsair/events/replay` with `provider`, `source`, `receiptId`, `triggerId`, and `historyRef` after confirming that the Trigger and account qualified at occurrence. The existing dispatcher rechecks current access and Goal state. Set `decision` to `account-inactive`, `authorization-revoked`, or `trigger-created-after-event` when the evidence establishes a skip. Use `unknown` to leave the dispatch in review. An unresolved change in eligibility remains in review. The legacy GitHub webhook has no Personal Connection for verifying historical read access. It leaves delayed supported events in review when their eligibility cannot be established. A terminal skip or a queued Run cannot be requeued by this operation.

OpenTag forwards its managed event ID without a provider occurrence time. After handoff, an OpenTag retry with an existing legacy receipt preserves its original owner. If the first OpenTag receipt appears after handoff for an older Slack event, check the native receipt and provider history before attempting recovery. Keep an incident when that history is insufficient.

Route server logs for `corsair-event-dispatch-overdue` to the operator alert sink. Each alert identifies the provider, source, event key, receipt, Trigger, and unresolved outcome. The sweep records the alert once after the receipt is more than 15 minutes old.

## Capture raw evidence for a specific delivery

Set `CORSAIR_EVENT_RAW_EVIDENCE_DELIVERIES` to the provider delivery identifiers approved for capture. Use comma-separated entries such as `github:<delivery-uuid>,slack:<event-id>`. The server captures the original signed bytes only on first receipt of a selected delivery and encrypts them with the deployment credential key.

To download evidence, call `GET /api/corsair/events/:provider/:receiptId/evidence?triggerId=<id>` while signed in as a Trigger owner with current provider read access to the resource. The server rejects reads after seven days and deletes expired evidence during the operations sweep. The receipts report contains delivery metadata.
