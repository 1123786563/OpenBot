# R04 — Reconcile an uncertain Gmail send: checkpoint

Ticket R04 / issue #52. Plan: `docs/superpowers/plans/tickets/R04-uncertain-send.md` (openmuse
worktree). TDD: Task 1 RED ran first (7 new tests failing — the timeout test hung 5s, itself
proof of the missing deadline), then GREEN, then verification. No commits (worktree carries
prior uncommitted checkpoints; nothing reverted). Only the four owned files touched;
`openmuse-tasks` (T09, concurrent) never opened.

## Task 0 — timeout-classification audit (cited)

`server/src/openmuse-reviewed-actions/gmail-send-executor.ts`, R02 as shipped:

| signal | classification | site |
| --- | --- | --- |
| `OpenMuseConnectionRefusedError` (connection setup refused; request never left) | `failed` | catch, first branch |
| HTTP 4xx (provider refused the send; it never happened) | `failed` | `status >= 400 && < 500` |
| HTTP 5xx / no status (may have been accepted internally) | `outcome_unknown` | same block, else |
| 2xx without a readable message id | `outcome_unknown` | `providerMessageId` null branch |
| any error thrown after the request left (mid-request network loss, vendor timeout) | `outcome_unknown` | generic catch |

Verdict: the ambiguous case was **already distinct** from definite refusals — every signal that
could mean "the request left" settles `outcome_unknown`, everything provably before/at refusal
settles `failed`. The gap R04 closes: R02 had **no deadline of its own** — a dial that neither
answers nor throws hung the decision forever. R04 adds the executor's send deadline
(`DEFAULT_SEND_TIMEOUT_MS = 30_000`, injectable `timeoutMs`): the dial and the body read race a
timer; expiry rejects, lands in the same ambiguous catch, and settles `outcome_unknown`
(`deadline = setTimeout` at gmail-send-executor.ts:179). The race abandons the *wait*, not the
request — the `MailWireDial` seam carries no AbortSignal, so a late answer is ignored (and a
late dial rejection is absorbed with `.catch(() => {})` so it cannot crash the loop).

## What changed (owned files only)

- `gmail-send-executor.ts` — send deadline (above); header doc updated.
- `service.ts` —
  - `reconcile(reviewer, id, input)` is now **operator-scoped**: lookup by id (an admin
    reconciling an owner's send is not that owner), reviewer = the session actor; §9's owner
    fence does not gate an operator repair (decision recorded here).
  - transitions: `confirmed_succeeded` → `succeeded`, `confirmed_not_sent` → `failed`,
    `unresolved` → stays `outcome_unknown` with its warning verbatim; evidence **appends**
    (`prior | next`, capped 2000) on repeated unresolved reconciles; receipt carries the
    reconciliation record.
  - re-proposal gate in `propose`: same owner + kind + payloadHash with prior status
    `outcome_unknown` or `succeeded` → `ReviewedActionReproposalError` (409,
    `code: "reproposal_blocked"`, `reason: "uncertain" | "already_sent"`). Only
    `confirmed_not_sent` (which flips the prior to `failed`) re-opens the same logical send.
    `ponytail:` scans the owner's newest 100 rows — a cursor walk if same-send history ever
    outgrows that window.
  - `sanitizeEvidence` (G06's pattern): strips `ya29.*`, `1//0*`, `Bearer <run>`, and any
    base64-ish run ≥40 chars → `[REDACTED]`, capped at 2000.
- `routes.ts` — `POST /:id/reconcile` is operator-only via the house `requireAdmin` inline
  guard (user seat → 403); gate 409 branch added; **reviewer comes from the session actor,
  never the body** — the plan's body-reviewer fallback was not needed; the trust boundary is
  recorded in the handler comment.
- test file — old owner-scoped reconciliation test superseded by the R04 operator matrix
  (7 tests): timeout-after-acceptance (hanging dial, 10ms deadline) → outcome_unknown with
  fingerprint + timestamps and zero re-offers; the three reconcile outcomes; 403 non-admin /
  409 non-uncertain / 404 missing; the re-proposal gate matrix; G06 evidence sanitization.

"NO queue offer ever": this module owns no replay queue by design (§6 forbids auto-retry), so
the observable is the re-offer count — dial.calls and attempts stay at exactly 1 through a
repeated decision (test 1).

## Verification

```
bun test tests/openmuse-reviewed-actions.test.ts tests/ready.test.ts
  48 pass
  0 fail
  294 expect() calls
  Ran 48 tests across 2 files.
tsc --noEmit → clean
biome check <4 owned files> → clean (import order auto-fixed)
```

## Files + shasum

```
edc056082e423e4b103698d01de7a1eb27fb336b  server/src/openmuse-reviewed-actions/gmail-send-executor.ts
1a68b395811c0e9aa780d9825390a74438bdcea0  server/src/openmuse-reviewed-actions/service.ts
f111511fff060aebf84d983b12fe83c5c06cbd77  server/src/openmuse-reviewed-actions/routes.ts
7d230ca352a21a422b9ca2fbfe1f842c28414592  server/tests/openmuse-reviewed-actions.test.ts
```

## Deferred notes

- **F-MAIL-2** (acceptance: provider accepts the send, response times out): the unit seam is
  proven here — hanging dial + deadline → `outcome_unknown` with attempt fingerprint, zero
  automatic retries. The live fault injection against the real OpenConnector/Gmail seat is the
  acceptance run's card (also `GMAIL_SEND_ACTION_ID` stays a documented placeholder until O02
  verifies the vendor catalogue).
- **S21** (acceptance: deny/expire/stale/timeout matrix incl. "uncertain shows warning, no
  auto-retry, reconciliation evidence persists"): the R04 half is unit-proven (warning verbatim,
  gate, evidence append/persist); the live multi-user pass needs the acceptance environment
  (two real Google accounts) and stays with the acceptance plan.
- V01 (Activity) consumer: routes already expose reconciliation state via the receipt on every
  answered action (`receipt.reconciliation` + post-reconcile status) — no extra surface added
  here.
