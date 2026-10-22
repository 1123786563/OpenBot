# T06-R1 implementation report

## Scope and result

Implemented the five assigned T06 review findings. The P18 datasets route was added to the bounded path set before editing, with the current file copied and hashed into the formal PRE checkpoint after explicit authorization from the parent. The repair brief now names that route.

- Added the observability access guard to the exports route `beforeLoad`; existing guard tests cover allowed manager and denied/missing `canManage` cases.
- Added optional `BotSubpage.width`, defaulting to `prose`; P16 runs, P17 detail, P18 datasets, P19 evaluations, and P23 exports request `wide`. Existing P20–P22 explicit widths remain unchanged.
- Added native `<details>/<summary>` disclosures for step payloads, sample reason/judge/usage, and failed export detail. Step payload content is rendered in a named, horizontally scrollable `<section>`; projected/truncated text continues through the existing projection helper. Missing sample usage is labeled unavailable inside the disclosure.
- Added P19 dataset-read-failure and empty-list assertions.

## Verification

ADR 0008 uses native `bun test ./<file>` for these selected suites; files were run individually to avoid sharing UI/global state across suites.

- `cd app && bun test ./tests/observability-route-guards.test.tsx` — passed, 3 tests.
- `cd app && bun test ./tests/ai-observability-run-steps.test.tsx` — passed, 25 tests.
- `cd app && bun test ./tests/ai-observability-experiments.test.tsx` — passed, 45 tests, including the two new P19 cases.
- `cd app && bun test ./tests/ai-observability-exports.test.tsx` — passed, 19 tests.
- `bunx biome check app/src/components/bot-profile/bot-subpage.tsx app/src/components/ai-observability/run-steps.tsx app/src/components/ai-observability/experiment-results.tsx app/src/components/ai-observability/exports-status.tsx 'app/src/routes/_authed/_app/bots.$agentId.exports.tsx' 'app/src/routes/_authed/_app/bots.$agentId.datasets.tsx' app/src/locales/en/ai-observability-runs.json app/src/locales/zh-CN/ai-observability-runs.json app/src/locales/en/ai-observability-evaluations.json app/src/locales/zh-CN/ai-observability-evaluations.json app/tests/ai-observability-run-steps.test.tsx app/tests/ai-observability-experiments.test.tsx app/tests/ai-observability-exports.test.tsx` — passed, 16 files checked, no fixes required. The scoped set was changed application and test files; untouched legacy tests were not reformatted.

No test manifest changed, so the coverage audit was not applicable. Browser geometry, native keyboard activation in a real browser, themes, real permission identities, and browser focus remain unverified as deferred in the brief. The disclosure uses native HTML `details/summary`, which provides the browser's built-in keyboard interaction; the source-level interaction tests exercise its collapsed/open states. Some pre-existing HeroUI `PressResponder` and React `act(...)` warnings appeared during the experiments/export suites; all assertions passed.

## Checkpoint evidence

The formal checkpoint is `docs/verification/workspace-redesign/execution/checkpoints/t06-r1/`.

- PRE: 21 unique owned source/test/locale paths, including the authorized datasets route; its manifest captures bytes and SHA-256 for each path.
- POST: 21 paths captured; 16 differ from PRE.
- POST manifest SHA-256: `7561b261f9ac0a6e6b3a1a2767f3fdc2abcf8e50708702ec0f33e7a73c8fdd23`.
- PRE-to-POST source delta SHA-256: `5fe478dc2bd673d809e50c54df90e3fbdcebb5e32671690c03cb65d4e36fc65e`.
- HEAD remained unchanged; no commit was created.

## Remaining validation

No browser run or app-wide typecheck was performed. The route and shell behavior is covered by the existing route guard and selected driven/native component tests; real-browser layout and focus acceptance remains deferred.
