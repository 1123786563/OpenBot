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

Apply the server migrations first. From the repository root:

```sh
(cd server && bun scripts/migrate.ts)
bun run --filter server start:personal-saas
```

The landing page sends participants to Casdoor for registration, verification, sign-in and account recovery. OpenBot uses the issuer and stable subject to retain ownership after a verified email change. Returning participants see their existing workspace. An interrupted setup can be retried from the preparation page. First entry creates the workspace and its default Personal Assistant Bot in one transaction. The workspace owns the Bot through `personal_workspace_default_bots`, and `/api/workspace` returns the canonical Bot ID. Bot execution, Connections, and Computers remain disabled in this trial entry point.

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

The deployment must record each disablement durably as it takes effect. Include disablements that end before OpenBot polls. Return a failure if the endpoint cannot establish current state or provide complete history. Keep observations ordered and synchronize clocks on the status provider and OpenBot hosts. The integration test provides this endpoint in its Casdoor fixture. Before admitting participants, deploy the provider and verify that it captures every Casdoor mutation path, including a brief disablement followed by recovery.

OpenBot stores the history in PostgreSQL and revokes existing Application Sessions as soon as it observes a new disablement. Recovery requires a later active observation and a new sign-in. If Casdoor cannot confirm status, API access and live sessions expire 60 seconds after the last reliable active confirmation. A failed check leaves that deadline in place. After Casdoor confirms activity again, an unexpired Application Session can regain access. The trial polls known accounts even when all clients are offline. Verify polling and stream closure within 60 seconds at the trial's planned concurrent account count.

Use `createAccountAccess` in trusted server code to read the current account decision and its expiry, or to verify an issued grant against the stored account and authorization epoch. The grant carries the account ID, epoch, and expiry. Enforce its expiry locally. An old grant stays invalid after the account recovers. The trial Web service applies this decision to access and live connections. Background execution and shared billing admission need to integrate the same decision and verify their own cutoff in the target deployment.

## iOS and Android trial builds

Set `EXPO_PUBLIC_OPENBOT_MODE=personal-saas` and `EXPO_PUBLIC_SERVER_URL` to the trial HTTPS origin in `mobile/.env` before building the native app. Use an installed development or release build that registers `openbotmobile`. The existing Casdoor HTTPS callback serves both Web and mobile. The app opens the system browser and returns through `openbotmobile://auth/personal-saas`.

Keep the HTTPS origin reachable from the system browser and the app's API client. For a restricted trial, use network-level access that both clients can reach. App API requests authenticate with their own OpenBot Application Session and do not share the system browser's cookies.

Web, iOS, and Android display the same workspace, default Assistant, and recent conversations. `GET /api/workspace/conversations` returns up to 50 titles and last-message previews from the owner's dedicated Assistant, newest activity first. Full transcripts and new conversations are outside the read-only trial.

## Workspace isolation

The owner can read the default Assistant at `GET /api/workspaces/{workspaceId}/bots/{botId}` and rename it at `POST /api/workspaces/{workspaceId}/bots/{botId}/name` with a JSON `name`. Use the IDs returned by `/api/workspace`. The access check uses the authenticated account and the workspace's Assistant binding. Foreign and unknown IDs return the same `404`. The trial sends `Cache-Control: no-store` on workspace responses.

The internal integration service issues an expiring credential for `assistant.read` on one workspace and Assistant. The caller that issues a credential must supply an authenticated owner identity. When a delivery or Worker entry point is enabled, it must also apply the account and workspace execution cutoff checks before dispatch. The trial has no integration credential issuance or execution HTTP route.

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
