# OpenConnector integration design

Date: 2026-10-09
Status: Draft — awaiting review. No implementation has started.

## Problem

OpenBot's broker story today is Composio-only, and Composio is a cloud broker: every person's
third-party credential passes through Composio's platform (`backend.composio.dev`), and the only
self-hosted alternative Composio offers is a closed-source enterprise tier. OpenBot positions
itself as a template that "runs on your infrastructure", so a broker that keeps credentials inside
the deployment is missing.

OpenConnector (`oomol-lab/open-connector`, Apache-2.0) is that broker: a self-hostable TypeScript
runtime holding connections and credentials locally (SQLite or Postgres, AES-256-GCM at rest when
keyed), publishing 1000+ providers and 10,000+ prebuilt actions over REST and MCP.

This design adds OpenConnector as a **second broker beside Composio**, following the existing
broker seams (`TransportKind`, `ConnectedAppBroker`, `brokered_connections`) so grants, policy,
audit, and the connected-accounts surface stay provider-blind.

## Assumptions (made without interactive confirmation — override any of these)

1. **Deployment shape: self-hosted inside the deployment.** The template's docker-compose gains an
   `open-connector` service. The code never hardcodes the instance: it reads `OPENCONNECTOR_URL`
   plus tokens from env, so a deployment may point at any instance (including OOMOL hosted) without
   code changes. The default story and docs assume self-hosted.
2. **Coexistence, not replacement.** Composio stays. The closed unions and registry are extended;
   nothing Composio-specific is removed.
3. **Phase 1 excludes OAuth-consent providers.** Self-hosted OpenConnector requires a per-provider
   OAuth client (clientId/secret) registered by the operator — exactly the screen the Composio
   connector documents as a deliberate non-goal. Phase 1 offers `api_key`, `custom_credential`, and
   `no_auth` providers only; OAuth lands in phase 2 with its own product decision.
4. **Key connections are accepted unverified in phase 1.** OpenConnector, like Composio, does not
   grade a submitted key, and it publishes no `readOnly` safety labels we could use to pick a safe
   probe action. The existing "accepted without being checked" sentence covers this state honestly.

## Non-goals

- No support for OpenConnector's proxy endpoint (`/v1/proxy/*`) or triggers. Only actions.
- No multi-instance / Cloudflare-Workers deployments of OpenConnector; one container, one volume.
- No per-person OpenConnector runtime tokens. The deployment holds the tokens; OpenBot's own gate
  (grants → policy → audit) remains the authorization, exactly as for Composio.
- No migration of Composio apps to OpenConnector.

## Approaches considered

**A. Parallel broker transport (chosen).** New `TransportKind "open-connector"` + REST adapter,
mirroring the Composio three-part split (transport / broker logic / vendor adapter). Per-person
connections map to deterministic OpenConnector connection aliases. Grants, policy, audit, admin UI,
and connected-accounts all keep their per-action granularity.

**B. Reuse the existing `"mcp"` transport against OpenConnector's `/mcp` endpoint.** Rejected:
OpenConnector's MCP surface is meta-tools (`search_actions`, `execute_action`), not one tool per
action. A grant on `execute_action` is a grant on everything; per-tool policy checks (`tool.name`)
and per-tool audit rows would describe nothing. This breaks OpenBot's security model at its root.

**C. Embed OpenConnector headless into the server process.** Rejected: couples a third-party
runtime's data, migrations, and egress into the API server's fault domain. OpenBot's established
pattern is separate services (agent-computer, supervisor, SPIRE) talking over the network.

## Architecture

### 1. Deployment & configuration

`docker-compose.yml` gains:

```yaml
open-connector:
  image: ghcr.io/oomol-lab/open-connector:<pinned>
  environment:
    OOMOL_CONNECT_ADMIN_TOKEN: ${OPENCONNECTOR_ADMIN_TOKEN:?}
    OOMOL_CONNECT_RUNTIME_TOKEN: ${OPENCONNECTOR_RUNTIME_TOKEN:?}
    OOMOL_CONNECT_ENCRYPTION_KEY: ${OPENCONNECTOR_ENCRYPTION_KEY:?}
    OOMOL_CONNECT_ORIGIN: ${OPENCONNECTOR_ORIGIN:-}   # set when OAuth lands (phase 2)
  volumes:
    - open-connector-data:/app/data                    # SQLite; zero coupling to the OpenBot DB
  ports:
    - "127.0.0.1:3100:3000"                            # server (host) reaches it on localhost:3100
volumes:
  open-connector-data:
```

