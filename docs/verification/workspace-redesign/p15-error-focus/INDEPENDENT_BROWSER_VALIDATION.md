# P15 Independent Browser Validation

- **Result:** PASS for rejected-save focus recovery at 390×844 in light and dark themes.
- **Workspace HEAD:** `203d0f0244b2f898218fa12027089c631e8448d9` (uncommitted worktree).
- **Source SHA-256:** `52319fee3fda9c9e916e3e0bf93b3d38947b549569d01d2a66a7a77d9b979b86`.
- **Test SHA-256:** `d01e1d0caf26d905c342810c80757c155a2f56347a95bcd57017235eac9e7d9e`.
- **Date:** 2026-10-21.

## Browser checks

Used repository-installed `playwright-core` to launch a separate headless local Chrome, with an isolated browser context. The browser signed in as a dedicated test admin created in the disposable `openbot-workspace-redesign-ui-pg` tmpfs database. After the prior API process had exited, the isolated API was restarted with `--no-env-file`, a fresh test-only encryption/auth secret, loopback Intelligence URLs, and email/password sign-in. A nonfunctional `*.invalid` Google OAuth client value was supplied only to satisfy the current auth-config requirement for an identity provider; no OAuth flow was attempted. No `.env` file or external provider was used. Only the Bot endpoint `PATCH /api/agents/agent_023d30c3-2e68-4bd4-a4ab-e2bba67c9fcc` was intercepted and answered with synthetic HTTP 503; each theme observed exactly one intercepted PATCH. No profile mutation reached the API.

| Theme | Viewport | 120-char draft | Alert | Focus stays in dialog | Escape closes | Trigger focus restored | Horizontal overflow |
|---|---:|---|---|---|---|---|---|
| Light | 390×844 | Pass | Pass | Pass | Pass | Pass | None |
| Dark | 390×844 | Pass | Pass | Pass | Pass | Pass | None |

Structured results: `browser-validation.json`. Error-state screenshots: `artifacts/light-390x844-error.png` and `artifacts/dark-390x844-error.png`.

## Test and review evidence

- From `app/`, `bun test ./tests/bot-setup.test.tsx`: 5 pass / 0 fail, 21 assertions.
- From `app/`, `bunx biome check tests/bot-setup.test.tsx`: pass.
- `git diff --check`: pass.
- `bunx tsc --noEmit -p app/tsconfig.json`: pass after the separate typed Input/Textarea refs were introduced.
- Initial e2e-driven group attempt failed in its JUnit report reader with `Cannot create a string longer than 0x1fffffe8 characters`; this is not counted as product test evidence. The focused Bun suite above is the direct test runner permitted by ADR 0008 for this Bun-dependent suite.
- Independent source review: Spec PASS and code quality PASS. Independent textarea-regression review is recorded separately in `docs/plans/reports/T05-P15-textarea-test-review.md` when complete.

## Limits

This closes the P15 error-focus browser check only. It does not replace the remaining T01–T08 page-specific browser acceptance gaps. OCR remains not run under the user's explicit instruction.
