# T01 implementation report — theme token and semantic ownership

Status: **DONE_WITH_CONCERNS**. The token and mapping implementation is complete. Browser computed-style verification is blocked because this environment exposes no browser session/control runtime.

## Summary

- Made `tokens.css` the only source for all 39 existing `--ob-*` values and all 19 new tokens specified by `theme-contract.json` (58 total), with exact light and dark values.
- Added complete HeroUI semantic-slot mappings to `heroui-theme.css` in light and dark selectors. HeroUI `--accent` maps to the action fill; `--muted` maps to muted text.
- Kept legacy aliases separate from native HeroUI variable ownership. Legacy `--input` now maps to `--ob-control-border`.
- Updated Tailwind aliases and fixed its `shadow-card` alias to point at `--ob-shadow-card` instead of itself.
- Replaced stale palette documentation in `app/DESIGN.md` with the workspace theme contract and retained the existing typography/layout facts relevant to this implementation.
- No tests, dependencies, generated configuration, or preference storage were changed. No commit was made.

## Changed files

- `app/DESIGN.md`
- `app/src/styles.css`
- `app/src/styles/heroui-theme.css`
- `app/src/styles/legacy-ui-bridge.css`
- `app/src/styles/tokens.css`

All five files were already modified or untracked in the shared worktree before T01. Existing migration content was retained where compatible. The theme palette and empty HeroUI bridge conflicted with the assigned contract, so those owned files were aligned to the contract. No files outside the brief's ownership were edited.

## Contract and ownership evidence

The validator compared declarations against `theme-contract.json`:

- Light scope: 58 declared, 58 expected; no missing, extra, or value-mismatched tokens.
- Dark scope: 58 declared, 58 expected; no missing, extra, or value-mismatched tokens.
- The contract declares 39 existing tokens; all are present, along with the 19 new tokens.
- HeroUI mapping scope: 79 semantic declarations in each theme scope; all semantic slots in the implementation-spec table are present.
- Custom-property dependency graph: no cycles.
- Legacy bridge: no redeclarations of HeroUI semantic variable names.
- Legacy `--input`: `var(--ob-control-border)`.

The browser-computed values expected from these mappings are:

| Theme | Native / wrapper variable | Contract value |
| --- | --- | --- |
| Light | `--background` | `#F5F7FA` (`--ob-canvas`) |
| Light | `--foreground` | `#192131` (`--ob-foreground`) |
| Light | `--accent` | `#315FCF` (`--ob-action`) |
| Light | `--muted` | `#526079` (`--ob-muted-text`) |
| Light | `--field-background` | `#FFFFFF` (`--ob-field-background`) |
| Light | `--field-border` | `#7A879B` (`--ob-control-border`) |
| Dark | `--background` | `#111318` (`--ob-canvas`) |
| Dark | `--foreground` | `#EBEFF7` (`--ob-foreground`) |
| Dark | `--accent` | `#3D6BDA` (`--ob-action`) |
| Dark | `--muted` | `#A2ACBE` (`--ob-muted-text`) |
| Dark | `--field-background` | `#191D26` (`--ob-field-background`) |
| Dark | `--field-border` | `#68788F` (`--ob-control-border`) |

These are static contract/mapping results, not browser-observed computed styles.

## Commands and results

- `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t01/r01/native ./node_modules/.bin/e2e run --config e2e.unit.config.ts app/tests/theme-preference.test.ts app/tests/user-preferences.test.tsx` — **exit 0**; 2 files, 11 tests passed. Both files were collected by the native e2e layer (neither appears in the Bun-driven manifest). This verifies the existing preference read/write contracts, not rendered CSS.
- `bun --bun node_modules/vite/bin/vite.js build` (cwd `app/`) — **exit 0**; Vite built 18,384 modules. Existing Rollup annotation/chunk-size warnings were emitted; build completed. The command invoked Vite directly and skipped the prebuild configuration-generation hook.
- `./node_modules/.bin/biome check app/src/styles.css app/src/styles/heroui-theme.css app/src/styles/legacy-ui-bridge.css app/src/styles/tokens.css` — **exit 1**; formatter-only suggestions in the changed CSS, no fixes applied. Per the brief, no formatting write was run.
- `./node_modules/.bin/biome check --formatter-enabled=false app/src/styles.css app/src/styles/heroui-theme.css app/src/styles/legacy-ui-bridge.css app/src/styles/tokens.css` — **exit 0**; 4 files checked, no diagnostics when formatter checks are disabled.
- Inline Python contract audit — **exit 0**; 58/58 exact values in each token scope, 79 mapping declarations in each native theme scope, no dependency cycles, no prohibited legacy native-variable redeclarations. (No source or test files were written by this check.)
- `browser-use <<'PY' ... PY` — **exit 127** (`browser-use: command not found`). CUA inventory showed `browsers: []`; `cua.getBrowser({id:"iab"})` returned `Browser is not available: iab`. Vite was started directly at `127.0.0.1:3011` and stopped after that availability check. Therefore exact browser computed-style and wrapper/native DOM value verification is **blocked**; no browser result is claimed.

## PRE / POST hashes

PRE values were captured before editing T01's owned files. POST values were captured after implementation and verification. SHA-256:

| File | PRE | POST |
| --- | --- | --- |
| `app/DESIGN.md` | `a774821d0fed75f8b296fe90a05d4705271ae5723e0359b7d552192fe2fadd42` | `2e10d7b1358155c755c79f99d83b6e8f5d5f5b2dd445e244060b1e1af946468f` |
| `app/src/styles.css` | `db07d7088e2b99c45c69852ff8862a9bc2b2c75d24a7b99ee59a45d12a7964cb` | `f32102564a7dc61180c38cd2e27c9d31bf0858ea04072d32f6199662868db8f3` |
| `app/src/styles/heroui-theme.css` | `e41b88750b58b95cef394d0abb2784737458ab4318da54de4891eeb42ad56afa` | `d77c63c61820591280fb7b83eb7fa967099054d080ed5928a2cde11157950153` |
| `app/src/styles/legacy-ui-bridge.css` | `77401f6f7b1c660c7f1fdadfe7136c29f814ceeb6832ae2cbf96033f5c60f765` | `acd6410dde1354c5606956baadcae31aef93e2fe9533f6ed1a6df13dc74e4323` |
| `app/src/styles/tokens.css` | `e8f5fec7cd95c44263d7bd7b2f1925e9107524a60a6dff78e09396b07070c216` | `840187b143e80f953bcb338b9a60944e858be36ddd0b9b6c5f6acb20c5fd8f71` |

## Decisions and remaining risk

- The assigned theme contract was used as the implementation authority for these owned files, despite the pre-task CSS representing the HeroUI native-default palette. This is the explicit T01 output consumed by T02.
- Existing `openbot-theme` preference storage and theme switching are untouched; the targeted preference tests passed.
- Browser-derived computed values, actual HeroUI component rendering, and wrapper-vs-native applied style comparison remain unverified until a browser runtime is available.
- Biome's full check remains red solely for formatting suggestions. No formatter was allowed to write files; lint/syntax checks with formatting disabled passed.
