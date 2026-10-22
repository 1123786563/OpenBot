# OCR round 1 — numbered fix plan (session c307d033, 43 files / 57 comments, recovered from session store)

Triage rule: findings against `checkpoints/*/base-files` or untouched billing/config/market-legacy code are pre-existing, parked (listed at bottom). Findings against current delivery files below enter the loop.

## Fix list (blocking)

- **F1 [bug·high] schema barrel without drizzle.config registration** (`server/drizzle.config.ts`): add `./src/db/schema/enterprise-plugin-packages.ts` to the explicit schema list per the repo's own convention comment, so a future `db:generate` cannot treat the package tables as absent and emit destructive DDL. Do NOT run `db:generate` (snapshot chain stale ≤0160; migration generation is PKG11/12 scope). Add a guard test asserting every `export * from "./..."` in `server/src/db/schema/index.ts` appears in the drizzle config schema list.
- **F2 [security·medium] client header merge not case-normalized** (`app/src/lib/client.ts:198-200`): lowercase caller-supplied header names before merging so content-type/scope headers cannot be duplicated/ambiguous. Tests in `app/tests/enterprise-client.test.ts` style.
- **F3 [bug·medium] use-package-scope folds revoked/pending into canInstall=false** (`app/src/lib/plugin-packages/use-package-scope.ts:36-47`): when the listing succeeded and the stored tenant is absent, treat scope as revoked (null); expose `listingPending`/`listingError`. Add a packages-page test: stored selection pointing at a team absent from the listing produces the select-team state and no catalogue request.
- **F4 [bug·medium] install dialog config mirrors half the contract** (`app/src/components/market/package-install-dialog.tsx:140-143`): enforce ≤32 keys, key length ≤64, string value ≤512 (constants from shared contract if exported; else literal + comment) and surface `serverMessage` in plan/apply generic-error branches. Tests in `plugin-package-install.test.tsx`.
- **F5 [maintainability·medium] package POST entrances lack fail-closed classification guard** (`server/src/enterprise/plugin-packages/routes.ts`): call `assertClassifiedCompanyEntrance("POST", "/api/enterprise/plugin-packages/plans")` and `…/plans/:id/apply` in the handlers (mirror `workspace-scope-routes.ts` requireClassifiedCompanyEntrance), so mount/rule drift fails closed with MANAGEMENT_ENTRANCE_UNCLASSIFIED.

## Parked (pre-existing, outside this delivery's scope — recorded, not fixed)

- admin-separation.ts base: audit-write reliance on caller, platform-actor kind-only check, rule-table shape validation, grantId uniqueness, doc comment drift, COMPANY_ADMIN_CONTEXT_REQUIRED overloading, subject-without-actorKind binding, lowercase-method registration asymmetry (our registered rules use uppercase "POST", so our paths are unaffected).
- config.ts (billing/Lago/webhook) findings — untouched by this delivery.
- market.tsx pre-existing: broker/plugins/agents query errors unread; nested ternary render.
- wb.tsx aria-label pending wording; locales `wb.segment*` duplication; artifact.ts late limit checks (performance·low); contracts secret-blacklist completeness (security·low; DB CHECK also nested-value incomplete — covered by F-lows already fixed in round M-fix? recorded); dead `PACKAGE_KEY_PATTERN`-derived branch; idempotency validation duplication; OperatorTransaction type duplication; request-body length in code units (low); export function MarketPage export rationale.

## Verification after fixes

- `bunx e2e run … app/tests/enterprise-client.test.ts app/tests/packages-page.test.tsx app/tests/plugin-package-install.test.tsx app/tests/plugin-package-catalogue.test.tsx` (fresh dir `.e2e/ocr-fix1`)
- `bun run --filter app typecheck`; `bun run --filter server typecheck` (pre-existing baseline only); Biome on touched files
- server native package suites re-run (`.e2e/ocr-fix1-native`) for F5 route changes
- Then OCR round 2 (workspace, `--audience agent`), recovered via session store if the CLI aborts again.
