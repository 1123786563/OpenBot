# R4-backend 执行报告 — OCR round3 修复（R4-1..R4-6）

角色：backend_implementer。工作区 `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`（分支 `feat/plugin-package-market-v1`，BASE `9057aeeb`）。执行日 2026-10-20。
**无 commit/push/stash**——全部变更停留在工作区；未触碰 `app/`、`shared/`、`docs/plans` 其他文件、任何他人容器（`openbot-test-pg` 等）。

## 一、结论速览

| 项 | 严重度 | 结果 |
| --- | --- | --- |
| R4-1 镜像补 `enterprise_package_install_scope_id_uq` | high | **done** |
| R4-2 grants PK 追加步骤重建为六列（含 tool_ref）+ 镜像/parity/正测 | medium | **done** |
| R4-3 apply() 事务内复验 connector install，品牌化错误 + 4xx | medium | **done** |
| R4-4 `openbot_create_package_expert` 递归 + 大小写不敏感强化（追加步骤） | medium | **done** |
| R4-5 marketplace 索引路径入 config（env `OPENBOT_PLUGIN_MARKETPLACE_INDEX`） | medium | **done** |
| R4-6 镜像 action CHECK/头注释/drizzle.config 定位对齐 | medium | **done** |

门禁：typecheck 仅既有 3 个 bootstrap 错误（原文见 §四）；`bunx biome lint` 13/14 触碰文件干净，`server/src/index.ts` 的 5 条 findings 经 BASE 对照确认为既有（见 §五 偏差 5）。fresh 验证全绿（native 133 通过，driven pkg02/pkg03+pkg03b/pkg04 全过）。

## 二、变更清单（本票触碰的文件）

生产代码：

1. `server/src/db/schema/enterprise-plugin-packages.ts` — R4-1：installs 补 `uniqueIndex("enterprise_package_install_scope_id_uq")`；R4-2 镜像：grants 主键列加入 `toolRef`（约束名不变）；R4-6：changes.action CHECK 镜像改为六值闭集（`'install','upgrade','rollback','grant','revoke','createExpert'`）；头注释改为"八张表"并按实际表重排编号、写明 PKG02/PKG03/PKG03B/PKG04A 权威与 F1 受控 generate 源定位。
2. `server/scripts/multitenancy/migrate-test.ts` — 纯追加（`git diff` 对 BASE 零删除行，已应用步骤文本一字未动）：
   - PKG03 任务尾部追加步骤 `package_grant_pk_tool_ref`：`DROP CONSTRAINT enterprise_package_grant_pk` + 重建为 `(tenant_id, install_id, generation, bot_id, resource_id, tool_ref)` 六列 PK；
   - PKG04 任务尾部追加步骤 `package_expert_create_function_hardening`：`CREATE OR REPLACE FUNCTION openbot_create_package_expert(...)` 发布强化版——敏感键防线从顶层 `?|`（大小写敏感）改为 `$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "…" flag "i")` 递归 + 大小写不敏感扫描，键集合为原 endpoint/auth 列表与 package_hardening 秘密载体列表的并集；`agentType='built_in'` 判定、签名、search_path、上下文重验不变（OR REPLACE 保留既有 ACL）；
   - 两个任务的头注释补记各自追加步骤的来由与等价性论证。
3. `server/src/enterprise/plugin-packages/contracts.ts` — R4-3：新增服务端内部错误码 `PACKAGE_INTERNAL_ERROR_CODES = ["CONNECTOR_INSTALL_MISSING"]`（shared 闭集不改，见偏差 3）；`PackageServiceError`/`packageError`/`packageErrorCodeOf` 的码类型放宽为 `PackageErrorCode | PackageInternalErrorCode`。
4. `server/src/enterprise/plugin-packages/routes.ts` — R4-3：内部码独立 status/message 表，`CONNECTOR_INSTALL_MISSING → 409` + 可解释文案；`respondError` 分流内部码与 shared 码。
5. `server/src/enterprise/plugin-packages/install-service.ts` — R4-3：apply() 在写 linkRows 前、**同一事务内**（`tx.db`）对即将写入的全部去重 connectorInstallId 逐个复验存在性；缺失 `throw packageError("CONNECTOR_INSTALL_MISSING")`——整事务回滚，FK 不再可能以裸错误暴露。
6. `server/src/config.ts` — R4-5：Config 接口与装配新增 `pluginMarketplaceIndexPath`（env `OPENBOT_PLUGIN_MARKETPLACE_INDEX`；默认 `fileURLToPath(new URL("../../plugins/marketplace.json", import.meta.url))`，与 index.ts 原解析同目录层级、绝对路径等价，行为不变；对照同函数内 `pluginArtifactRoot` 既有模式）。
7. `server/src/index.ts` — R4-5：marketplace 索引读取改用 `config.pluginMarketplaceIndexPath`，注释说明默认等价。
8. `server/drizzle.config.ts` — R4-6/F1：在 `enterprise-plugin-packages.ts` 条目上方补注释块，写明"DDL 权威是 migrate-test 的 PKG02/03/04 任务；本文件是 typed 投影，按 OCR round1 F1 裁决刻意保留在 generate 清单里（parity 守护下的受控 generate 源），不是建表的第二条路径"。条目本身不动（parity 测试的 contains 断言仍成立）。

