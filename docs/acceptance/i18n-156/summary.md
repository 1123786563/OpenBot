# Issue #156 acceptance summary

The browser ran the real Web app from its normal Vite entry point against an isolated API process with no upstream. Every reply carried `x-openbot-fixture: isolated`. The paths were sign-in, General settings and its dialogs, the language selector, the sidebar destinations and the account menu, the narrow navigation and settings sheets, and the missing-page screen. The run covered English and Simplified Chinese at 1280 and 360 widths in light and dark, with pointer and keyboard input. [Checks, per-cell counts and captured text](browser.json)

- Sign-in showed the translated heading, the three provider buttons, the company email field with its required marker, the separator and the guidance. The company submit stayed disabled until an address was typed. Tab reached six controls in both languages.
- General settings showed both section links, the language and message-list selectors and the privacy switch. The standing-instructions row and the AI model row showed a 3,960-character text and a long address in full, with no clipped text. Both rows wrap rather than truncate.
- The name dialog showed its title, close, Cancel and Save name controls. Escape closed it and returned focus to the row. The instructions dialog held the full text with the translated character count. A dirty draft raised the translated discard guard, and both Keep editing and Discard did what their labels say. Save wrote the text through the fixture API, showed the translated saved status, and closed without the guard. The saved text then reached the row.
- The AI dialog showed its translated model and address labels, and the long address wrapped.
- The language selector switched to English by keyboard and back by pointer. Focus stayed on the selector after both switches. The document language and title followed each time. Every audit repeated on the switched page.
- The sidebar destinations, the Credits destination and the account menu's sign-out and Settings items were translated. Escape closed the account menu and kept focus on its trigger.
- At 360, the home page opened its navigation sheet and the settings page opened its settings sheet, each with a translated title, description and links. Escape closed each sheet and returned focus to the trigger. The settings sheet's description is read by the accessibility tree although it is not visible.
- The missing-page screen showed its translated title, description and primary action, and the action left the screen. Every cell took the "open workspace" variant in this run. The "go back" variant ran only in the Web tests.
- Each page was audited for its document language, horizontal overflow, leaked message ids and `@astryx.*` keys, clipped text and unnamed controls. Chromium's accessibility tree supplied the translated title and control names. No cell failed.

The run ended with two browser-language cases and one missing-key case. A first visit with a zh-CN browser language opened in Chinese, and zh-TW fell back to English. Removing one Chinese message showed the English source, kept the neighbouring copy Chinese, showed no message id, and the catalog was restored byte for byte.

The branch also passed Web typecheck, the production build, the Astryx doctor, formatting and lint, and 260 tests in the 28 files it touched. The catalogs hold 220 paired keys, and the extractor changes nothing.

## Limits of this run

- Sign-in used a fixture session switch. No identity provider was contacted and no credential was entered.
- The run used Chromium only, at the lockfile's Playwright version. No WebKit or Firefox pass exists.
- The long AI model and address came from an injected desktop IPC fixture. This is not native desktop acceptance.
- The name dialog was not saved. Its labels, Escape and focus return were checked. The instructions dialog was saved.
- Sign-out was checked as a translated menu item, not as a completed sign-out.
- Preferences were switched by the language and message-list selectors only as far as their labels and focus. No preference save was audited.
- No save-failure or load-failure path ran in the browser. Those paths have Web tests only.
- The run took the "open workspace" variant of the missing-page action. The "go back" variant has Web tests only.
- The sheets were checked for names, description, links, Escape and focus. No sheet link was followed.

## Reproduce the browser checks

From a worktree at the recorded base, run `bun install --frozen-lockfile` and link `.env.test` to the primary checkout's copy. Then:

```sh
bun run --cwd app typecheck
bun run format:check
bun run lint
sh scripts/browser-acceptance/start.sh
bun scripts/browser-acceptance/matrix.mjs
```

The runner writes `run/run.json` and `run/screenshots/` beside this file and exits 1 when any check fails. `run/` is gitignored, so rerunning rewrites it. `CELLS=en-1280-light,zh-CN-360-dark` runs a subset. The fixture keeps its state in process memory, so one run writes the same evidence as this one only from a fresh fixture. [Fixture setup](../../../scripts/browser-acceptance/README.md)
