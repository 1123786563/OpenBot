# T01-R1 implementation report — reduced motion and scoped formatting

Status: **DONE_WITH_CONCERNS**. S1 and Q1 are repaired. Browser computed-style verification remains blocked by the unavailable browser runtime documented in the T01 report.

## Changes

- Added a `prefers-reduced-motion: reduce` rule in `app/src/styles/heroui-theme.css`. Both light and dark theme roots now set `--skeleton-animation: none`, and both HeroUI shimmer pseudo-elements (`::before` and `::after`) explicitly use `animation: none`.
- Ran Biome formatter on the four assigned CSS files only. It made formatting-only changes in `heroui-theme.css` and `tokens.css`.
- No tests or CSS mirror tests were added. No dependency install or commit was made.

## Installed HeroUI evidence

Inspected installed `app/node_modules/@heroui/styles/dist/components/skeleton.css` from `@heroui/styles` 3.2.6. The `.skeleton--shimmer::after` selector applies Tailwind's `animate-skeleton`; nested `.skeleton--shimmer:has(.skeleton)::before` also applies `animate-skeleton` for the synchronized parent shimmer. The reduced-motion override covers both pseudo-elements. The override is in the later `ob-theme` layer, after HeroUI's `components` layer.

## Commands and results

- `cat app/node_modules/@heroui/styles/dist/components/skeleton.css` — **exit 0**; confirmed both actual animated pseudo-elements and the `animate-skeleton` class.
- `bunx biome format --write app/src/styles/heroui-theme.css app/src/styles.css app/src/styles/legacy-ui-bridge.css app/src/styles/tokens.css` — **exit 0**; formatted 4 files, fixed 2.
- `bunx biome check app/src/styles/heroui-theme.css app/src/styles.css app/src/styles/legacy-ui-bridge.css app/src/styles/tokens.css` — **exit 0**; checked 4 files, no fixes/diagnostics.
- Inline Python audit against `theme-contract.json` and all CSS custom-property references — **exit 0**; 58 exact light token values, 58 exact dark token values (normalized for formatter-only casing/whitespace), 79 semantic mappings in each theme scope, and no custom-property cycles.
- Browser computed-style check — **blocked**. The prior T01 evidence records `browser-use` unavailable (exit 127), no CUA browser inventory, and `cua.getBrowser({id:"iab"})` unavailable. No runtime computed style is claimed.

## PRE / POST SHA-256

PRE hashes were captured before this repair and scoped formatter run. POST hashes were captured after all edits and checks.

| File | PRE | POST |
| --- | --- | --- |
| `app/src/styles/heroui-theme.css` | `d77c63c61820591280fb7b83eb7fa967099054d080ed5928a2cde11157950153` | `f7699c402b7a9eddb7d0789799a7e0519e58a9be19d4696b7cda0063ad3f0f20` |
| `app/src/styles.css` | `f32102564a7dc61180c38cd2e27c9d31bf0858ea04072d32f6199662868db8f3` | `f32102564a7dc61180c38cd2e27c9d31bf0858ea04072d32f6199662868db8f3` |
| `app/src/styles/legacy-ui-bridge.css` | `acd6410dde1354c5606956baadcae31aef93e2fe9533f6ed1a6df13dc74e4323` | `acd6410dde1354c5606956baadcae31aef93e2fe9533f6ed1a6df13dc74e4323` |
| `app/src/styles/tokens.css` | `840187b143e80f953bcb338b9a60944e858be36ddd0b9b6c5f6acb20c5fd8f71` | `a94817966e2235def6be4efd36171ca97d424dc41ec58b4229346fd542171afc` |

## Scope and remaining risk

Changed source files are limited to the four assigned CSS files. `docs/plans/reports/T01-R1-impl.md` is the required report. Actual browser-computed animation remains unverified until a browser runtime is available.
