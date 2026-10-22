# T05 Repair 03 — Bind Pending SMS Challenge to Its Conversation

- **Parent:** `docs/plans/2026-10-20-workspace-redesign-b1.md` Task 5; finding T08-S1 in `docs/plans/reports/T08-final-review.md`.
- **Authority:** approved P09 behavior preserves conversation destination configuration and validation feedback. T05's existing pending SMS record already stores `{version, challengeId, agentId, channelId}` and is session-scoped. This repair makes the visible challenge honor that existing owner tuple; it does not alter server/API behavior.
- **Finding:** a challenge created for Bot A / conversation A is currently passed into the dialog based only on Bot ID; dialog conversation selection is independent and can switch to B while retaining the A challenge.
- **Goal:** pending SMS challenge is resumable only for its original Bot and conversation; reopening defaults to that conversation. Switching conversations cannot show or submit the prior challenge; returning to the original conversation restores it.
- **Owner / sequence:** one `frontend_implementer`, then `frontend_validator`, then independent `reviewer`; no commits. T08 final review FAIL requires this finding to close before completion.
- **PRE:** `docs/verification/workspace-redesign/execution/checkpoints/t05-r3/PRE/` captures `reaching-you.tsx`, `bot-reaching-you.test.tsx`, HEAD/status and hashes before edit.

## Owned files

| File | Allowed changes |
|---|---|
| `app/src/components/delivery/reaching-you.tsx` | Pass stored challenge channel into dialog; initialize conversation selection from pending challenge when resuming; expose challenge only when current Bot and selected channel match; preserve write/clear semantics. |
| `app/tests/bot-reaching-you.test.tsx` | Add behavior test: start challenge for A, switch to B and prove challenge/code form is absent, switch back to A and prove challenge/code form is restored and confirmation targets original challenge. |

No server, API, locale, permission or unrelated UI changes.

## Verification

- TDD RED → GREEN around conversation switch behavior; retain existing A→B→A Bot test.
- Focused native e2e for `app/tests/bot-reaching-you.test.tsx`; scoped Biome and `git diff --check`.
- Full app native and app/tests + app/src driven groups; app typecheck. Build is unchanged product architecture but rerun if production source changes type-level API.
- Independent validator confirms exact PRE/POST hashes and behavior evidence. Reviewer confirms P09/spec and quality separately. Then rerun full workspace OCR.

## Failure handling

Do not delete or mutate a pending challenge when merely switching conversations; keep it resumable for its original channel. Do not submit the old challenge against a newly selected conversation. Preserve an ability to start a new challenge on another conversation, with server behavior unchanged. Browser acceptance stays pending user testing.
