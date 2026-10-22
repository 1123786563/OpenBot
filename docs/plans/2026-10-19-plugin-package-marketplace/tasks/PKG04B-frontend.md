# Task Brief — PKG04 Slice B (#463): expert creation wizard UI (创建向导)

## Context

Same worktree `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`, uncommitted; binding checkpoint cp15 (`121167c0…47ef0`). No commit/push. Slice A (backend, reviewed PASS/fix accepted) delivered `POST` admin route for expert instantiation from an installed package's `expertTemplate` resource — read `tasks/PKG04A-report.md` and `server/src/enterprise/plugin-packages/experts.ts` + `routes.ts` (the exact path, request body schema, response shape, and error codes are the contract; `server/tests/package-expert-routes.test.ts` is the behavioral spec). UI patterns to mirror: `app/src/components/market/package-detail.tsx` (detail page + grants section from slice C of PKG03), `app/src/lib/plugin-packages/mutations.ts` (mutation + scope-key invalidation + `serverMessage` pattern), `app/tests/plugin-package-grants.test.tsx` (harness test style incl. `/api/me` stub and workspace-scope stubs).

## Goal (slice B, frontend)

In the admin package detail, each `expertTemplate` resource of the current revision renders a "从此模板创建专家" flow: a dialog showing the template's name/summary/systemPrompt (prefilled, editable within the accepted field set) and the package skill refs it will grant (read-only list); submit calls the slice-A route with the `idempotency-key` header (generated once per dialog open, reused on retry); on success the dialog shows the created agentId and a link/hint to open the Bot. Server copy rules apply: 创建者和归属由服务器确定 — no owner/scope fields in the UI; no connector/account/publish affordances anywhere in the flow.

## Deliverables (priority order; tree compiling + green each step)

1. **Mutation** in `app/src/lib/plugin-packages/mutations.ts` (or sibling): `useInstantiateExpert` — per-call scope headers, idempotency-key header, body exactly per the slice-A route schema; on success invalidate the install-detail key (same key family as slice C).
2. **Wizard UI** in `app/src/components/market/package-detail.tsx` (or a sibling component file): per-template create affordance rendered only under the same gate as the grants section (canInstall && install not uninstalled); dialog with editable name/summary/systemPrompt (length limits mirroring the shared schema), read-only skill-ref list, disabled submit while pending; server errors via the `serverMessage` pattern (409 IDEMPOTENCY_CONFLICT and 400 TEMPLATE_FIELD_REJECTED surfaced verbatim); success state shows agentId (copyable text) + 「打开 Bot」link if the app has a Bot detail route for agentId (check; if none exists show the id with a hint instead — do not invent navigation).
3. **i18n**: `packages.experts.*` keys in BOTH `en` and `zh-CN` locale files; copy must not imply package skills beyond the granted refs or any execution capability ("仅安装不会授予任何能力" tone).
4. **Tests** (extend `app/tests/plugin-package-grants.test.tsx` or sibling harness file): wizard renders per template and not for non-admin; submit calls the route with scope headers + idempotency-key + exact body; server 400/409 surface via serverMessage; success shows agentId; scope-switch mid-flight does not pollute (query-key assertion style from slice C).

## Constraints

- App-only: ZERO server changes. If the route contract mismatches what the UI needs, STOP and report.
- No new npm deps; app typecheck exit 0; Biome clean on touched files.
- Official evidence: `bunx e2e run --config e2e.unit.config.ts <touched app test files>` fresh dir `.e2e/pkg04b/`.

## Report

Files, route contract as consumed, test counts (pass/fail), evidence dir, typecheck/biome, deviations. ≤400 words. No commit.
