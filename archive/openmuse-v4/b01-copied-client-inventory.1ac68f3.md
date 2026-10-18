# B01 — Copied-client difference inventory (OpenBot `apps/openmuse-mobile` vs canonical OpenMuse `apps/mobile`)

- Canonical baseline: OpenMuse v4-base worktree @ `1ac68f3` (`/Users/wuyongjun/trea/openmuse/.worktrees/v4-base/apps/mobile`)
- Copied baseline: OpenBot v4-base worktree @ `748f91ad` (`/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base/apps/openmuse-mobile`)
- File counts: copied = 71 (excl. .expo, android, ios, node_modules), canonical = 54, rows = 71 (identical 28, diverged 31, copied_only 12, canonical_only 0)
- Difference-hash rule (verbatim): File difference hash = sha256( ("identical"|"differs") + "\n" + unified_diff_text ), where unified_diff_text is the output of `diff -u -L canonical/<canonical_path> -L copied/<copied_path> <canonical file> <copied file>`. For copied-only/canonical-only rows the hash is sha256( ("copied-only"|"canonical-only") + "\n" + hex(sha256(file bytes)) ). Labels are fixed so hashes are machine-independent and reproducible.
- Path namespaces: `canonical_path` is relative to `apps/mobile`; rows whose path starts with `packages/` are relative to the OpenMuse monorepo root (vendored-domain mapping, plan Task 2 rule 5).
- Generated (UTC): 2026-10-12T14:30:18Z
- Regenerate: `python3 docs/openmuse-v4/b01-build-inventory.py && python3 docs/openmuse-v4/b01-build-inventory.py --verify`

## diverged (31)

