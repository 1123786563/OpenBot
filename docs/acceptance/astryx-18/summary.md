# Issue #18 acceptance summary

Personal and Team served Astryx from their normal Vite production builds. Both builds used the branded fixture tenant and the default Web entry point. The build outputs had the same HTML digest. The server's `OPENBOT_EDITION` selected the edition at runtime.

- Chromium used isolated API processes and separate PostgreSQL 17.12 databases with pgvector. The rehearsal first ran against the archived #17 legacy bundle. The new assertion failed there because the Bots page opened the legacy shell. Switching the static artifacts kept the origins, databases, and browser storage in place.
- Each edition opened the same Astryx shell with all four saved account IDs: `openbot`, `openduet`, `opendots`, and `openmuse`. The preferences API returned the saved ID after navigation. Old browser skin values did not alter the shell. Settings exposed the theme control and no skin picker. Dark and light persisted, and both appearances used the Northstar QA tenant name, custom mark, and configured accent.
- The browser reran the #17 bookmarks, including Tasks, Routines, Memories, Activity, Ideas, Goals, Bot and Conversation links, Settings, and Connections with callback search state. It checked the Personal Memories fallback, the saved Bot on Activity, and the fallback for an unknown skin screen. On narrow screens, Enter opened navigation and Escape returned focus to the trigger.
- The existing Bot, Conversation, and component draft stayed readable. The legacy creation link opened the New Bot dialog, which submitted a new Bot through the real API in both editions. The browser opened the created Bot's profile and found it in the roster.
- In Team, the admin reached Admin and the component draft editor. The member's Admin bookmark redirected home. The Admin API returned 403, and the other user's private Bot returned 404. The Personal Admin audit bookmark opened Settings Activity.

Web typecheck, both production builds, and 258 focused Web tests passed. The Web tests include Bot creation, Settings and Connections, the Desktop return page, and Escape handling in the Bot's computer view. The browser used the lockfile's Playwright Chromium. [Browser checks and artifact digests](browser.json)

The broad Web run passed 3,132 tests and skipped 38. Its two Check-ins assertion failures passed on retest with the final Astryx assertions. The remaining file required `TEST_DATABASE_URL`. Both tests in that file passed against a dedicated migrated PostgreSQL database. The broad run predates those retests.

## Reproduce the browser checks

Follow the [#17 fixture setup](../../astryx-web-rollout.md#isolated-reproduction). Point the Web servers at the archived #17 legacy bundle and run the browser script with the `before` phase for each edition. This seeds the Bot, Conversation, and draft and saves browser storage. Build the new bundle twice into separate directories. Use the fixture tenant and brand variables from the #17 reproduction. Keep `VITE_OPENBOT_ASTRYX_PILOT` unset.

```sh
OPENBOT_EDITION=personal bun run --cwd app build --outDir /tmp/openbot-issue18/personal
OPENBOT_EDITION=team bun run --cwd app build --outDir /tmp/openbot-issue18/team
bun run --cwd app typecheck
```

Place the fixture mark in each output directory. Repoint each loopback Web server to its build and use the same browser storage directory as the `before` phase.

```sh
ISSUE17_DIR=/tmp/openbot-issue18 bun scripts/acceptance/astryx-rollout.mjs personal retired
ISSUE17_DIR=/tmp/openbot-issue18 bun scripts/acceptance/astryx-rollout.mjs team retired
```

The fixture uses Personal local sign-in and seeded Team sessions. It reuses each signed-in account while testing its four saved values. External SSO, live model turns, connected-app consent exchanges, and native binaries were outside this run. Unsent Conversation text still clears on full reload, as recorded in both #17 baselines.
