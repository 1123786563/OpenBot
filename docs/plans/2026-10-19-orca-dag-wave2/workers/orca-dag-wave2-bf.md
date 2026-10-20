# orca-dag-wave2-bf：Bifrost #251（05.10）与 #287（09.2）执行报告

- Worktree：`bf2`（BASE = main@c80927fa），未提交检查点（全部改动在工作区，未 commit/push）
- 测试库：`postgres://postgres:postgres@127.0.0.1:5561/bf2`（容器 orca-w2-bf-pg，pgvector pg16；执行中容器曾意外退出一次，`docker start` 后全部复跑通过）
- 迁移已对 bf2 应用：`server/drizzle/0164_usage_outbox_workspace.sql`（journal 登记 idx=164）

## 结论总览

| 票 | 结论 | 关键证据 |
|---|---|---|
| #287 09.2 公司 payer 贯穿全链路 | **SATISFIED（实施交付）** | `bun test server/tests/company-payer-e2e.integration.test.ts` → 4 pass / 0 fail，exit 0 |
| #251 05.10 用户侧 Key 状态展示与全版本撤销 | **SATISFIED（实施交付）** | `bun test app/tests/user-key-status-ui.test.tsx` → 4 pass / 0 fail，exit 0；server 侧 `access-grant-key-status.integration.test.ts` 4 pass / 0 fail |

两张票均**非零改动收尾**：核验发现 02.3/02.5/05.4/05.7 的库件齐备但接线缺失（`withPayerBinding` 与 `resolveCompanyPayerAccount` 在生产代码零调用方；`/api/model-access` 无 key 状态数据、无 revoke-all），故按票面实施。

---

## #287（Bifrost 09.2）公司 payer 贯穿全链路 — SATISFIED

### 现状核验（为什么必须实施）
- 02.5 已交付 `withPayerBinding`/`resolveConsumptionPayerBinding`（不切换语义），但 `withPayerBinding` 生产调用方为零。
- 02.3 已交付 `resolveCompanyPayerAccount`（公司 scope → 公司账户），生产调用方为零。
- `payer-binding.ts` 注释原话："until group 09 (09.2) wires per-surface payer resolution"；`index.ts` 装配注释："the branch group 09 (09.2) replaces with per-surface payer resolution"。
- 前置 #286（09.1 改道）、#219（不切换）均已 closed 并在库。

### 交付（Write scope：工作台调用 payer 绑定接线 + 用量归因维度 + 测试）
1. **`server/src/billing/workbench-payer.ts`（新）**：`withWorkbenchScope`/`currentWorkbenchScope` ambient（团队/使用人归因维度，模式同 `usage-origin.ts`）；`resolveWorkbenchPayerBinding`（trusted scope → 公司账户 → binding）；`createWorkbenchPayerMiddleware`（读 tenancy 中间件已建立的 `entryBusiness`；无 entry business 的请求原样放行，个人/遗留路径零变化）。
2. **`server/src/app.ts`**：`createApp` 尾参 `workbenchPayer?: { database: Database }`；`/api/copilotkit` 面（09.1 的工作台模型调用面）在 `withRunnerRequestContext` 外再包 payer 绑定中间件。
3. **`server/src/index.ts`**：gate 的 usage fact 写入附 `workspaceId: currentWorkbenchScope()?.workspaceId ?? null`（归因维度不参与 payer 决策）；`createApp` 传 `{ database }`。
4. **用量团队维度**：`usage_outbox` 加 `workspace_id` 列（schema + `UsageOutboxInput`/`immutableFields` + 迁移 0164 + journal）。使用人维度沿用 09.1 的 `owner_user_id`。
5. **测试 `server/tests/company-payer-e2e.integration.test.ts`（票面 Verification 文件名）**：
   - 中间件接线：公司 scope 请求 → binding=公司 + 归因（tenant/workspace/principal）；无 entryBusiness → 不绑定。
   - 全链贯穿：绑定内重演 gate 的货币三步（resolve→reserve→fact→settle）——公司余额变化、个人账户分文不动、fact=公司 key+workspace+owner、尾差行=公司 key。
   - 余额不足：公司空账户 reserve 拒绝（reserved:false/availableCents:0），payer 不重解析不切换，个人/部署零写入。

