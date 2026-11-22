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
