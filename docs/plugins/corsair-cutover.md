# Cut over GitHub or Slack tools

A deployment administrator controls the tool route independently for each
workspace and app. Existing Broker calls use legacy until activation. The
destination is the existing Corsair GitHub, Slack Personal or Slack Shared
approval and execution endpoint. Update callers to use that endpoint after
activation and open a fresh one-time Approval. Direct MCP servers use their
existing connection and call entry points.

1. Review the current [readiness inventory](corsair-readiness.md). Copy the
   reviewed policy and decide every capability at the reported revision. A
   disabled tool or grant cannot dispatch through its excluded Corsair mapping.
   Disable any legacy Trigger being retired in its own configuration.
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

A consumed Approval cannot dispatch again. A matching Corsair action for the
same Person and target is blocked while the first result is unknown or has
been reconciled as applied. A confirmed absence permits a new one-time
Approval and dispatch. The old Approval remains consumed.

## Roll back or start cleanup

During the seven-day observation window, verify the remaining legacy
authorization at the broker and verify current action, account, resource and
audience restrictions. Record both evidence references. Send
`{ "kind": "rollback", "inventoryRevision": "<current revision>", "legacyAuthorizationRef": "<ref>", "currentPermissionsRef": "<ref>" }`
with the pilot header to the cutover endpoint. Legacy calls still pass their
normal per-call authorization and approval checks.

Before withdrawing old authorization in the broker or provider console, record
`{ "kind": "begin_cleanup", "evidenceRef": "<ref>" }` at the same endpoint.
Cleanup permanently closes the rollback path for that workspace and app.
Recovery thereafter means fixing the Corsair route and reauthorizing any
affected Connections. Resolve outstanding writes before sending new ones.

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
