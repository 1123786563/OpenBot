# T05-R4 Independent Validation

- **Status:** DONE_WITH_CONCERNS
- **Revision:** `203d0f0244b2f898218fa12027089c631e8448d9` (`feat/heroui-v3-migration`; dirty worktree)
- **Brief/plan:** `docs/plans/2026-10-20-workspace-redesign-b1-t05-repair-04.md`; bounded follow-up described in `docs/plans/task-briefs/T05-R3.md`.
- **Scope:** `app/tests/bot-reaching-you.test.tsx` only. No production source changed by T05-R4. Validation report and isolated e2e output are the only artifacts produced by this validation.

## Checkpoint and delta

- PRE file digest: `e04b22805b31a48a22a6109797e0c3702770a86b9516213bd918d6f47b702a27`; matches PRE `hashes.txt` and its archived file.
- POST and live file digest: `335b169ddf21798e36a037dbac3ad35a10854cce04839c1dfe8a510239cdda68`; they match each other and POST `hashes.txt`.
- Rebuilt unified PRE→POST diff is byte-identical to `POST/delta.diff`. It contains only a change to the A→B→A SMS conversation test: removes direct `sessionStorage.setItem` seeding and starts the challenge through the UI. No other test or production path is in the delta.
- PRE and POST checkpoint HEAD are recorded as `203d0f0244b2f898218fa12027089c631e8448d9`, matching current HEAD.

## Acceptance evidence

The updated test starts with empty storage (after `serving(true)`), opens Connect a phone, chooses **Finance desk**, enters `+15551234567`, and clicks **Send verification code**. It asserts `POST /api/delivery/sms/start` with `{ channelId: "channel-expenses", agentId: "expenses", phone: "+15551234567" }`, then asserts the persisted `challenge-1` tuple is bound to Bot `expenses` and `channel-expenses`. It checks the verification-code field appears on Finance desk; on same-Bot **Team desk** it checks the field is hidden while the Finance channel record remains stored; returning to Finance desk restores the field, and confirmation posts the original `challenge-1` with code `123456`. The new test contains no storage seed. The separate Bot A→B→A case remains.

## Commands and results

1. `E2E_BUN_ONLY='app/tests part 1' E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/execution/t05-r4-validator-driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — **exit 0**, wrapper 1/1 passed. Report: `docs/verification/workspace-redesign/execution/t05-r4-validator-driven/report.json`, e2e run `01a15a89-6a09-7bee-9e58-f9c000a33ba5`, same HEAD.
2. `cd app && bun test tests/bot-reaching-you.test.tsx` — **exit 0**, 8 passed, 0 failed, 31 expectations.
3. `cd app && bunx biome check tests/bot-reaching-you.test.tsx` — **exit 0**, one file checked, no fixes.
4. `git diff --check -- app/tests/bot-reaching-you.test.tsx` — **exit 0**.
5. `shasum -a 256` on PRE/POST/live source and checkpoint hash records; `diff -q` live against POST; regenerated PRE→POST diff comparison — source digests match the recorded values, live equals POST, regenerated diff equals `POST/delta.diff`.

## Shared-process and collection warnings

The driven group passed its wrapper but reported exactly these five files failing only when sharing a Bun process: `app/tests/account-mode-dialog.test.tsx`, `app/tests/approvals-rules.test.tsx`, `app/tests/bot-approval-rules.test.tsx`, `app/tests/bot-memory.test.tsx`, and `app/tests/bot-reaching-you.test.tsx`. The scoped target passes in isolation (8/8). The archive scan also skipped `server/tests/billing-period-fulfillment.integration.test.ts` because Node's default ESM loader rejected the `bun:` protocol. Both the warning set and skip match `docs/verification/workspace-redesign/t08/pre-r3-driven-warning.md`, the T05-R3 independent validation, and the T05-R4 implementation report; no new group warning is evidenced.

## Gaps and risks

- The isolated UI test emits repeated HeroUI warnings: `PressResponder` without a pressable child and missing visible/accessibility labels. This check confirms those warnings remain; it does not determine their browser or assistive-technology impact.
- This test-only repair has no loading/error UI or responsive/browser acceptance criterion, and no browser or screen-reader verification was performed. No such claim is made.
- The driven wrapper's success does not mean the shared-process warning files passed in the group; only the scoped test's isolated success is clean evidence for its behavior.
