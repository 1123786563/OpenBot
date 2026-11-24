# Personal SaaS Web trial

The trial runs a separate OpenBot Web service and database. Put both the OpenBot and Casdoor trial entry points behind participant-only HTTPS ingress. For example, use a private network or an authenticated test ingress that preserves the OpenBot URL and POST `Origin` header. The trial service listens on loopback, so run the proxy on the same host or in the same network namespace. The `private-trial` setting is required. Keep both entry points restricted until public launch acceptance is complete.

In Casdoor, configure a dedicated organization and confidential OIDC Web application. Enable self-service signup for the trial organization, require an email verification step and configure email delivery. Register `<OpenBot trial origin>/auth/casdoor/callback` and `<OpenBot trial origin>/auth/casdoor/reverify/callback` as redirect URIs. Use the `JWT-Standard` token format with authorization code, S256 PKCE, nonce, and token introspection. Keep `Email` present in the application's token fields if you restrict fields. Use the discovery document for this application and copy its `issuer` value exactly. Use one Casdoor origin for discovery and all advertised endpoints. Confirm that introspection returns `active: false` for a forbidden or deleted account on the deployed Casdoor build before admitting participants.

Set these variables in the trial process environment:

| Variable | Value |
| --- | --- |
| `OPENBOT_PERSONAL_SAAS_MODE` | `private-trial` |
| `OPENBOT_PERSONAL_SAAS_URL` | The HTTPS origin participants use for OpenBot |
| `CASDOOR_DISCOVERY_URL` | The HTTPS URL of the trial application's OIDC discovery document |
| `CASDOOR_ACCOUNT_STATUS_URL` | The authenticated account status endpoint at the Casdoor discovery origin |
| `CASDOOR_ISSUER` | The exact `issuer` string from discovery |
| `CASDOOR_CLIENT_ID`, `CASDOOR_CLIENT_SECRET` | The trial application's client credentials |
| `DATABASE_URL` | A dedicated OpenBot trial PostgreSQL database with pgvector |
| `KEY_ENCRYPTION_KEY` | A deployment-specific key generated with `openssl rand -base64 32` |
| `PORT` | The local trial port, default `3001` |
| `OPENBOT_TEST_CREDIT_GRANT_BUDGET_MICROCREDITS` | The global bounded Test Credit issuance budget. Configure together with the grant amount and batch UUID. |
| `OPENBOT_TEST_CREDIT_GRANT_AMOUNT_MICROCREDITS` | The one-time amount issued to each stable Casdoor identity. |
| `OPENBOT_TEST_CREDIT_GRANT_BATCH_ID` | A stable UUID for the grant batch. Keep it unchanged while the trial is running. |

Apply the server migrations first. From the repository root:

```sh
(cd server && bun scripts/migrate.ts)
bun run --filter server start:personal-saas
```

The merged journal keeps main's `0089_direct_chat_runs` and renumbers the
trial migrations to `0090` through `0101`. Their SQL and journal timestamps
are preserved. When the database has a complete prefix of the original trial
journal, the migration command applies and records the missing direct-chat
migration under the migration lock, then runs any pending trial migrations
in the same transaction. An unrecognized journal with unreachable migrations
still requires operator review. Keep the existing trial database and use the
migration command above during rollout.

The landing page sends participants to Casdoor for registration, verification, sign-in and account recovery. OpenBot uses the issuer and stable subject to retain ownership after a verified email change. Returning participants see their existing workspace. An interrupted setup can be retried from the preparation page. First entry creates the workspace and its default Personal Assistant Bot in one transaction. The workspace owns the Bot through `personal_workspace_default_bots`, and `/api/workspace` returns the canonical Bot ID. Enable Bot execution and the managed Computer separately for private acceptance. Workspace preparation does not start a Computer.

When the three Test Credit settings are present, first workspace preparation creates one issuance record per Casdoor issuer and subject. The issuance locks the configured amount to the stable identity and atomically consumes the global budget. A budget shortage leaves the issuance pending and does not block workspace preparation. The next workspace entry retries the same issuance after the operator restores the budget. The Web workspace shows the grant and balance, and `GET /api/workspace` returns the same `testCredits` object for Web and native clients. Issuances remain attached to the billing account after workspace closure, so reprovisioning cannot create another grant.

The budget environment variable seeds the trial budget. When the budget row already exists, set `new_total` to the approved cumulative budget in microcredits and run this statement against the trial database using `psql`:

```sql
UPDATE test_credit_issuance_budgets
SET total = :'new_total'::bigint
WHERE id = 'personal-saas-trial'
  AND total < :'new_total'::bigint
RETURNING total, issued;
```

