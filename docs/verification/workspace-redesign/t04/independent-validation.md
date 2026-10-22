# T04 Independent Frontend Validation

**Status: DONE_WITH_CONCERNS**  
**Revision:** `203d0f0244b2f898218fa12027089c631e8448d9` (`feat/heroui-v3-migration`, dirty worktree)  
**Validated delta:** `docs/verification/workspace-redesign/execution/checkpoints/t04/delta.patch`, SHA-256 `fb6dfa2e0a51c120610e3ad97eaf8a345806fc522cc33e1752d78370c0b6503f`.

## Integrity and commands

- `sha256sum docs/verification/workspace-redesign/execution/checkpoints/t04/delta.patch` — exit 0; matched the brief SHA.
- `node -e 'const fs=require("fs"),crypto=require("crypto"); const m=JSON.parse(fs.readFileSync("docs/verification/workspace-redesign/execution/checkpoints/t04/POST/source-manifest.json")); let bad=[]; for(const f of m.files){let b; try{b=fs.readFileSync(f.path)}catch{bad.push([f.path,"MISSING"]);continue} const h=crypto.createHash("sha256").update(b).digest("hex"); if(h!==f.sha256)bad.push([f.path,h,f.sha256]);} console.log(JSON.stringify({paths:m.paths,mismatches:bad.length,details:bad},null,2));'` — exit 0; all 22 POST paths matched (0 mismatches).
- `E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t04/native-validation bunx e2e run --config e2e.unit.config.ts app/tests/bot-manage.test.tsx app/tests/bot-needs-you.test.tsx app/tests/bot-profile-active.test.tsx app/tests/bot-profile-notice.test.tsx app/tests/bot-roster-groups.test.ts app/tests/bot-roster.test.tsx app/tests/bot-settings-rows.test.tsx` — exit 0; e2e 0.20.0 collected 7,976, selected/executed 12, passed 12, failed 0, skipped 0. Those 12 tests came from the two native files (`bot-manage`: 7; `bot-roster-groups`: 5). The other five requested files are excluded from native execution by the partition.
- `E2E_BUN_ONLY='app/tests part 1' E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t04/driven-validation bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — exit 0; e2e collected 7,942, selected/executed 1 wrapper, passed 1, failed 0, skipped 0. The Bun driver reported four sibling files that fail only when sharing a process (`account-mode-dialog`, `approvals-rules`, `bot-approval-rules`, `bot-memory`) and individually reran them; these are isolated sibling reruns, not T04 target files. The driver partition passed after those reruns. Per ADR0008, Bun files are aggregated to one e2e wrapper assertion, so this report does not claim individual case counts for the five driven T04 files.

Run artifacts are in `docs/verification/workspace-redesign/t04/{native-validation,driven-validation}/`.

## Acceptance inspection

Source and test inspection against P06/P07 and the T04 brief confirms the requested contracts:

- P06 `BotRoster` preserves `needsYou`, `pinned`, `yours`, `shared`, then `hidden` rendering; empty states remain explicit; hidden items render only after activating the keyboard-operable Show button. `bot-roster.test.tsx` covers order/uniqueness, navigation, folded hidden rows, no-hidden, initial error and refetch failure behavior.
- Rows use `min-h-16` (64px minimum), two-line wrapping/clamping for name and summary, and `ItemActions min-h-11 shrink-0` (44px minimum non-shrinking action area).
- P07 identity uses a 32px avatar and renders name, role, and description. Existing profile sections/actions retain their order and `PageSection` structure; management and dangerous delete are distinct sections.
- Delete remains absent without `canManage`; `bot-manage.test.tsx` asserts this and checks the distinct section. Implementation retains the prior delete dialog/mutation source path.

No source or test files were changed. Browser acceptance was not run: P06/P07 require real URL, identity/fixture, screenshots and traces, narrow widths (390/768/1280/1440), 200% zoom, computed styles, focus and overflow evidence. Therefore responsive rendering, browser accessibility/focus behavior, and full long-content fixtures remain acceptance gaps pending the planned browser pass. The native run also emitted HeroUI `PressResponder` warnings in `bot-manage`; assertions passed, but runtime semantics of those press responders were not browser-verified.