Own SQLite volume rather than the shared Postgres: the broker's lifecycle (explicit migrations,
separate roles) stays decoupled from OpenBot's drizzle migrations. A deployment may switch
OpenConnector to Postgres via its own env; that is OpenConnector's documented business, not ours.

`server/src/config.ts` gains three optional env vars, following the `COMPOSIO_API_KEY` pattern
where **unset is a supported, fully described state**:

- `OPENCONNECTOR_URL` (default `http://localhost:3100`) — base URL for both API faces. Set by the
  deployer in env, never taken from a request; requests originate only from this configured host.
- `OPENCONNECTOR_ADMIN_TOKEN` — management face (`/api/*`): provider catalog detail, connection
  CRUD, alias addressing.
- `OPENCONNECTOR_RUNTIME_TOKEN` — execution face (`/v1/*`): action listing and execution.

With any of the tokens unset, the admin plugins page renders one row under **More apps** titled
*OpenConnector* with the same shape as Composio's unset row: names the settings, links nowhere.

### 2. Identifier model

| Concept | Composio today | OpenConnector |
| --- | --- | --- |
| provenance value | `"composio"` | `"open-connector"` |
| url scheme | `composio://<toolkit>` | `openconnector://<service>` |
| `mcp_servers.id` | `composio-<slug>` | `open-connector-<service>` |
| `brokered_connections.provider` | `"composio"` | `"open-connector"` |
| account handle in `vendorUserId` | Composio user id | **connection alias** (below) |

**Connection aliases are the per-person mapping.** OpenConnector is single-tenant: no user
accounts, just named connections per provider selected per call via `x-oo-connector-alias`.
Aliases are minted deterministically by OpenBot, never taken from user input:

- personal: `openbot-u:<userId>:<service>`
- shared/deployment: `openbot-d:<deploymentId>:<service>`

`userId`/`deploymentId`/`service` are all system-generated or regex-validated (`/^[A-Za-z0-9_-]+$/`
for the service slug), so an alias cannot smuggle another person's identity. Re-connecting
re-`PUT`s the same alias (idempotent overwrite); disconnect `DELETE`s by alias; offboarding revokes
by alias — the same lifecycle shape Composio's vendor user id serves, which is why both ride the
same `vendorUserId` column.

If OpenConnector proves to restrict alias characters beyond what OpenBot ids contain, the mint
function encodes defensively (percent-safe alphabet); verified in the transport's unit tests.

### 3. Transport (`server/src/plugins/openconnector.ts`)

Zero SDK imports; satisfies `VendorTransport`:

- `listNeedsCredential = false` — the runtime token lists for the whole deployment.
- `toolkitOf(url)`: `openconnector://` prefix + the same strict slug regex; the only source of
  `ServerAccess.toolkit` for this broker.
- `listTools({url})` → vendor `GET /v1/actions?service=<service>`; one `mcp_tools` row per action.
  Action id (e.g. `github.get_current_user`) becomes the tool name verbatim — the grant ref
  `<serverId>/<toolName>` and exposed name `mcp__<serverId>__<tool>` tolerate the dot.
- **Effect classification is fail-closed to write.** OpenConnector publishes no
  `readOnly`/`destructive` hints, so every action records `effect = "write"`. The
  "turn on every read-only action" bulk affordance simply finds nothing to turn on. No widening,
  ever.
- `callTool(connection, toolName, args)` → vendor `POST /v1/actions/<toolName>` with body
  `{"input": args}` and header `x-oo-connector-alias: <connection.vendorUserId>` (the alias).
  Refuses, like the Composio transport: no `actorId`, url without an app, client not installed.
