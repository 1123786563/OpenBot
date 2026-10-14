# V01 — Activity feed checkpoint (2026-10-13)

Ticket V01 / Issue #77. Plan: `V01-activity-feed.md`. No commit (worktree
checkpoint only). Work in `/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base`.

## Task 0 citations

Policy approvals seam (read-only, exactly what mobile-bff's activity consumes):

- `server/src/mobile-bff/activity.ts:29-58` — reads approvals through
  `ApprovalService.inbox(actor.id)`, keeping `inbox.requests` (the waiting
  items).
- `server/src/approvals/service.ts:391-418` — `inbox(ownerUserId)` =
  `store.list(ownerUserId)` projected by `publicApproval`
  (`service.ts:691-717`): the public DTO (args/target masked via
  `approvalPreview`, policy reason kept).
- Decision verbs: `ApprovalService.decide(ownerUserId, id, decision)`
  (`service.ts:376-382`), `ApprovalDecision = "allow_once" | "allow_always" |
  "deny" | "handled"` (`approvals/types.ts:8-12`); the store refuses a
  non-pending re-decide (`approvals/store.ts:126-136`). The feed's approve
  maps to `allow_once` (one tap must never write an always-rule), deny to
  `deny`. No second implementation: dispatch calls this seam.

Reviewed-actions owner-list capability:

- `ReviewedActionRows.listByOwner(owner, {limit, before})`
  (`openmuse-reviewed-actions/store.ts:79-82`, drizzle at :159-190) — the
  existing owner-scoped, cursor-paginated read. The service wrapper `list`
  (`service.ts:405-410`) is limit-only and unfiltered.
- Gap closed by the plan's ONE store export addition:
  `createOpenMuseActivityReviewedLister({database, rows})`
  (`store.ts`, above `rowToAction`) — the owner's `awaiting_review` +
  `outcome_unknown` rows, status filter inside the query, behind the same §9
  fence via `rows.ownerDisabled` (so D01's marker gates it without a new
  seam). Read-only.
- Decision path re-used: `OpenMuseReviewedActionService.decide`
  (`service.ts:261-355`) — re-reads the row, flips expiry to 409/expired,
  CAS-claims, settles; a settled row re-answers itself with zero provider
  calls.

## Files (shasum -a 256)

```
04384c59b7209e0ef65080b440dba684b7fcbd831085be84f00057ed176f491d  server/src/openmuse-activity/feed.ts        (new)
d1bef58e9dd108e99bb0ffcdb408a72e321d301a61f90427c2faa1ca13d3c4c3  server/src/openmuse-activity/routes.ts      (new)
33bfee0f276138efb36eea0ff2e61a85066bf700915eb184e5cace707419e1d0  server/tests/openmuse-activity.test.ts      (new)
0e537bf50acb84176bf5a8ba5146b449781c9896acad71423ca81cdc7739d127  server/src/openmuse-reviewed-actions/store.ts (ONE export addition)
529ee8280e711c2f4f160698b2fd126fbfc99a9dca34ec4424e17f4468f578d9  server/src/app.ts        (ONE tail param + mount)
5db84370d95b657b6f9aff7f227eecf194d3bbd8524cb8ca46b775aece7089d0  server/src/index.ts      (import + hoist + router + arg)
1cc548c1988115a9361f8729db7b40db0f34d90b9f6d1fed1f97d0d982be861c  server/tests/ready.test.ts                (offset -14 → -15)
a0fd934bb052eaa01d97ab867ee9cabb13e85db63df5adee49ae4275723abc8c  server/tests/self-host-banner.test.ts     (offset -25 → -26)
```

Notes on shared files: `index.ts` also hoists the reviewed rows/service out
of the inline `createOpenMuseReviewedActionsRoutes` call (behavior-neutral;
both surfaces share one in-flight execution map — required so feed dispatch
goes through the OWNING service instance, not a second one).
`self-host-banner.test.ts` needed the same offset shift as `ready.test.ts`
(its comment says so by rule); D01's earlier param had left it failing, the
-26 value is correct for the final param count.

## Verification

`bun test tests/openmuse-activity.test.ts tests/openmuse-reviewed-actions.test.ts tests/ready.test.ts`:

```
 103 pass
 0 fail
 764 expect() calls
Ran 103 tests across 3 files. [908.00ms]
```

Also green: `tests/self-host-banner.test.ts` (22 pass), `bun run build`
(tsc --noEmit, clean), `biome check` clean on every file above.

Tests cover: mixed feed §8 DTO + desc order + per-type allowedActions
(policy pending approve/deny; reviewed awaiting approve/deny;
outcome_unknown → view only, + reconcile marker for an admin actor);
wrong decision type both directions → 409 with both stores snapshot-unchanged
and zero seam/executor calls; expiry while feed open → 409
{code:"expired",status:"expired"} with the row flipped and no provider dial;
policy re-decide answers current status without a second decision; cursor
discipline (default 25 → nextCursor walk to 1, limit=101 clamps to 100
returning all 26, limit=abc 400, garbage cursor 400, foreign-owner cursor
400); same-createdAt id-desc tiebreak; §9 fence 403; dispatch happy paths
(executor called once; approvals seam decide called once with allow_once).

## S22 deferred note

Spec story 22 ("Policy approvals and Reviewed actions in one Activity view
with their types clear") — the feed API half is this checkpoint; deferred:
`task_notification` items and `readAt` marking (V02's task notifications —
V01 ships the §8 row shape with `readAt: null` and no mark route), and the
live-card acceptance evidence on a real device, which belongs to the mobile
UI tickets (I03/B01+) once the client renders the feed.
