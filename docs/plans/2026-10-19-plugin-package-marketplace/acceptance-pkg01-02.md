# PKG01 / PKG02 acceptance mapping — checkpoint cp02-member-route

Checkpoint: `checkpoints/cp02-member-route/manifest.json`, SHA `09f6bd63adb1f0896756c2383a3cae4af26a8027df4ceac2f579dcc3f9229978`, HEAD `9057aeeb`, all work uncommitted.
Status: **partial — not verified**. Browser/real-stack acceptance and OCR round 1 outstanding (see ledger). Every claim below binds to the checkpoint; prior review rounds ran against earlier checkpoints and are labeled.

## PKG01 (#460) — browse verified trusted package catalogue

| Acceptance | Evidence (file:line / report) | Status |
| --- | --- | --- |
| schemaVersion=1, platformApi=1, limits/paths/digest per spec | `server/tests/package-artifact.test.ts` (31 tests, `.e2e/cp02-native`); `shared/enterprise/plugin-package-contracts.ts:14-27` | tested |
| order-independent digest; same version+different digest refused | artifact tests (order test, registration refusal in `server/src/plugin-packages/catalogue.ts:224-236` + catalogue tests) | tested |
| reject absolute/`..`/symlink/case-fold/limits/unknown fields/deps; no fake installable | artifact tests incl. walked-path predicate (`artifact.ts:108-118,178-186`); `installable = blockers.length===0` (`catalogue.ts:205-214`) | tested |
| members see real name/publisher/version/kinds/unavailable reasons | `package-pane.tsx` + `packages-page.test.tsx` (member route); unavailable blocker copy in `package-detail.tsx:29-59` | tested |
| catalogue leaks no accounts/secrets/paths/other-team installs | DTO `.strict()` (`plugin-package-contracts.ts`); leakage tests (`package-catalogue.test.ts:385-394,450-458`, `package-read-routes.test.ts:269-280`) | tested |
| search/pagination/detail Web loop; skill-only fixture demo | `package-pane.tsx`, `package-detail.tsx`, fixture `plugins/packages/openbot/demo-skill` digest `b5b2a8e1…878e` built into `plugins/.artifacts` | tested (UI); **browser session missing** |

## PKG02 (#461) — preview & idempotent team install

| Acceptance | Evidence | Status |
| --- | --- | --- |
| preview exact version/digest/team/resources/connections; 10 min; no vendor calls | `install-service.ts:236-321`, `plans.ts:211,264`; integration `package-install.integration.test.ts:470-485,683-702` incl. vendor-spy=0; TTL asserted via 11-min expiry (exact 600s constant `plans.ts:211`) | tested |
| only tenant_admin applies; platform admin no implicit company | authorizer `workspace-admin.ts:280-290`; per-tx revalidation `mutation-context.ts:113-136`; routes tests incl. real authorizer role case | tested |
| concurrency/idempotency: same plan once; different plans 409; replay after expiry returns original | integration `:487-582` (concurrent apply, distinct keys, same-key-different-body 409, expired replay 200/410) | tested |
| expectedRevision null first; CAS otherwise; expired/changed/withdrawn refused | non-null → 409 in PKG02 (CAS is PKG06 per DAG); withdrawal live-check is PKG08; plan/digest change → `PLAN_CHANGED` (`install-service.ts:496-505`) | tested within scope; deferrals recorded |
| real restricted roles: FK/RLS/epoch/context clearing | `package-storage.test.ts` 13 tests (`.e2e/pkg02-fix-driven` inner 26/0; `.e2e/cp02-driven` rebind blocked by DB down, evidence quoted in ledger) | tested; rebind pending |
| install shows needs_grant; grants nothing | integration `:433-468` (`needs_grant`, empty allowedActions, `plugin_grants`/connections unchanged) | tested |
| two teams/companies isolated; cross-scope same-404 | integration `:343-431,622-653`; routes `:539-563`; same-company cross-team case added in fix round | tested |
| failed confirm keeps non-secret input; scope switch cancels; forged scope rejected server-side | UI: install tests (410 recovery, scope switch, late-response isolation); server: WeakSet scope/admin refusal (`store.ts:188,212`, `mutation-context.ts:141-152`) | tested |

## Known gaps blocking `verified`

1. Real authenticated browser session on a deployment-shaped enterprise DB (current blocker: `DATABASE_CAPABILITY_CHECK_FAILED` — test-provisioned DB lacks deployment capability catalog; runtime evidence in `/tmp/pkg-server.log` captured 2026-10-19).
2. Driven-tier rebind at cp02 (enterprise test DB :5435 down at rebind time).
3. OCR round 1 in flight; findings fix-loop not yet run.
4. Controller-conducted reviews after subagent budget exhaustion (disclosed limitation).
