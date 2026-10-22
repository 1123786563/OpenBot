# R5-backend 执行报告 — OCR round4 修复（R5-1..R5-4）

角色：backend_implementer。工作区 `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`（分支 `feat/plugin-package-market-v1`，BASE `9057aeeb`）。执行日 2026-10-20。
**无 commit/push/stash**——全部变更停留在工作区；未触碰 `app/`、`shared/`、`docs/plans` 其他文件、任何他人容器（仅使用指定容器 `openbot-enterprise-test-pg` @127.0.0.1:5435）。

## 一、结论速览

| 项 | 严重度 | 结果 |
| --- | --- | --- |
| R5-1 路由体上限改 `hono/body-limit`（字节口径）+ 多字节拒绝测试 | medium·security | **done** |
| R5-2 `authorizeAndRecordCompanyManagementAction` 文档披露（零行为变更） | medium·documentation | **done** |
| R5-3 build.ts 版本匹配构建 + 历史条目 store 校验/warn | medium·bug | **done** |
| R5-4 PKG02 追加步骤重建三个秘密载体 CHECK 加 `flag "i"`（镜像/parity 同步） | medium·security | **done** |

门禁：typecheck 仅既有 3 个 bootstrap 错误（原文见 §四.5）；触碰文件 biome 全部干净；fresh 验证全绿（native 140 通过，driven pkg02/pkg03+pkg03b/pkg04 全过，bun 直跑计数 37/16/8/15、skip=0）；`git diff` 对 migrate-test.ts **零删除行**（584 insertions / 0 deletions，含前轮 563 行，本轮纯追加 21 行）。

## 二、变更清单（本票触碰的文件）

生产代码：

1. `server/src/enterprise/plugin-packages/routes.ts` — R5-1：`createPluginPackageRoutes` 顶部挂载 `routes.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES /* 128*1024 */, onError }))`，onError 返回与本面既有完全一致的封闭 400 `INPUT_INVALID` 体（对照 memory/learning/openmuse-tasks 等 18 个路由模块的既有 `hono/body-limit` 用法）；`parseJsonBody`/`parseOptionalJsonBody` 删除手写 `text.length`（UTF-16 码元）检查，**保留既有 content-length 预检**（计划要求的兼容口径）。`createUnavailablePluginPackageRoutes` 不读体，不加中间件。
2. `server/src/enterprise/tenancy/admin-separation.ts` — R5-2：**仅注释**。模块头注释（第 3 节）与 `authorizeAndRecordCompanyManagementAction` 函数 docblock 补记：意图消费方（MT019 族跨面管理动作接线方）、当前集成状态（生产零调用，grep 实证，仅测试消费）、plugin-packages 为何不经它（PKG02/03/04 按 Spec 走 `CompanyAdminContext` assert+resolve，域内审计=同事务 `enterprise_package_changes` 回执，PKG03/04 已测；不属于本函数绑定的 `enterprise_security_events` 跨面审计通道）、首个跨面消费方接线时必须经此入口。零行为变更，未接线。
3. `scripts/plugin-packages/build.ts` — R5-3：核心循环重构为 `buildMarketplaceArtifacts(catalogPath, outputRoot, emit?)`（导出，返回 failed 布尔；`emit` 收集器使 CLI 输出与测试断言同源；CLI 入口 `main()` 行为不变，自动执行改由 `import.meta.main` 守卫，测试可安全 import）。分类逻辑：每个 packageKey 先读源 `openbot.plugin.json` 身份（缓存一次）；`身份+版本` 与索引条目匹配 → 走既有构建路径（`buildArtifact` + 摘要必须相符，不符即失败的既有语义不变，`--print-digest` 不动）；同版本但身份不符 → 明确报错失败（manifest↔索引身份校验，finding 点名的缺口）；**版本不符 = 历史条目**：不参与构建，`loadArtifact(outputRoot, digest)` 校验通过报 `verified-historical`、`ARTIFACT_MISSING` 显式 warn（不判失败），存在但校验失败（存储损坏）→ 判失败。
4. `server/scripts/multitenancy/migrate-test.ts` — R5-4：**纯追加**。PKG02 任务尾部（`package_hardening` 之后）追加步骤 `package_hardening_case_insensitive`（第 4 步，文件名 `0004_pkg02_package_hardening_case_insensitive.sql`）：对 `enterprise_package_revision_config_shape` / `enterprise_package_plan_input_shape` / `enterprise_package_change_diff_shape` 三个 CHECK 各 `DROP CONSTRAINT IF EXISTS` + 原文重建、唯一差异是 like_regex 追加 `flag "i"`；任务头注释补记一行（纯插入行）。已入账三步文本一字未动（`git diff --numstat` = 584/0，其中本轮 21 行全部为插入）。
5. `server/src/db/schema/enterprise-plugin-packages.ts` — R5-4 镜像同步：`NO_NESTED_SECRET_CARRIERS_SQL` 加 `flag "i"` 并更新注释（三个秘密载体 CHECK 共用此常量，一处改三处生效），与权威 DDL 保持 lockstep（R4-1/R4-2/R4-6 镜像对齐先例）。

