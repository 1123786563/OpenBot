# T05 P11 Save-Error Focus — Implementation Report

- **Scope:** P11 rejected-save keyboard recovery only; no API or shared Dialog changes.
- **Initial finding:** see `docs/verification/workspace-redesign/b1-approval-rule-focus/INITIAL_BROWSER_FINDING.md` and `rules-error-focus-diagnostic.json`.
- **RED limitation:** the first happy-dom attempt to assert `document.activeElement` and Escape timed out because React Aria portal teardown is not modeled consistently there. After removing the simulated focus/Escape claims, the scoped regression remains a deterministic retained-draft/error/one-request check. Real Escape and focus behavior is delegated to the independent Chrome validator as prescribed in the plan.

## Implementation and verification

- Production change: `RuleForm` holds a ref to the Tool/app input and focuses it on mutation `onError` on the next animation frame. Existing draft/error rendering, close/reset path, and successful-save callback remain intact.
- Regression coverage: rejected save checks the exact draft, visible error, one request, and retained dialog. happy-dom could not model focus recovery reliably; see the planned independent browser validation.
- Validation: `bun test ./tests/approvals-rules.test.tsx` — 12/12, 31 assertions; scoped Biome — pass; `bunx tsc --noEmit -p app/tsconfig.json` — pass; `git diff --check` — pass.
- Independent Chrome check: 390×844, light/dark; exact POST intercepted as synthetic 400; focus returned to the editor, Escape closed, focus returned to trigger, no overflow; no API write. See `docs/verification/workspace-redesign/b1-approval-rule-focus/VALIDATION.md`.
- Final hashes: source `96a5b50a645b886bddd8bf16be8252ff62caa960b4929503911115c0b8b6b200`; test `5e2bd4a93fa0a654d8b27dbd976094ead359197e75358fe0b0deb6d419c651ab`.
- Review follow-up: retained the original successful-retry close and second-request assertions after the rejected-save checks. Final focused suite remains 12/12 (32 assertions); final test SHA-256 is recorded in `VALIDATION.md`.
