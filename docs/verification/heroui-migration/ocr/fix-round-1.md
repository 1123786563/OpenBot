# OCR fix round 1 — frontend_implementer report

Branch `feat/heroui-v3-migration`, BASE `203d0f02`, worktree `.worktrees/heroui-migration`.
Deliverable is uncommitted working-tree changes only; nothing committed/pushed/stashed.
Owned files touched: `app/src/styles.css`, `app/tests/theme-preference.test.ts`,
`h01/baseline/screenshots/capture-sign-in.cjs`, `h01/browser/cdp-harness/*.mjs` (10 scripts).
`app/src/lib/theme.ts` was NOT changed in the final tree (temporary RED mutation, exactly reverted;
`diff` against the pre-mutation copy returned identical, and its diff vs HEAD is the migration's own).

## Task 1 — Restore the global border baseline (OCR high)

Change: `app/src/styles.css:230-244` — restored the BASE form (`git show 203d0f02:app/src/styles.css`,
old `@layer base` block) as its own block, with a why-comment in the file's existing style:

```css
@layer base {
  * {
    @apply border-border outline-ring/60;
  }
}
```

- The rest of the old base block (`body`/`html`/scrollbar) had already been migrated to
  `@layer ob-app` by the migration; only the `*` border/outline baseline was deleted and unreplaced.
- Why `@layer base` and not `ob-app` (documented in the comment at styles.css:230-239): the layer
  statement (styles.css:15-22) puts `base` below `utilities` and HeroUI's `layer(components)`, so
  explicit `border-*`/`outline-*` utilities and HeroUI component styles keep winning; the same `*`
  selector in `ob-app` would sit above both and suppress explicit border colors app-wide — the exact
  failure mode the file's `font: inherit` note warns about. This mirrors BASE exactly, so bare
  `border` no longer falls back to currentColor across the ~112 affected files.
- Biome's `--write` pass also rewrapped the layer statement (styles.css:15-22) onto separate lines —
  pure formatting, same declaration order.
- Build evidence: `dist/assets/index-*.css` contains
  `*{border-color:var(--border);outline-color:var(--ring)}` plus lightningcss's
  `@supports (color:color-mix(...))` fallback to `color-mix(in oklab,var(--ring) 60%,transparent)`;
  a bracket-balance scan confirms both universal-selector occurrences are enclosed in `@layer base`.

## Task 2 — Cover the new theme path (OCR medium)

Change: `app/tests/theme-preference.test.ts` only; production `lib/theme.ts` already satisfies the
behavior and was left untouched.

- `theme-preference.test.ts:17-48` — the effects-injection test now records `setRootTheme` and runs
  both polarities: `applyDarkTheme(true, …)` → `themes === ["dark"]` synchronized with
  `toggleRootClass("dark", true)`; `applyDarkTheme(false, …)` → `["light"]` with
  `toggleRootClass("dark", false)` (storage/color-scheme effects re-asserted for both).
- `theme-preference.test.ts:71-79` — new boot test reads `app/index.html` and asserts the pre-paint
  script assigns `document.documentElement.dataset.theme = dark ? "dark" : "light"`, i.e.
  `data-theme` derives from the same boolean as the class toggle.
- RED→GREEN: with the new assertions in place, `lib/theme.ts` was temporarily mutated to
  `setRootTheme?.("light")`; the native run failed exactly on the new assertion
  (`expected ["light"] to equal ["dark"]`, exit 1). The file was then restored byte-identical
  (verified by `diff` against a pre-mutation copy) and the run went green (exit 0, 8/8). The
  index.html assertion could not be mutation-tested because `index.html` is outside my ownership;
  it asserts existing content.

## Task 3 — Evidence script portability (OCR mediums/lows)

- `capture-sign-in.cjs:1-15` — `require("playwright-core")` (resolves via the root workspace's
  declared `playwright-core@1.62.1`; the hardcoded absolute worktree require is gone), `OUT =
  __dirname`, and `executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? chromium.executablePath() ??
  "<previous hardcoded Chrome for Testing path>"` (kept as final fallback, so it still runs on this
  machine). No package.json touched.
- `cdp-harness/*.mjs` — every hardcoded Chrome `executablePath` now honors
  `process.env.CHROME_PATH` with the original `/Applications/Google Chrome.app/...` as default:
  8 files via the shared `CHROME` const (`ac-reach.mjs:9-11`, `combobox.mjs:9-11`,
  `combobox-dialog.mjs:9-11`, `matrix-nested.mjs:4-6`, `matrix.mjs:3-5`, `probe-c.mjs:3-5`,
  `probe-d.mjs:3-5`, `repro.mjs:3-5`) and 2 inline (`probe-btns.mjs:2`, `probe-q.mjs:2`). No logic,
  locators, URLs, or assertions changed.
- `node --check` passes on the .cjs and all 10 .mjs files (syntax only; the harnesses were not
  executed — they target the spike dev server and are one-off evidence tools).

### H14 interface-change request (dependency-declaration gap)

The cdp-harness scripts `import puppeteer from "puppeteer-core"`, but no package.json in the
workspace declares puppeteer-core (root declares only `playwright-core`). Per `cdp-harness/README.md`
the scripts are deliberately copied to an out-of-repo scratch dir (`/tmp/cdp-harness`, `bun add
puppeteer-core@23`) so the frozen lockfile is untouched — the dependency is real but undeclared, so
the scripts only run after a manual, undocumented setup step. Request: either declare
`puppeteer-core` as a devDependency (or give the harness its own manifest) and document it in the
README, so the evidence harness is reproducible without out-of-band knowledge. Note for the same
ticket: the harness README still says the Chrome path lives in the script constant; that remains
true as the default, but `CHROME_PATH` now overrides it per machine.

## Verification (commands run from the worktree root unless noted)

| # | Command | Exit |
|---|---------|------|
| 1 | `cd app && bun run typecheck` | 0 |
| 2 | `E2E_UNIT_OUTPUT=docs/verification/heroui-migration/ocr/fix-round-1-native bunx e2e run --config e2e.unit.config.ts app/tests/theme-preference.test.ts` | 0 (8/8 passed) |
| 2-RED | same, with `lib/theme.ts` temporarily mutated to `setRootTheme?.("light")` | 1 (`expected ["light"] to equal ["dark"]`) — mutation reverted |
| 3 | `cd app && bun run build` | 0 (built in 7.1s; baseline rule present in compiled CSS, inside `@layer base`) |
| 4 | `bunx biome check app/src/styles.css app/tests/theme-preference.test.ts` | 0 |
| 4b | `bunx biome lint --error-on-warnings` on all 13 changed files | 1 — 5 pre-existing findings, see below |
| — | `node --check` on capture-sign-in.cjs + 10 .mjs | pass |

Layer routing per ADR 0008: `theme-preference.test.ts` is in neither `docs/verification/e2e-bun-suites.json`
nor `e2e-known-broken.json`, so it runs on the native layer only; the driven layer is not involved.
`e2e.unit.config.ts`'s `E2E_UNIT_SCOPE` filters by suite directory only, but the runner's positional
path filter (same mechanism as the repo's own `test:agent-sandbox` script) targeted the single file,
so the app-wide scope run was unnecessary. Report artifacts: `docs/verification/heroui-migration/ocr/fix-round-1-native/`.

## Deferred / notes

- 5 pre-existing lint findings in one-off harness scripts, none on lines I edited, left per the
  minimal-diffs instruction: `ac-reach.mjs:42` (useTemplate), `ac-reach.mjs:48`
  (noUselessLoneBlockStatements), `combobox.mjs:29` (useTemplate), `combobox-dialog.mjs:26`
  (useTemplate), `probe-d.mjs:27` (noAssignInExpressions). These scripts were authored unformatted;
  `biome format` would rewrite them wholesale.
- `probe-btns.mjs:2` / `probe-q.mjs:2`: the single-line `puppeteer.launch(...)` statement exceeds
  the print width and stays that way — it already violated format before this round; wrapping it
  would rewrite the whole statement against the minimal-diffs instruction.
- First verification pass captured pipeline exit codes with bash's `PIPESTATUS` under zsh, which
  silently reports the `tail` status; every recorded exit code above was re-taken without a pipe.
- Concurrent-migration caveat: typecheck/build cover the whole shared working tree (another agent is
  migrating settings components in the same checkout), so a green run reflects the tree as of
  2026-10-20 ~12:57 local; it is not solely evidence about owned files.
