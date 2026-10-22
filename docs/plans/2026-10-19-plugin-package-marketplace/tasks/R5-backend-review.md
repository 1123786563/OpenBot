# R5-backend 独立复审报告（R5-1..R5-4）

角色：独立 backend reviewer（只读复审；除本报告外零文件写入）。
工作区 `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`，BASE `9057aeeb`。
复审日 2026-10-20。输入：`ocr/ocr-fix-plan-round5.md`、`tasks/R5-backend-report.md`、`docs/adr/0008-test-runner-tester-army-e2e.md`。
全部验证为 **fresh 重跑**（非采信实现者证据），证据目录使用 reviewer 自己的命名：`.e2e/r5-review-native`、`.e2e/r5-review-driven-pkg02|pkg03|pkg04`；scratch probe 在 `/tmp/r5-review-probe/`（非仓库文件）。容器仅使用 `openbot-enterprise-test-pg` @127.0.0.1:5435，未触碰他人容器。无 commit/push。

## 结论

| 维度 | 裁决 |
| --- | --- |
| **SPEC compliance** | **PASS** |
| **Code quality** | **PASS** |
| **Blocking findings** | **0** |

## 一、R5-1 路由体上限改 `hono/body-limit`（medium·security）— PASS

代码（`server/src/enterprise/plugin-packages/routes.ts`）：

1. **挂载方式与仓库一致**：`createPluginPackageRoutes` 顶部 `routes.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES /* 128*1024 */, onError }))`（routes.ts:278-293）。与仓库既有模式逐一可比：`openmuse-tasks/routes.ts:265`（`routes.use("*", bodyLimit(...))`）、`responsibilities/routes.ts:29`、`mobile-bff/routes.ts:76`、`memory/routes.ts:21` 等。maxSize=131072 字节，符合 Spec §7 的 128 KiB 字节口径。
2. **onError 语义不变**：返回本面封闭 400 `INPUT_INVALID` 体（`ERROR_MESSAGE.INPUT_INVALID`，不回显请求），未改用 hono 默认 413，未新增错误码；现有 closed-error-body 断言全部绿。
3. **content-length 预检兼容保留**：`parseJsonBody`/`parseOptionalJsonBody`（routes.ts:234-269）保留「非数字拒绝 / >128KiB 拒绝」预检；全文件已无任何可执行的手写 `text.length` 检查（grep 仅命中解释性注释）。`createUnavailablePluginPackageRoutes` 不读体、不加中间件——与报告披露一致。
4. **字节口径双路实证**（读 `server/node_modules/hono/dist/middleware/body-limit/index.js`）：有 content-length（无 transfer-encoding）走头部预检，否则逐块读流按 `value.length`（字节）累计，超限即 onError。两条路都在中间件层闭合。
5. **多字节测试真按字节口径、且旧逻辑确会放行**（`server/tests/package-install-routes.test.ts:419-469`）：测试体内自证 `byteLength > 128*1024` 且 `serialized.length <= 128*1024`（正是旧检查的穿透窗口）；流式（无 content-length）与字符串体（content-length=真实字节）两条路都断言 400 `INPUT_INVALID` 且 service 零调用。**reviewer 独立 probe**（复刻旧逻辑：跳过预检 + `text.length` + schema）：同一构造体 bytes=160,546（超上限）、UTF-16 units=58,146（低于旧上限）、schema 合法 → **旧逻辑 200 到达 service，漏洞确认为真**；实现者报告 §4.4 的数字（160,533/58,133）与 probe 构造细节略有差异但结论一致。
6. **fresh 验证**：native 7 文件 140/140 passed（含本面 install-routes 26、read 16、grants 19、expert 15、catalogue 25、artifact 36、parity 3）——`.e2e/r5-review-native/report.json` run.status=passed，报告内含 multibyte 测试标题。

## 二、R5-2 `authorizeAndRecordCompanyManagementAction` 文档披露（medium·documentation）— PASS

1. **零行为变更属实**：`git diff HEAD -- server/src/enterprise/tenancy/admin-separation.ts`（58+/2-）中，R5-2 对应的两个 hunk（模块头注释第 3 节、函数 docblock「集成状态」段）均为纯注释行；函数体 8 行（authorize → 同事务 insert 审计 → return）与既有语义一致，签名/导出零变化。（文件整体 diff 中的 MANAGEMENT_PLANE_RULES package-admin 条目、平台面空主体 deny 等为前轮改动，非本票。）
2. **披露内容与事实相符**：
   - 「生产零调用」：`grep -rn authorizeAndRecordCompanyManagementAction` 全仓仅命中定义（admin-separation.ts:508）、头注释（:26）与测试（admin-separation.test.ts:35/814/842）——**零生产调用方，属实**。
   - 「plugin-packages 走 CompanyAdminContext」：routes.ts 各写入口 `assertClassifiedCompanyEntrance` + `resolveAdmin`（返回 workspace-admin 的 `CompanyAdminContext`），不经本函数——**属实**。
   - 「域内审计=同事务 `enterprise_package_changes` 回执」：install-service.ts:559、:715 在 `store.transaction(scope, admin, ...)` 事务内 `tx.db.insert(changeRows)`——**属实**。
