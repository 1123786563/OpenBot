# T07-R1 independent review — combined T07 PRE→POST

## Scope and checkpoint integrity

Reviewed the T07 brief, repair plan, P01–P05 handoff acceptance, implementation spec/detail and verification plan, `CONTEXT.md`, ADR 0008, and the combined four-file PRE→POST package. Both manifests identify HEAD `203d0f0244b2f898218fa12027089c631e8448d9` and the same 84 owned source/test paths. Their byte counts and SHA-256 values differ only for `chat-transcript.tsx`, `conversation-view.tsx`, `group-chat.tsx`, and the Home `index.tsx`. All 84 POST entries match live file bytes and hashes. The final POST manifest SHA-256 is `d31fae9336e59d17e785d986da62f3ee3cef25aeeb8e217739b5b20c25e487b4`, matching `CHECKPOINT_SHA256`; the combined `delta.patch` SHA-256 is `1c6d09c87758b2d0927614e3b7e78d627db551e44fd3b68fc2608c74e7bb5975`. The R1 POST Home source hash `a2f2dc59dcaa66c277648468bbdb82bcac8c9a69c6465d9f26b323f40254cd93` matches both the combined POST and the live route. R1's one-line PRE→POST delta is included in the combined patch.

The earlier T07 independent validation and review refer to the preceding three-file manifest hash `2cad641c...`; this review uses the current four-file package. No tests, OCR, or browser checks were run here. Browser/runtime acceptance remains deferred.

## Spec compliance verdict: **fail — T07-S1 remains partially unresolved**

### T07-S1 — Medium — Home hint and error rows remain narrower than the Composer

- **Evidence / affected symbol:** The implementation spec §5 sets the chat message/input reading column to 720px, and T07-R1's repair goal includes alignment of the P01 Home Composer and its hint/error rows. The R1 delta changes only the `Composer` class to `w-full max-w-[720px]` in `app/src/routes/_authed/_app/index.tsx:62`. The fallback hint at line 101, send error at line 111, and load error at line 125 still use `w-full max-w-2xl` (672px). The repair plan's statement that those rows are already 720px is contradicted by the POST source. Single/group transcript and composer wrappers use `max-w-[720px]` in the other three changed files.
- **Impact:** At a Home container width above 720px, the hint and error rows have a 48px smaller outer cap than the primary Composer. This leaves the P01 column alignment requirement incomplete, including the error states. The source diff alone does not establish the rendered widths at every viewport.
- **Smallest defensible correction:** Give the three Home hint/error rows the same 720px cap as the Composer, or place all four under one shared 720px column wrapper while preserving the existing responsive padding and send/error behavior. Capture and review a new checkpoint.

The four-file delta does not alter P02–P05 routes, data/event contracts, URL state, scroll ownership, or computer control logic. The P03 single-chat and P04 group transcript/composer containers now share the specified 720px maximum and 16px inset. Rendered geometry, soft-keyboard reachability, and standalone `/bot` width still require the deferred browser acceptance; source review does not sign them off.

## Code quality verdict: **pass for the four-file source delta; no new quality finding**

The combined patch changes width/inset utility classes only. Existing `MessageScrollerViewport` and group `overflow-y-auto` remain the transcript scroll regions; composer wrappers remain `shrink-0` flex siblings. No new API, permission, state, asynchronous operation, or persistence path appears in the patch, so no correctness, security, concurrency, or data consistency regression is evident from these edits. The missing rendered-width assertion is an acceptance evidence gap and belongs in the deferred browser check. The valid medium spec finding above keeps the T07 review gate open.
