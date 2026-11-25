# Issue #156 acceptance summary

The browser ran the real Web app from its normal Vite entry point against an isolated API process with no upstream. Every reply carried `x-openbot-fixture: isolated`. The paths were sign-in, General settings and its dialogs, the language selector, the app sidebar's destinations, conversation rows and account menu, the narrow navigation and settings sheets, and the missing-page screen. The run covered English and Simplified Chinese at 1280 and 360 widths in light and dark, with pointer and keyboard input. It recorded 1,074 checks and none failed: 124 in each 1280 cell and 143 in each 360 cell, plus six in the closing cases. [Checks, per-cell counts and captured text](browser.json)

- Sign-in showed the translated heading, the three provider buttons, the company email field with its required marker, the separator and the guidance. The company submit stayed disabled until an address was typed. Tab reached six controls in both languages.
- General settings showed both section links, the language and message-list selectors and the privacy switch. The standing-instructions row and the AI model row are two-line summaries, which is how main draws them. Each shows two lines of its text, a 3,960-character instruction or a long address, and cuts the rest. Its dialog holds the whole text. A page audit records those two cuts in its notes as designed summaries and passes. Any other cut fails it.
- The name dialog showed its title, close, Cancel and Save name controls. Escape closed it and returned focus to the row. The instructions dialog held the full text with the translated character count. A dirty draft raised the translated discard guard, and both Keep editing and Discard did what their labels say. Save wrote the text through the fixture API, showed the translated saved status, and closed without the guard. The row's summary then held the saved text, of which it shows two lines.
- The AI dialog showed its translated model and address labels, the whole model, and the long address wrapped.
- The language selector switched to English by keyboard and back by pointer. Focus stayed on the selector after both switches. The document language and title followed each time. Every audit repeated on the switched page.
- The sidebar destinations, the Credits destination and the account menu's sign-out and Settings items were translated. Escape closed the account menu and kept focus on its trigger.
- The sidebar drew six conversations from the fixture. At 1280 and in the 360 navigation sheet, each row said its time in the interface language: now, 4m, 3h and 2d in English; 刚刚, 4 分钟前, 3 小时前 and 2 天前 in Chinese. A conversation waiting on a Bot said Working and 处理中 where its time goes. One nobody has used showed no time and the translated New conversation. No time was cut off, and the page audit covered these rows like every other element.
- At 360, the home page opened its navigation sheet and the settings page opened its settings sheet, each with a translated title, description and links. Escape closed each sheet and returned focus to the trigger. The settings sheet's description is read by the accessibility tree although it is not visible.
- The missing-page screen showed its translated title, description and primary action, and the action left the screen. Every cell took the "open workspace" variant in this run. The "go back" variant ran only in the Web tests.
- Each page was audited for its document language, horizontal overflow, leaked message ids and `@astryx.*` keys, clipped text and unnamed controls, with the two designed summaries above as the only cuts allowed. Chromium's accessibility tree supplied the translated title and control names. No cell failed.

The run ended with two browser-language cases and one missing-key case. A first visit with a zh-CN browser language opened in Chinese, and zh-TW fell back to English. Removing one Chinese message showed the English source, kept the neighbouring copy Chinese, showed no message id, and the catalog was restored byte for byte.

The run above was made twice on commit `68a99f783`, once by the implementer and once by the orchestrator, with the same 1,074 checks passing both times. On that commit the branch also passed Web typecheck, the production build and the Astryx doctor on that build, formatting and lint across the repository, and 261 tests in the 29 test files it touches under `app/tests`. The catalogs hold 219 paired keys, and the extractor changes nothing.

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
- The conversation rows came from six fixture conversations with short names and titles, so the ellipsis that cuts a long one by design did not run. The roster's empty state, search, pagination and context menu were not exercised in the browser. The empty state and "Load older conversations" have Web tests only.
- Row times were checked at four ages that each sit inside their unit: now, minutes, hours and days. The moment one unit turns into the next was not exercised in either language.
- The language switch was driven on a settled page. Switching while an editor holds an unsent draft did not run in the browser, because a dialog hides the selector behind it. That path has a Web test only.
- The 360 settings-sheet screenshot is taken as the sheet arrives, so it shows the sheet translucent. The navigation sheet was allowed to arrive before its rows were measured and photographed.

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
