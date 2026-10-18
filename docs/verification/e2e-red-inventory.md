# 红点清单 · 由测量直接生成，不要手改

生成：`node scripts/e2e-red-inventory.mjs` · 报告 `.e2e/final2/report.json`（run 01a14e9e-234b-78f3-b357-f55ae94404ca，结束于 2026-10-18T10:56:41.060Z）· 判定 `docs/verification/e2e-vs-bun-final.json`

运行器：`e2e`（Node）为原生层，`bun test` 由 `tests/bun-suites.test.ts` 分组代为调度与报告（ADR 0008 的两层制）。

汇总：8181 executed · 7925 passed · 195 failed · 74 skipped；收集文件 33 个红；run 级错误 4 个。

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
| `app/tests/account-mode-dialog.test.tsx` | 3 | 未单独判定（本次判定集合来自上一次报告的红文件；新红文件要重跑 scripts/e2e-vs-bun.mjs） | Unable to find an element with the text: 14 personal accounts will be disconnected.. This could be because the text is broken up by multiple |
| `server/tests/enterprise/run-failure-contract.test.ts` | 3 | red-on-old-runner-with-current-code | WORKSPACE_FORBIDDEN |
| `server/tests/enterprise/login-reprovision.integration.test.ts` | 2 | already-red-at-baseline | connect ECONNREFUSED 127.0.0.1:5435 |
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
| bun runtime suite agent-sandbox/tests | failed | agent-sandbox/tests: 2 of 17 bun tests failed workspace snapshots (S4): AssertionError: expect(received).toContain(expected)&#10;&#10;Expected to contain: &quot |
| bun runtime suite app/src | passed | — |
| bun runtime suite app/tests part 1 | failed | app/tests part 1: 21 of 281 bun tests failed : TestingLibraryElementError: Found multiple elements with the text: /Unpaid invoices/&#10;&#10;Here are the matchi |
| bun runtime suite app/tests part 2 | passed | — |
| bun runtime suite app/tests part 3 | passed | — |
| bun runtime suite app/tests part 4 | passed | — |
| bun runtime suite desktop/scripts | passed | — |
| bun runtime suite scripts/processes.test.ts | passed | — |
| bun runtime suite scripts/start-restart-guard.test.ts | passed | — |
| bun runtime suite scripts/tls-pipeline.test.ts | passed | — |
| bun runtime suite server/src | passed | — |
| bun runtime suite server/tests part 1 | failed | server/tests part 1: 213 of 258 bun tests failed POST /:channelId/attachments: Error: Failed query: insert into &quot;users&quot; (&quot;id&quot;, &quot;email&q |
| bun runtime suite server/tests part 2 | failed | server/tests part 2: 259 of 433 bun tests failed : Error: Failed query: insert into &quot;bot_services&quot; (&quot;bot_id&quot;, &quot;display_name&quot;, &quo |
| bun runtime suite server/tests part 3 | failed | server/tests part 3: 225 of 397 bun tests failed createCraftRoutes assembly: resolver-only wiring converges: Error: Failed query: insert into &quot;billing_cust |
| bun runtime suite server/tests part 4 | failed | server/tests part 4: 81 of 265 bun tests failed : Error: Failed query: insert into &quot;bot_services&quot; (&quot;bot_id&quot;, &quot;display_name&quot;, &quot |
| bun runtime suite server/tests part 5 | failed | server/tests part 5: 182 of 296 bun tests failed gatewayCustomerName derives the deterministic remote name from the payer ref: Error: Failed query: select &quot |
| bun runtime suite server/tests part 6 | failed | server/tests part 6: 60 of 104 bun tests failed : Error: Failed query: insert into &quot;users&quot; (&quot;id&quot;, &quot;email&quot;, &quot;name&quot;, &quot |
| bun runtime suite server/tests part 7 | failed | server/tests part 7: 30 of 545 bun tests failed : Error: Failed query: insert into &quot;users&quot; (&quot;id&quot;, &quot;email&quot;, &quot;name&quot;, &quot |
| bun runtime suite server/tests part 8 | failed | server/tests part 8: 5 of 539 bun tests failed : Error: Failed query: insert into &quot;enterprise_tenants&quot; (&quot;id&quot;, &quot;name&quot;, &quot;status |
| bun runtime suite server/tests part 9 | failed | server/tests part 9: 97 of 407 bun tests failed : Error: Failed query: insert into &quot;ai_observation_bindings&quot; (&quot;id&quot;, &quot;scope_key&quot;, & |
| bun runtime suite server/tests part 10 | failed | server/tests part 10: 134 of 550 bun tests failed : PostgresError: Failed to connect&#10; at wrapPostgresError (internal:sql/postgres:176:10)&#10; at handleClos |
| bun runtime suite server/tests part 11 | failed | server/tests part 11: 90 of 390 bun tests failed : Error: Failed query: insert into &quot;payment_orders&quot; (&quot;id&quot;, &quot;deployment_scope&quot;, &q |
| bun runtime suite server/tests part 12 | failed | server/tests part 12: 88 of 151 bun tests failed : Error: Failed query: insert into &quot;payment_orders&quot; (&quot;id&quot;, &quot;deployment_scope&quot;, &q |
| bun runtime suite server/tests part 13 | failed | server/tests part 13: 238 of 297 bun tests failed : Error: Failed query: insert into &quot;users&quot; (&quot;id&quot;, &quot;email&quot;, &quot;name&quot;, &qu |
| bun runtime suite server/tests part 14 | failed | server/tests part 14: 146 of 191 bun tests failed : Error: Failed query: select &quot;id&quot; from &quot;credentials&quot; where (&quot;credentials&quot;.&quot |
| bun runtime suite server/tests part 15 | failed | server/tests part 15: 63 of 124 bun tests failed : Error: Failed query: select &quot;grant_id&quot;, &quot;user_id&quot;, &quot;bot_id&quot;, &quot;external_ide |

## 驱动层红组的文件级归属（重跑 bun 得到）

### app/tests part 1
- `bun test` 退出码 1
- 8 × `app/tests/ai-observability-datasets.test.tsx`
- 6 × `app/tests/ai-observability-experiments.test.tsx`
- 3 × `app/tests/ai-observability-route-chain.test.tsx`
- 1 × `app/tests/approvals-rules.test.tsx`
- 1 × `app/tests/bot-approval-rules.test.tsx`
- 1 × `app/tests/bot-memory.test.tsx`
- 18 × `app/tests/bot-needs-you.test.tsx`

### agent-sandbox/tests
- `bun test` 退出码 1
- 1 × `agent-sandbox/tests/sse.test.ts`

### server/tests part 8
- `bun test` 退出码 1
- 1 × `server/tests/multitenancy/payer-accounts.test.ts`
- 1 × `server/tests/multitenancy/rls-core.test.ts`
- 1 × `server/tests/multitenancy/scan-executor.test.ts`
- 1 × `server/tests/multitenancy/settlement-idempotency.test.ts`
- 1 × `server/tests/multitenancy/team-public-rules.test.ts`

