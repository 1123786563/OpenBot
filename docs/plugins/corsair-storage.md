# Corsair storage in PostgreSQL

The published migration `0094_corsair_shared_storage` replaces 14 provider pilot tables
with five Corsair core tables and four OpenBot extension tables. The runtime migrator
applies it after `0093_corsair_slack_shared`. The historical migration combines generated
DDL, a data backfill and the drop of the pilot tables in one PostgreSQL transaction.
It retains connection, installation, Trigger, receipt and Run IDs, credential
revisions and the data they pin.

Stop all API and worker replicas running code that reads the pilot tables before
applying the migration. Start all replicas with the matching runtime after the
migration succeeds. The old runtime requires the dropped tables, and the new runtime
requires the migrated records and compatibility views.

Keep the published migration intact for installations that have already applied it.
For future schema changes, generate DDL and put backfills or other custom SQL in
separate migrations as described in the [development guide](../development.md).


The core columns follow the [Corsair LangChain example](https://github.com/corsairdev/corsair/blob/main/demo/langchain/db.ts) and the `corsair@0.2.15` PostgreSQL ORM. PostgreSQL stores timestamps as `timestamptz` and config, entity data, and event payloads as `jsonb`. IDs and permission expiry remain text. Use a version such as `1.0.0` for entities. The pinned ORM applies JSON decoding to text fields and interprets a version like `"1"` as a number. The OpenBot views read digit-only GitHub repository IDs as exact text without passing them through that decoder.

- `corsair_integrations` identifies provider registrations. OpenBot reserves integration names and IDs beginning with `openbot:`. The key includes the workspace, provider, and registration.
- `corsair_accounts` stores Personal connections, Slack Shared installations, and registration accounts. A registration account owns workspace-scoped entities and events. Each Personal account has a distinct Corsair tenant key derived from the workspace, Person, and stable connection ID. Typed columns carry provider identity, sealed credentials, and the credential revision. The existing OpenBot credential encryption code owns the sealed credentials.
- `corsair_entities` stores repository enrollments and Goal trigger bindings under separate entity types. OpenBot keeps the allowlist and authorization pins in typed extension columns. The Corsair account, entity type, and entity ID are unique together.
- `corsair_events` stores authenticated receipts and the original payload. Delivery IDs and body hashes are each unique within the workspace and registration. The core status becomes `completed` after fan-out planning. Each trigger retains its own retry and outcome.
- `corsair_permissions` supports Corsair's SDK permission shape. OpenBot writes still use OpenBot Approvals, including the pinned identity, resource, and arguments.

The four extension tables hold single-use OAuth states, owner-scoped default selections, per-trigger dispatch outcomes, and Slack Shared access tied to a verified installation. The installation foreign key removes Shared access when the installation changes. Personal Bot grants use `plugin_grants` kinds `corsair.github` and `corsair.slack`. The grant reference encodes the workspace, registration, and tool in a JSON array. Audit events, approved actions, and queued Goal Runs continue to use the OpenBot tables.

The provider modules write through PostgreSQL views with check options. The views preserve the typed route records and filter by provider and record kind. The applications of `createCorsair` used for outgoing calls still receive credentials through the OpenBot authorization path. The SDK database adapter is tested separately against the five core tables.

## Rebase issue #25

Commit `68a592df` changes Slack authorization before a Goal write. In `slack/write-access.ts`, replace the removed `slackPilotGrants` import with `pluginGrants`. Use `corsairGrantRef(workspaceId, registration, tool.ref)`, `kind = 'corsair.slack'`, and `agentId` for the write-access and retry queries. Resolve the overlap in `slack/routes.ts` by retaining this grant contract for the route that enables or revokes access. In `slack/accounts.ts`, preserve `storageKind` in the account and default conflict targets. The connection IDs and revisions used by #25 remain strings with their existing values. The GitHub receipt and trigger exports keep their existing names, and the dispatch references use text IDs to match the underlying entities and events.

## Disconnect and revocation

The account records retain the local disconnect time and independent access and refresh evidence. Active account views exclude disconnected records, and dispatch checks the pinned account under a PostgreSQL row lock. A request that already reached the provider can finish. Revocation checks use the sealed credential until enough evidence is recorded to clear it.

For GitHub and Slack Personal connections, use `DELETE /api/corsair/{provider}/connections/{id}/revocation` to disconnect and attempt provider revocation. The same path supports `GET` for status and `POST` to retry outstanding checks. `GET /api/corsair/{provider}/connections/revocations` lists the signed-in person's disconnected accounts. A fresh authorization can reconnect the same account after revocation is confirmed.

Slack checks the access and refresh tokens independently using `auth.revoke`. GitHub checks the specific access token using the app token endpoint and can confirm access loss through an authentication probe. The GitHub pilot has never stored refresh tokens. An administrator records separate refresh evidence after a provider-side review. Any provider error or ambiguous response leaves the corresponding capability unconfirmed.

For a Slack Shared installation, `DELETE /api/corsair/slack/shared/installation` disconnects the local enrollment. `GET /api/corsair/slack/shared/installation` includes its revocation status. An administrator reviews the installations and channels returned by `GET /api/corsair/slack/shared/installation/revocation/impact` and posts the returned `confirmation` to `/api/corsair/slack/shared/installation/revocation`. An impact change requires a new review. Matching enrollments are disconnected at confirmation. Evidence from the configured Bot token applies to the selected enrollment. Other enrollments stay pending until independently checked. The shared pilot uses a static Bot token.

Administrators can record provider-side evidence with `PUT` on the appropriate revocation path plus `/evidence`. Send the verified `capability` (`access` or `refresh`) and an opaque `evidenceRef` such as a provider incident record ID. Keep tokens out of the reference. Revocation attempts and manual evidence are recorded in the OpenBot audit trail. Mutating requests use the existing `X-OpenBot-Pilot` header.
