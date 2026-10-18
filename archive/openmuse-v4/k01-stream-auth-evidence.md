# K01 — Authorize a private computer stream: implementation evidence

Ticket: GitHub issue #22 (catalog K01). Plan: `docs/superpowers/plans/tickets/K01-computer-stream-auth.md` (openmuse worktree).
Worktree: `/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base`, branch `v4/openbot-exec`, uncommitted I01–I03/I09/O01 checkpoints untouched. No commits made.

All timestamps UTC (`date -u +%Y-%m-%dT%H:%M:%SZ`); local machine time is UTC+8.
Cycle: 2026-10-12T15:32Z → 2026-10-12T15:56Z.

## 1. What changed

| File | Status | Role |
|---|---|---|
| `server/src/computer/stream-auth.ts` | new | `createStreamAuthorizer(deps)` → `authorize(request)` returning `{kind:"passthrough"} \| {kind:"refuse",status,message} \| {kind:"proxy",upstream,botId,actorId}`; `toStreamUrl(baseUrl, botId, token)` moved here from index.ts (now exported, token passed in) |
| `server/tests/stream-auth.test.ts` | new | 8 tests over the decision with in-memory deps (fake `resolveRequestActor`, two-profile store: private owner-A Bot + public Bot, fake `gateway.locate`) |
| `server/src/index.ts` | modified | the inline stream-upgrade guard (old lines ~4070–4140) replaced by one `authorizeStream(request)` call; recording lookup + `server.upgrade` + 400 fallback remain inline (upgrade mechanics, per plan §Failure handling); unused `streamPathBotId`/`computerAccessCheck` imports dropped |
| `docs/openmuse-v4/k01-stream-auth-evidence.md` | new | this file |

Logic moved verbatim; the refusal messages, statuses and their order are byte-identical to the inline block.

**The refusal order (now pinned by tests), from the extracted code:** stream-path+websocket → `config.computer` off → **503 "No computer is configured."** → session resolve → **401 "Sign in first."** → `computerAccessCheck` (private ⇒ owner or admin; profile absent ⇒ nobody) → **404 "There is no such Bot."** → `gateway.locate` → **503 "No computer address is configured." / 502 <error.message>** → proxy. Session and Bot checks run before `gateway.locate`, so a caller with no right to ask learns nothing about which Bots exist or where computers sit.

**One deviation from the plan's written return shape:** the proxy decision carries `actorId` in addition to `{upstream, botId}`. index.ts needs the actor id for `demonstrationStore.active` and `StreamData.ownerUserId`; carrying it keeps one `resolveRequestActor` call per upgrade (re-resolving after the decision would double the session lookup and could 401 a session that expired between the two lookups — a behavior change). Recorded per plan §Task 2.

## 2. TDD: RED → GREEN

RED (`server/tests/stream-auth.test.ts` written first, module absent):

```
$ bun test tests/stream-auth.test.ts
error: Cannot find module '../src/computer/stream-auth' from '.../server/tests/stream-auth.test.ts'
 0 pass
 1 fail
```

GREEN tail (after implementing `stream-auth.ts` and rewiring `index.ts`):

```
$ bun test tests/stream-auth.test.ts tests/openmuse-bot.test.ts tests/mobile-bff.test.ts
bun test v1.4.2 (50a8a8387)

 23 pass
 0 fail
 55 expect() calls
Ran 23 tests across 3 files. [467.00ms]
```