3. **fresh 验证**：`admin-separation.test.ts` 直跑 22 pass / 8 skip（该套件自身 DB 环境门控，既有行为）/ 0 fail，与报告 §五.6 一致。

## 三、R5-3 build.ts 版本匹配构建 + 历史条目处置（medium·bug）— PASS

代码（`scripts/plugin-packages/build.ts`）分类逻辑与裁决三段逐一对应：

1. **版本匹配构建**：`identityMatches && versionMatches` → 既有构建路径，摘要不符即失败（错误文案原文保留，`--print-digest` 未动）——既有失败语义保持。
2. **manifest↔索引身份校验**：同版本但 `publisher/name` 不符 → 明确报错失败（finding 点名的缺口已闭合）。
3. **历史条目**：版本不符 → 不参与构建，`loadArtifact(outputRoot, digest)` 校验通过报 `verified-historical`；`ARTIFACT_MISSING` → 显式 warn（指明当前源只构建哪个版本、需从发布溯源恢复）不判失败；**存在但校验失败（损坏）→ 判失败**（裁决未覆盖的边界按「宁红勿静默」处理，已在报告 §五.3 披露，方向与裁决同族）。源 manifest 不可读 → 逐条目走既有构建失败路径（保守，fail-closed）。
4. **「最初必败场景」测试真实**（`server/tests/package-artifact.test.ts:566-828`，5 条全部在 fresh native run 中出现并通过）：test 1 就是 finding 原场景（源 1.1.0 + 索引 1.0.0/1.1.0，注释明言 "the exact shape that failed every build before R5-3"）→ 绿 + `verified-historical`；缺失 → 恰 1 条 warn 不失败；源版本摘要不符 → 仍失败；同版本身份不符 → 失败；存储损坏（1.1.0 字节挂在 1.0.0 摘要地址）→ 失败且非 warn。
5. **reviewer 真实目录 probe**：
   - 旧逻辑复刻（每条目都从单一源构建 + 摘要必须相符）跑真实 `plugins/marketplace.json`：`openbot/demo-skill@1.0.0: declared digest b5b2a8e1… does not match computed be9ea955…` → **build FAILED，finding 场景复现**。
   - 新逻辑真实跑（`bun scripts/plugin-packages/build.ts --catalog plugins/marketplace.json --out /tmp/r5-review-store`）：1.1.0 构建成功且 digest 与索引已发布值一致，1.0.0 报 absent-store warn，**exit=0**。
   - CLI 兼容：usage exit=2、构建失败 exit=1（fresh 实测），`import.meta.main` 守卫下直跑行为不变。

## 四、R5-4 PKG02 追加步骤重建三 CHECK 加 `flag "i"`（medium·security）— PASS

1. **追加不触碰已应用步骤**：
   - `git diff HEAD --numstat -- server/scripts/multitenancy/migrate-test.ts` = **584 / 0**（对 BASE 零删除、零改写）。
   - 机械等价证明（对 `buildPlan("PKG02")` 编程比对）：第 4 步 3 条 ADD 语句去掉唯一的 ` flag "i"` 后与第 3 步对应语句**逐字节相同**；regex 字符类/锚点零变化，无任何意外放宽；3 DROP 与 3 ADD 配对。
   - **live 重放**：`TEST_DATABASE_URL=… bun --no-env-file server/scripts/multitenancy/migrate-test.ts migrate PKG02`（dry-run）→ 「已应用 4/4；待应用 0 步」——journal 逐步 digest 与当前计划一致，功能性证明已入账步骤一字未动（任何改写都会被 `validateJournalAgainstPlan` 拒绝）。
2. **DB live 状态**（psql 直查 `openbot_enterprise_test`）：
   - journal：PKG02 = 4 步，第 4 步 `0004_pkg02_package_hardening_case_insensitive.sql` 已增量入账；PKG03=6 步、PKG04=5 步不变。
   - `pg_get_constraintdef`：三个约束定义均含 `flag "i"`（位置 243/265/247）。
