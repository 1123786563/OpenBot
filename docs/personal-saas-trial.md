# Personal SaaS Web trial

The trial runs a separate OpenBot Web service and database. Put both the OpenBot and Casdoor trial entry points behind participant-only HTTPS ingress. For example, use a private network or an authenticated test ingress that preserves the OpenBot URL and POST `Origin` header. The trial service listens on loopback, so run the proxy on the same host or in the same network namespace. The `private-trial` setting is required. Keep both entry points restricted until public launch acceptance is complete.

In Casdoor, configure a dedicated organization and confidential OIDC Web application. Enable self-service signup for the trial organization, require an email verification step and configure email delivery. Register `<OpenBot trial origin>/auth/casdoor/callback` and `<OpenBot trial origin>/auth/casdoor/reverify/callback` as redirect URIs. Use the `JWT-Standard` token format with authorization code, S256 PKCE, nonce, and token introspection. Keep `Email` present in the application's token fields if you restrict fields. Use the discovery document for this application and copy its `issuer` value exactly. Use one Casdoor origin for discovery and all advertised endpoints. Confirm that introspection returns `active: false` for a forbidden or deleted account on the deployed Casdoor build before admitting participants.

Set these variables in the trial process environment:

| Variable | Value |
| --- | --- |
| `OPENBOT_PERSONAL_SAAS_MODE` | `private-trial` |
| `OPENBOT_PERSONAL_SAAS_URL` | The HTTPS origin participants use for OpenBot |
| `CASDOOR_DISCOVERY_URL` | The HTTPS URL of the trial application's OIDC discovery document |
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

Use the existing deployment commands for enterprise or local Personal edition. The Web trial checks Casdoor status for each protected request. Durable disablement history and execution cutoff are separate rollout requirements.

## Sign out

**Sign out** ends the current OpenBot Application Session. **Sign out all devices** first asks the user to authenticate again with Casdoor. OpenBot requires a signed `auth_time` from after the request began and verifies that the fresh identity matches the application session's issuer and subject. Success revokes every session for that identity in the shared PostgreSQL session store. Cancelled, stale, or mismatched verification leaves other sessions usable. The operation is scoped to OpenBot Application Sessions. Casdoor sessions and sessions in other applications are separate.

The Web workspace opens a same-origin session event stream. Each replica checks the shared store every second while the connection is healthy. Revocation closes matching streams and the Web page returns to sign-in. Configure the trial ingress to forward server-sent events without buffering. Native clients must use the same session store for token issuance and request validation. When native and resource transports are wired, verify that each transport closes revoked connections and requires a new Application Session.

Before enabling all-device sign-out for trial participants, verify the deployed Casdoor application honors `prompt=login` and `max_age=0`, and returns a signed ID token with a fresh `auth_time`. Synchronize OpenBot and Casdoor clocks. OpenBot rejects proof issued in the same second the challenge began, since timestamps have whole-second precision. The integration test uses a local OIDC fixture with real JWT signing and validation. Provider behavior needs verification on the deployed Casdoor build.

Sign-out only deletes session records. An integration test exercises the real durable work queue on PostgreSQL and shows that a worker can renew and finish its lease and claim queued work across both kinds of sign-out. The private trial keeps runtime execution disabled. End-to-end continuation for an authorized Personal SaaS Bot, Routine, or Computer needs verification through its production worker once that runtime and its execution authorization are wired.