测试：

9. `server/tests/schema-drizzle-parity.test.ts` — 保留 F1 原断言，新增第二条 typed parity 测试：`getTableConfig` 内省镜像，钉住 `enterprise_package_install_scope_id_uq` 索引名、grants PK 六列精确列序（含 tool_ref）、action CHECK 六值闭集（经 `PgDialect.sqlToQuery` 渲染断言）。
10. `server/tests/package-install-routes.test.ts` — 状态映射表加入 `["CONNECTOR_INSTALL_MISSING", 409]`；新增用例断言该码的响应体为品牌化 `error.code`（非 INTERNAL 回声）。
11. `server/tests/package-install.integration.test.ts`（pkg02 驱动组）— 新增 R4-3 用例：专用 connector install 上 plan 成功 → 经 setup 连接删除该行 → apply 被 `CONNECTOR_INSTALL_MISSING` 拒绝、install/link/change 零行、plan 未消费。
12. `server/tests/multitenancy/package-grants.test.ts`（pkg03 驱动组）— DDL 应用测试补六列 PK 的 `pg_get_constraintdef` 现场断言；新增 R4-2 正测（专用 install+Bot）：同一 (install, generation=910, bot, resource='tracker') 两条不同 tool_ref（`tracker:list`/`tracker:write`）connectorTool 活跃授权共存；born-revoked 重复行与 skill 重复行（tool_ref=''）仍撞 `enterprise_package_grant_pk`（23505）——skill 行为不变。
13. `server/tests/multitenancy/package-expert.test.ts`（pkg04 驱动组）— DDL 应用测试补函数体现场断言（`$.**`、`keyvalue()`、`flag "i"`）；新增 R4-4 直调用例（operator 角色真实调用）：`{"remote":{"endpoint":"…"}}`、`{"Token":"x"}`、`{"nested":{"apiKey":"x"}}` 均 `PKG_EXPERT_REMOTE_FORBIDDEN` 且零 ghost 行；正常 built_in 模板配置仍可创建、config 原样落库。JSON 字面量按既有测试惯例以 `sql.raw` 内联（Bun SQL 会 JSON 编码 jsonb 类型参数，绑定字符串会变成 jsonb 标量而误触 `PKG_EXPERT_CONFIG_INVALID`，用例内有注释说明）。
14. `server/tests/multitenancy/migration-tool.test.ts` — 既有缺口补记（见偏差 2）：`ALLOWED_TASK_IDS` 穷举断言追加 `"PKG04"`（pkg04 票注册 TASKS 时漏更），沿用文件内 ruling #5 补记先例并加注释。

## 三、finding → 修复映射与关键实现口径

- **R4-1**：镜像 installs 表补 `uniqueIndex("enterprise_package_install_scope_id_uq").on(tenantId, workspaceId, id)`（PKG03 `package_grant_table` 步权威的镜像），typed parity 测试钉名。live DB 断言在 pkg03 DDL 用例（`indexColumns` 恰为三列）。
- **R4-2**：PKG03 尾部追加 `package_grant_pk_tool_ref`；既有行 tool_ref 全为 `''`，旧 PK 唯一 ⇒ 新 PK 唯一，对存量等价、唯一性放宽（expand-compatible）；镜像 `primaryKey` 加 `toolRef`；`schema-drizzle-parity.test.ts` 新增 typed 断言；pkg03 组正测两条 tool_ref 共存 + 重复拒绝 + skill 行为不变。测试库已重放（见 §四 数据库证据）。
- **R4-3**：plan→apply 最长 10 分钟窗口内的 connector install 删除，原先会以 `enterprise_package_link_connector_fk`（restrict）裸 FK 错误冒出（被错误分类器判为 500 INTERNAL）。修复后 apply 在同一写事务内复验，缺失抛品牌化 `CONNECTOR_INSTALL_MISSING`，路由层 409 + 固定文案。驱动测试证明零 link/installs/changes 残留、plan 可重用。
- **R4-4**：`CREATE OR REPLACE` 发布强化版函数（不改已入账步骤）。递归键名扫描与文件内 `package_hardening` 既有 CHECK 的 jsonpath 风格对齐并加 `flag "i"`。三个直调穿透样本全部 `PKG_EXPERT_REMOTE_FORBIDDEN`；正常模板 default_config 仍可创建；ACL 测试（PUBLIC 零 EXECUTE、operator 独占）在强化版发布后依旧全绿（OR REPLACE 不动 ACL）。
- **R4-5**：索引路径改由 config 提供，默认绝对路径与原解析等价（config.ts 与 index.ts 同在 `server/src/`，`../../plugins/marketplace.json` 落点相同）。Docker COPY 缺口不在本票（PKG11 受阻票已记录）。
- **R4-6**：镜像 action CHECK 对齐权威六值（权威步骤 `package_changes_grant_actions` + `package_changes_create_expert_action`）；头注释从"五张表（编号错位）"改为实际八张表并重排；drizzle.config 定位矛盾按 F1 既定裁决改写为"parity 守护下的受控 generate 源"。

