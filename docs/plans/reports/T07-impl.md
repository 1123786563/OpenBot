# T07 Implementation Report — Home and Chat Layout

## Scope and outcome

Implemented only the T07 visual/layout delta for P01–P05, including the bounded T07-R1 correction from independent review. The current UI already preserved the existing recipient, message, group identity, streaming, route/search, context-panel, and `/bot` contracts, so no state/API/runtime wiring or behavior tests were changed.

The chat reading and composing columns now use a 720px maximum width, as required by the layout contract. The single-chat transcript, composer, and group chat transcript/composer share the same centered width; transcript and composer keep matching horizontal insets at narrow and wide sizes. Internal transcript scrolling and the composer’s bottom flex placement remain unchanged.

## Changed source files

- `app/src/components/channels/chat-transcript.tsx`
- `app/src/components/channels/conversation-view.tsx`
- `app/src/components/channels/group-chat.tsx`
- `app/src/routes/_authed/_app/index.tsx` (T07-R1: P01 primary Composer max-width)

No tests or state/API files changed.

## Checkpoint and scope evidence

- PRE/POST HEAD: `203d0f0244b2f898218fa12027089c631e8448d9`.
- PRE manifest: `docs/verification/workspace-redesign/execution/checkpoints/t07/PRE/manifest.json`.
- POST package: `docs/verification/workspace-redesign/execution/checkpoints/t07/POST/`.
- POST source/test path count: 84. PRE hashes were reconstructed from HEAD plus the PRE staged and unstaged patches and every hash matched.
- Final POST manifest SHA-256: `7fc8e4fa17006bda612785ee924226e2a7ff4c1f8e988858fcc9312acdccf435`.
- Final incremental PRE→POST delta contains exactly the four changed source files listed above; patch SHA-256 is `6ba618d32cfa617437efb609902bba0643edf5cda1b87d048161297e2dafa335`.
- No staging or commit was performed. Pre-existing shared worktree modifications were preserved.

## Verification

- Native: 17 test files; 124 selected, executed, and passed; 0 failed/skipped.
- Driven: app/tests part 2, part 3, and part 4 each selected and passed one driver group with nonzero execution.
- Biome: all three changed source files clean.
- `git diff --check`: passed.
- `bun run --cwd app build`: passed. Existing Rollup annotation/dynamic import notices and oversized chunk warning are recorded in `docs/verification/workspace-redesign/t07/build.log`.
- `bun run --cwd app typecheck`: initial T07 run found two T06 R3 omitted-value fixture errors (now corrected in T06-R4), a T06 exports route test typing issue (being addressed in T06-R5), and the existing `app/tests/button-native.test.tsx` callback-ref error. After T06-R5, typecheck had only the T02 callback-ref error; T02-R3 is fixing that one-line test callback. Rerun after T02-R3 for final status.
- Full test summaries and warnings: `docs/verification/workspace-redesign/t07/summary.md` and the report JSON files under that directory.

## Remaining evidence and gate

Real browser/runtime testing is pending user testing, as requested. In particular, responsive measurements, keyboard/IME, actual stream and failed-send interactions, route-backed settings/watch/workshop plus Back, control release, real group member ordering, and standalone `/bot` need a configured test identity and fixture. No screenshot or runtime claim is made here.

The first independent review found T07-S1 (medium): P01 home Composer was 672px. T07-R1 changed its `max-w-2xl` class to `max-w-[720px]`; the adjacent hint/error rows already use 720px. T07-R2 aligned all three Home hint/error rows to 720px. The combined four-file package is under `checkpoints/t07/POST/` and awaits scoped independent re-review.

T07 is not verified for downstream release until an independent frontend validator and a separate Spec/quality reviewer both pass against this exact POST hash.