(stream-auth alone: 8 pass / 12 expect; the plan's seven cases plus a `toStreamUrl` encoding check; case 5 additionally pins the non-Error 502 fallback, case 6 additionally pins "No computer address is configured.")

Full `bun test` for regression context: 4798 pass / 73 skip / **161 fail — all pre-existing, environmental** (integration files demand `TEST_DATABASE_URL` pointing at a dedicated PostgreSQL test database; others need live services; none touch the stream gate — no stream/auth-related failures). A foreign in-flight checkpoint (`server/src/openmuse-files/routes.ts`, not this ticket's file) currently adds one `tsc` error at `src/openmuse-files/routes.ts(152,29)`; this ticket's three files typecheck and biome clean:

```
$ bunx biome check src/computer/stream-auth.ts tests/stream-auth.test.ts src/index.ts
Checked 3 files in 59ms. No fixes applied.
```

## 3. Live smoke (O01 baseline)

Ports: `OPENMUSE_V4_PGPORT=55440`, `OPENMUSE_V4_PORT=18787` (55432/5432/8787/55433/55434 occupied, untouched). `scripts/openmuse-v4-baseline.sh up` → 78 migrations applied, `/ready` 200 `{"status":"ok","database":"up"}`. Probe: raw-TCP websocket handshake client (`/tmp/openmuse-v4-baseline/k01-handshake.ts`, node:net; a bogus short `Sec-WebSocket-Key` made Bun's `server.upgrade` decline once — with a proper 16-byte key it upgrades; the first 400 attempt is recorded as a probe artifact, not a server defect).

Fixture: one private Bot inserted for the single-user admin (`agent_profiles`: `k01-private-bot`, owner `dev-local-user`, visibility `private`, `template_key='openmuse-private'`).

| # | Target | Request | Result |
|---|---|---|---|
| S1 | baseline 18787 (computer OFF) | ws upgrade `/api/computers/k01-private-bot/stream`, no cookie | **`HTTP/1.1 503` `No computer is configured.`** — the gate answers the handshake itself; the config check leads the order |
| S2 | baseline 18787 | plain GET same path, no `Upgrade` header | **`HTTP/1.1 404` `404 Not Found`** from Hono — passthrough live-confirmed (not the gate's 503) |
| S3 | 18788 second API (computer ON) | ws upgrade, nonexistent bot id | **`HTTP/1.1 404` `There is no such Bot.`** — with config+session passed, the Bot check decides before locate |
| S4 | 18788 second API (computer ON) | ws upgrade, private bot, single-user admin | **`HTTP/1.1 101 Switching Protocols`** at 20ms, then **socket closed by peer at 23ms** |

Raw outputs:

```
{"mode":"upgrade","port":18787,"statusLine":"HTTP/1.1 503 Service Unavailable","body":"No computer is configured.","ms":2}
{"mode":"get","port":18787,"statusLine":"HTTP/1.1 404 Not Found","body":"404 Not Found","ms":4}
{"mode":"upgrade","port":18788,"statusLine":"HTTP/1.1 404 Not Found","body":"There is no such Bot.","ms":6}
{"mode":"upgrade","port":18788,"statusLine":"HTTP/1.1 101 Switching Protocols","body":"","ms":20}
{"mode":"upgrade","port":18788,"event":"socket closed by peer","ms":23,"bytes":170}
```

Second API env (process 2, same DB, port 18788): baseline env plus `AGENT_COMPUTER_URL=http://127.0.0.1:19999` (nothing listens there), `COMPUTER_TOKEN=k01-smoke-token` → `config.computer = {provider:"shared", …}`; the shared provider's `locate` is a pure string return, so authorization is decided without any live computer, and the socket that follows 101 must die on the inward connect. Its log confirms the inward target was truly refused (`egress-policy-push-failed … connect ECONNREFUSED 127.0.0.1:19999`). The 3ms 101→close gap is live evidence that an inward failure closes the outward socket.

Teardown: second API killed, `baseline.sh down` → API stopped, container removed, all four ports verified free.

## 4. Deferred (recorded, not faked)

1. **Live 401 (no/expired session) and foreign-owner 404.** The O01 baseline is `OPENBOT_SINGLE_USER=true` by design (the documented no-provider mode; without an identity provider boot refuses), so there are no sessions and every request resolves to the one admin — those two decisions are pinned by unit tests (cases 2 and 3) and their order is live-evidenced by S1 vs S3 (config leads; session/Bot before locate). Session-bearing live evidence needs a deployment with a real OIDC provider — deferred to K02/K04 device-level flows or a multi-user baseline.
2. **Browser-disconnect → inward-close propagation** (the disconnect direction, Issue #22's "a client disconnect closes the proxied stream"). No real computer exists in the baseline; what is live-evidenced is the opposite direction (S4: inward refusal closes the client socket in 3ms, which is the same close wiring running). Unit level, the authorizer's proxy decision hands index.ts a well-formed upstream; the socket-close mechanics are Bun-runtime behavior. Deferred to K02/K04 with a real `agent-computer`, per plan Task 3 Step 2.
3. **Not live-tested:** `502` from `gateway.locate` (needs a computer that answers locate with a disallowed address) and the recording query-suffix path (needs an active demonstration). Both unit-pinned; no code was written for them beyond the moved logic.

## 5. Checkpoint

No commit (per plan). Changed files + shasum at cycle end (2026-10-12T15:56Z; index.ts may move again under parallel tickets — hash is of this ticket's final state):

```
b98b76f432d917b968d4465d83e961238f38ac28a1b0477836b39315c55f254f  server/src/computer/stream-auth.ts
08d1df00c29f3c0900c43b72079e1cd2372ce3eb60ff6edc5129930795dec7b0  server/tests/stream-auth.test.ts
1795915f3b850c682e0838e2dba2a6491fac5565d60ff4aa4c4e18955d5279254  server/src/index.ts
```