测试：

6. `server/tests/package-install-routes.test.ts` — R5-1：新增「rejects a multibyte body by byte count under the UTF-16 code-unit cap」：构造 400 条 `connectorInstalls`（键 `tool-NNNNNN`、值 128 个 `漢`）的计划体（**160,533 字节 > 131,072 上限，58,133 UTF-16 码元 < 旧检查上限**，schema 全程合法），流式无 content-length 请求经中间件按字节拒 400 `INPUT_INVALID`；字符串体（content-length=真实字节数）经预检同样 400；断言 service 零调用。**判别力实证**：同一体喂给旧 `text.length` 逻辑（scratch probe）→ 200 到达 service（§四.6）。
7. `server/tests/package-artifact.test.ts` — R5-3：新增 `describe("buildMarketplaceArtifacts")` 5 条（复用文件内 tmp 目录基建）：双版本目录+源 1.1.0 → 只构建 1.1.0、1.0.0 报 `verified-historical` 且整体绿（旧逻辑此场景必败，即 finding 原场景）；历史条目缺存 → warn 一条、不失败、当前版本照常入库；源版本条目摘要不符 → 失败（既有语义）；同版本身份不符 → 失败；存储内历史制品损坏（1.1.0 字节挂在 1.0.0 摘要地址下）→ 失败且非 warn。
8. `server/tests/schema-drizzle-parity.test.ts` — R5-4：新增 typed parity 断言：镜像三个秘密载体 CHECK（`getTableConfig` 内省 + `PgDialect.sqlToQuery` 渲染）均含 `like_regex` 与 `flag "i"`。
9. `server/tests/multitenancy/package-storage.test.ts` — R5-4（pkg02 驱动组）：新增（a）非 DB 计划结构测试：`buildPlan("PKG02")` 第 4 步 slug/文件名正确、3 条 ADD 均带 `flag "i"`、既有第 3 步 `package_hardening` 语句不含 `flag "i"`（追加纪律的静态证据，改写会被 journal digest 校验拒绝）；（b）DB 级用例：`pg_get_constraintdef` 三个约束定义均含 `flag "i"`；`{"nested":{"Token":"x"}}`（revision config）、`{"Nested":{"API_KEY":"x"}}`（plan canonical_input）、`{"n":{"SecretRef":"x"}}`（change diff）全部 23514 拒绝（修复前大小写敏感正则放过的大写变体）；小写正常键（`{"region":"us"}`）仍可写入并在用例内验证+清理（保护后续 RLS 行数断言）。

## 三、finding → 修复映射与关键实现口径

- **R5-1**：手写 `text.length` 是 UTF-16 码元数，多字节请求体可在「码元≤128Ki 且字节>128Ki」区间穿透；仓库统一防线是 `hono/body-limit`（18 个路由模块在用，grep 实证）。中间件挂在面级 `routes.use("*", ...)`，maxSize=`128*1024` 精确字节；无 content-length 时中间件逐块读流计字节，有 content-length 时头部预检——两条路都覆盖。`parseJsonBody` 的 content-length 预检按计划原文保留（拒绝行为兼容：本面超限响应保持封闭 400 `INPUT_INVALID`，不改 413）。onError 走 `context.json` 固定体，不回显请求。
- **R5-2**：裁决=文档披露不接线。改动仅两处注释块；`grep -rn authorizeAndRecordCompanyManagementAction server/src shared app scripts` 只命中定义与头注释（零生产调用），测试侧唯一消费方 `admin-separation.test.ts`。功能、签名、导出零变化。
- **R5-3**：裁决三段逐一落地：①仅构建与源 manifest `版本+身份` 匹配的条目，摘要不符即失败（既有语义保持，错误文案原文不变）；②同 packageKey 历史条目不参与构建，store 存在→`loadArtifact` 重哈希校验→`verified-historical`；③缺失→`console.warn` 级显式提示（指明当前源只构建哪个版本、需从发布溯源恢复），不判失败。两点裁决未覆盖的边界按保守口径处理并记录：历史条目**存在但校验失败**（内容损坏）判失败（列出的 digest 不得指向损坏字节）；源 manifest 不可读时逐条目走既有构建失败路径（`buildArtifact` 自身错误信息）。marketplace 索引中真实的 `openbot/demo-skill` 1.0.0+1.1.0 双条目即 finding 原场景，修复后构建整体转绿。
- **R5-4**：与 R4-4（`package_expert_create_function_hardening`）同一漏洞家族、同一追加纪律。journal 校验是「已应用编号必须是计划的连续前缀且 digest 逐步骤一致」——追加在第 4 步天然满足；共享测试库上首次跑pkg02 组即完成增量应用（journal 1→4 实证），重放为 `up-to-date`。镜像 `NO_NESTED_SECRET_CARRIERS_SQL` 与 parity 测试同步（计划项「核对镜像/parity 是否触及」的答案：触及，已同步）。CHECK 只约束写入，既有行不受影响（DROP+ADD 不改行数据）。

