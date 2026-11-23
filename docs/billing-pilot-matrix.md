# First trial matrix: two applications sharing Test Credits

This record covers #98's first pilot matrix on a traceable local deployment:
one harness, two verified chat models, two Billing Accounts (plus a
balance-race account), model switching through the product's selection seam,
WeKnora ingestion through the real Go worker, the denial and recovery replays,
and OpenBot↔Lago reconciliation. Test Credits only.

## Deployment

| Piece | Version / location |
| --- | --- |
| Bifrost gateway (chat) | `openbot-bifrost89:zhipu-cap-fixed6` (`sha256:2fe9cf9c28ee…`), dual provider `zhipu` (native `glm-5.3-flash`) + `zhipu-compat` (OpenAI-compatible `glm-5.3`), `127.0.0.1:32790` |
| Bifrost gateway (embeddings) | pinned local deployment, `openai/BAAI/bge-small-en-v1.5` over TEI, `127.0.0.1:25170` + tokenizer `127.0.0.1:25169` |
| Input metering (chat) | Zhipu tokenizer `/api/paas/v4/tokenizer`, +2 framing margin |
| Lago | self-hosted CE v1.57, `127.0.0.1:32832`, plan `openbot-usage-v2`, metric `model-usage` |
| Driver | `server/scripts/pilot-matrix.ts` — 19 scenarios, `matrix.json` for the full record |

Chat routes are capped at 4096 input / 8 output tokens (8256 µc max charge),
mirroring the #89 publication caps; embeddings are bounded at 512 input tokens
(256 µc max charge).

## Matrix result — 19/19 pass

**Happy paths**

- Two verified models published on distinct providers; `modelOptions` lists
  both; bot and conversation picks resolve through the #92 selection seam, and
  a stale revision pick is refused.
- Account A runs one completion per route on real Zhipu (route-a 102 µc,
  route-b 78 µc). Account B runs its own completion (102 µc); A's charge is
  untouched — per-account isolation holds.
- WeKnora: the real Go worker uploads `managed.txt` through the uploader's
  spending authorization and settles 7 µc; after the uploader "signs out", a
  further ingestion under the same valid authorization still settles (4 µc) —
  authorizations outlive sessions.
- Lago reconciliation: the outbox flush sends 6 events; a Lago-side audit
  attributes every event to `openbot-sub-<accountId>` with amounts matching
  the ledger exactly (A 193 µc, B 102 µc; no non-settled operation appears).

**Races, failures and cutoffs**

- Balance race: an account funded for exactly two reservations, four
  concurrent reserves → exactly 2 reserved + 2 `insufficient_credits`,
  availability never below zero.
- Gateway timeout: dispatch against a dead endpoint fails, `releaseUnsent`
  returns the hold (199 796 available restored).
- Meter refusal: with the tokenizer unavailable the executor refuses
  `route_unavailable` — the request never reaches the provider.
- Auxiliary boundary: helper-model calls without a billing context and
  platform-funded calls without a bounded budget are refused fail-closed.
- Stale reservation: after the 5-minute window `beginDispatch` denies
  `route_unavailable`.
- Reconciliation cutoff: a dispatched-but-abandoned operation is swept after
  24 h and the 8256 µc hold returns to the account.
- Wrong permit: `beginDispatch` with a forged permit denies `not_authorized`.
- Worker recovery without a reservation: replaying a released operation id is
  refused (409); only replay of a settled operation is idempotent.
- Revocation and isolation denials: stranger subject 403, resource outside the
  authorization 403, revoked authorization 410.

**Boundary note.** The pinned gateway answers a direct HTTP call without
OpenBot context (loopback deployment; provider credentials never leave it).
The dispatch gate is the ledger: no permit can be minted outside a live
reservation, as the wrong-permit and stale-reservation scenarios show. On a
production deployment the gateway runs on an isolated network, which is the
#89 pinned-deployment design.

Evidence: [`evidence/billing-pilot-matrix/`](./evidence/billing-pilot-matrix/).
Deployment artifacts stay outside the checkout at
`/Users/wuyj/.local/share/openbot/billing-98`.

## Remaining for #98's production grade

This matrix runs on the traceable local deployment (pinned images, real Zhipu
and TEI routes, live self-hosted Lago). Upgrading to the ticket's
production-grade acceptance reruns it on an approved independent deployment —
the same open item as #89 — and repeats the account-status legs jointly with
#69 once Workspace Suspension lands there.

## Local Test Credit rerun with no live model calls

The combined fixture used the two normal Conversation routes on a single
Harness, a real local Casdoor sign-in and sign-out, and the WeKnora Go upload
handler and worker at `822d457c5`. The retrieval store, queue, token meter, and
the models were fixtures. The three published fixture routes were
`joint-text`, `joint-alternate`, and `joint-fixture` for the 384-dimension
embedding result. The Conversation model list showed only the two chat
routes after fixing the filter.

| Account | Path | Operations | Verified usage per operation | Charge |
| --- | --- | ---: | --- | ---: |
| Alice | OpenBot, primary then alternate | 2 | 3 input, 1 output | 6 microcredits |
| Alice | WeKnora, after sign-out and explicit cap increase | 1 | 14 input, 0 output | 7 microcredits |
| Bob | OpenBot, primary | 1 | 3 input, 1 output | 3 microcredits |

Alice's balance moved from 1,000 to 987 and Bob's from 1,000 to 997. The
receipts and account bills named the originating application. Bob could
not read Alice's WeKnora receipt. Gateway evidence and account-status
regressions ran separately from the combined fixture.

After simulating an export outage, the production Lago client validated a
fresh UTC, zero-rate subscription on local Lago CE v1.57.0
(image `sha256:24678b61b372e5ca02f9bb4687c9aec012f8ba8a3539d28c4cbe989f131f3aed`).
The outbox replayed four original transaction IDs; each stored event matched
its OpenBot record, and a second flush sent zero. Lago returned 16 usage
units at zero cents.

The separate Bifrost image
`sha256:2fe9cf9c28eee03a9392ee7d032538dc6c9be53c266c70e08fbf6a4e36523cf1`
recovered a dropped response from its durable log with one synthetic
upstream dispatch. Its gateway and synthetic upstream had no published host
ports on the internal Docker network. The loopback relay was fixture-only.

Local reproduction and evidence are in `/tmp/openbot-98-joint.b3WdhT`.
Run the product regression with an isolated, migrated PostgreSQL database:

```sh
bun test --no-env-file --env-file=.env.test --timeout 90000 \
  server/tests/{direct-chat,billing-routes,billing-paths,managed-model-routes,resume-points,lago-usage,provider-cost-limit,test-credit,weknora-work}.integration.test.ts \
  server/tests/bifrost-catalog.test.ts
```

The approved Harness/provider routes, direct-access controls on the target
deployment, and the real account-status and Workspace Suspension matrix
with #69 remain pending.
