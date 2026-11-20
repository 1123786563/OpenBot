# Personal SaaS Web trial

The trial runs a separate OpenBot Web service and database. Put both the OpenBot and Casdoor trial entry points behind participant-only HTTPS ingress. For example, use a private network or an authenticated test ingress that preserves the OpenBot URL and POST `Origin` header. The trial service listens on loopback, so run the proxy on the same host or in the same network namespace. The `private-trial` setting is required. Keep both entry points restricted until public launch acceptance is complete.

In Casdoor, configure a dedicated organization and confidential OIDC Web application. Enable self-service signup for the trial organization, require an email verification step and configure email delivery. Register `<OpenBot trial origin>/auth/casdoor/callback` as the redirect URI. Use the `JWT-Standard` token format with authorization code, S256 PKCE, nonce, and token introspection. Keep `Email` present in the application's token fields if you restrict fields. Use the discovery document for this application and copy its `issuer` value exactly. Use one Casdoor origin for discovery and all advertised endpoints. Confirm that introspection returns `active: false` for a forbidden or deleted account on the deployed Casdoor build before admitting participants.

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

Use the existing deployment commands for enterprise or local Personal edition. This entry point only exposes the trial workspace, sign-in and sign-out. The Web trial checks Casdoor status for each protected request. Cross-client revocation, durable disablement history and execution cutoff are separate rollout requirements.

## iOS and Android trial builds

Set `EXPO_PUBLIC_OPENBOT_MODE=personal-saas` and `EXPO_PUBLIC_SERVER_URL` to the trial HTTPS origin in `mobile/.env` before building the native app. Use an installed development or release build that registers `openbotmobile`. The existing Casdoor HTTPS callback serves both Web and mobile. The app opens the system browser and returns through `openbotmobile://auth/personal-saas`.

Keep the HTTPS origin reachable from the system browser and the app's API client. For a restricted trial, use network-level access that both clients can reach. App API requests authenticate with their own OpenBot Application Session and do not share the system browser's cookies.

Each client uses the same workspace and default Assistant identifiers. The trial has no Personal Workspace conversation-history or Bot resource API. The mobile build displays the workspace identity and the default Assistant.