Use the existing deployment commands for enterprise or local Personal edition.

## Sign out

**Sign out** ends the current OpenBot Application Session. **Sign out all devices** first asks the user to authenticate again with Casdoor. OpenBot requires a signed `auth_time` from after the request began and verifies that the fresh identity matches the application session's issuer and subject. Success revokes every session for that identity in the shared PostgreSQL session store. Cancelled, stale, or mismatched verification leaves other sessions usable. The operation is scoped to OpenBot Application Sessions. Casdoor sessions and sessions in other applications are separate.

The Web workspace opens a same-origin session event stream. Each replica checks the shared store every second while the connection is healthy. Revocation closes matching streams and the Web page returns to sign-in. Configure the trial ingress to forward server-sent events without buffering. Native workspace API requests use the shared session store and reject revoked tokens. Verify revocation for resource transports as they are enabled.

Before enabling all-device sign-out for trial participants, verify the deployed Casdoor application honors `prompt=login` and `max_age=0`, and returns a signed ID token with a fresh `auth_time`. Synchronize OpenBot and Casdoor clocks. OpenBot rejects proof issued in the same second the challenge began, since timestamps have whole-second precision. The integration test uses a local OIDC fixture with real JWT signing and validation. Provider behavior needs verification on the deployed Casdoor build.

Sign-out only deletes session records. An integration test exercises the real durable work queue on PostgreSQL and shows that a worker can renew and finish its lease and claim queued work across both kinds of sign-out. The private trial keeps runtime execution disabled. End-to-end continuation for an authorized Personal SaaS Bot, Routine, or Computer needs verification through its production worker once that runtime and its execution authorization are wired.

## Account status and cutoff

Deploy an account status endpoint at `CASDOOR_ACCOUNT_STATUS_URL`. The endpoint accepts a form POST with `client_id`, `client_secret`, and the stable Casdoor `subject`. Authenticate the configured trial application before returning account data. Return the current account state and complete disablement history from one consistent read of Casdoor state.

| Response field | Meaning |
| --- | --- |
| `issuer`, `subject` | The Casdoor issuer and stable subject for this account |
| `active` | Whether the account is currently active |
| `observedAt` | When the provider reliably observed this state, in UTC Unix milliseconds |
| `disablements` | Every effective disablement for this identity, with a stable `id` and an `effectiveAt` timestamp in UTC Unix milliseconds |

The repository includes a [Casdoor SQLite account-status provider](../docker/casdoor-account-status/README.md) for the private trial. Install it before creating accounts in the dedicated trial organization.

The deployment must record each disablement durably as it takes effect. Include disablements that end before OpenBot polls. Return a failure if the endpoint cannot establish current state or provide complete history. Keep observations ordered and synchronize clocks on the status provider and OpenBot hosts. The integration test provides this endpoint in its Casdoor fixture. Before admitting participants, deploy the provider and verify that it captures every Casdoor mutation path, including a brief disablement followed by recovery.

OpenBot stores the history in PostgreSQL and revokes existing Application Sessions as soon as it observes a new disablement. Recovery requires a later active observation and a new sign-in. If Casdoor cannot confirm status, API access and live sessions expire 60 seconds after the last reliable active confirmation. A failed check leaves that deadline in place. After Casdoor confirms activity again, an unexpired Application Session can regain access. The trial polls known accounts even when all clients are offline. Verify polling and stream closure within 60 seconds at the trial's planned concurrent account count.

Use `createAccountAccess` in trusted server code to read the current account decision and its expiry, or to verify an issued grant against the stored account and authorization epoch. The grant carries the account ID, epoch, and expiry. Enforce its expiry locally. An old grant stays invalid after the account recovers. The trial Web service applies this decision to access and live connections. OpenBot background dispatch and billing admission need to enforce this workspace decision and verify their cutoff in the target deployment. Other applications should use their own authorization and Casdoor account checks.

## iOS and Android trial builds

Set `EXPO_PUBLIC_OPENBOT_MODE=personal-saas` and `EXPO_PUBLIC_SERVER_URL` to the trial HTTPS origin in `mobile/.env` before building the native app. Use an installed development or release build that registers `openbotmobile`. The existing Casdoor HTTPS callback serves both Web and mobile. The app opens the system browser and returns through `openbotmobile://auth/personal-saas`.

Keep the HTTPS origin reachable from the system browser and the app's API client. For a restricted trial, use network-level access that both clients can reach. App API requests authenticate with their own OpenBot Application Session and do not share the system browser's cookies.

Web, iOS, and Android display the same workspace, default Assistant, and recent conversations. `GET /api/workspace/conversations` returns up to 50 titles and last-message previews from the owner's dedicated Assistant, newest activity first. Full transcripts and new conversations are outside the read-only trial.