## 四、验证证据（全部 fresh，独立目录 `.e2e/r5-backend-*`）

环境：容器 `openbot-enterprise-test-pg`（127.0.0.1:5435，`openbot_enterprise_test`），env 来自仓库根 `.env`（bun 自动加载）。

### 4.1 native（Node 层，e2e tools-only target）

```
E2E_UNIT_OUTPUT=.e2e/r5-backend-native bunx e2e run --config e2e.unit.config.ts \
  server/tests/schema-drizzle-parity.test.ts server/tests/package-install-routes.test.ts \
  server/tests/package-read-routes.test.ts server/tests/package-grants-routes.test.ts \
  server/tests/package-expert-routes.test.ts server/tests/package-catalogue.test.ts \
  server/tests/package-artifact.test.ts

 ✓ server/tests/package-grants-routes.test.ts (19 tests)
 ✓ server/tests/package-expert-routes.test.ts (15 tests)
 ✓ server/tests/package-read-routes.test.ts (16 tests)
 ✓ server/tests/schema-drizzle-parity.test.ts (3 tests)
 ✓ server/tests/package-install-routes.test.ts (26 tests)
 ✓ server/tests/package-catalogue.test.ts (25 tests)
 ✓ server/tests/package-artifact.test.ts (36 tests)
 Test Files  7 passed (7)
      Tests  140 passed (140)
```

证据目录：`.e2e/r5-backend-native/`（`report.json` run.status=passed）。

### 4.2 driven（Bun 层，真实受限角色，e2e 统一调度与报告）

```
E2E_UNIT_OUTPUT=.e2e/r5-backend-driven-pkg02 E2E_BUN_ONLY='server/tests/multitenancy pkg02' \
  bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
  → passed："bun runtime suite server/tests/multitenancy pkg02"
E2E_UNIT_OUTPUT=.e2e/r5-backend-driven-pkg03 E2E_BUN_ONLY='server/tests/multitenancy pkg03' …
  → passed：pkg03 与 pkg03b 两条组断言均过（子串过滤同时命中两组）
E2E_UNIT_OUTPUT=.e2e/r5-backend-driven-pkg04 E2E_BUN_ONLY='server/tests/multitenancy pkg04' …
  → passed："bun runtime suite server/tests/multitenancy pkg04"
```

bun 直跑对照（判定只认组内文件；`bun test` 显式传文件路径，恰好 2/1/1/1 个文件，无 checkpoints 副本混入）：pkg02 组 **37 pass / 0 fail**（R4 基线 35 + 本票 2）；pkg03 **16 pass / 0 fail**；pkg03b **8 pass / 0 fail**；pkg04 **15 pass / 0 fail**。skip=0（环境就绪，无静默跳过）。
证据目录：`.e2e/r5-backend-driven-pkg02|pkg03|pkg04/`（report.json run.status 均 passed）。

### 4.3 数据库证据（R5-4 追加步骤在真实库上的增量应用）

```
select task_id, number, name from mt_task_migration_journal where task_id='PKG02' order by number;
-- 1  0001_pkg02_package_tables.sql
-- 2  0002_pkg02_package_rls_policies.sql
-- 3  0003_pkg02_package_hardening.sql
-- 4  0004_pkg02_package_hardening_case_insensitive.sql   ← 本票追加步骤已增量应用
-- （PKG03=6 步、PKG04=5 步不变；重放当前计划 = up-to-date）

select conname, position('flag "i"' in pg_get_constraintdef(oid)) from pg_constraint
 where conname in ('enterprise_package_revision_config_shape',
                   'enterprise_package_plan_input_shape',
                   'enterprise_package_change_diff_shape') order by conname;
-- enterprise_package_change_diff_shape    | 243
-- enterprise_package_plan_input_shape     | 265
-- enterprise_package_revision_config_shape| 247   （三处定义均含 flag "i"）
```