- No `__version` reserved-arg merging — versions are a Composio requirement; `mcp_tools.version`
  stays null and the store's version merge is a no-op for a null version.

### 4. Vendor adapter (`server/src/plugins/openconnector-adapter.ts`)

The only module that issues HTTP. Mirrors `composio-adapter.ts`: a narrow projection interface
`OpenConnectorVendor` (fetch-based, both token faces), `buildOpenConnectorClient(vendor)` returning
`{ actions, broker }`, and `createOpenConnectorClient(config)` wired in `index.ts` at boot
alongside `useOpenConnectorClient(null)` for test teardown. Every outbound URL derives from the
configured base URL; the adapter never follows redirects and treats a non-JSON body as a refusal.

`OpenConnectorActions` (the transport's projection): `listActions(service)`,
`execute({service, actionId, alias}, input)`.

### 5. Broker face — `ConnectedAppBroker` mapping

`broker.ts`'s interface is reused as-is; a second implementation `openConnectorBroker` maps:

| Interface method | OpenConnector call | Notes |
| --- | --- | --- |
| `listApps` | `GET /v1/providers` + provider auth detail | Phase 1 filter: `oauth2` providers are not offered (an Add that can only fail is hidden, same rationale as Composio's 56). Shows action counts per provider. |
| `ensureAuthConfig` / `deleteAuthConfig` | — (no-op) | No auth-config concept for key/custom apps. Becomes `PUT/DELETE /api/oauth/configs/:service` in phase 2. |
| `authorize` | phase 2: `POST /v1/connections/:service/connect` | Not reachable in phase 1 (no consent apps offered). Round-trip mechanics (OpenConnector hosts the OAuth callback; OpenBot polls `connection-requests/:id` or a return hop) are an open question for phase 2. |
| `isConnected` | `GET /v1/apps/services/:service` with alias header | |
| `revoke` / `revokeAccount` | `DELETE /api/connections/:service?connectionName=<alias>` | `revoke: true` (RFC 7009) when phase 2 adds OAuth. |
| `connectionFields` | provider auth field metadata | Mapped to `BrokerField` verbatim — OpenConnector trims values and rejects unknown field names, matching this codebase's own refuse-don't-drop form semantics. |
| `connectWithFields` | `PUT /api/connections/:service` `{authType, values, connectionName: alias}` | Key typed by the person; held by the **OpenConnector container**, never by OpenBot — same guarantee shape as Composio's key flow (`composio_connections` stores names, not values). |
| `accountName` | connection metadata | Where the provider publishes an account identifier. |

Key-probe (`recheck`) machinery: phase 1 reports every OpenConnector key connection as
`checkable: false`, so the Re-check button is withheld exactly as Composio withholds it for an app
that publishes nothing safe to spend a key on, and the row honestly reads *accepted without being
checked*. This follows from metadata: OpenConnector publishes no safety labels, so no read-only
action can be identified to probe with.

### 6. Resolution & store changes (`access.ts`, `store.ts`, schema)

- `access.ts`: provenance→broker becomes data. `BROKERS: Record<Provenance, BrokerDescriptor>`
  with `{ transportKind, urlScheme, toolkitOf }`. `isBrokerTransport` consults it; the
  entry-vs-broker ambiguity refusals (`ServerRowAmbiguousError`,
  `CatalogueTransportUnroutableError`) extend to both kinds; `CuratedTransportKind` excludes
  `"open-connector"` the same way it excludes `"composio"` (a catalogue entry may never name a
  broker). The invariant "provenance and url scheme are one fact stored twice" is decided at
  row-write time by the enabling broker.
- `store.ts`: every `provider='composio'` predicate (`accountRow`, `brokeredAppRow`,
  `brokeredAppKind`) reads the provider off the resolved access instead of the literal.
  `connectionTokenFor`'s brokered branch returns `{vendorUserId: alias}`.
- Migrations (drizzle-kit): `brokered_connections.provider` type widens to
  `"composio" | "open-connector"` and its CHECK constraint is replaced accordingly;
  `mcp_servers.provenance` gains `"open-connector"`. No data migration — the new value simply
  starts being written.

### 7. Routes & UI

- `routes.ts`: `GET/POST /composio/apps` gain siblings `GET/POST /openconnector/apps` (same
  handlers, broker parameterized by the route prefix; the composio paths stay for compatibility).
  Connect/confirm/recheck/disconnect already dispatch off the row; the toolkit/broker dispatch
  inside them reads the new registry.
- Admin plugins page: the **More apps** heading lists both brokers; each renders its unset-row or
  its directory page. New `app/src/routes/_authed/admin/plugins/open-connector.tsx` directory page
  clones the composio picker pattern (search, action counts, Add→`open-connector-<service>` row).
  Enabled apps land on the existing `$key` pages unchanged (`open-connector-<service>` is just
  another server id).
- Every `provenance === "composio"` string check in `app/src` (connected-accounts index + key,
  plugins index) becomes membership in `BROKERED_PROVENANCES`, exported from `shared/` so client
  and server agree.
- `brokered-account-row`, `connection-fields`, `account-mode-dialog`, shared-approval UI: reused
  unchanged — they speak `BrokerField` and `AccountRef`, not Composio.

### 8. Security & blast radius

- Authorization remains OpenBot's gate (grant → policy → audit) exactly as for Composio; OpenBot's
  tokens are deployment-level, and aliases are derived, not user-supplied.
- SSRF posture: the adapter dials only the configured base URL (env-sourced, deployer-controlled),
  rejects redirect-following, and no custom-URL path exists for brokered rows (they are minted from
  the directory's own service slug). OpenConnector's own egress protection (private networks
  denied by default) stays at its defaults.
- Blast radius sentence for the docs: every person's connection to every app now lives in **one
  container inside this deployment** rather than one vendor's cloud — same concentration, different
  owner; the encryption key and volume are the deployment's to protect.

## Testing

Same style as the Composio suite — narrow projections, object-literal stubs, zero network:

- `openconnector-transport.test.ts` — `toolkitOf`, effect fail-closed, refusals, alias header use.
- `openconnector-broker-seam.test.ts` — alias minting (personal/shared/uniqueness), field mapping
  verbatim-passthrough, refusal-sentence mapping from OpenConnector's `{success, message}` envelope.
- `openconnector-adapter.test.ts` — what constructing the vendor is allowed to do at boot; envelope
  and non-JSON handling.
- `openconnector-access.test.ts` — `accessFor` enumeration extended: both brokers' rows, entry vs
  either provenance ambiguity, curator exclusions.
- `plugin-store.integration.test.ts` — brokered end-to-end on `provider='open-connector'`,
  including shared-account gating (machinery is shared; one path proves it).
- `app/tests` — directory picker, `connection-fields` drift test extended to the OpenConnector
  field source, brokered connection card on an `open-connector` row.

## Delivery phases

**Phase 1 (this spec's implementation scope):** compose service; env config + unset state;
transport; adapter; broker (api_key / custom_credential / no_auth); access/store/routes/schema
generalization; admin directory page + More-apps row; per-person connect with fields; call gate
end-to-end; grants & audit; connected-accounts UI generalization; shared-account mode expected to ride the existing
machinery (verified by one integration test; small provider-generalization glue fixes are in
scope if the test finds them); docs page `reference/plugins/open-connector.md`.

**Phase 2 (separate decisions, not designed here):** OAuth-consent providers (client-registration
surface + authorize round-trip + connection-request polling), safe key probes (per-app read-only
allowlist, since metadata publishes no labels), proxy/trigger surfaces.

## Open questions

1. **OAuth round-trip mechanics** (phase 2): whether OpenConnector's connect flow offers a
   browser return hop to OpenBot or requires `connection-requests/:id` polling (≥2s interval).
2. **Alias charset**: confirm OpenConnector accepts `:` / `-` and OpenBot user/deployment ids in
   `connectionName`; the mint function encodes defensively regardless, and the transport tests pin
   the exact format.
3. **Provider catalog scale**: `GET /v1/providers` size vs the directory page's read-to-the-end
   listing (Composio paginates; verify OpenConnector's shape and cache TTL).
