# Isolated browser acceptance (#149 / #156)

From the worktree root run `bun install --frozen-lockfile`, link `.env.test` to the primary checkout's private test file if absent, then run:

```sh
scripts/browser-acceptance/start.sh
```

App: http://localhost:41849/sign. API: http://127.0.0.1:41850.
Override both using `FIXTURE_APP_PORT` and `FIXTURE_API_PORT`. Vite receives explicit `APP_PORT` / `SERVER_PORT`; strictPort prevents silently choosing another app port. The mock API has no upstream or fetch calls. Unimplemented endpoints return 501 locally with their method/path, and all JSON replies identify themselves with `x-openbot-fixture: isolated`.

Open an incognito preview. Switch login state by navigating to:

- http://localhost:41850/__fixture/session?signedIn=true → `/settings`
- http://localhost:41850/__fixture/session?signedIn=false → `/sign`

State is process-local and shared by tabs using this fixture. Restart to reset edits. Do not run concurrent scenarios against the same fixture instance.

API schemas follow `app/src/lib/auth/queries.ts`, `shared/user-preferences.ts`, and the navigation/model/setup envelopes in `app/tests/starter-tour-route.test.tsx`: `{user}`, 401 when signed out, `{preferences}`, `{instructions}`, `{channels:[],nextCursor:null}`, and capability auth provider/SSO flags. Preferences and instructions support edits in memory. Social/SSO starts redirect to the fixture login switch; no identity provider is contacted.

The isolated Vite wrapper injects a minimal desktop IPC fixture before the real app mounts, using `DesktopAiConnection` and `DesktopUsageData` shapes from `app/src/lib/desktop/queries.ts`. It supplies a compatible endpoint, long model and address, and 3,840-character standing instructions. Unsupported desktop commands reject explicitly. This is a browser fixture, not native desktop acceptance.

Verified on b24a808cf: Vite proxy `/api/me` returns fixture-marked 401; T3 incognito preview renders the real sign-in screen with Google/Microsoft/Okta and company email, and real `/settings` renders Acceptance Tester, complete long instructions, AI model/endpoint, privacy and language controls. Full responsive/keyboard matrix remains for the parent task. Servers were left running for that task.