| copied path | canonical path | status | difference hash (first 12) | kind | intent | target Ticket | resolved commit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| App.tsx | App.tsx | diverged | ddb7a7392151 | source | OpenBot session integration: OpenBotGate sign-in gate, SignOutButton, openbotBackend switch (src/openbot/*), plus zh-CN localization and vendored-domain path rewrite; auth/transport core belongs to I01 (I04/I05 for native specifics) | I01 | null |
| README.md | README.md | diverged | 781c3603b351 | doc | copied-tree bookkeeping: demo media/doc relative links rewritten to upstream pinned-commit absolute URLs, commands run from package dir (MIGRATION.md) | B04 | null |
| metro.config.js | metro.config.js | diverged | 0b540763c456 | config | watchFolders changed from source monorepo root to the package dir so Metro does not watch the whole OpenBot backend repo (MIGRATION.md); canonical config works as-is under the submodule (B02/B03), copy change dies with B04 | B04-cleanup | null |
| package.json | package.json | diverged | 06fe19cd5793 | config | adds better-auth, @better-auth/expo, expo-secure-store and other Expo deps required by the src/openbot/* session/transport layer (native specifics land with I04/I05) | I01 | null |
| src/BrowserConsole.web.tsx | src/BrowserConsole.web.tsx | diverged | 243b0bcd1809 | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/DateTimeEditor.tsx | src/DateTimeEditor.tsx | diverged | e921a31cab4e | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/agent-ui.tsx | src/agent-ui.tsx | diverged | 1d5b99c60670 | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/agent-workspace.tsx | src/agent-workspace.tsx | diverged | d35d17f8bac7 | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/background-updates.tsx | src/background-updates.tsx | diverged | 096754813cab | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/browser-address.ts | src/browser-address.ts | diverged | 4d1953ff24f6 | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/browser-tool-card.tsx | src/browser-tool-card.tsx | diverged | 63566d7556e9 | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/chat.tsx | src/chat.tsx | diverged | 3321e63ab070 | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/computer-status.ts | src/computer-status.ts | diverged | b0f25261bb02 | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/computer-workspace.tsx | src/computer-workspace.tsx | diverged | 96fde6761fbd | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/computer.tsx | src/computer.tsx | diverged | 8b131d1ea989 | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/date-time.ts | src/date-time.ts | diverged | d563dfdc7006 | source | vendored domain import path rewrite (../../../packages/domain/src -> ../packages/domain/src, per MIGRATION.md); unnecessary once the submodule build (B02/B03) uses the canonical tree, copy deleted at B04 | B04-cleanup | null |
| src/desktop-stream.tsx | src/desktop-stream.tsx | diverged | 4839e57a3853 | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/desktop-tool-card.tsx | src/desktop-tool-card.tsx | diverged | 76f79d2c008e | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/details.tsx | src/details.tsx | diverged | a36629dfd475 | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/jev-actions.ts | src/jev-actions.ts | diverged | 2c7a3eb8d07d | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/jev-tool-card.tsx | src/jev-tool-card.tsx | diverged | 75931ce34457 | source | vendored domain import path rewrite (../../../packages/domain/src -> ../packages/domain/src, per MIGRATION.md); unnecessary once the submodule build (B02/B03) uses the canonical tree, copy deleted at B04 | B04-cleanup | null |
| src/mail-tool-card.tsx | src/mail-tool-card.tsx | diverged | 278d30f135e6 | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/relative-date.ts | src/relative-date.ts | diverged | 669fa8ddb6db | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/screens.tsx | src/screens.tsx | diverged | 1335762ef0e6 | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/search-tool-card.tsx | src/search-tool-card.tsx | diverged | 3d96b746a88e | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/thread-artifacts.tsx | src/thread-artifacts.tsx | diverged | a213644e0191 | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/threads.tsx | src/threads.tsx | diverged | b1751fa17cd3 | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/ui.tsx | src/ui.tsx | diverged | e064cfc02e93 | source | zh-CN UI localization applied only in the copied tree (no catalog ticket owns i18n; see 'Unmapped rows' in the MD manifest) | null | null |
| src/workspace.tsx | src/workspace.tsx | diverged | b717ef4949c3 | source | vendored domain import path rewrite (../../../packages/domain/src -> ../packages/domain/src, per MIGRATION.md); unnecessary once the submodule build (B02/B03) uses the canonical tree, copy deleted at B04 | B04-cleanup | null |
| test/jev-actions.test.ts | test/jev-actions.test.ts | diverged | 8454b3e05f12 | test | vendored domain import path rewrite (../../../packages/domain/src -> ../packages/domain/src, per MIGRATION.md); unnecessary once the submodule build (B02/B03) uses the canonical tree, copy deleted at B04 | B04-cleanup | null |
| tsconfig.json | tsconfig.json | diverged | 19d98c37336f | config | paths['@openmuse/domain'] pointed at the in-package vendored copy (MIGRATION.md); canonical keeps its own mapping under the submodule, copy change dies with B04 | B04-cleanup | null |

## copied_only (12)

| copied path | canonical path | status | difference hash (first 12) | kind | intent | target Ticket | resolved commit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| .gitignore | null | copied_only | 46666623f657 | config | copied-tree bookkeeping: upstream ignore rules lived at the source repo root and had to be re-created for the standalone package (MIGRATION.md) | B04 | null |
| .npmrc | null | copied_only | 8357a757b6b6 | config | copied-tree bookkeeping: reproduces the source repo's pnpm peer-dependency behavior outside the workspace (MIGRATION.md) | B04 | null |
| MIGRATION.md | null | copied_only | cf7f37eaa0f1 | doc | copied-tree bookkeeping: migration record for the copy itself, removed with the subtree at B04 | B04 | null |
| bun.lock | null | copied_only | 6952b2ddea50 | lockfile | copied-tree bookkeeping: lockfile produced by the standalone Bun install on the OpenBot side (upstream uses pnpm-lock) | B04 | null |
| src/openbot/api.ts | null | copied_only | 169ed86cdbba | source | OpenBot REST facade: zod-checked /api/me, workspace, conversations, history, message send and activity endpoints; no canonical counterpart (searched apps/mobile then packages/) | I01 | null |
| src/openbot/auth.ts | null | copied_only | f869ff4f689b | source | Better Auth client with @better-auth/expo + SecureStore native session persistence and web cookie storage; native session restore is I04's acceptance (Android twin I05, web cookie I01) | I04 | null |
| src/openbot/client.ts | null | copied_only | e0c6e487285d | source | OpenBot HTTP transport: native Cookie header injection, 20s timeout/abort, 401->authentication_required and 403->refused error mapping, outcomeUnknown marking on 5xx/408 writes | I01 | null |
| src/openbot/config.ts | null | copied_only | 9ddbbdd1463d | source | EXPO_PUBLIC_OPENBOT_URL / EXPO_PUBLIC_BACKEND backend-selection switch with URL validation and loopback normalization | I01 | null |
| src/openbot/email-signin.tsx | null | copied_only | 2a78ef2d93cb | source | email/password sign-in and sign-up form plus SignOutButton on Better Auth | I01 | null |
| src/openbot/errors.ts | null | copied_only | d698fa16bf80 | source | OpenBot error model: nine error codes incl. authentication_required (401) that drives the back-to-sign-in behavior in I01's acceptance | I01 | null |
| src/openbot/gate.tsx | null | copied_only | 09bef9302d9f | source | OpenBotGate session gate: auth-gated rendering, OpenBotWorkspace -> Muse workspace adapter (empty mail/calendar/files as empty states), runtime Cookie headers | I01 | null |
| src/openbot/types.ts | null | copied_only | 84f754ecf9b0 | source | zod DTO schemas for OpenBot mobile endpoints (me/workspace/conversations/history/message) | I01 | null |

## canonical_only (0)

| copied path | canonical path | status | difference hash (first 12) | kind | intent | target Ticket | resolved commit |
| --- | --- | --- | --- | --- | --- | --- | --- |

## identical (28)

| copied path | canonical path | status | difference hash (first 12) | kind | intent | target Ticket | resolved commit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| app.json | app.json | identical | 1cc103f316d7 | config | in sync | null | null |
| assets/README.md | assets/README.md | identical | 1cc103f316d7 | asset | in sync | null | null |
| assets/capybara.png | assets/capybara.png | identical | 1cc103f316d7 | asset | in sync | null | null |
| index.js | index.js | identical | 1cc103f316d7 | source | in sync | null | null |
| packages/domain/src/agent.ts | packages/domain/src/agent.ts | identical | 1cc103f316d7 | source | in sync | null | null |
| packages/domain/src/computer.ts | packages/domain/src/computer.ts | identical | 1cc103f316d7 | source | in sync | null | null |
| packages/domain/src/date-time.ts | packages/domain/src/date-time.ts | identical | 1cc103f316d7 | source | in sync | null | null |
| packages/domain/src/index.ts | packages/domain/src/index.ts | identical | 1cc103f316d7 | source | in sync | null | null |
| packages/domain/src/jev.ts | packages/domain/src/jev.ts | identical | 1cc103f316d7 | source | in sync | null | null |
| src/BrowserConsole.native.tsx | src/BrowserConsole.native.tsx | identical | 1cc103f316d7 | source | in sync | null | null |
| src/DateFields.native.tsx | src/DateFields.native.tsx | identical | 1cc103f316d7 | source | in sync | null | null |
| src/DateFields.web.tsx | src/DateFields.web.tsx | identical | 1cc103f316d7 | source | in sync | null | null |
| src/PdfReader.native.tsx | src/PdfReader.native.tsx | identical | 1cc103f316d7 | source | in sync | null | null |
| src/PdfReader.web.tsx | src/PdfReader.web.tsx | identical | 1cc103f316d7 | source | in sync | null | null |
| src/api-response.ts | src/api-response.ts | identical | 1cc103f316d7 | source | in sync | null | null |
| src/api.ts | src/api.ts | identical | 1cc103f316d7 | source | in sync | null | null |
| src/assistant-markdown.ts | src/assistant-markdown.ts | identical | 1cc103f316d7 | source | in sync | null | null |
| src/assistant-response.tsx | src/assistant-response.tsx | identical | 1cc103f316d7 | source | in sync | null | null |
| src/computer-drafts.tsx | src/computer-drafts.tsx | identical | 1cc103f316d7 | source | in sync | null | null |
| src/conversation-queue.ts | src/conversation-queue.ts | identical | 1cc103f316d7 | source | in sync | null | null |
| src/conversation-run.ts | src/conversation-run.ts | identical | 1cc103f316d7 | source | in sync | null | null |
| test/api-response.test.ts | test/api-response.test.ts | identical | 1cc103f316d7 | test | in sync | null | null |
| test/assistant-markdown.test.ts | test/assistant-markdown.test.ts | identical | 1cc103f316d7 | test | in sync | null | null |
| test/browser-address.test.ts | test/browser-address.test.ts | identical | 1cc103f316d7 | test | in sync | null | null |
| test/computer-status.test.ts | test/computer-status.test.ts | identical | 1cc103f316d7 | test | in sync | null | null |
| test/conversation-queue.test.ts | test/conversation-queue.test.ts | identical | 1cc103f316d7 | test | in sync | null | null |
| test/date-time.test.ts | test/date-time.test.ts | identical | 1cc103f316d7 | test | in sync | null | null |
| test/relative-date.test.ts | test/relative-date.test.ts | identical | 1cc103f316d7 | test | in sync | null | null |

## Unmapped rows

The rows below carry `target_ticket: null`. The v4 ticket catalog has no i18n/localization
ticket, yet the copied tree contains a full zh-CN UI localization (all user-visible strings
translated to Chinese) that does not exist in the canonical English-only client:

- `src/agent-ui.tsx`
- `src/agent-workspace.tsx`
- `src/background-updates.tsx`
- `src/browser-address.ts`
- `src/browser-tool-card.tsx`
- `src/chat.tsx`
- `src/computer-status.ts`
- `src/computer-workspace.tsx`
- `src/computer.tsx`
- `src/desktop-stream.tsx`
- `src/desktop-tool-card.tsx`
- `src/details.tsx`
- `src/jev-actions.ts`
- `src/screens.tsx`
- `src/thread-artifacts.tsx`
- `src/threads.tsx`
- `src/ui.tsx`
- `src/BrowserConsole.web.tsx`
- `src/DateTimeEditor.tsx`
- `src/mail-tool-card.tsx`
- `src/relative-date.ts`
- `src/search-tool-card.tsx`

The zh-CN portion of `App.tsx` is annotated `I01` (its primary difference is the OpenBot session gate),
but the same localization question applies there.

Resolution options before B04 can pass (B04 requires every row to name a resolution):

1. Port the localization upstream / into the canonical client (needs a new catalog ticket or an
   amendment folding i18n into the screen tickets), or
2. Consciously abandon the Chinese UI: product decision recorded, rows resolve as `B04-cleanup`.

This manifest deliberately does NOT choose; leaving the rows null keeps the gap visible.

