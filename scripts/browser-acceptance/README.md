# Isolated browser acceptance (#149 / #156)

From the worktree root run `bun install --frozen-lockfile`, link `.env.test` to the primary checkout's private test file if absent, then run `scripts/browser-acceptance/start.sh`. In a second shell run `bun scripts/browser-acceptance/matrix.mjs`.

`matrix.mjs` drives the real Chromium that CI's real-browser job uses (playwright-core is a root devDependency) through the batch's paths: sign-in → General settings and its dialogs → language switching → the app sidebar's destinations and account menu → the narrow navigation sheet → the missing-page screen, in English and Simplified Chinese × 1280 and 360 widths × light and dark, with pointer and keyboard input. Every page is audited for the document language, horizontal overflow, leaked message ids and `@astryx.*` keys, clipped text, and unnamed controls; Chromium's accessibility tree is read through CDP for the translated title and control names. The run ends with the browser-language cases (a zh-CN first visit, zh-TW falling back to English) and the missing-key fallback demo, which removes one Chinese message, checks the English source renders, and restores the catalog byte for byte.

Evidence lands in `EVIDENCE_DIR` (default `docs/acceptance/i18n-156/run`) as `run.json` plus `screenshots/`; the script exits 1 when any check fails. `CELLS=en-1280-light,zh-CN-360-dark` runs a subset. Each cell gets its own Chromium and one retry, because a crash under load should cost one cell, not the matrix.

App: http://localhost:41849/sign. API: http://127.0.0.1:41850.
Override both using `FIXTURE_APP_PORT` and `FIXTURE_API_PORT`. Vite receives explicit `APP_PORT` / `SERVER_PORT`; strictPort prevents silently choosing another app port. The mock API has no upstream or fetch calls. Unimplemented endpoints return 501 locally with their method/path, and all JSON replies identify themselves with `x-openbot-fixture: isolated`.

For a hand-driven session, open an incognito preview at the app and switch login state by navigating to:

- http://localhost:41850/__fixture/session?signedIn=true → `/settings`
- http://localhost:41850/__fixture/session?signedIn=false → `/sign`

State is process-local and shared by tabs using this fixture. Restart to reset edits. Do not run concurrent scenarios against the same fixture instance.

API schemas follow `app/src/lib/auth/queries.ts`, `shared/user-preferences.ts`, and the navigation/model/setup envelopes in `app/tests/starter-tour-route.test.tsx`: `{user}`, 401 when signed out, `{preferences}`, `{instructions}`, `{channels:[],nextCursor:null}`, and capability auth provider/SSO flags. Preferences and instructions support edits in memory. Social/SSO starts redirect to the fixture login switch; no identity provider is contacted.

The isolated Vite wrapper injects a minimal desktop IPC fixture before the real app mounts, using `DesktopAiConnection` and `DesktopUsageData` shapes from `app/src/lib/desktop/queries.ts`. It supplies a compatible endpoint, long model and address, and 3,840-character standing instructions. Unsupported desktop commands reject explicitly. This is a browser fixture, not native desktop acceptance.
