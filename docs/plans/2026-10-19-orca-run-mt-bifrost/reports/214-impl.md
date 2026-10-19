# #214 Bifrost 01.8 管理员就绪状态页面 — 实施核验报告

- 工作区：`bf214-pilot`（独占），分支 `1123786563/bf214-pilot`
- 日期：2026-10-19
- 结论：**票面全部 AC 已有实证，票面 Verification 全绿，typecheck/build/lint 通过；本轮零代码改动（实现已由 Bifrost-5 集成提交带入本分支，核验无缺口）**

## 0. 本轮性质

派发时实现已完整存在于本分支（由 `fb66bd11` / `0c378562` / `5192c33c` 等 Bifrost-5 集成提交带入，`gateway.tsx`/`admin-routes.ts` 文件头注释均标明 Bifrost 01.8 / #214）。本轮工作为：逐项核验 AC 与 Produces 契约、按票面 Verification 重跑全部测试与检查、建专用测试库、落检查点证据。未发现需要补的实现缺口，因此无代码 diff（见 §5 检查点）。

## 1. AC 逐项结果

| AC | 结果 | 证据 |
|---|---|---|
| 1. 管理员可完成保存地址、写入凭据、设置比例、触发探测的完整流程并看到状态变化 | ✅ | 页面四动作齐全（`gateway.tsx`：endpoint/rate/credential 表单 + re-probe 按钮），`mutations.ts` 打到 `/api/admin/gateway/{endpoint,rate,credential,probe}`；UI 测试 `saving the endpoint, the rate and the credential refreshes what the page shows` 与 `the re-probe action reports the classified answer and readiness follows` 断言保存后 configVersion/rate/fingerprint 刷新；服务端测试覆盖三保存动作返回新版本号、probe 成功后联动 capability negotiation（probe→negotiation→ready 是 01.8 特有的“能到达就绪”路径） |
| 2. 未就绪时展示每条阻塞原因，不是笼统“失败” | ✅ | `ReadinessView` 渲染 `readiness.blockingReasons` 全量列表（`data-testid="gateway-blocking-reasons"`），14 个 reason code 全部有 i18n 句子（`GATEWAY_REASON_CODES` 以 en bundle 为类型源，缺句即编译错）；UI 测试 `a not-ready gateway names every blocking reason, not a blur` 逐句断言；服务端 `/status` 返回 01.7 verdict 全量 blockingReasons |
| 3. 页面与接口响应中都不出现凭据明文 | ✅ | 服务端测试断言原始响应体不含明文 key（plain + base64 两种编码，`server/tests/gateway-admin-routes.test.ts:304-306`），credential 视图只含 `fingerprint`（`queries.ts` 类型上不存在明文字段）；UI 测试断言 `document.body.innerHTML` 不含注入的 `SECRET_KEY` 且保存成功后输入框清空（`admin-gateway-readiness.test.tsx:385-396`） |
| 4. 普通用户访问页面或诊断接口被拒绝 | ✅ | 接口：`gatewayAdminRoutes` 全路由 `requireUser` + `requireAdmin`，服务端测试断言 member 全路由 403、匿名 401（test:224-245）；页面：`app/src/routes/_authed/admin/route.tsx` `beforeLoad` 对非 admin `redirect({ to: "/" })` |

Produces 契约核对：管理员网关设置页（保存/探测/状态/阻塞原因/configVersion/当前比例）✅；只读状态接口 `GET /api/admin/gateway/status`（管理员专属、`cache-control: no-store`、不含明文）✅；组 01 缝合点——配置→探测→协商→就绪在同一页面端到端可演示 ✅（服务端测试 + UI 探测测试双证）。

## 2. Verification 命令与结果（本轮实跑）

票面旧命令已过时，按任务约束改用 e2e.unit 运行器 / Bun 层原生跑法，仓库根 cwd：

| 命令 | 结果 |
|---|---|
| `bun test ./app/tests/admin-gateway-readiness.test.tsx`（Bun 驱动层，等价于 driver 对该文件的同款调用） | **4 pass / 0 fail**（24 expect） |
| `E2E_BUN_ONLY="app/tests part 1" bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`（含上文件所在整组） | **1/1 pass**（组 24 文件 8.93s） |
| `TEST_DATABASE_URL=postgres://postgres@localhost:5432/openbot_bf214 bun test ./server/tests/gateway-admin-routes.test.ts` | **9 pass / 0 fail**（68 expect） |
| `bunx e2e run --config e2e.unit.config.ts server/tests/gateway-readiness-gate.test.ts`（Node 收集层，直跑 bun test 会因 `node:module registerHooks` 报错——是调用方式问题非缺陷） | **20/20 pass**（01.7 前置门禁在本工作区为绿） |
| `bun run --filter app typecheck` | exit 0 |
| `bun run --filter app build` | exit 0（仅既有 chunk-size 警告） |
| `bun run --filter server typecheck` | exit 0 |
| `bunx biome lint --error-on-warnings <6 个票面文件>` | No fixes applied，无告警 |