### AC 对照
- AC1 公司调用只动公司余额、个人不变 → 全链用例断言（公司<500000，个人=500000）✓
- AC2 准入/用量/结算/尾差同一 PayerRef → resolve/reserve/fact/settle/remainder 全部断言同一公司 key（尾差按 payerKey 派生，credit-remainder 机制既有）✓
- AC3 用量记录含团队与使用人维度 → fact.workspaceId + fact.ownerUserId 断言 ✓（归因不反噬 payer：维度来自 scope，payer 来自绑定，两个通道）
- AC4 余额不足拒绝不回退个人 → 不足用例断言 ✓

---

## #251（Bifrost 05.10）用户侧 Key 状态展示与全版本撤销 — SATISFIED

### 现状核验（为什么必须实施）
- 04.7 已交付授权列表（identity/status/createdAt + 单 grant Revoke），但无 Key 期限/credentialVersion 展示、无"撤销全部有效版本"。
- `/api/model-access` 仅 `GET /grants`、`POST /grants/:grantId/revoke`；无 key 状态数据（05.4 的 `gatewayKeyStatusView` 未暴露到用户 API）、无 revoke-all。
- 05.7 的撤销语义（`revokeForUser`：grant 翻转 + 全部版本同事务退役 + gateway 退役）齐备，revoke-all 复用之。

### 交付（Write scope：用户 Key 状态页面与组件 + app/tests；server 侧为该页面的数据/动作支撑）
1. **`server/src/bot-services/access-grants.ts`**：
   - `AccessGrantKeyStatus` 类型 + `listForUser` 附 `activeKeys`（批量查 `gateway_virtual_keys` status='active' 行，credentialVersion 倒序；表无明文列——无 secret 是结构性保证）。
   - `revokeAllForUser(userId, botId)`：撤销该用户该 Bot 全部 active grants（逐个走 05.7 的 `revokeForUser`，幂等，他人 Bot 无 grant 时返回空而非报错）。
   - 路由：`GET /grants` 序列化带 activeKeys；`POST /grants/revoke-all`（zod 严格 body `{botId}`，缺失 400；重放=空撤销 200）。
2. **app**：`mutations.ts` 加 `AccessGrantKeyStatus`/`revokeAllAccessGrantsMutationOptions`（invalidate 列表同单撤销纪律）；`model-access-authorizations.tsx` 行内渲染 key 版本行（v{n} · Active · 期限），active 行双按钮（Revoke all versions + Revoke）；i18n zh-CN/en 各 3 键。
3. **测试**：
   - `app/tests/user-key-status-ui.test.tsx`（票面 Verification 文件名）4 用例：版本/状态/期限渲染 + 无 secret 断言；撤销全部（POST revoke-all {botId}）→ 列表刷新后版本行消失、行转 Revoked、按钮消失；**GET 401 → role="alert" 错误态且绝不出现空列表文案**（Resume hint 点名场景）；拒绝时明说。
   - `server/tests/access-grant-key-status.integration.test.ts` 4 用例：列表只答 live 版本（expired 不出）+ wire 形状无 secret 字段；revoke-all 撤 2 grants/3 版本全退役 + 旁观者不动 + gateway 退役被调；重放幂等；无 botId 400。

### AC 对照
- AC1 状态与期限可见、明文不可见 → 版本行 + 双侧无 secret 断言 ✓
- AC2 一次撤销该用户该 Bot 所有有效 Key → revoke-all 端点 + UI 单击 + server 多 grant/多版本用例 ✓
- AC3 远端不可用展示错误非空列表 → 401 用例（alert 出现、空态文案不出现）✓
- AC4 撤销后界面立即更新 → invalidate + refetch 断言（版本行与按钮即时消失）✓

---

## 验证记录（命令 + 退出码）