## Workspace isolation

The owner can read the default Assistant at `GET /api/workspaces/{workspaceId}/bots/{botId}` and rename it at `POST /api/workspaces/{workspaceId}/bots/{botId}/name` with a JSON `name`. Use the IDs returned by `/api/workspace`. The access check uses the authenticated account and the workspace's Assistant binding. Foreign and unknown IDs return the same `404`. The trial sends `Cache-Control: no-store` on workspace responses.

A workspace owner can issue a 15-minute `assistant.read` credential with an empty `POST /api/workspaces/{workspaceId}/bots/{botId}/integration-grants`. Use the owner's Application Session and send the trial `Origin` header for browser sessions. The response contains the grant `id`, the bearer `credential`, and `expiresAt`. The API returns the bearer credential during issuance. Pass it only to the intended integration.

The integration sends `Authorization: Bearer <credential>` to `GET /api/integrations/workspaces/{workspaceId}/bots/{botId}` to read the bound Assistant's ID and name. The owner revokes the grant with `POST /api/workspaces/{workspaceId}/bots/{botId}/integration-grants/{id}/revoke`. Account authorization changes, workspace suspension, and workspace closure invalidate the grant.

Recent conversation history requires an OpenBot Application Session. The authenticated account determines the workspace and Assistant. Assistant integration credentials cannot read conversation history.

Use the two-owner matrix in `server/tests/personal-saas-entry.integration.test.ts` to enable a resource. Replace the closed probe with the real entry point and two actual resources. Verify each owner's success and compare the same request with a foreign and a missing resource. For mutations, verify the denied request leaves the target unchanged. For downloads, replay the exact URL across accounts. For realtime, verify the actual handshake and delivered events. For cache and index access, populate the cache or index as one owner and repeat the same lookup as the other. Apply the same owner and scope checks at background dispatch.

## Support access

Set `OPENBOT_SUPPORT_SUBJECTS` to the comma-separated Casdoor subject IDs of individual support operators for the configured issuer. An empty or omitted setting disables operator endpoints. Operators sign in with their own OpenBot Application Sessions. Removing a subject from the setting takes effect after restarting the trial replicas.

Under `/api/support/workspaces/{workspaceId}`, operators can use:

