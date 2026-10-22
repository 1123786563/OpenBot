# T07 Final Validation (after T07-R2)

- **Status:** `DONE_WITH_CONCERNS` — automated source checks pass; browser acceptance remains pending.
- **Revision:** HEAD `203d0f0244b2f898218fa12027089c631e8448d9` (`feat/heroui-v3-migration`).
- **Combined T07 PRE→POST package:** 84 paths. Independently verified all saved PRE source copies and all current POST files against manifest byte counts and SHA-256 hashes: 0 missing/mismatched in each set.
- **POST manifest SHA-256:** `7fc8e4fa17006bda612785ee924226e2a7ff4c1f8e988858fcc9312acdccf435`.
- **Exact delta paths (four):** `app/src/components/channels/chat-transcript.tsx`, `app/src/components/channels/conversation-view.tsx`, `app/src/components/channels/group-chat.tsx`, and `app/src/routes/_authed/_app/index.tsx`.
- **Final PRE→POST patch SHA-256:** `6ba618d32cfa617437efb609902bba0643edf5cda1b87d048161297e2dafa335`.

## Verification

| Check | Exact command | Result |
|---|---|---|
| Home fallback / driven part 3 | `E2E_BUN_ONLY='app/tests part 3' E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t07/final-r2-driven-part3 bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | Exit 0; selected driver passed (1 test). Runner noted collection skips for unrelated unselected `bot-subpage`, `routines-list`, and server integration tests using `bun:` under Node. |
| Changed-source Biome | `bunx biome check app/src/components/channels/chat-transcript.tsx app/src/components/channels/conversation-view.tsx app/src/components/channels/group-chat.tsx app/src/routes/_authed/_app/index.tsx` | Exit 0; four files clean. |
| Whitespace/diff | `git diff --check` | Exit 0; run in the same command chain after Biome. |
| App typecheck | `bun run --cwd app typecheck` | Exit 0; app config generation and `tsc --noEmit` passed. |
| Native T07 list | Not rerun. T07-R2 changes the home route's width classes; the directly relevant home fallback behavior was rerun in driven part 3. The prior native report does not independently certify this route width change. | No native result claimed for the R2-only route change. |

## Acceptance gaps and risks

No browser session was run. Responsive rendering, visual alignment/overflow, keyboard and screen-reader behavior, loading/empty/error/success UI in the browser, and composer interactions remain unverified at runtime. The driven test, Biome, and typecheck do not establish browser presentation or accessibility behavior. The assigned automated validation is complete; browser-level acceptance remains a known gap.
