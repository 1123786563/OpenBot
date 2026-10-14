# R02 — Approve and send one Gmail message: Checkpoint

Ticket R02 / Issue #50. Executed per `docs/superpowers/plans/tickets/R02-gmail-send.md` (openmuse worktree), full TDD (RED → GREEN), no commit. Worktree: OpenBot/.worktrees/v4-base, branch v4/openbot-exec.

## Send action id

`gmail.send` — a PLACEHOLDER action id per M01's discipline, pinned as `GMAIL_SEND_ACTION_ID` in `server/src/openmuse-reviewed-actions/gmail-send-executor.ts`; the live id is verified against the vendor's `listServiceActions("gmail")` catalogue at O02 deployment. The dial is `POST /v1/actions/gmail.send` with `{ input }` in the owner's connection via the `x-oo-connector-alias` header — the same action-call seam the adapter and mail client model.

## What landed

- **`gmail-send-executor.ts` (new)** — the §6 provider attempt behind R01's seam: pre-claim `preflight` (requireConnection → 409 `connection_required` when disconnected; accountEmail/generation mismatch → 409 `stale`; no dial → 503), then execute: provider success → `succeeded` with providerRef = provider message id; HTTP 4xx → `failed` with vendor detail; timeout/5xx/unreadable answer after submission → `outcome_unknown`, never retried; post-claim drift (connection re-bound between preflight and execute) → definite `failed`.
- **`service.ts`** — `ClaimGuardedExecutor` type (executor + optional `preflight`); `decide` runs the preflight after the deny branch, before the atomic claim, so preflight refusals leave the row `awaiting_review` with zero dials.
- **`routes.ts`** — `OpenMuseConnectionRefusedError` → 409 `{code: "connection_required"}` and `OpenMuseVendorUnavailableError` → 503 in `onError` (the mail surface's own mapping); header comment updated (the fake is gone).
- **`proposal.ts`** — kind `gmail.send` added to `reviewedActionKinds` + strict payload schema `{to[], subject, body}` (reply binding stays on `mail`, R03's business). Hash-stable via the existing §6 canonical serialization.
- **`index.ts`** — R01's TODO-cited seam: `createFakeReviewedActionExecutor()` → `createGmailSendExecutor({ dial, requireConnection })`. The mail seam block now builds ONE guarded `openMuseMailDial` (same OPENCONNECTOR_URL read, same no-boot-death rule) shared by the mail reads (`buildOpenMuseMailClient({dial})`) and the send executor — see Deviations.
- **`db/schema/openmuse.ts`** — `kind` column `$type` widened to include `"gmail.send"` (type-only; the column is `text`, no migration).
- **`openmuse-mail/client.ts`** — the ONE allowed export addition: the transport dial extracted and exported as `createOpenMuseMailDial(config)`; `createOpenMuseMailClient` is now a thin wrapper over it, behavior identical (openmuse-mail.test.ts green).
- **`executor.ts`** — header comment only: R01's TODO(R02) marked done (fake remains as the seam's reference implementation).

## Deviations from the plan's owned-files list (all additive, no concurrent owner)

1. `proposal.ts` + `db/schema/openmuse.ts` were touched although not listed: the kind union, payload schema map, and drizzle `$type` live there, and keeping them truthful avoids type casts in service/store. The plan's parentheticals ("service.ts kind validation", "routes.ts proposal input schema for gmail.send") are satisfied end-to-end through proposal.ts's declared seams instead.
2. `index.ts` exceeds one physical line (imports + the shared-dial restructure of the mail seam block): the executor arg is the swap, and the guarded shared dial honors the mail seam's "a boot must not die over a connector" rule without duplicating the URL construction. The createApp tail (P01's region) is untouched; P01's concurrent goals wiring is intact.
3. `openmuse-mail/client.ts` export addition: `createOpenMuseMailDial` (noted per the plan's one-export allowance); the dial factory was inline in `createOpenMuseMailClient` and needed extraction, no behavior change.

## Verification (evidence)

`bun test tests/openmuse-reviewed-actions.test.ts tests/ready.test.ts tests/openmuse-mail.test.ts` (from server/):

```
 58 pass
 0 fail
Ran 58 tests across 3 files. [419.00ms]
```

46 baseline → 58 (12 new R02 tests: exact-field validation + hash stability; approve-once dial with alias header + exact input + provider message id receipt; deny/expiry zero dials with the real executor wired; definite 4xx rejection → failed; timeout and 5xx → outcome_unknown with no retry; disconnected → 409 at decision time zero dials; account email/generation mismatch → 409/stale zero dials; no-dial deployment → 503; non-gmail.send kind → failed without dial).

`bun run typecheck` (tsc --noEmit): clean. `bunx biome check` + `biome lint --error-on-warnings` on all touched files: clean.

## Files + shasums

```
d77bcf8b590dad197dcbcc873d82c960f6a776fd11fa45d4d3bce0eb0d8b9e60  src/openmuse-reviewed-actions/gmail-send-executor.ts
44d066b0d3aa28d033c8fbe18134d01886304a22f65bef150edaff467630057a  src/openmuse-reviewed-actions/service.ts
031f3fea94ad4c49db8b88209b24f9f469396a1cbefcdde86add20f085649034  src/openmuse-reviewed-actions/routes.ts
2495b899721d9076d0d2cb5e5d79d74608d724b56beb05d200b63d8ad4b54700  src/openmuse-reviewed-actions/proposal.ts
a83ffc4318253640776ece0d11540c56170a538142e9f12ba4b3b8abd1e0cfc1  src/openmuse-reviewed-actions/executor.ts
de094cf1dad3a9450920b95a0ee14411a4f33debcac7c1a398c7d620a65ac29c  src/openmuse-mail/client.ts
5e1ced229ed983d09c189e48ffa484760812eb184d9e28a108b49fb3abda2210  src/db/schema/openmuse.ts
7f50b4800743acb5f6c443e5decd90fccb68aad84c92f51223b4089b6f2cfa48  src/index.ts
85aff21fcdae7e782011992bc9163c5eaeed6fc8c93e0c31ce8bd9826755e4b0  tests/openmuse-reviewed-actions.test.ts
```

## S19 / F-MAIL-1 / F-MAIL-2 deferred notes

- **S19** (prepare Gmail proposal with exact to/subject/body/G-A, approve once): mechanism proven at unit level (exact fields shown in the proposal echo; one dial; one provider message id + one receipt). The live test-account card (Web/iOS/Android review surface showing bound fields) is gate-level, deferred to live verification.
- **F-MAIL-1** (approve same hash in two clients at once): one claim, one attempt, both callers see the same settled record — proven at unit level with the CAS-honoring row seam (R01's suite) and re-asserted against the real executor wiring (deny/expiry zero-dial cases); the live two-client card is gate-level.
- **F-MAIL-2** (provider accepts send, response times out): `outcome_unknown` with attempt fingerprint and zero automatic retries proven at unit level (timeout + 5xx tests); R04 owns the reconciliation UX and the fault-injected live matrix.