大写变体写入（`"Token"` / `"API_KEY"` / `"SecretRef"`，各自嵌套一层）在真实受限通道上全部 23514 拒绝、小写正常键可写（pkg02 组 DB 用例，见 §二.9b）。

### 4.4 R5-1 判别力实证（scratch probe，非仓库文件）

```
同一请求体：bytes=160533, utf16-units=58133, cap=131072
旧逻辑（content-length 预检 + text.length + schema）+ 流式请求 → 200 {"why":"reached-service"}
新面（hono/body-limit 中间件，同请求）→ 400 INPUT_INVALID，service 零调用（native 用例断言）
```

### 4.5 门禁

`bun run --filter server typecheck`（fresh，原文引用，共 3 条，均为既有 bootstrap 错误，零新增）：

```
server typecheck: scripts/bootstrap-local-gateway.ts(106,52): error TS2339: Property 'result' does not exist on type 'GatewayProbeRun'.
server typecheck:   Property 'result' does not exist on type '{ ready: false; reasonCode: GatewayProbeNotReadyReasonCode; }'.
server typecheck: scripts/bootstrap-local-gateway.ts(108,53): error TS2339: Property 'result' does not exist on type '{ ready: false; reasonCode: GatewayProbeNotReadyReasonCode; }'.
server typecheck: scripts/bootstrap-local-gateway.ts(120,74): error TS2339: Property 'reasonCode' does not exist on type 'GatewayCapabilityNegotiationRun'.
server typecheck:   Property 'reasonCode' does not exist on type '{ negotiated: true; negotiation: GatewayCapabilityNegotiation; }'.
```

（grep "error TS" 计数 = 3。注：`server/tsconfig.json` include 覆盖 `src`/`scripts`，不含 `server/tests/*.test.ts`——测试文件以 bun 运行时为门禁。）

`bunx biome lint <9 个触碰文件>`：全部干净（"Checked 9 files in 13ms. No fixes applied."，无 error/warning）。

追加纪律证据：`git diff HEAD --numstat -- server/scripts/multitenancy/migrate-test.ts` = `584  0`（对 BASE 纯追加，已入账步骤逐字未动）。

## 五、偏差与遗留

1. **e2e-compat 无非对称匹配器**：初版 artifact 测试用 `expect.stringContaining` 数组断言被 compat 层拒绝（ADR 所述刻意缺口），改为 `toHaveLength` + `toContain` 显式断言，语义等价。
2. **驱动层组级 junit 折叠的盲区（观察，非本票缺陷）**：pkg02 驱动组首跑时，`package-storage.test.ts` 存在一个坏 import（本票笔误，`../../../scripts` 应为 `../../scripts`），bun 直跑当场红（`Cannot find module`），而驱动组断言仍 passed（bun junit 将文件级收集错误折进组文本的方式未被判定为组失败）。已修复并重跑；该盲区值得主控复核时知悉——bun 直跑对照不是可省步骤。
3. **R5-3 两处裁决未覆盖边界按保守口径处理**：历史条目存在但校验失败 → 判失败（非 warn）；源 manifest 不可读 → 走既有构建失败语义。均为「宁红勿静默」方向，与裁决的失败语义同族。
4. **R5-3 需要最小可测重构**：`buildMarketplaceArtifacts` 提取 + `emit` 收集器 + `import.meta.main` 守卫。CLI 参数、usage、退出码（2=用法错、1=构建失败）、逐条目 console 行为与原版一致；自动执行改守卫后 `bun scripts/plugin-packages/build.ts` 行为不变。
5. **storage 测试的正向对照行**：`{"region":"us"}` 探针行会在同文件后续 RLS 行数断言中多算一行，已在用例内验证后删除并加防残留清理（防上次中断运行遗留）。
6. **R5-2 skip 说明**：admin-separation 套件 bun 直跑 30 tests / 0 fail / 8 skip——8 条 skip 为该套件自身的 DB 环境门控（既有行为，与本票注释改动无关）；本票改动为纯注释，零行为。
7. **遗留（按裁决归位）**：R5-5..R5-8 为 frontend 实现者范围，本票未触碰；round4 22 low 项维持 park。

## 六、复核入口

- 工作区 diff：`git diff HEAD -- server/ scripts/`（含并行会话既有未提交改动；本票触碰文件清单见 §二，共 9 个）。
- 证据目录：`.e2e/r5-backend-native/`、`.e2e/r5-backend-driven-pkg02/`、`.e2e/r5-backend-driven-pkg03/`、`.e2e/r5-backend-driven-pkg04/`。