## 四、验证证据（全部 fresh）

环境：容器 `openbot-enterprise-test-pg`（127.0.0.1:5435，`openbot_enterprise_test`），env 来自仓库根 `.env`（bun 自动加载）。

### 4.1 native（Node 层，e2e tools-only target）

```
E2E_UNIT_OUTPUT=.e2e/r4-backend-native bunx e2e run --config e2e.unit.config.ts \
  server/tests/schema-drizzle-parity.test.ts server/tests/package-install-routes.test.ts \
  server/tests/package-read-routes.test.ts server/tests/package-grants-routes.test.ts \
  server/tests/package-expert-routes.test.ts server/tests/package-catalogue.test.ts \
  server/tests/package-artifact.test.ts

 ✓ server/tests/package-grants-routes.test.ts (19 tests)
 ✓ server/tests/package-expert-routes.test.ts (15 tests)
 ✓ server/tests/package-read-routes.test.ts (16 tests)
 ✓ server/tests/schema-drizzle-parity.test.ts (2 tests)
 ✓ server/tests/package-install-routes.test.ts (25 tests)
 ✓ server/tests/package-catalogue.test.ts (25 tests)
 ✓ server/tests/package-artifact.test.ts (31 tests)
 Test Files  7 passed (7)
      Tests  133 passed (133)
```

证据目录：`.e2e/r4-backend-native/`（独立命名，`report.json` status=passed）。
简报原列的 `server/tests/package-storage.test.ts` 在仓库中不存在——该存储套件在 `server/tests/multitenancy/package-storage.test.ts`，属 Bun 驱动层（pkg02 组），按"按实际触碰面增减"在驱动层执行（见 4.2）。

### 4.2 driven（Bun 层，真实受限角色，e2e 统一调度与报告）

```
E2E_UNIT_OUTPUT=.e2e/r4-backend-driven-pkg02 E2E_BUN_ONLY='server/tests/multitenancy pkg02' \
  bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
  → passed："bun runtime suite server/tests/multitenancy pkg02"

E2E_UNIT_OUTPUT=.e2e/r4-backend-driven-pkg03 E2E_BUN_ONLY='server/tests/multitenancy pkg03' …
  → passed：pkg03 与 pkg03b 两条组断言均过（子串过滤同时命中两组，见偏差 4）

E2E_UNIT_OUTPUT=.e2e/r4-backend-driven-pkg04 E2E_BUN_ONLY='server/tests/multitenancy pkg04' …
  → passed："bun runtime suite server/tests/multitenancy pkg04"
```

bun 层用例数（`bun test ./…` 直接对照，驱动层同文件同进程语义）：pkg02 组 35 pass / 0 fail；pkg03 16 pass；pkg03b 8 pass；pkg04 15 pass。skipped 为 0（环境就绪，无静默跳过）。
证据目录：`.e2e/r4-backend-driven-pkg02|pkg03|pkg04/`（`report.json` status 均为 passed）。

### 4.3 数据库证据（DDL 追加步骤重放）

首次驱动跑经 `applyPackageTasks()`（dry-run → manifest → --apply）把 PKG03 六步、PKG04 五步全部应用：

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conname='enterprise_package_grant_pk';
-- enterprise_package_grant_pk | PRIMARY KEY (tenant_id, install_id, generation, bot_id, resource_id, tool_ref)

select task_id, count(*) from mt_task_migration_journal
 where task_id in ('PKG03','PKG04') group by task_id;
-- PKG03 | 6 ；PKG04 | 5

