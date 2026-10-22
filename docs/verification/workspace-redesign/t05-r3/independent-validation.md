# T05-R3 Independent Validation

- **Status:** DONE_WITH_CONCERNS
- **Revision:** `203d0f0244b2f898218fa12027089c631e8448d9` (worktree HEAD; task changes uncommitted)
- **Brief:** `docs/plans/task-briefs/T05-R3.md`
- **Plan:** `docs/plans/2026-10-20-workspace-redesign-b1-t05-repair-03.md`
- **Validation date:** 2026-10-21

## Scope and checkpoint integrity

The required PRE hashes match the PRE checkpoint records:

| Path | PRE SHA-256 | Current and POST SHA-256 |
|---|---|---|
| `app/src/components/delivery/reaching-you.tsx` | `725843713e096d69b17a969bc5d81e2eea0c2473b6d8a3cd23465c3b71b200ec` | `54fce69d0b19235e98198ad21d96e08dc647ffaaf39d5cc0a8978069becd1503` |
| `app/tests/bot-reaching-you.test.tsx` | `f4876c67b9b7b997168743f96440397d4519e3a325dc3362a02562df145f0277` | `e04b22805b31a48a22a6109797e0c3702770a86b9516213bd918d6f47b702a27` |

Both current files compare byte-for-byte equal to their POST checkpoint copies. The recorded PRE→POST deltas are exactly these two owned paths: one source file and one test file. Source delta passes `git diff --check`; no other source/test path is part of this checkpoint. The worktree has extensive unrelated migration edits, so whole-worktree status is not evidence for this task's delta.

## Acceptance checks

- **Bot + channel binding:** source derives the dialog's pending channel only when the stored pending record's `agentId` equals the fixed Bot. The dialog only exposes `challengeId` for SMS when the selected `channelId` equals that pending channel.
- **Preselection:** on SMS dialog mount, selection initializes to the linked channel when present, otherwise to the stored pending challenge channel. Test asserts Finance desk is preselected when reopening.
- **Switch to B:** A→Team desk (shared channel, still eligible for the same Bot) removes the verification-code form. Test also verifies session storage keeps `channelId: channel-expenses`.
- **Return to A:** selecting Finance desk restores the code form; confirming posts the original `challenge-1` with code `123456`.
- **Existing Bot switching:** existing test still verifies pending challenge is hidden on another Bot and visible again on original Bot.
- **Accessibility / interaction:** code input remains associated with its localized `FieldLabel`, keeps `autoComplete="one-time-code"` and `required`; selection is operable by the test's button/listbox interaction and form submits the original ID. Isolated test emitted HeroUI `PressResponder` and unlabeled element warnings; these are warnings from the rendered UI/test environment and were not shown to be caused by the new challenge conditional. No browser-level or screen-reader validation was performed.
- **Loading/error/success:** this repair does not alter fetch or mutation loading/error branches; focused test verifies successful start and confirm payloads. There is no browser observation of these states in this validation.
- **Responsive/browser:** no viewport or browser check was requested by the brief; browser acceptance is explicitly pending user testing in the plan.

## Commands and results

1. `E2E_BUN_ONLY='app/tests part 1' bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — **exit 0**, driver 1/1 passed. Driver warning: **5 files failed only when sharing a process**: `app/tests/account-mode-dialog.test.tsx`, `app/tests/approvals-rules.test.tsx`, `app/tests/bot-approval-rules.test.tsx`, `app/tests/bot-memory.test.tsx`, `app/tests/bot-reaching-you.test.tsx`. The latter is the scoped target; its isolated diagnostic passed below. Archive scan also skipped `server/tests/billing-period-fulfillment.integration.test.ts` because Node's default ESM loader rejected the `bun:` protocol (`Only URLs with a scheme in: file, data, and node are supported ... Received protocol 'bun:'`). Thus the group driver exits successfully despite collection/shared-process warnings; it is not clean evidence for the full group.
2. `bun --env-file=.env test ./app/tests/bot-reaching-you.test.tsx` — diagnostic only, **exit 0**, 8 pass, 0 fail, 29 expectations. Output included repeated HeroUI accessibility/PressResponder warnings as noted above.
3. `bunx biome check app/src/components/delivery/reaching-you.tsx app/tests/bot-reaching-you.test.tsx` — **exit 0**, 2 files checked, no fixes.
4. `git diff --check -- app/src/components/delivery/reaching-you.tsx app/tests/bot-reaching-you.test.tsx` — **exit 0**.
5. `shasum -a 256` over current and PRE/POST checkpoint files — all hashes match the table and checkpoint hash records.
6. `diff -q` current source/test against POST copies — both identical.

## Acceptance gaps and risks

- Driver's shared-process failure warning includes this test file despite its isolated 8/8 pass. Treat as a known test isolation issue requiring follow-up; this validation does not establish a clean shared-process run.
- The archive scanner skipped one unrelated `bun:`-protocol integration suite; it is outside T05-R3 behavior but means the scan did not collect it.
- Browser acceptance and responsive behavior remain unverified, as explicitly noted in the plan.
- Accessibility warnings surfaced under the isolated test harness. This change has no browser/assistive-technology verification to establish whether the warnings reflect actual accessible-name or activation problems.
