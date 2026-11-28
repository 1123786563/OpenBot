# Isolated browser acceptance (#149 / #156)

From the worktree root run `bun install --frozen-lockfile`, link `.env.test` to the primary checkout's private test file if absent, then run `scripts/browser-acceptance/start.sh`. In a second shell run `bun scripts/browser-acceptance/matrix.mjs`.

`matrix.mjs` drives the real Chromium that CI's real-browser job uses (playwright-core is a root devDependency) through the batch's paths: sign-in → General settings and its dialogs → language switching → the app sidebar's destinations, conversation rows and account menu → the narrow navigation sheet → the missing-page screen, in English and Simplified Chinese × 1280 and 360 widths × light and dark, with pointer and keyboard input. Every page is audited for the document language, horizontal overflow, leaked message ids and `@astryx.*` keys, clipped text, and unnamed controls; Chromium's accessibility tree is read through CDP for the translated title and control names. One clamp is the design and not clipped text: the two-line summary on the General settings rows for standing instructions and AI connection, whose dialogs hold the whole text. The audit records it in the cell's notes as `designedSummaries` and fails on any other cut. The run ends with the browser-language cases (a zh-CN first visit, zh-TW falling back to English) and the missing-key fallback demo, which removes one Chinese message, checks the English source renders, and restores the catalog byte for byte.

Evidence lands in `EVIDENCE_DIR` (default `docs/acceptance/i18n-156/run`) as `run.json` plus `screenshots/`; the script exits 1 when any check fails. `CELLS=en-1280-light,zh-CN-360-dark` runs a subset. Each cell gets its own Chromium and one retry, because a crash under load should cost one cell, not the matrix.

App: http://localhost:41849/sign. API: http://127.0.0.1:41850.
Override both using `FIXTURE_APP_PORT` and `FIXTURE_API_PORT`. Vite receives explicit `APP_PORT` / `SERVER_PORT`; strictPort prevents silently choosing another app port. The mock API has no upstream or fetch calls. Unimplemented endpoints return 501 locally with their method/path, and all JSON replies identify themselves with `x-openbot-fixture: isolated`.

For a hand-driven session, open an incognito preview at the app and switch login state by navigating to:

- http://localhost:41850/__fixture/session?signedIn=true → `/settings`
- http://localhost:41850/__fixture/session?signedIn=false → `/sign`

State is process-local and shared by tabs using this fixture. Restart to reset edits. Do not run concurrent scenarios against the same fixture instance.

API schemas follow `app/src/lib/auth/queries.ts`, `shared/user-preferences.ts`, and the navigation/model/setup envelopes in `app/tests/starter-tour-route.test.tsx`: `{user}`, 401 when signed out, `{preferences}`, `{instructions}`, `{channels,nextCursor:null}`, and capability auth provider/SSO flags. The roster is the six `ChannelSummary` conversations in `conversations.mjs`, aged from each request so their short relative times stay put, with one waiting on a Bot and one nobody has used; the runner expects the same rows. Preferences and instructions support edits in memory. Social/SSO starts redirect to the fixture login switch; no identity provider is contacted.

The isolated Vite wrapper injects a minimal desktop IPC fixture before the real app mounts, using `DesktopAiConnection` and `DesktopUsageData` shapes from `app/src/lib/desktop/queries.ts`. It supplies a compatible endpoint, long model and address, and 3,960-character standing instructions. Unsupported desktop commands reject explicitly. This is a browser fixture, not native desktop acceptance.

## First-message attachment handoff

Set `BUILD_DIR` to a production build that includes the attachment handoff, `BUILD_MANIFEST` to its JSON manifest containing `commit` and `indexSha256`, and `EVIDENCE_DIR` to an absolute output directory. Run `scripts/browser-acceptance/first-batch.sh --first-attachment` from the worktree root. The script uses an isolated fixture to exercise an interrupted read, then checks the multipart upload in the new conversation and the unchanged reference in the original draft. It writes four screenshots and `run.json`.

## Group turn stop

Use a production build that includes group turn Stop, its `BUILD_MANIFEST`, and an absolute `EVIDENCE_DIR`. Run `scripts/browser-acceptance/first-batch.sh --group-stop` from the worktree root. The fixture returns a 503 on the first Stop request. Chromium reaches Stop with Tab, activates it with Enter, retries in place, and checks that the stopped state appears without another message being sent. The script writes four screenshots and `run.json` with the build and request counts.

## Route module recovery

Set `BUILD_DIR`, `BUILD_MANIFEST`, and `EVIDENCE_DIR` as above. Run `bun --no-env-file scripts/browser-acceptance/route-recovery.mjs` from the worktree root with Playwright Chromium and WebKit installed. The script serves the archived build and a fixture API on loopback. It returns an HTTP 503 for the Settings route module, retries while the module is unavailable and checks for the fixed asset support code, then restores it and checks that a keyboard retry preserves the original URL and moves focus to the recovered page's heading. The two browsers' module response codes and screenshots are archived with the build identity.