3. **镜像/parity 同步**：`server/src/db/schema/enterprise-plugin-packages.ts` 的共享常量 `NO_NESTED_SECRET_CARRIERS_SQL` 已带 `flag "i"`（一处改三处生效）；`server/tests/schema-drizzle-parity.test.ts:97-113` 新增 typed parity（getTableConfig 内省 + PgDialect 渲染，三表 CHECK 均断言 `like_regex` + `flag "i"`），fresh native 绿。
4. **驱动层验证**：pkg02 驱动组 fresh passed（`.e2e/r5-review-driven-pkg02`）；组内两文件 bun 直跑（root cwd，判定只认组内文件）**37 pass / 0 fail / skip=0**——备注：naive `bun test` 会把 44 个 checkpoints 副本（模块解析错误）计入 44 fail，属度量污染而非测试失败，与任务警示一致。
   - 计划结构测试（package-storage.test.ts:83-111）：第 4 步 slug/文件名正确、3 ADD 均带 flag、既有第 3 步语句不含 flag（追加纪律静态证据）。
   - DB 级测试（:538-637）：`pg_get_constraintdef` 三处均含 flag；`{"nested":{"Token":"x"}}` / `{"Nested":{"API_KEY":"x"}}` / `{"n":{"SecretRef":"x"}}` 全部 23514 拒绝；小写 `{"region":"us"}` 可写、用例内验证后删除（保护后续 RLS 行数断言）。
5. pkg03+pkg03b（2 组断言）、pkg04 驱动组 fresh passed；`migration-tool.test.ts`（migrate-test.ts 自身套件，**实现者门禁清单未列**，见 finding-1）reviewer 补跑 41 pass / 1 既有 DB 门控 skip / 0 fail。

## 五、门禁（fresh）

- **typecheck**：`bun run --filter server typecheck` → 恰 3 条 error TS，全部为 `scripts/bootstrap-local-gateway.ts` 既有 bootstrap 错误（106/108/120 行），零新增——与报告 §4.5 逐字一致。
- **biome**：9 个触碰文件 lint 全干净（"Checked 9 files… No fixes applied"）。

## 六、Findings（0 blocking）

| # | severity | blocking | 位置 | 内容 |
| --- | --- | --- | --- | --- |
| 1 | low | no | `tasks/R5-backend-report.md` §4.1/4.2（流程缺口，非代码缺陷） | 实现者门禁未覆盖 `server/tests/multitenancy/migration-tool.test.ts`（被修改生产文件 migrate-test.ts 自身的套件，两个 "part 1/2/3" 驱动组均未跑）；admin-separation 仅以 bun 直跑覆盖。reviewer 已补跑，两者全绿，未酿成缺陷；建议后续修复轮把「被改文件的自身套件」纳入门禁清单。 |
| 2 | low | no | `scripts/plugin-packages/build.ts:101-106,116-120` | `manifest === null` 将「源不可读」与「身份不可证」合并进构建失败路径：该 packageKey 的每个条目各自重复尝试 `buildArtifact` 并各自报错（N 条重复 error 行）。fail-closed 方向正确且已披露，仅输出噪音问题。 |
| 3 | low | no | `server/tests/schema-drizzle-parity.test.ts:109-111` | 镜像 CHECK parity 为包含式断言（`toContain("like_regex")` + `toContain('flag "i"')`），非与权威 DDL 的全文相等；共享常量结构下足以钉住本票差异，沿用 R4 既有模式，非本票引入的缺口。 |
| 4 | info | no | `server/tests/multitenancy/package-storage.test.ts:553-568` | DB 级约束定义断言作用在共享长活测试库上（断言的是上次 migrate 的结果状态）；journal 重放一致性检查（本文 §四.1 的 dry-run 证据）补足了「计划↔库」对账，符合 ADR-0008 的环境证据纪律。观察项，不要求整改。 |

## 七、证据索引（reviewer fresh）

- `.e2e/r5-review-native/report.json` — native 7 文件 140/140 passed；含 multibyte、5 条 buildMarketplaceArtifacts、R5-4 parity 测试标题。
- `.e2e/r5-review-driven-pkg02|pkg03|pkg04/report.json` — 三驱动组 passed。
- 容器直查 — journal（PKG02 4 步 / PKG03 6 / PKG04 5）与三约束 `flag "i"`（位置 243/265/247）。
- `/tmp/r5-review-probe/`（仓库外）— 旧 body-limit 逻辑 probe（漏洞确认为真）、旧 build 循环 probe（真实目录 finding 场景复现）、新 build 真实跑（exit 0）、CLI exit code（2/1）实测。
- `git diff HEAD` — migrate-test.ts 584/0；admin-separation.ts 的 R5-2 hunks 纯注释。
