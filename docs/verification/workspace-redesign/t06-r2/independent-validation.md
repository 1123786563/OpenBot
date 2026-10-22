# T06-R2 independent validation

- **Result:** DONE_WITH_CONCERNS
- **Revision checked:** `203d0f0244b2f898218fa12027089c631e8448d9` (`HEAD`, unchanged during validation)
- **Scope:** `docs/plans/reports/T06-R2-impl.md` and its five owned source/test paths. No source or test files were modified; no commit was made. This report is the only validation output written.

## Checkpoint integrity

Recomputed SHA-256 and byte lengths for the five current files against `docs/verification/workspace-redesign/execution/checkpoints/t06-r2/POST/manifest.json`: all five match. The hashes match the final hashes listed in the implementation report. PRE manifest contains five entries; PRE records the same HEAD above. `delta.patch` SHA-256 is `1aa6e576ad82df5b3f18cc55e1a8e066476a2606fd2c26d2a2e5ec7751bd75b3`, size 8037 bytes, matching the report. `git apply --stat` reports exactly the five owned paths (114 insertions, 32 deletions). `git diff --check` on those five current paths exited 0 with no output.

## Verification run

All commands ran from `app/` at the revision above.

| Command | Result |
| --- | --- |
| `bun test ./tests/ai-observability-run-steps.test.tsx` | exit 0; 26 pass, 0 fail |
| `bun test ./tests/ai-observability-experiments.test.tsx` | exit 0; 45 pass, 0 fail |
| `bun test ./tests/ai-observability-exports.test.tsx` | exit 0; 19 pass, 0 fail |
| `bun test ./tests/observability-route-guards.test.tsx` | exit 0; 5 pass, 0 fail |
| `bunx biome check src/components/ai-observability/run-steps.tsx tests/ai-observability-run-steps.test.tsx tests/ai-observability-experiments.test.tsx tests/ai-observability-exports.test.tsx tests/observability-route-guards.test.tsx` | exit 0; checked 5 files, no diagnostics |
| `git diff --check -- app/src/components/ai-observability/run-steps.tsx app/tests/ai-observability-run-steps.test.tsx app/tests/ai-observability-experiments.test.tsx app/tests/ai-observability-exports.test.tsx app/tests/observability-route-guards.test.tsx` | exit 0; no output |

The route guard suite directly navigates a memory router to `/bots/bot-1/exports` using the actual production exports route and its `beforeLoad`: `canManage=true` reaches the exports match, and `canManage=false` is refused (no active matches in this minimal harness). The suite also directly covers the guard helper's allowed, false, and missing permission cases.

## Acceptance notes and limitations

The required null/omitted payload rendering and failed dataset read/no-submit assertions pass. The implementation report's Happy DOM limitation is consistent with its stated probe: `userEvent.keyboard("{Enter}")` did not set native `<details>.open` for P17, P21, or P23. Happy DOM's result cannot establish native browser keyboard activation, so no browser behavior is inferred from it. Real-browser keyboard/focus and visual/layout verification remain **pending** as directed; no browser verification was performed here.

Test output included non-failing React warnings (PressResponder without a pressable child and state updates outside `act`) in the experiments and exports suites. They did not fail the assertions, but remain diagnostic noise for future cleanup.

At validation start the shared worktree already contained numerous unrelated tracked and untracked changes. This validation only checks the specified five-file package and its checkpoint; it does not certify the full worktree diff or attribute unrelated changes.
