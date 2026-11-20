# Corsair migration readiness

Deployment administrators can inspect GitHub and Slack independently at
`GET /api/corsair/migration/github` and `GET /api/corsair/migration/slack`.
The server supplies the workspace from its deployment ID. Legacy Broker rows
have deployment-level ownership, so they are attributed only to that deployment.
The report includes configured and observed tools, legacy accounts, pilot grants,
and Trigger configurations. Read the capability blockers alongside the Connection
and installation status. A local Connection or installation record alone does
not establish live provider access or revocation.

After running the pilot checks, record a decision with
`POST /api/corsair/migration/:app/decisions`. Send the capability key and a
decision of kind `verified`, the report's `inventoryRevision`, evidence
references under `checks.identity`, `checks.resourceScope`, `checks.approval`,
`checks.event` and `checks.revocation`, and an `addedPermissions` array. List
each added GitHub App permission or Slack scope. The capability stays blocked
while this array contains entries. For legacy accounts and Triggers, set
`targetId` to the verified Connection, shared installation, or GitHub replacement Trigger ID. For a Slack Trigger,
record the verified Personal Connection for the Trigger owner and Slack team. Use durable references to the underlying checks and keep credentials
and raw provider payloads out of the evidence. A capability can also be excluded
from cutover with a decision of kind `disabled`, the inventory revision, and
a reason. The audit records the actor and decision. The cutover controller must
honor these exclusions when routing calls and Triggers.

To copy a reviewed policy, send `POST /api/corsair/migration/:app/policies` with
`legacyTool` (the exact configured tool ref), `botId`, `inventoryRevision`,
`resources` (GitHub repository IDs or Slack channel IDs), and a binding
of `{"kind":"personal","connections":["<id>"]}` or
`{"kind":"shared","installationId":"<id>"}`. Provide evidence references for
`equivalentAppAndAction`, `identityAndResources`, and `preservedRestrictions`
under `evidence`. Shared policy copies also require
`evidence.sharedAudienceAndOutsideInput`. Copying requires a current source
grant and reviewed accounts. Existing destination decisions take precedence.
Shared audience, listed members, and outside-input policy come from the saved
legacy approval.

Migrated grants are constrained to the reviewed Connections and resources.
Dispatch checks the original grant and tool, applicable restrictive approval
rules, and the deployment boundary. A missing policy or unknown initiator
context blocks the migrated grant. Goal dispatch via a copied Slack Personal grant is blocked until its legacy
initiator context can be evaluated. The Slack Shared route retains its Goal
initiator and checks the copied audience and outside-input rule on each call. Pending and conversation
approvals stay on the legacy path. Corsair writes require a fresh one-time
approval bound to the new action.

The Slack Trigger check uses the existing Trigger and verifies that its
owner has the selected Connection and that the shared installation covers its
channel. Record #24 live delivery evidence for that binding. Readiness treats
the #26 revocation marker as disconnected. Record Access and Refresh
revocation evidence separately through the #26 workflow. Re-read readiness at the cutover boundary
and consume the explicit capability exclusions there. This feature stores
decisions in the existing audit trail and policies in the existing grant and
shared-access tables.