select position('flag "i"' in prosrc) from pg_proc … proname='openbot_create_package_expert';
-- 1206  （强化版已发布）
```

追加纪律证据：`git diff HEAD -- server/scripts/multitenancy/migrate-test.ts` 零删除行（对 BASE 纯追加，已入账步骤逐字未动）；对已迁移库重放当前计划：

```
PKG03 "up-to-date" ; PKG04 "up-to-date"   （journal 与含追加步骤的当前计划逐步骤一致）
```

journal 前缀+追加语义的单元守卫（`validateJournalAgainstPlan` 等 10 条 journal 测试）在新计划下全绿。

### 4.4 门禁

`bun run --filter server typecheck`（原文引用，共 3 条，均为既有 bootstrap 错误，零新增）：

```
server typecheck: scripts/bootstrap-local-gateway.ts(106,52): error TS2339: Property 'result' does not exist on type 'GatewayProbeRun'.
server typecheck:   Property 'result' does not exist on type '{ ready: false; reasonCode: GatewayProbeNotReadyReasonCode; }'.
server typecheck: scripts/bootstrap-local-gateway.ts(108,53): error TS2339: Property 'result' does not exist on type '{ ready: false; reasonCode: GatewayProbeNotReadyReasonCode; }'.
server typecheck: scripts/bootstrap-local-gateway.ts(120,74): error TS2339: Property 'reasonCode' does not exist on type 'GatewayCapabilityNegotiationRun'.
server typecheck:   Property 'reasonCode' does not exist on type '{ negotiated: true; negotiation: GatewayCapabilityNegotiation; }'.
```

（grep "error TS" 计数 = 3。）

`bunx biome lint <触碰文件>`：除 `server/src/index.ts` 外 13 个文件全部干净（"Checked 13 files in 30ms. No fixes applied."，无 error/warning）。index.ts 详见偏差 5。

## 五、偏差与遗留

1. **简报 native 清单中的 `server/tests/package-storage.test.ts` 不存在**：实际为 `server/tests/multitenancy/package-storage.test.ts` 且属驱动层（pkg02 组）。已在驱动层执行并以 bun 直跑对照计数（35 pass）。
2. **既有缺口补记（超出 R4-1..R4-6 字面清单，一行）**：`server/tests/multitenancy/migration-tool.test.ts` 的 `ALLOWED_TASK_IDS` 穷举断言缺少 `"PKG04"`——pkg04 票把 `PACKAGE_EXPERT_TASK` 注册进 TASKS 时漏更该断言，BASE+工作区状态下该断言为红。按文件内 ruling #5 补记先例追加 `"PKG04"` 并加注释（"PKG04（#463 brief 预授权，R4-backend 补记）"）。已用 `bun test -t "the allowlist is exactly the registry…"` 单测确认转绿（1 pass）。
3. **R4-3 错误码落点**：简报建议码 `CONNECTOR_INSTALL_MISSING`，但本票禁改 `shared/`，shared 的 `PackageErrorCodes` 闭集不能扩张。落点：服务端内部码 `PACKAGE_INTERNAL_ERROR_CODES`（server contracts），与 shared 码共用品牌化 `PackageServiceError`，路由层独立 status/message 表映射 409。shared 契约零变更；若后续票愿扩 shared 闭集，可直接收编该码（迁移为一行改动）。
4. **pkg03 证据运行同时覆盖 pkg03b**：`E2E_BUN_ONLY` 是子串过滤，`… pkg03` 同时命中 `server/tests/multitenancy pkg03` 与 `… pkg03b` 两个组名；报告目录 `.e2e/r4-backend-driven-pkg03/` 内含两条组断言，均 passed。
5. **`server/src/index.ts` biome 非 clean（既有）**：该文件带 3 errors + 2 warnings（`suspicious/noConsole` ×3 @1014/1042/1076、`style/noNonNullAssertion` ×2 @5397/6956）。将 BASE `9057aeeb` 的文件内容落盘 lint 对照：同样 3 errors + 2 warnings（@1004/1032/1066/5298/6856，行号平移）。全部为本票触碰区（~1145-1152）之外的既有 findings，本票零新增；其余 13 个触碰文件干净。
6. **journal 追加转换的端到端演示受挫（非阻断）**：曾尝试在自建 scratch 库上做"旧 journal → 含追加步骤的新计划"重放演示，scratch 库缺 drizzle 基础 schema（MT004 依赖 `enterprise_workspaces`），完整重建超出探测范围，已放弃并删除 scratch 库（容器内仅剩 `openbot_enterprise_test` 一库）。追加纪律以三重证据替代：纯追加 diff（零删除行）、journal 单元守卫全绿、已迁移库上六/五步计划 `up-to-date` 重放。
7. **遗留（按裁决归位）**：Docker 镜像未 COPY `plugins/` 的部署缺口归 PKG11（受阻票）；R4-7..R4-9 为 frontend 实现者范围，本票未触碰。

## 六、复核入口

- 工作区 diff：`git diff HEAD -- server/`（含并行会话对 server 的既有未提交改动；本票触碰文件清单见 §二）。
- 证据目录：`.e2e/r4-backend-native/`、`.e2e/r4-backend-driven-pkg02/`、`.e2e/r4-backend-driven-pkg03/`、`.e2e/r4-backend-driven-pkg04/`。
