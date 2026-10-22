# T05-R3 Independent Review — SMS Challenge Conversation Ownership

## Scope and evidence

Reviewed `docs/plans/task-briefs/T05-R3.md`, repair plan 03, T08-S1 in `T08-final-review.md`, P09 in `docs/design/2026-10-20-workspace-redesign/pages.md`, the B1 implementation plan, `CONTEXT.md`, ADR 0008, and the exact two-file PRE→POST deltas under `docs/verification/workspace-redesign/execution/checkpoints/t05-r3/POST/`. Current source/test SHA-256 matches POST (`54fce69d…` / `e04b2280…`); PRE hashes match their recorded copies. This is a static independent review; the implementer reported focused 8/8 passing, Biome, diff-check, and typecheck. I did not rerun tests.

## Findings

### T05-R3-Q1 — Low — Transition test starts from seeded storage

- **Evidence / affected symbol:** `app/tests/bot-reaching-you.test.tsx:298–333` writes the pending challenge directly to `sessionStorage`, then switches Finance desk → Team desk → Finance desk. The prior test at `:238–276` checks a real `/api/delivery/sms/start`, but completes confirmation without switching conversations.
- **Impact:** The two tests cover storage creation and the A→B→A visibility/confirm behavior separately. They do not prove the full start-response → switch → restore → confirm path as one behavioral sequence, including a response arriving after a conversation change. This limits regression confidence; it does not show a production defect in the reviewed delta.
- **Smallest defensible correction:** In the transition test, create A's challenge through the Send verification code action and assert its stored tuple before switching; retain the existing independent Bot switching case. A response-order case is useful if this boundary is later changed.

## Spec compliance verdict: PASS for the bounded repair

P09 keeps the existing contact/destination operation and validation feedback. The delta passes the stored `channelId` into the dialog only for the matching fixed Bot (`reaching-you.tsx:316–321`), preselects that conversation on SMS reopen (`:374–376`), and derives the visible confirmation ID only when the selected conversation matches (`:408–409`). Switching to B removes the code form (`:528`) and returning to A restores it without clearing the stored record; confirmation uses that selected original challenge ID (`:532–533`). The added test checks the displayed A selection, absence of the code form on B, retained storage channel, restored form on A, and confirmation payload containing `challenge-1` (`bot-reaching-you.test.tsx:298–333`). The existing Bot A→B→A test remains intact (`:278–296`). The repair makes no server/API, schema, locale, or permission change.

## Code quality verdict: PASS with one low test gap

The gate is in the UI derivation and is used for both form visibility and the confirmation payload, so B cannot submit A's visible challenge through this form. The pending tuple is not cleared by conversation selection. The exact PRE→POST delta adds only the channel prop, selection/gate logic, one shared fixture conversation, and one test; prior assertions were not removed or weakened. No correctness, security, concurrency, data consistency, or architecture blocker was found in this bounded delta.

## Shared-process driver observation

The implementer reports the `app/tests part 1` driven group recorded this file and five others failing only in the shared Bun process, while isolated reruns passed. ADR 0008 explicitly distinguishes this kind of process-state contamination from an independently failing suite and requires the driver to name it. This is a test-driver/process-isolation issue to track separately, not a T05-R3 source finding or proof of a clean shared-process run. Browser acceptance and the coordinator's complete delivery/OCR gates remain outside this bounded verdict.
