# T07 Final Independent Review

## Scope and evidence

Reviewed the T07 combined original PRE through R2 POST package, the parent B1 plan Task 7, T07 plan and brief, R1/R2 repair plans, approved workspace redesign implementation spec and detail, P01–P05 route acceptance, verification plan, `CONTEXT.md`, and ADR 0008. This is a source and checkpoint review; browser/runtime acceptance remains pending as specified in the T07 plan.

- Checkpoint: `docs/verification/workspace-redesign/execution/checkpoints/t07/`; HEAD in both manifests is `203d0f0244b2f898218fa12027089c631e8448d9`.
- PRE and POST each list the same 84 owned source/test paths. Only `chat-transcript.tsx`, `conversation-view.tsx`, `group-chat.tsx`, and the Home `index.tsx` differ. All 84 POST entries match live file byte counts, SHA-256 hashes, and snapshot bytes.
- POST manifest SHA-256 is `7fc8e4fa17006bda612785ee924226e2a7ff4c1f8e988858fcc9312acdccf435`, matching `CHECKPOINT_SHA256`. `delta.patch` SHA-256 is `6ba618d32cfa617437efb609902bba0643edf5cda1b87d048161297e2dafa335`. The patch exactly reconstructs the four PRE→POST file diffs.

## Spec compliance verdict: PASS for T07 source scope

The approved spec sets the chat message/input reading column maximum at 720px. The P01 Home Composer and its fallback hint, send error, and initial-load error rows now all use `w-full max-w-[720px]` in `app/src/routes/_authed/_app/index.tsx:62,101,111,125`. This resolves T07-S1 across normal and conditional Home states. The P02/P03 single-chat transcript (`chat-transcript.tsx:1635`) and composer wrapper (`conversation-view.tsx:437`), and P04 group transcript and composer wrappers (`group-chat.tsx:63,93`), use the same 720px outer cap. Both transcript/composer pairs have `px-4`, giving matching 16px source insets.

The patch changes only width and inset classes. It leaves the transcript scroll containers, bottom `shrink-0` composer siblings, message/send handlers, recipient and group identity logic, route-backed panels, and standalone P05 `/bot` route unchanged. Thus it introduces no source-visible conflict with the P01–P05 behavioral contracts, `CONTEXT.md`, or the T03 DetailPanel interface and thresholds. Existing targeted verification is recorded in the implementation reports; this review did not rerun tests.

Rendered P01–P05 acceptance remains pending. In particular, actual alignment with a scrollbar gutter, narrow viewport/zoom overflow, soft-keyboard composer reachability, and the packaged P05 `CopilotChat` geometry require the deferred browser/runtime check. Source inspection does not certify those conditions.

## Code quality verdict: PASS

No new correctness, security, concurrency, data consistency, regression, or architecture finding in this four-file delta. The width changes do not add state, side effects, APIs, permissions, or protocol handling. The single and group changes apply symmetric transcript/composer insets, and all Home states use the same cap. No new behavioral test is required for these class-only corrections; rendered geometry remains an explicit acceptance check.

**Findings:** none. This verdict covers the exact POST hash above; changes to the package require renewed review of the affected scope.