- `GET /metadata` for workspace readiness, counts by Routine run status, and recent failed run IDs.
- `POST /tickets/{ticketId}/requests` with `resources`, `durationSeconds`, and `reason`. Specify up to 20 exact resources by `{kind, id}`. Supported kinds are `conversation` (channel ID), `file` (attached file UUID), and `computer-session` (session ID for the workspace's isolated Assistant).
- `POST /tickets/{ticketId}/requests/{id}/read` with `resource` and a per-read `reason`. The response returns the conversation's trial title and preview, attached file bytes as base64, or the current snapshot for the specified Computer session.

Ticket IDs refer to the operator's existing support cases. The workspace owner opens **Support access** to review the ticket, resource IDs, reason, and requested duration. The owner can approve for up to 24 hours from approval or revoke access early. The same page shows which operator read each resource, when, and why after expiry or revocation. Owner clients can use `GET /api/workspaces/{workspaceId}/support-requests` and POST to `/{id}/approve` or `/{id}/revoke` beneath that path.

The trial keeps Bot execution, file upload, and live Computer access disabled. The support API reads existing scoped records and provides read-only snapshots for Computer sessions.

## Workspace suspension

Configure `OPENBOT_SUSPENSION_OPERATOR_ID`, `OPENBOT_SUSPENSION_OPERATOR_TOKEN`, and `OPENBOT_SUSPENSION_SUPPORT_EMAIL` together to enable operator actions. Give the designated operator a dedicated credential generated from 32 random bytes encoded as unpadded base64url. Set the ID to the operator's identity in your operations records. Rotate the credential when that person changes and update the ID at the same time.

Send an HTTPS `POST /api/operator/workspaces/{workspaceId}/suspension` with that credential as a Bearer token and a JSON body containing `action` (`pause` or `resume`), a required internal `reason`, and an optional user-facing `displayReason`. A successful change returns an operation ID and the effective time. An already applied state returns `409`. Each transition is recorded with the operator identity. The bearer credential has access to this operation only.

Pause revokes OpenBot sessions, approved support access, and Assistant integration credentials for that workspace in the same transaction as the audit record. Live Web sessions recheck server-side and close on revocation. Mobile and Desktop periodically recheck access and clear displayed workspace content when access ends. A new Casdoor sign-in while paused returns the owner's published reason, support email, and operation ID through the same sign-in flow. Native clients receive those fields through the one-time exchange without a workspace session. Resume requires a later active Casdoor observation and a new sign-in started after the resume took effect. Workspace suspension leaves the Casdoor account and other applications' permissions under their own policies.

Before deployment, apply the suspension migration, provision the operator secret and support address, and verify session closure and offline or foreground behavior on installed builds. Personal SaaS worker dispatch and account deletion are separate trial capabilities. Verify their integration and cutoff before enabling them.

## Workspace export

Select **Download workspace data** in the Web workspace. API clients can POST
to `/api/workspaces/{workspaceId}/exports` to get a relative download URL and
expiry. Use the existing cookie or native Application Session on both requests.
The URL expires after 15 minutes and requires current ownership of the issuing
workspace. Suspension blocks both requests and invalidates links issued before
the pause.

The download is a readable JSON snapshot taken when the link is opened. It
includes the Assistant's readable configuration, stored conversation records,
committed attachments with Base64 content, Personal Memory, Routine
configuration, and Connection metadata. The trial's conversation records
contain stored titles, opening messages, and last-message previews. Full
transcripts in external Intelligence threads are outside the trial scope.

Personal workspace resource writers can use `workspaceResourceOwner` for
user-owned Memory, Routine, and Connection rows. Existing local or enterprise
accounts have separate storage ownership. The trial does not currently expose
creation flows for those resources. Export artifacts are generated from the
workspace data on demand, with no separate copies to remove during closure.

## Bot execution and stopped work

The private trial can run the default Personal Assistant through the OpenBot headless runtime. To enable it on a restricted acceptance service, set `OPENBOT_PERSONAL_SAAS_BOT_EXECUTION=on` and configure `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, `CPK_INTELLIGENCE_API_KEY`, `BOT_MODEL`, and `OPENAI_API_KEY`. This runtime uses the deployment's model credential. It has no connected app or Computer tools and does not implement Test Credits admission.

An authorized client can create a run with `POST /api/workspace/bot-runs` using the workspace ID, Bot ID, and instruction. The response contains a run ID for `GET /api/workspace/bot-runs/{key}`. The same service process polls the durable queue. Work is bound to the account authorization epoch that admitted it, independent of the lifetime of any Application Session. The worker checks that epoch again before dispatch and while running, and enforces expiry locally. A run submitted with `requiresComputer: true` also requires a managed Computer that accepts the task’s original authorization time. If the Computer is unavailable or has since restarted, start it manually and retry to create a new authorization.

After restoring workspace access, Web, mobile, and Desktop Cloud show stopped work with its reason, original input and available output. Cancel or requeue each item independently. A claimed item may have reached an external service, so retry requires acknowledging that the external actions were checked. Requeue and retry produce new queue and run IDs and preserve the stopped record. Keep this capability restricted until cutoff timing on the deployed Intelligence and model services and the recovery flow on installed clients have been verified.

### Managed Test Credit text runs

Enable `OPENBOT_TEST_CREDIT_CONVERSATIONS=enabled` on the Personal SaaS server with
`OPENBOT_PERSONAL_SAAS_BOT_EXECUTION=on` and the three one-time grant settings
above. Configure `TEST_CREDIT_BIFROST_URL` with the HTTPS chat completions
endpoint and `TEST_CREDIT_BIFROST_TOKEN` with its bearer credential.
Set `TEST_CREDIT_INPUT_METER_URL` and `TEST_CREDIT_INPUT_METER_TOKEN` for the trusted
HTTPS input meter. `TEST_CREDIT_GATEWAY_REVISION`,
`TEST_CREDIT_GATEWAY_IMAGE_DIGEST`, and `TEST_CREDIT_METERING_REVISION` must match
the verified default route published in the shared billing catalog.
The meter receives the exact Chat Completions JSON that OpenBot sends to
Bifrost. Use the request headers and response format from the
[managed Harness probe](../scripts/billing-pilot/bifrost.md#run-the-managed-harness-probe).
The meter must support non-streaming text requests and return their input
token upper bound, request SHA-256, and the pinned gateway and metering
revisions.

This mode serves single-instruction text requests through the existing Bot-run API.
It uses the Personal SaaS server's durable work queue and the Test Credit tables in
its PostgreSQL database. The workspace API returns the published quote. The Bot-run
status endpoint returns the owner's receipt when the ledger has an operation.
Supply a UUID `Idempotency-Key` on managed submissions to reuse the same run when
retrying a request. Clients that display the managed quote send
`execution: "test-credit"` in the request body so the API returns HTTP 503 if
managed execution is unavailable. Send the disclosed workspace quote's `route`
and `priceVersion` in the request body's `quote` object. A changed quote returns
HTTP 409 before admission. In the Web workspace, the Test Credits
section accepts a message after showing the price and reservation limit. The
run page shows the Bot's response and the owner's receipt.
A new request with insufficient available credit returns HTTP
402. A concurrent submission may be accepted into the queue and stop at
reservation if another run has already reserved the available credit. Existing
history and workspace resource management remain available.

With managed Test Credit execution enabled, the deployment's headless Bot runner
is disabled. Managed Computer runs and unattended model execution require a
separate billing integration.

In Stopped work, review the current quote before requeuing or retrying a managed
text run. The new run has its own reservation and receipt. If the old run
reached provider dispatch, the new receipt links to its ledger operation.
Confirm that you checked any
external actions whose outcome is unknown. A stopped run keeps its original
input, output and receipt.

API clients send `action: "retry"` and the displayed `quote` with its `route`
and `priceVersion` to `POST /api/workspace/recovery/{key}`. Include
`acknowledged: true` after checking unknown outcomes. Repeated recovery
requests return the original recovery decision and its new run ID.

### WeKnora text ingestion with Test Credits

Publish an embedding route with v3 qualification evidence and input-only pricing.
Set `OPENBOT_WEKNORA_EMBEDDING_ROUTE` to its catalog ID. Configure the shared
`OPENBOT_WEKNORA_SERVICE_TOKEN` on the OpenBot and WeKnora servers. Set
`OPENBOT_WEKNORA_BIFROST_URL` and `OPENBOT_WEKNORA_BIFROST_TOKEN` for the HTTPS
Bifrost embeddings endpoint. Set `OPENBOT_WEKNORA_INPUT_METER_URL` and
`OPENBOT_WEKNORA_INPUT_METER_TOKEN` for the HTTPS meter for that exact request.
The configured `OPENBOT_WEKNORA_GATEWAY_REVISION`,
`OPENBOT_WEKNORA_GATEWAY_IMAGE_DIGEST`, and `OPENBOT_WEKNORA_METERING_REVISION`
must match the evidence of the published route. The meter returns the request
UUID, request SHA-256, gateway revision, meter revision, and input token upper
bound. The gateway must return ordered or indexed float vectors and trusted
input token usage.

The owner submits explicit spending consent with a signed-in OpenBot Web session
to `POST /api/weknora/ingestion-grants`. Supply an `Idempotency-Key` UUID and a
JSON body with `confirmed: true`, the ISO `expiresAt`, the string
`maxMicrocredits`, and `resourceId` in the form
`weknora:tenant:<resource tenant ID>:kb:<knowledge base ID>`. The Web session can
end after consent. The durable grant can be revoked with
`POST /api/weknora/ingestion-grants/<authorizationId>/revoke` using the same
`resourceId`.

WeKnora's service authenticates to `POST /api/weknora/embeddings` with the shared
bearer token. Send the server-verified Casdoor `subject`, `authorizationId`,
`resourceId`, per-batch UUID `operationId`, and `input` array. The batch can
contain up to 32 strings within a 256 KiB request and the route's verified token
ceiling. A completed request returns vectors and a receipt. Reuse the exact
operation ID, scope, and input after a lost response. Completed vectors can be
replayed for up to 24 hours. HTTP 409 indicates a conflicting operation or an
outcome that needs reconciliation. A retry of the same operation cannot create
a second dispatch. OpenBot retains the billing receipt after vector expiry.

## Routine and inbound automation

The workspace’s **Routines and inbound bindings** page lists existing items and their history. The same owner-scoped API accepts a session cookie or native bearer session.

- `GET /api/workspace/automation` lists the items and their current cutoff or resume status.
- `GET /api/workspace/automation/{routines|bindings}/{id}/runs` returns recent history for one item.
- `POST /api/workspace/automation/routines/{id}/run` queues **Run now**.
- `POST /api/workspace/automation/{routines|bindings}/{id}/resume` resumes one item after workspace access returns.

A cutoff leaves Routine configuration and delivery bindings in place. History records the cutoff reason for skipped work. If a Bot turn had started when access ended, its external actions may already have taken effect. Resume schedules the Routine’s next occurrence and accepts inbound messages sent after the binding was resumed. Queued work from an earlier authorization epoch cannot run after access returns.

Inbound delivery uses a trusted provider relay. Set `OPENBOT_PERSONAL_SAAS_INBOUND_RELAY_TOKEN` to enable `POST /api/webhooks/personal-inbound`. The relay verifies the provider event before forwarding it over HTTPS with the configured bearer token. The JSON body contains `transport` (`sms`, `slack`, or `teams`), `realm`, `identity`, `externalId`, `sentAt`, and `text`. Use the provider’s original event ID and send time for every retry. `sentAt` is an ISO 8601 timestamp with a time zone. A valid relay request returns `204`, including when an event is skipped or already recorded. The relay resolves provider identities against existing Personal Workspace delivery bindings.

### Workspace quotas

All Personal SaaS replicas must use the same limits. Trial defaults are placeholders for
target-environment capacity acceptance.

| Variable | Default | What counts |
| --- | ---: | --- |
| `OPENBOT_PERSONAL_QUOTA_BOT_RUNS` | 4 | Queued reservations and in-flight Bot turns, including Routines and inbound automations |
| `OPENBOT_PERSONAL_QUOTA_COMPUTERS` | 1 | The managed Computer while starting, running, or awaiting process exit. Set to 0 to disable starts. |
| `OPENBOT_PERSONAL_QUOTA_STORAGE_BYTES` | 67108864 | PostgreSQL attachments and reserved Computer filesystem capacity. The previous `OPENBOT_PERSONAL_QUOTA_ATTACHMENT_BYTES` is accepted as a fallback. |
| `OPENBOT_PERSONAL_QUOTA_COMPUTER_STORAGE_BYTES` | 0 | The portion of the workspace storage limit reserved for the Computer. At zero, Computer starts are disabled. |
| `OPENBOT_PERSONAL_QUOTA_TRIGGERS_PER_MINUTE` | 30 | Admitted Routine and inbound triggers in the preceding 60 seconds, including manual Run now |

`GET /api/workspace` publishes `quotas` to cookie and bearer sessions. Direct
admissions that exceed a limit return HTTP 429 with `workspace_quota_exceeded`,
`resource`, `used`, `limit`, and `message`. Background automation records
the refusal in its run history. Failed admissions do not consume a trigger.
Completed turns release Bot slots. An interrupted running turn holds its slot
until the worker returns or its lease expires. Stopping a Computer keeps its
files and configuration. The supervisor must be upgraded with the API to
support manual Computer stop.

Use `POST /api/workspace/bot-runs/:key/stop` or
`POST /api/workspace/computer/stop` to request a stop. Attachment clients
can stage a file with multipart `conversationId` and `file` at
`POST /api/workspace/attachments`, list drafts at `GET /api/workspace/attachments`,
and withdraw a draft through `POST /api/workspace/attachments/:id/withdraw`.
The upload limit is 8 MiB per file. Published conversation attachments remain
available through existing history and export paths.

The storage usage total includes staged and retained attachment bytes plus allocated Computer
filesystem blocks. When Computer storage is configured, the response also includes
`attachmentUsed`, `computerUsed`, and `computerReserved`. An unavailable filesystem reading
sets `used` and `computerUsed` to `null`. Upload admission counts the full Computer reservation
so filesystem writes and uploads can proceed concurrently within the combined limit.

With the Flash provider, NAS enforces the reservation as the AgenticSpace quota and OpenBot
keeps no byte counter. A start is refused with HTTP 409 unless NAS confirms that the bound space
is `Running` and sized exactly like `OPENBOT_PERSONAL_QUOTA_COMPUTER_STORAGE_BYTES`. `computerUsed`
is the NAS `SpaceUsage` of that space, which NAS updates after about 15 minutes. A workspace
without an AgenticSpace binding reports `0`. Admission never reads this figure, so the configured
limits keep admitting capacity and attachments while usage is unknown. See
[enforce the quota and read usage](personal-saas-agenticfs.md#enforce-the-quota-and-read-usage).

#### Provision Computer storage

1. Set the same positive `OPENBOT_PERSONAL_QUOTA_COMPUTER_STORAGE_BYTES` on the API replicas and
   the Docker supervisor. Set `OPENBOT_WORKSPACE_STORAGE_ROOT` on the supervisor to an absolute
   path on the Docker engine host. Keep these settings consistent when replacing an API replica
   or supervisor.
2. On the Docker engine host, mount a dedicated, writable ext4 filesystem for each workspace at
   `<root>/<namespace>-workspace-workspace-<workspace UUID>`. The default namespace is `openbot`.
   Set the filesystem's block capacity at or below the reservation. Mount it with `nodev,nosuid`.
   Keep the mount in place while the workspace is in service.
3. Create `workspace` and `profiles` directories at the filesystem root. Put the exact mount
   directory basename in the root's `.openbot-workspace` file. Keep the root and marker under
   operator control. Use regular directories and keep the filesystem free of nested mounts.
4. For an upgrade, stop the existing Computer before copying. Copy the old
   `<namespace>-workspace-workspace-<id>` volume into `workspace` and
   `<namespace>-profile-workspace-<id>` into `profiles` on the new filesystem. Preserve ownership
   and modes. Keep the source volumes for rollback and confirm both copies before starting
   the replacement. Ensure existing attachments fit within the workspace limit after reserving
   Computer storage.
5. Replace the API and supervisor together while admissions are paused. The supervisor probes
   the filesystem through Docker before launch and returns 503 if the mount or the requested
   reservation cannot be verified. Verify a write to both directories, an out-of-space refusal,
   and a stop and restart before admitting participants.

Both directories share the kernel-enforced capacity of the same filesystem. The Computer's
image filesystem is read-only. Temporary files go to bounded memory mounts and package installs
that modify the image filesystem fail. The Computer image must ship with the required system
packages. Docker log rotation is separate from the workspace storage budget.

Calibrate filesystem size, upload capacity, and Docker host resources in the target environment.
Exercise quota refusals, release and retry, cross-account isolation, supervisor process exit,
and the actual Web, mobile, and desktop builds before setting trial capacity.

## Workspace closure cleanup and disaster recovery

Apply migrations through `0104_personal_intelligence_cleanup` before rolling
out this worker. Drain older trial workers during the rollout so every new
Intelligence dispatch records its locator. The closure operation remains the access fence. Its PostgreSQL cleanup
removes workspace content and the dedicated Assistant but keeps the workspace
identity anchor, the Casdoor binding, and suspension history. Billing accounts,
ledger entries, and transactions follow their existing billing retention rules.

Set `OPENBOT_CLOSURE_CLEANUP_URL` to the deployment's authenticated HTTPS
reconciliation endpoint and `OPENBOT_CLOSURE_CLEANUP_TOKEN` to its service
credential. Without this endpoint, closure still blocks access and stops
execution, and cleanup remains pending. The deployment supplies the endpoint
and its store and provider integrations. OpenBot can still erase supported
local Computer files and Intelligence threads while reconciliation is pending.

The endpoint receives a JSON POST with `step`, `id` (the closure operation),
`accountId`, `workspaceId`, and `acceptedAt`. Calls can be repeated after a
timeout or restore. Each response must reflect a fresh observation of the
target environment. Respond with `{"status":"confirmed"}` after verifying the
step, or `{"status":"unconfirmed"}` while any result is unknown.

| Step | Deployment verification |
| --- | --- |
| `computerVolume` | The configured supervisor removes the stopped workspace container and its Docker JSON logs, then erases and checks both the `workspace` and `profiles` directories on the verified ext4 mount. The provisioner must release the filesystem and verify any replicas, migrated source volumes and forwarded logs. |
| `exports` | OpenBot streams exports from PostgreSQL. Verify any proxy, CDN or managed export store has no retained workspace copies. User-downloaded files are outside the deployment's control. |
| `caches`, `indexes` | Fence repopulation and remove entries for the workspace from every configured cache and index replica. |
| `internalServices` | The request includes an `intelligence` array of `threadId`, `runId` and `agentId`. When Bot execution is configured, OpenBot calls Intelligence thread deletion with the closed account ID before reconciliation. Verify run storage, event and artifact replicas and any model trace stores. When Bot execution is disabled, the reconciler must also delete threads. PostgreSQL keeps the Assistant and conversations through reconciliation. |
| `connections` | Resolve grants from authoritative provider inventory, remove only the closed workspace's bindings, and verify dedicated grants are revoked. Shared grants and installations must continue working for other authorized parties. Return unconfirmed for missing, ambiguous or partially verified provider results. |
| `backups` | Return `{"status":"confirmed","schedule":[{"store":"PostgreSQL","retentionDays":7,"remainingCopiesExpireBy":"2026-12-01T00:00:00Z"}]}` with the deployment's actual values for every store. The example values are only illustrative. |

Before release, record the production retention period and expiry calculation
for PostgreSQL snapshots and WAL, Computer volume snapshots, internal service
storage, and each cache, index or export store that takes backups. Include
provider-managed replicas in the inventory. The endpoint must calculate each
expiry from the last backup that could contain the data. The expiry is a
schedule for backup retention and does not attest to completed deletion.

Private exports are streamed from PostgreSQL, and attachment bytes live in
PostgreSQL. Computer tmpfs is discarded with the container. The mounted cleanup
does not control host or external log collectors. Existing append-only audit
rows can contain follow-up reasons and handoff failure details. The audit
retention API expires rows by age, so the operator must account for their
PostgreSQL retention and any audit copies in the deployment. Completion of
the closure reconciler requires verification of the relevant stores.

The inventory stores identifiers only. Migration backfills surviving Bot work,
Routine runs, inbound deliveries and decision origins. For executions predating
this migration whose exact IDs no longer exist in PostgreSQL, the Intelligence
operator must inventory the closed account in the owning project. Include older
continuations, follow-ups, check-ins, goals and handoffs in that verification.

Preserve committed closure tombstones and their run inventory independently of data snapshots, using
an authoritative recovery copy with zero loss of acknowledged closure
transactions. A periodic journal export alone leaves a gap after the last
export. Keep recovery traffic, workers and downstream services offline until
reconciliation is complete.

1. From a trusted copy with all acknowledged closure transactions, export the
   minimal journal with `bun server/scripts/export-workspace-closure-journal.ts`.
   Set `DATABASE_URL` to that copy. Protect the version 2 output as an
   operator-only file. Re-export version 1 journals from the migrated authority
   to include run locators.
2. Restore and migrate the target database. Preserve the account identity
   bindings and billing state from their respective recovery sources.
3. Mount the journal read-only and set `OPENBOT_CLOSURE_RESTORE_JOURNAL` to
   its path on the Personal SaaS server. Point the reconciler at the recovery
   environment. Startup replays the access fences, removes restored sessions
   and workspace integration grants, then verifies cleanup and remote
   reconciliation before opening the listener. A missing identity or
   conflicting journal record blocks startup.
   If the backup already contains a replacement Workspace, startup also
   rechecks the retired Workspace's external copies. Scope the reconciler to
   the retired Workspace ID and its journaled run locators. Keep the retired
   Workspace's provider inventory available for as long as its backups can
   be restored.
4. After verification, remove the recovery-only setting before normal
   restarts. Keep the authoritative tombstones for as long as older backups
   can be restored. Exercise this procedure in a disposable deployment before
   enabling closure for real users.


### Pause new workspace openings

Set `OPENBOT_WORKSPACE_ADMISSIONS_PAUSED=true` on every Personal SaaS server
replica and restart them to pause first-time provisioning and reopening after
closure. Existing workspaces and closure progress remain available. Set it to
`false` and restart the replicas to accept new openings again.

Returning owners sign in to view closure progress. After execution has stopped
and online cleanup and dedicated connection revocation are confirmed, they can
choose **Open a new workspace** and sign in again. An active Workspace
Suspension continues to block reopening. Backup expiration follows the old
workspace's original schedule, and provisioning retains the same OpenBot
account ID and Casdoor issuer and subject for the shared billing boundary.

## Run target-cloud acceptance

Use a private ingress on the target cloud for all acceptance runs in [#74](https://github.com/1123786563/OpenBot/issues/74). Record the candidate commit, installed build versions, service revisions, replica counts, and configured quota values. Use dedicated trial accounts and disposable workspace data.

1. Build the Web candidate and install the iOS, Android, macOS Apple silicon, macOS Intel, and Windows x64 candidates. Set the desktop signing workflows' `OPENBOT_PERSONAL_SAAS_URL` repository variable and the mobile build's `EXPO_PUBLIC_SERVER_URL` to the same trial origin. Use the signed builds intended for distribution.
2. Register one account through Casdoor. Use that identity on each client. Compare the workspace and Assistant identifiers, and verify the same conversation history. Verify that Desktop Local continues to use its own data.
3. Exercise sign-out, session revocation, and workspace suspension. For each installed client, leave protected content open, disconnect the client, and bring it to the foreground. Verify that the client hides expired content and checks authorization again before restoring it.
4. With two or more accounts, start Bot runs and managed Computers before each fault. Exercise brief Casdoor disablement, late account status, loss of Casdoor connectivity, loss of the Computer control plane, and new work racing suspension. For each account, record the cutoff origin and deadline, stream closure, dispatch refusal, Bot terminal time, and confirmed Computer process exit. A cancellation request alone does not establish the terminal time.
5. Restore access. Verify that old work stays stopped, then recover each item explicitly. Check that retries use current authorization and that the Computer keeps its files after a manual restart. Use WeKnora to verify that OpenBot suspension leaves permitted external work available, and that Casdoor cutoff blocks new external dispatch while previously dispatched usage still settles.
6. Download a readable export. Confirm closure after fresh Casdoor authentication. Record access cutoff, terminal execution, online cleanup, dedicated provider revocation, and backup retention. Restore a disposable backup and prove that replay blocks old workspace access before the service accepts traffic.
7. Repeat the Casdoor outage at the planned launch concurrency. Increase concurrency against the trial's configured quotas until you have a measured passing capacity. Use that result to set the initial limits. Keep participant-only ingress until the release matrix and capacity checks pass.

Save per-platform and per-account timestamps with the acceptance record. Link the evidence and any failing scenarios from #74.