skipped 记为零：以上各跑法输出中无 skip。

## 3. 测试环境（可复跑配方）

- 专用测试库建在 `bf011-pg`（localhost:5432，trust 认证，与 openbot_bf013/bf036 同模式）：`openbot_bf214` 与 `openbot_enterprise_bf214`（+`_dir`/`_data`，后述），均 `DATABASE_URL=… bun server/scripts/migrate.ts` 迁移至最新（`{"type":"migrations-applied","status":"ok"}`）。未触碰任何开发库。
- 说明：bun 组 `server/tests part 5` 混有 `server/tests/enterprise/tenancy*.integration.test.ts`（多租户族），其 URL 校验强制库名 `openbot_enterprise_*`，故组级验证用 `openbot_enterprise_bf214`；本票自己的 `gateway-admin-routes.test.ts` 在 `openbot_bf214` 上单跑 9/9 绿（两库名均满足“非 openbot 开发库”约束）。

## 4. 遗留 / 域外发现（不构成本票失败）

1. **组级运行器的 enterprise 预置缺口（多租户族，非本票写域）**：`E2E_BUN_ONLY="server/tests part 5"` 整组驱动时，组内 `enterprise/tenancy(-rls)?.integration.test.ts` 报 `DATABASE_CAPABILITY_MISMATCH`——需要 `enterprise-test-db.ts provision` 在 PG 实例上建 **cluster 级** 角色。bf011-pg 为共享容器（bf013/bf036 在用），建全局角色有跨票干扰风险，故本轮不越域执行；这与分支上 `docs/plans` 已记录的“multitenancy 一族三道门禁”同源。本票文件在该组的单文件验证已全绿。
2. `gateway-admin-routes.ts` 等文件由族内多票共用（03.5/03.7/05.8/05.9 的路由同文件追加），本轮未发现接口冲突。
3. 票面 Handoff Checkpoint 字段未回写 GitHub（运行纪律禁止本轮发帖到 GitHub）；以本报告 §5 为检查点记录，由协调者决定回写时机。

## 5. 检查点（未提交检查点 = 分支 HEAD + 干净树 + 文件哈希）

- HEAD：`0a85bb42d622c25d3190db7c7cde117f3b8e57b9`
- `git status`（全量）：`nothing to commit, working tree clean`
- 本轮唯一新增文件：本报告自身（`docs/plans/2026-10-19-orca-run-mt-bifrost/reports/214-impl.md`，未提交）
- 实现引入提交：`5192c33c`（gateway.tsx 等）→ `fb66bd11`（Bifrost-5 累计集成检查点）

sha256 清单（票面写域文件）：

```
6cbc4d0eaff9f3ba7af9b311ab7b08110b04f04d456c1b011f8ffdeace033615  app/src/routes/_authed/admin/gateway.tsx
b512fa62a0e11d808ed76c5c0bceae7bb8f1835f9d3e54e3a65269d0bf1cfe03  app/src/lib/gateway/queries.ts
bc7c5b6cbb73a2e0cf375f523b05147bc8a717977b2f25bfc265be9ed9526c31  app/src/lib/gateway/mutations.ts
6a59fa153af197b7a3f252e3ad1a75e84e96a720c3752f754abe0b4b85659984  server/src/gateway/admin-routes.ts
493b5e8a120013f6ff906b6420e0dd7ac4803da3e81b92df63aa2a83e0b73d32  server/src/gateway/admin-credential-routes.ts
e58c0f40e4bf6019ceb7b5068dd2983bbe9a0d88e95d2c838c5303259c4018de  server/src/gateway/readiness.ts
154c896f000c49507ffc389bf93be01a9c21c9f3ed115a2e45d60cd1a95f657a  app/tests/admin-gateway-readiness.test.tsx
b1b411e741d74e23c22dbc3f2dad99355247c661cd520547c39d2447befaf7f1  server/tests/gateway-admin-routes.test.ts
2086be8410f2e972f45b6afa3bcca74c1717b3da5e5b0efecb0ac2af09327783  app/src/locales/en/admin.json
8ba4b56a8878aa46b55d79b2f14faaee371249803ec9c776e79bdd72e8821f78  app/src/locales/zh-CN/admin.json
3e990e0ae83a60abf1641a9635f1a71f78b49e48f9d93b65fe8db338e3ede044  app/src/components/admin/admin-sidebar.tsx
```
