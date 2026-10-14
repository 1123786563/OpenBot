# M03 — Read a Gmail thread: Checkpoint (Issue #34)

No commit; worktree carries prior uncommitted checkpoints, untouched.

## Thread action-id note (placeholder discipline)

The repo pins no gmail action ids. `GMAIL_THREAD_ACTION_ID = "gmail.thread"`
(server/src/openmuse-mail/client.ts) stands in as a documented placeholder,
same discipline as M01's `gmail.list` / `gmail.search`: the live id is
verified against the vendor's `listServiceActions("gmail")` catalogue at O02
deployment. The dial is alias-bound (`x-oo-connector-alias` = the owner's
gmail alias, minted in G01) with body `{ input: { threadId } }` on the
adapter's `actions.execute` seam (`POST /v1/actions/<actionId>`).

Vendor not-found contract is fake-defined (recorded for O02): HTTP 404 on the
action call → `getThread` returns null → route answers 404. Foreign and
missing are indistinguishable at the vendor boundary BY DESIGN (an alias-bound
dial only ever sees that alias's mailbox); both answer the identical outward
404, and the internal log (`openmuse-mail-thread-not-found` with threadId +
alias) is the reason an operator can act on.

## Endpoint

`GET /api/mobile/openmuse-mail/threads/:threadId` → bare JSON array of §4
message DTOs, oldest `receivedAt` first then id ascending (parity with the
original OpenMuse `/api/mail/threads/:id` which returns `Mail[]`; errors are
objects). Checks in order: §9 disabled owner → 403 (vendor never called);
requireConnection → 409 (vendor never called); vendor 404 → 404; other vendor
failure → 502 no partial.

Choices recorded in code: HTML-only body falls back to a naive tag-strip (no
rendering/fetching, five common entities, source line breaks are rendered
whitespace — only `<br>`/closing block tags break a line); plain-body CRLF
normalized to LF; empty body stays `""`. Rows lacking per-message ids derive
stable ids from `(threadId, index)` = `${threadId}-${index}`.

The `ownerDisabled` seam on `createOpenMuseMailRoutes` is optional (mail has
no store of its own to carry the §9 marker); the wiring ticket that mounts the
real marker should pass it — and the M01 list route deliberately does not
consult it (that surface belongs to its own ticket's matrix).

## Files + shasum

- server/src/openmuse-mail/client.ts — f47f05f4dc7b98c5a7bfd0ecdef576c631b8f8fb43f9a24c96675ccdd4ecb5c1
- server/src/openmuse-mail/mail.ts — c85532b0cc3b2e74db5da6b5f01ae28e182dcedc2c22b1a93f1321c574286eb9
- server/src/openmuse-mail/routes.ts — eda7162ec3db623ee514dcfe85e9ce02f35864c1bfa850947f0645659edc95b1
- server/tests/openmuse-mail.test.ts — 551f90f2c1edb7fc48fd0a450b34e1c416cb360a65df5ac14c2248e60bc7f958

No app.ts/index.ts changes (route mounts under the existing M01 mount), no
migrations, openmuse-tasks untouched (T06 concurrent).

## Verification tails

- `bun test tests/openmuse-mail.test.ts tests/ready.test.ts` →
  `27 pass / 0 fail / 93 expect() calls / Ran 27 tests across 2 files`
  (TDD: matrix written RED first — 7 new tests failed with 404-before-route,
  then GREEN after implementation.)
- `tsc --noEmit` (server) → clean.
- `bunx biome check server/src/openmuse-mail server/tests/openmuse-mail.test.ts` → clean.

## S17 deferred note

S17 (live two-real-Google-account fixture) is deferred to the O02 deployment
check, same as M01/M02: this ticket proves the contract against the fake dial
only; the live gmail.thread action id, the vendor 404 signal, and real
cross-account isolation are verified against the deployed OpenConnector with
two real accounts before cutover.
