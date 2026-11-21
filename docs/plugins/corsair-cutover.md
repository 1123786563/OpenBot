# Cut over GitHub or Slack tools

A deployment administrator controls the tool route independently for each
workspace and app. Existing Broker calls use legacy until activation. After
activation, a Bot keeps its reviewed tool reference and uses the corresponding
Corsair GitHub, Slack Personal or Slack Shared action. Writes need a fresh
one-time Approval in a conversation that can ask. The Approval pins the
reviewed Broker account, Corsair Connection and provider resource.

The Bot catalogue offers verified GitHub issue creation and Slack channel
posting with the arguments supported by the Corsair action. Choose the Broker
account as usual when more than one is connected. OpenBot checks the exact
account mapping and current resource access before dispatch. Other scopes and
direct MCP servers continue to use their existing connection and call entry
points.

1. Review the current [readiness inventory](corsair-readiness.md). Copy the
   reviewed policy and decide every capability at the reported revision. A
   disabled tool or grant cannot dispatch through its excluded Corsair mapping.
   An audited Trigger exclusion suppresses its event delivery while Corsair is
   the active route. Pause the Trigger in its own configuration to retire it
   permanently.
2. For each remaining legacy Trigger, complete
   [event reconciliation and handoff](corsair-event-handoff.md). Wait for
   each source's cutoff and check a post-cutoff event delivered one Run.
3. Send `{ "kind": "activate", "inventoryRevision": "<revision>" }` to
   `POST /api/corsair/migration/:app/cutover` with `X-OpenBot-Pilot` set to the app.
   The server rereads readiness and checks recorded Trigger handoffs. New
   dispatches for the scope receive 409 during the drain. Calls that were
   admitted can finish. If they still hold the route after five seconds of
   lock wait, the transition returns 409 and legacy remains active. Inspect
   in-flight or unknown writes before trying again.
4. Read `GET /api/corsair/migration/:app/cutover` for the current route,
   exclusions and observation deadline. Reconcile provider history throughout
   observation. A tool rollback leaves the event ownership established at each
   source cutoff in place. Resolve event incidents through the handoff workflow.

## Reconcile a write before retrying

Administrators can inspect
`GET /api/corsair/migration/:app/unknown-writes?approvalId=<approval>`.
Look up the approved target, operator and exact action in provider history.
Compare the resulting repository issue or channel message and save an opaque
reference to that check. Send `{ "outcome": "applied", "evidenceRef": "<ref>" }`
or `{ "outcome": "not_applied", "evidenceRef": "<ref>" }` with the pilot header
to `PUT /api/corsair/migration/:app/unknown-writes/:approvalId`. A started
attempt becomes reviewable when marked unconfirmed or after 30 seconds. If
evidence is inconclusive, leave it open.

A legacy Broker write with an unknown outcome appears in the same list with
`route: "legacy"`. Use `attemptId` to identify the dispatch. Use the audit record
to identify the Broker account, action and originating Person. While the
attempt is unresolved, both routes for that workspace and app refuse writes.

After reconciling a Broker write as applied, verify the provider operator and
resource in the same provider history. Submit the stable provider operator ID,
the numeric GitHub repository ID or Slack channel ID, and the exact Broker
arguments to `PUT /api/corsair/migration/:app/unknown-writes/:attemptId/operation`.
Include the recorded argument order and Broker tool version when present, plus
an evidence reference. For example, an issue uses the following request:

```json
{
  "providerSubject": "12",
  "resourceId": "23",
  "brokerArgs": {
    "owner": "team",
    "repo": "project",
    "title": "Reconcile a write"
  },
  "evidenceRef": "provider-history/review-42"
}
```

OpenBot checks the arguments against the original attempt digest and verifies
the resource mapping before recording a digest of the equivalent Corsair
operation. An equivalent write remains blocked. An applied Broker attempt
without sufficient evidence fences Corsair writes for its workspace and app.
A `not_applied` verdict permits a fresh Approval.

A consumed Approval cannot dispatch again. A matching Corsair action for the
same Person and target is blocked while the first result is unknown or has
been reconciled as applied. A confirmed absence permits a new one-time
Approval and dispatch. The old Approval remains consumed.

## Roll back or start cleanup

During the seven-day observation window, verify the remaining legacy
authorization at the broker and verify current action, account, resource and
audience restrictions. Read the current inventory and route. Use the same workspace, app and observation
deadline from those responses. Include each current `legacy-account:`, `tool:`
and `audit:` capability key once. Record the time you completed the checks in
`observedAt` and submit the attestation within five minutes with the pilot header.

