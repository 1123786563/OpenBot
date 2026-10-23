# T07 Implementation — Home, New Session, Direct Chat and Group Chat

- **Parent plan:** `docs/plans/2026-10-20-workspace-redesign-b1.md` Task 7.
- **Spec:** P01–P05 acceptance in `docs/design/2026-10-20-workspace-redesign/handoff/refinement/route-acceptance.json`, `implementation-spec.md`, `implementation-detail.md` §§3–6, `verification-plan.md`; runtime and terminology from `CONTEXT.md`; test partitions from ADR 0008.
- **Scope:** T07 only, after T06 source/test verification and independent review. No server API, chat protocol, permission, tenant, channel, computer runtime, or later-page redesign changes.
- **Owner / gate:** one `frontend_implementer`, then independent `frontend_validator` and `reviewer`; no commits.
- **PRE:** all 42 owned source/test paths plus HEAD/status/staged and unstaged binary patches are captured at `.archive/runs/2026-10-20-workspace-redesign-b1/verification/execution/checkpoints/t07/PRE/`.

## Requirements and interfaces

- P01: home message entry remains primary and colleague choice remains reachable; honestly represent no available Bot.
- P02: recipient selection and first message flow remain reachable; failed first send retains text and attachments.
- P03: preserve IME composition behavior; stream/scroll, stop/retry, and route-backed settings/watch/workshop context; computer panel 400px, workshop 480px, widths switch at content thresholds 880/960 without duplicated state; Back and control release remain authoritative.
- P04: group member identity/ordering and message send remain intact.
- P05: start a new conversation and open the computer; retain `/bot` standalone route.
- Keep message reading column max-width 720px, 48px top bar, transcript's internal scroll region, and composer at the bottom of the flex column. Keep existing channel/computer/workshop APIs and event contracts.
- Respect shared T03 `DetailPanel` and T02 wrappers as verified; T07 owns only the paths below. The previous T03 transfer of `skill-fields.tsx` back to its T07 default owner is recorded in the parent ledger.

## Owned paths

All `owned_files` and `test_files` for T07 in `tasks.json` are exclusive to this task: 42 source files and 42 listed behavior test files. Exact paths are frozen in PRE `manifest.json`; any additional path requires a bounded plan amendment and ownership check before edits.

## Steps and verification

1. Audit existing current UI against P01–P05; implement only visual/layout changes needed by the spec while preserving existing event, state and route contracts. Add or update behavior regressions only in owned tests where a requirement lacks coverage.
2. Run changed behavior suites through ADR 0008 native or driven partition. For driven Bun files, a direct Bun run is diagnostic; the final task evidence is the relevant `e2e.unit.config.ts` group and nonzero selected counts. Run changed-path `bunx biome check`, `git diff --check`, app typecheck, and app build if T07 implementation changes app production sources; report pre-existing errors against baseline.
3. Recheck coverage audit if test files or test manifest entries change. Capture POST snapshots, byte hashes, and a real PRE→POST package including untracked additions/deletions. Persist exact commands/results in `.archive/runs/2026-10-20-workspace-redesign-b1/verification/t07/`.
4. Independent validator and reviewer verify the same POST hash. Real browser/runtime/identity verification is deferred to user testing and remains pending; do not claim that source tests prove it.

## Failure handling

Preserve all unrelated baseline changes. Do not install dependencies, stage, commit, push, merge, publish or deploy. Any runtime/fixture blocker remains explicitly blocked; do not send messages or alter shared business data to create evidence. T08 is gated until source/test validation and Spec/quality review both pass.