| 命令 | 结果 |
|---|---|
| `bun test app/tests/user-key-status-ui.test.tsx` | 4 pass / 0 fail（exit 0） |
| `bun test app/tests/user-authorizations-ui.test.tsx`（04.7 回归，fixture/选择器适配新契约） | 4 pass / 0 fail（exit 0） |
| `TEST_DATABASE_URL=…5561/bf2 bun test server/tests/company-payer-e2e.integration.test.ts` | 4 pass / 0 fail（exit 0） |
| `TEST_DATABASE_URL=…5561/bf2 bun test server/tests/access-grant-key-status.integration.test.ts` | 4 pass / 0 fail（exit 0） |
| 7 文件回归批（company-payer-e2e / access-grant-key-status / access-grant-revoke / access-grant.integration / key-revocation / payer-no-fallback / billing-usage-outbox.integration） | 75 pass / 0 fail（exit 0） |
| 深度回归（billing-credits-consumption / reserve-payer-tampering / payer-company-resolution） | 14 pass / 0 fail（exit 0） |
| `bun run --filter app typecheck` | exit 0 |
| `bun run --filter server typecheck` | 仅 `scripts/bootstrap-local-gateway.ts` 4 处**预存**错误（未跟踪本地脚本，git diff HEAD 为空；与本次改动无关），其余全部通过 |
| `bunx biome lint --error-on-warnings`（9 个新建/净文件） | 零问题；app.ts/index.ts 的 7 处 lint 报告经 HEAD 版本对照全部预存（仅行号平移） |
| `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts -- server/tests/billing-usage-evidence.test.ts` | 9 pass（bun 直跑的 registerHooks 失败为运行时兼容层预存） |
| `bunx e2e run` 跑 workbench-gateway-routing（09.1） | 2 fail —— **基线对照**：干净 main@c80927fa 临时 worktree 同文件同样 2 fail（UnmeterableModelError/CreditGateError，环境预存），非本次改动引入 |

## 已知边界
- `payer-no-fallback.test.ts` 的 gate 源提取 harness 因新 seam 做了最小适配（deps 加 `currentWorkbenchScope`；core 白名单不含它——它在 finish 闭包内读取，超出 gateCall 的 accessed 采集窗）。
- `billing-usage-delivery`（Lago payload）未加 workspace_id：AC 的"用量记录"落点是 usage fact 行（与 owner_user_id 同层）；Lago 投影扩展不在票面范围。
- `code_run` source 的 fact 未附 workspace 维度（该路径不在"工作台调用"范围，字段可选保持 absent）。

## 改动清单与 sha256

```
b8f08227867cdc0869e8379b204a4f9372b560db6083378b7934cf8dd7c90951  app/src/components/settings/model-access-authorizations.tsx
fe5deab07791da5653087d975741fd65406ede1405fb7c4d0f5f4f94823bab75  app/src/lib/model-access/mutations.ts
0ba45431746100362801f695f050b56e8b087fe7fddd355739301735aa4db58d  app/src/locales/en/settings.json
4c1fd927f2314237c8458f3b6e6c7eef9e05b6bb920109587b6d820151d9ea9c  app/src/locales/zh-CN/settings.json
1d8f99f5be18646e42f9dd48adbbb4d59ff88342331812ae5ac1f4dfe4994292  app/tests/user-authorizations-ui.test.tsx
9e537c38c836a4f309f355e4676a81d8d632a98f56c070bedb286cddc4bd5377  app/tests/user-key-status-ui.test.tsx
0264ea14f27d51eb69f356021bed4a0ef09c62061e9e009c10fc3f4930c7a65b  server/drizzle/meta/_journal.json
f120f60d79c1f61cd2f556a94aad6aa4c97e014ed012b1db1735c3ac4c3abbb2  server/drizzle/0164_usage_outbox_workspace.sql
006998c422bd5ca34f27b0bfe6a72f16ca2993a1bedcad5263bcbc039fd279f1  server/src/app.ts
1b81c5570b3c33afa9716fd87d42dc25b061d8f566893bd3770fbdd68cdcfaf2  server/src/billing/usage-outbox.ts
e42d99f421a432c457ee1ba6421705a585d7468d6f3f28cca31be2f91fe8b6ab  server/src/billing/workbench-payer.ts
e668ca9e0d85a3706cdca177eeada790359fef644a26bac5f74c0f08f29b1c5b  server/src/bot-services/access-grants.ts
b347b4c7ba6f45d29a04d5aa680b6cc88567fa6cd7af64b7f5285a15dac49bd7  server/src/db/schema/usage-outbox.ts
add58f1d0fa25fbb80e05561722bf85f0f890409e24b3a69f490e34e495d8ca3  server/src/index.ts
3cb4b0d106434350998e120e265660f6ef96c922af49536e370f9bee14ddfdbb  server/tests/payer-no-fallback.test.ts
0e92bc457a93fccf54f51457705ca309f0d579bd9c022c27c061621652f91278  server/tests/access-grant-key-status.integration.test.ts
990f2263256b4044edfcd99206881b4919e0e18b648d4df4fdcefff0822d43e6  server/tests/company-payer-e2e.integration.test.ts
```

未提交（按约束不 commit/push）；上表即未提交检查点的文件哈希清单。