```json
{
  "kind": "rollback",
  "inventoryRevision": "<current revision>",
  "evidence": {
    "workspaceId": "<workspace>",
    "app": "github",
    "observationUntil": "<current cutover until>",
    "observedAt": "<UTC ISO 8601 timestamp>",
    "authorizationsValid": true,
    "permissionsCurrent": true,
    "legacyAuthorizationRef": "<broker evidence>",
    "currentPermissionsRef": "<provider and policy evidence>",
    "capabilities": ["legacy-account:<account>", "tool:<server>/<action>"]
  }
}
```

The server checks the active observation window, inventory revision and local
connection records. The administrator attests the broker and provider checks.
Legacy calls still pass their normal per-call authorization and approval checks.

After seven days, resolve the observation incidents and reload the readiness
inventory and cutover state. Before withdrawing legacy authorization, submit
`kind: "begin_cleanup"` with the current `inventoryRevision` and an `evidence`
object containing `workspaceId`, `app`, `observationUntil` from the cutover
state, `observedAt` at or after the deadline, `incidentsResolved: true`, and
an `evidenceRef` for the completed observation. OpenBot records this
administrator attestation with the route change and requires current readiness.
Cleanup permanently closes the rollback path for that workspace and app.
Recovery thereafter means fixing the Corsair route and reauthorizing any
affected Connections. Resolve outstanding writes before sending new ones.

## Reconcile legacy authorizations and retire the cleanup credential

Use the deployment-admin endpoint
`/api/corsair/migration/:app/legacy-cleanup/:provider`, where the provider is
`composio` or `arcade`. Include `X-OpenBot-Pilot` with the app name on every
POST. The endpoint accepts evidence after the seven-day observation period and
`begin_cleanup`. Perform provider operations through the authorized broker or
provider console.

1. GET the ledger. Compare its entries with the broker and provider records,
   including remote-only grants and consent attempts that can still finish.
   File a complete `inventory` with an `evidenceRef` and an `entries` array.
   Each entry contains a `ref` and an `impact` array of affected installations,
   connections, or scopes. Keep the returned local refs and add stable opaque
   refs for remote-only entries. Cite the inventory that links each local ref
   to its remote record or documents its absence. Use `reopen: true` if an
   existing authorization becomes uncertain again.
2. For each nonempty impact list, show the full list to the person authorized
   to approve the impact. Record `confirm_impact` with the entry ref, the exact
   impact array, and an evidence ref for their approval. Include the
   `deployment-account` marker when it appears in the local inventory.
3. Request revocation in the authorized console and record `requested` with
   the entry ref and the broker receipt as `evidenceRef`. If the status query
   fails, record `query_failed` with the entry ref and an evidence ref. Recheck
   before retrying a request whose outcome is uncertain. The ledger keeps the
   entry open until evidence verifies the result.
4. Submit `verify` for each entry with its ref, `accessEvidenceRef`, and
   `refreshEvidenceRef`. Use `source: "broker"` for broker evidence that
   separately establishes both results. When the broker cannot establish
   both results, a holder or external administrator verifies them and gives
   the deployment administrator an evidence reference. Record
   `source: "holder"` or `source: "external_admin"` and a `verifierRef`.
   For a local attempt, also provide `terminalAttemptEvidenceRef` showing that
   the attempt can no longer grant authorization. Use an updated inventory
   to include blocked callbacks that arrive during review.
5. Check for other apps, workspaces, deployments, and external jobs that use
   the cleanup credential. Submit `prepare_retirement` with
   `dependencyEvidenceRef` for that review. If OpenBot finds a remaining
   dependency or an unverified entry, it returns 409. Use the preparation
   event's `id` from the response as `preparationRef`.
6. Have the authorized operator disable the credential and verify its
   retirement. Submit `retire` with the preparation ref, the same
   `dependencyEvidenceRef`, and the retirement `evidenceRef`. OpenBot
   rechecks the ledger and records the actor and time. If new evidence
   invalidates the preparation, reconcile it and prepare again.

Use evidence references that an operator can resolve in an access-controlled
record. Keep tokens, authorization URLs, and raw callback handles in their
original systems.

## Live pilot evidence still required

Use an authorized isolated self-hosted pilot. Record separate GitHub and Slack
evidence for the verified identity and resources, Connection, grant,
one-time Approval, remote write, signed Goal event and unique Run, disconnect,
and independent access and refresh revocation. For Slack, distinguish Personal
from Shared identity where both are enrolled.

For each provider, exercise a drain timeout, disconnect before dispatch,
write applied with a lost response, reconciliation before retry, rollback
with live legacy authorization, and recovery after cleanup starts. Record
the provider result and matching OpenBot IDs for each case. Run a direct MCP
connect and call with the pilot configuration and check the remote result.

Observe each provider for seven days. Before widening the cohort, close every
observed identity mix-up, excess permission, approval bypass, dropped
delivery, duplicate Run and unexplained legacy authorization. Fixture tests
exercise PostgreSQL coordination and simulated provider responses. The live
credentials, provider history and seven-day observation record are separate
acceptance evidence.
