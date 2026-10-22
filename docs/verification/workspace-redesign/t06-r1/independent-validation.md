# T06-R1 independent validation

## Result

**DONE_WITH_CONCERNS** — the assigned source behavior, focused regression suites, formatting check, and checkpoint integrity pass. Real browser layout/keyboard/focus behavior was deferred in the assigned brief and remains unverified. The route denial test invokes the shared guard directly; route wiring was confirmed in source rather than by navigating a router instance.

## Revision and checkpoint

- Worktree: `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
- HEAD: `203d0f0244b2f898218fa12027089c631e8448d9` (unchanged from POST `head.txt`)
- Assigned POST manifest SHA-256: `7561b261f9ac0a6e6b3a1a2767f3fdc2abcf8e50708702ec0f33e7a73c8fdd23` (recomputed and matches)
- PRE and POST each contain 21 unique paths. Recomputed all 21 PRE snapshot, POST snapshot, live byte lengths and SHA-256 values: no mismatches. All POST snapshot bytes equal live bytes.
- PRE-to-POST differences: 16 paths; recomputed delta SHA-256 `5fe478dc2bd673d809e50c54df90e3fbdcebb5e32671690c03cb65d4e36fc65e`, matching `POST/delta.sha256`.
- No source or test files were changed during validation; only this report was written.

## Checks run

Commands below ran successfully at the revision above:

- `cd app && bun test ./tests/observability-route-guards.test.tsx` — 3 passed, 0 failed.
- `cd app && bun test ./tests/ai-observability-run-steps.test.tsx` — 25 passed, 0 failed.
- `cd app && bun test ./tests/ai-observability-experiments.test.tsx` — 45 passed, 0 failed.
- `cd app && bun test ./tests/ai-observability-exports.test.tsx` — 19 passed, 0 failed.
- `bunx biome check app/src/components/bot-profile/bot-subpage.tsx app/src/components/ai-observability/run-steps.tsx app/src/components/ai-observability/experiment-results.tsx app/src/components/ai-observability/exports-status.tsx 'app/src/routes/_authed/_app/bots.$agentId.exports.tsx' 'app/src/routes/_authed/_app/bots.$agentId.datasets.tsx' app/src/locales/en/ai-observability-runs.json app/src/locales/zh-CN/ai-observability-runs.json app/src/locales/en/ai-observability-evaluations.json app/src/locales/zh-CN/ai-observability-evaluations.json app/tests/ai-observability-run-steps.test.tsx app/tests/ai-observability-experiments.test.tsx app/tests/ai-observability-exports.test.tsx` — 13 files checked, no fixes.

Hash verification command was a read-only Python script loading `PRE/manifest.json` and `POST/manifest.json`, hashing each listed live file and checkpoint snapshot, comparing snapshot bytes, and hashing `POST/delta.patch`; its results are recorded above.

## Acceptance evidence

- **P23 direct guard:** `app/src/routes/_authed/_app/bots.$agentId.exports.tsx` now wires `requireBotObservabilityAccess` in `beforeLoad`; `observability-route-guards.test.tsx` passes manager, denied, and missing-permission guard cases. The exports suite also passes direct typed-address scope refusal. The route-level `beforeLoad` itself was source-inspected, not exercised through a real router navigation.
- **Widths:** source inspection confirms `width="wide"` for P16 runs, P17 detail, P18 datasets, P19 evaluations, and P23 exports. `BotSubpage` accepts `prose | wide`, defaults to `prose`, and forwards the selected width to `PageShell`.
- **P17 disclosure:** step payload is in a native `details/summary`; its content is a named horizontally scrollable section. The steps suite asserts closed and open states and projected/truncated text. Test activation uses a click; native summary keyboard behavior was not browser-tested.
- **P21 disclosure:** sample reason, judge detail, and usage are inside a native `details/summary`. Tests assert initially closed, open after interaction, and detail visibility. Missing usage renders an explicit unavailable label. Keyboard operation was not browser-tested.
- **P23 disclosure:** failed export detail is inside a native `details/summary`; tests assert closed/open states and localized failure detail. The exports suite also covers keyboard-reachable navigation elsewhere on the page, but did not exercise disclosure keyboard activation.
- **P19 unavailable versus empty:** experiments suite passes both new cases: dataset read failure displays unavailable and offers no submit action; an empty dataset list preserves the empty state.

## Risks and limits

- Browser testing was explicitly deferred: viewport geometry/responsiveness, themes, actual keyboard activation of disclosures, focus behavior, and route navigation in a browser remain unverified.
- The guard test directly verifies the shared guard function, not the route's assembled `beforeLoad`; source inspection confirms the route is wired to that function.
- The experiments and exports suites emit existing HeroUI `PressResponder` and React `act(...)` warnings while passing. No app-wide typecheck was run, per the assigned focused-validation scope.
