# PKG04 Slice B (#463 frontend) — Implementation Report

Status: DONE (app-only; zero server files touched; nothing committed).

## Files changed

- `app/src/lib/plugin-packages/mutations.ts` — `useInstantiateExpert(queryClient)`: POST with per-call scope headers + `idempotency-key`, body exactly `PackageExpertCreateInputSchema`, success invalidates exactly `pluginPackageKeys.installDetail(scope, installId)` (slice C key family).
- `app/src/components/market/package-experts.tsx` (new) — `PackageExpertsSection` + `ExpertWizardDialog` (structure mirrors `package-grants.tsx`: section states, `serverMessageOf`/`statusOf`, Wb primitives, Dialog).
- `app/src/components/market/package-detail.tsx` — section rendered under the grants gate (`canInstall && install && status !== "uninstalled"`).
- `app/src/locales/{en,zh-CN}/market.json` — `packages.experts.*` in BOTH; copy keeps the 仅安装不会授予任何能力 tone, no execution-capability or connector implications.
- `app/tests/plugin-package-experts.test.tsx` (new) — native harness, grants-test style.

## Route contract as consumed

`POST /api/enterprise/plugin-packages/installs/:installId/experts/:resourceId`, header `idempotency-key` (1–128 ASCII), body `{ installId, resourceId, expectedRevision, name }` — nothing else (strict schema; summary/systemPrompt never travel, scope/actor headers only). 201 first, 200 replay with the SAME agentId; 400/409 refusals surface `serverMessage` verbatim, 403/503 localized. Rulings applied: editable fields exactly name/summary/systemPrompt with `PACKAGE_EXPERT_TEMPLATE_LIMITS` maxLengths; skill refs a read-only list (install-detail skill resources; no checkboxes); no owner/scope anywhere; key generated once per dialog open (`useState` initializer), reused on retry; success shows agentId as copyable text (`WbIdRow`) + 「Open Bot」 to `/bots/$agentId` (route exists: `AuthedAppBotsAgentIdIndexRoute`); no expertTemplate resources → section renders `null` (no shell).

## Tests & evidence

New 7/7: exact body + scope headers + key length; member sees nothing (and no detail read); no-template revision renders nothing; 400 `TEMPLATE_FIELD_REJECTED` and 409 `IDEMPOTENCY_CONFLICT` sentences verbatim; key stable across retries, new key on reopen; disabled submit (empty name / pending); scope-key value assertions + mid-flight switch leaves team B's cache empty.
Combined package suites **49/49** (experts 7 + grants 6 + install 17 + catalogue 15 + packages-page 4). Evidence: `E2E_UNIT_OUTPUT=.e2e/pkg04b/final bunx e2e run --config e2e.unit.config.ts <5 files>` — report.json `status: passed, exitCode: 0`.

## Verification

- `cd app && bun run typecheck` → exit 0.
- `bunx biome check` on the 6 touched files → clean.

## Deviations / notes for review

1. The slice-A wire contract transports only `name` (profile written from the verified template server-side), so the editable summary/systemPrompt are local drafts; the dialog states this (`profileNote`) — implemented exactly as ruled, flagged for reviewer awareness.
2. No template-content read endpoint exists, so prefill comes from the package identity (displayName/summary), not the template file.
3. "Open Bot" draws through the system Button `render` prop, so Base UI exposes it as a button-role anchor with `href=/bots/$agentId` (app idiom, `button.tsx`).
4. Browser acceptance of the wizard remains a controller step, per plan.

## Fix round 1 (review)

- [blocking·dead-UI] summary/systemPrompt were editable textareas but the strict name-only wire schema never receives them; edits were silently discarded. Both fields are now `disabled`+`readOnly` displays of the server-pinned profile (summary shows the package summary; system prompt stays empty — no template-content read endpoint). `profileNote` reworded to "read-only, written on the server from the verified template"; placeholder keys removed (both locales).
- [low·copy] `successHint` no longer references "skills listed above".
- [low·test] fetch stub now records expert-path hits; the `expertSeen` assertion is live.
- [low·duplication] helper trio shared with grants/install-dialog left as-is — dedup would touch two reviewed files, not mechanical here.

Verified: typecheck exit 0; biome clean (4 touched files); `.e2e/pkg04b-fix` report 49/49 passed, exit 0; read-only state asserted in the exact-body test.
