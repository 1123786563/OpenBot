# 红点清单 · 由测量直接生成，不要手改

生成：`node scripts/e2e-red-inventory.mjs` · 报告 `.e2e/drivenfull/report.json`（run 01a14edc-e637-79a6-a973-39e17bfa2797，结束于 2026-10-18T12:10:01.264Z）· 判定 `docs/verification/e2e-vs-bun-final.json`

运行器：`e2e`（Node）为原生层，`bun test` 由 `tests/bun-suites.test.ts` 分组代为调度与报告（ADR 0008 的两层制）。

汇总：8179 executed · 7931 passed · 187 failed · 74 skipped；收集文件 32 个红；run 级错误 4 个。

## 原生层（e2e / Node）

| 文件 | e2e 失败数 | 归因 | 第一条消息 |
 | --- | --- | --- | --- |
| `server/tests/enterprise/runner-production.test.ts` | 42 | red-on-old-runner-with-current-code | expected {} to be undefined |
| `server/tests/enterprise/model-route-rebind.test.ts` | 17 | red-on-old-runner-with-current-code | WORKSPACE_FORBIDDEN |
| `server/tests/enterprise/expert-run-admission.test.ts` | 15 | red-on-old-runner-with-current-code | WORKSPACE_FORBIDDEN |
| `server/tests/enterprise/governed-execution.test.ts` | 14 | red-on-old-runner-with-current-code | WORKSPACE_FORBIDDEN |
| `server/src/knowledge/retrieval.test.ts` | 13 | already-red-at-baseline | expected "degraded" to be "hit" |
| `server/tests/enterprise/run-execution-failure.test.ts` | 12 | red-on-old-runner-with-current-code | WORKSPACE_FORBIDDEN |
| `server/tests/enterprise/run-success-contract.test.ts` | 9 | red-on-old-runner-with-current-code | WORKSPACE_FORBIDDEN |
| `server/src/knowledge/qa-verify.test.ts` | 8 | already-red-at-baseline | expected "degraded" to be "hit" |
| `server/tests/payer-company-resolution.test.ts` | 6 | red-on-old-runner-with-current-code | WORKSPACE_FORBIDDEN |
| `server/tests/tool-selection.integration.test.ts` | 5 | already-red-at-baseline | REMOTE_RUN_BUDGET_UNVERIFIED |
| `server/tests/enterprise/expert-version-catalog.test.ts` | 4 | red-on-old-runner-with-current-code | WORKSPACE_FORBIDDEN |
| `server/tests/enterprise/model-route-catalog.test.ts` | 4 | red-on-old-runner-with-current-code | WORKSPACE_FORBIDDEN |
| `server/tests/enterprise/run-failure-contract.test.ts` | 3 | red-on-old-runner-with-current-code | WORKSPACE_FORBIDDEN |
| `server/tests/enterprise/login-reprovision.integration.test.ts` | 2 | already-red-at-baseline | role "ent_data" does not exist |
| `server/tests/enterprise/runner-events.test.ts` | 2 | already-red-at-baseline | ENOENT: no such file or directory, open 'drizzle/0070_runner_event_attribution.sql' |
| `server/tests/schema.test.ts` | 2 | already-red-at-baseline | expected ["model","connector","agent","mcp","mcp_oauth_client","mcp_user_token","bot_service","gateway_admin","credit_service"] to equal ["m |
| `server/tests/self-host-banner.test.ts` | 2 | already-red-at-baseline | Unexpected token 'I', "Internal S"... is not valid JSON |
| `server/tests/workshop-preview.test.ts` | 2 | already-red-at-baseline | expected [502,503] to contain 200 |
| `agent-computer/tests/egress-connect.test.ts` | 1 | already-red-at-baseline | expected "10.255.255.1" to be "127.0.0.1" |
| `agent-sandbox/tests/proxy.test.ts` | 1 | old-runner-unreadable | expected [] to contain "/event?directory=cs-scoped-9" |
| `scripts/test-ci.test.ts` | 1 | red-on-old-runner-with-current-code | expected 1 to be 7 |
| `server/tests/audit.test.ts` | 1 | already-red-at-baseline | expected ["workshop.session_created","workshop.session_archived","workshop.artifact_downloaded","workshop.sandbox_reset","workshop.preview_a |
| `server/tests/copilot.test.ts` | 1 | already-red-at-baseline | expected {"model":{"specificationVersion":"v3","supportedUrls":{"image/*":[{}]},"modelId":"gpt-5.6-terra","config":{"provider":"openai.chat" |
| `server/tests/enterprise/intelligence-contracts.test.ts` | 1 | already-red-at-baseline | node:internal/modules/esm/resolve:272 throw new ERR_MODULE_NOT_FOUND( ^ Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/wuyongjun/t |
| `server/tests/enterprise/migration-entrypoints.test.ts` | 1 | red-on-old-runner-with-current-code | expected "import { defineConfig } from \"drizzle-kit\";\n\nconst databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;\n\ |
| `server/tests/enterprise/migration-runner-guard.test.ts` | 1 | already-red-at-baseline | expected "import { defineConfig } from \"drizzle-kit\";\n\nconst databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;\n\ |
| `server/tests/enterprise/runtime-artifacts.test.ts` | 1 | already-red-at-baseline | document_baseline[docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md]: expected "3988f0a53a6f51c106ef34373a33b76ead6fa599f2af59b9d |
| `server/tests/guards.test.ts` | 1 | already-red-at-baseline | expected {"user":{"id":"member","email":"member@openbot.test","name":"OpenBot Member","image":"https://example.test/member.png","role":"user |
| `server/tests/migration-journal.test.ts` | 1 | already-red-at-baseline | expected ["0073_narrow_vulture: the snapshot adds \"enterprise_identity_events\", the migration never creates it","0073_narrow_vulture: the  |
| `server/tests/ready.test.ts` | 1 | already-red-at-baseline | expected 503 to be 200 |
| `tests/compose.test.ts` | 1 | already-red-at-baseline | expected "# The main local stack. The optional stacks live in docker/compose/ — kb.yml, services.yml,\n# lago.yml, observability.yml, opik.y |

归因口径（`scripts/e2e-vs-bun.mjs`）：同一份生产代码 + 迁移前套件文本用 `bun test` 再跑一遍。

- `already-red-at-baseline`：迁移前整树上也是红的 → 与迁移无关。
- `red-on-old-runner-with-current-code`：换回旧运行器同样红 → 迁移没有改变结论。
- `runner-difference`：只有旧运行器绿 → 才是迁移的责任，必须修兼容层或按两层制分流。

## 驱动层（e2e 调度、Bun 执行）

| 组 | 结果 | 运行器给出的原因 |
 | --- | --- | --- |
| bun runtime suite agent-computer/tests | passed | — |
| bun runtime suite agent-langgraph/tests | passed | — |
| bun runtime suite agent-mastra/src | passed | — |
| bun runtime suite agent-sandbox/tests | failed | agent-sandbox/tests: 1 of 2 failing file(s) are still red run alone agent-sandbox/tests/sse.test.ts: 2 of 11 — forwardBlock (the family filter): AssertionError: |
| bun runtime suite app/src | passed | — |
| bun runtime suite app/tests part 1 | passed | — |
| bun runtime suite app/tests part 2 | passed | — |
| bun runtime suite app/tests part 3 | passed | — |
| bun runtime suite app/tests part 4 | passed | — |
| bun runtime suite app/tests/ai-observability | failed | app/tests/ai-observability: 1 of 2 failing file(s) are still red run alone app/tests/ai-observability-route-chain.test.tsx: 5 of 5 — the runs chain mounts its d |
| bun runtime suite desktop/scripts | passed | — |
| bun runtime suite scripts/processes.test.ts | passed | — |
| bun runtime suite scripts/start-restart-guard.test.ts | passed | — |
| bun runtime suite scripts/tls-pipeline.test.ts | passed | — |
| bun runtime suite server/src | passed | — |
| bun runtime suite server/tests part 1 | passed | — |
| bun runtime suite server/tests part 2 | passed | — |
| bun runtime suite server/tests part 3 | failed | server/tests part 3: 2 of 4 failing file(s) are still red run alone server/tests/cleanup-dry-run.integration.test.ts: 2 of 18 — the cleanup dry-run is read-only |
| bun runtime suite server/tests part 4 | failed | server/tests part 4: 3 of 6 failing file(s) are still red run alone server/tests/demonstrations-store.integration.test.ts: 3 of 10 — : Error: Failed query: inse |
| bun runtime suite server/tests part 5 | failed | server/tests part 5: 2 of 2 failing file(s) are still red run alone server/tests/enterprise/tenancy-rls.integration.test.ts: 2 of 4 — : Error: ENTERPRISE_TEST_D |
| bun runtime suite server/tests part 6 | passed | — |
| bun runtime suite server/tests part 7 | failed | server/tests part 7: 5 of 8 failing file(s) are still red run alone server/tests/multitenancy/acceptance-harness.test.ts: 11 of 17 — harness isolation resolutio |
| bun runtime suite server/tests part 8 | failed | server/tests part 8: 4 of 5 failing file(s) are still red run alone server/tests/multitenancy/payer-accounts.test.ts: 20 of 23 — MT069 AC1: company↔customer map |
| bun runtime suite server/tests part 9 | failed | server/tests part 9: 1 of 3 failing file(s) are still red run alone server/tests/multitenancy/vendor-billing.test.ts: 1 of 1 — : Error: Failed query: select &qu |
| bun runtime suite server/tests part 10 | passed | — |
| bun runtime suite server/tests part 11 | failed | server/tests part 11: 3 of 4 failing file(s) are still red run alone server/tests/payer-company-resolution.integration.test.ts: 4 of 5 — resolveCompanyPayerAcco |
| bun runtime suite server/tests part 12 | failed | server/tests part 12: 1 of 1 failing file(s) are still red run alone server/tests/people-paging.integration.test.ts: 1 of 9 — reading the people in a deployment |
| bun runtime suite server/tests part 13 | failed | server/tests part 13: 2 of 3 failing file(s) are still red run alone server/tests/recovery-scan.integration.test.ts: 11 of 11 — : Error: worker exited 1: 70 | : |
| bun runtime suite server/tests part 14 | failed | server/tests part 14: 4 of 6 failing file(s) are still red run alone server/tests/skill-tools.integration.test.ts: 10 of 11 — a skill declaring the tools it nee |
| bun runtime suite server/tests part 15 | passed | — |
