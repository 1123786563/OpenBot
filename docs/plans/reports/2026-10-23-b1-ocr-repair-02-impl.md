# B1 OCR Repair 02 implementation report

**Task:** R2 — preserve a URL-deep-linked hidden Bot when adding a visible Bot.
**BASE:** `f55d12f899883fc4a5d7bf0e8067bb500b86ee38`
**Commit policy:** no commit; implementation checkpoint remains uncommitted.

## Changes

- `app/src/routes/_authed/_app/channel/new.tsx`: selection IDs now resolve against the union of currently selected profiles and the visible roster. This keeps an already-selected, permission-valid deep-linked profile in the original selection order while allowing newly selected roster entries. The roster itself remains permission-filtered.
- `app/tests/channel-new-recipients.test.tsx`: behavioral regression renders `/channel/new?agent=hidden-bot`, selects a visible Bot, then checks the resulting selected label order and that the URL still names `hidden-bot`.

## Validation evidence

- RED: `bun test ./app/tests/channel-new-recipients.test.tsx` — regression failed before the fix because route search changed to `visible-bot`; seven setup-state tests passed.
- GREEN: `bun test ./app/tests/channel-new-recipients.test.tsx` — 8 passed, 0 failed.
- `bunx e2e run --config e2e.unit.config.ts app/tests/channel-new-recipients.test.tsx` — collection failed before executing tests (`bun:` protocol unsupported by Node ESM loader). Per ADR 0008, used the native Bun suite command above.
- `bunx biome check --write app/src/routes/_authed/_app/channel/new.tsx app/tests/channel-new-recipients.test.tsx` — formatted owned files.
- `bunx biome check app/src/routes/_authed/_app/channel/new.tsx app/tests/channel-new-recipients.test.tsx` — passed; no fixes needed.
- `bun run --cwd app typecheck` — passed (`tsc --noEmit`; its pretypecheck generated app config).
- `git diff --check` — passed.

No route/API changes or permission changes were made. No full app build, real data, message send, or commit was performed.
