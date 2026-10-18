# MT075 复审报告 — 独立复审（Issue #118 平台/公司管理分离）

- 复审者：MT075 独立复审 worker（Pi，Orca Task `task_e5418bad8e47` / Dispatch `ctx_b5d2ce61bd49`），全新会话，与实现者（`task_3e6ccb21018b`）无共享上下文。
- 日期：2026-10-18。BASE：`f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（本工作树 HEAD 实测；分支 `1123786563/i7-review-mt075`）。
- 输入：brief `briefs/MT075-review-brief.md`（七项裁决 A–G + 独立复跑清单）+ 实现 brief `briefs/MT075-brief.md` + `reports/MT075.md` + `checkpoints/MT075/` 全套 + 被审五交付文件本体。
- 复审约束遵守：只读被审文件；唯一新建 = 本报告；不修复；无提交/推送/合并。两处受控实验（MT014 缺失件补齐、MUT5 变异复验）均为**临时状态**，收尾已逐字节还原并复验（见 §2.8）。

---

## 1. 交付物与前置完整性核验

- **prereq-manifest 36 项逐文件 SHA-256 复算**：34 项与当前字节一致；仅 2 项漂移 = `inventory.ts`、`workspace-scope-routes.ts`——恰为本票授权扩展的两个文件。
- 漂移文件的当前哈希（`4f1ec9f8…` / `19f2084d…`）与 `checkpoints/MT075/before-after-hashes.txt` 的 after 值**逐字节一致**；两个"零改动"声称文件 `workspace-admin.ts`（`731a30e6…`）、`index.ts`（`addc265c…`）与 before/prereq 哈希一致，零改动坐实。
- 五交付文件当前哈希与 after-hashes 全部一致：`admin-separation.ts` `9253bae5…`、`admin-separation.test.ts` `cd140fe1…`、`support/admin-separation.ts` `98b4fbc8…`。
- 证据链版本对齐：review brief 声称前置 36 项，MT075 报告声称领取时 34 项——当前 manifest 36 项中 `runtime-config.test.ts` 与 `support/runtime-config.ts` 为 manifest 后补的并行票测试侧条目（见 §4 Finding-1），非 MT075 报告失实。
- `checkpoints/MT075/sha256-manifest.txt` 18 项工件哈希逐一复算全部一致（`reports/MT075.md` 自身哈希 `a9a3e8be…` 亦复现）。

## 2. 独立复跑记录（全部亲自执行，退出码实测）

环境：端口 55487 预检空闲（lsof 无占用）；容器 `mt075-review-pg`（pgvector/pgvector:pg16，trust + 随机口令，仅回环映射）；psql `select version()` 探针 = PostgreSQL 16.15；主库 `openbot_enterprise_mt075_review` 与 assigned 库 `…_assigned` 各 base migrate 一次通过（exit 0）；五变量 URL 显式用户 + 随机口令，env 文件 0600（`/tmp/mt075-review/`），用后删除。

| # | 步骤 | 实测结果 | exit |
| --- | --- | --- | --- |
| 1 | base migrate（主库 + assigned 库） | `{"type":"migrations-applied","status":"ok"}` ×2 | 0 / 0 |
| 2 | apply MT004→MT008→MT112→MT012（generate → `--apply --manifest` 逐票） | applied 2+2+4+2 步全部记入 journal；MT012 planDigest `dbdb978a…` 与 MT012-review 记录一致 | 0 |
| 3 | `bun --no-env-file test tests/multitenancy/admin-separation.test.ts --timeout 30000` | **25 pass / 0 fail / 0 skip**，164 expect（与实现者存档逐项一致） | 0 |
| 4 | `bun --no-env-file test tests/config.test.ts`（裁决 F-①） | **140 pass / 1 fail**（141 用例；失败 = Google auth 部署契约断言，裁定见 §3-F） | 1 |
| 5 | 全量 `bun --no-env-file test tests/multitenancy/ --timeout 30000` | 树内原样：359 pass / 1 fail(module 缺失 error) / 14 文件；**补齐 MT014 缺失 src 后：388 pass / 0 fail / 0 skip / 14 文件 / 8760 expect** = 363+25（见 §4 Finding-1） | 0 |
| 6 | typecheck（`tsc --noEmit`） | Exited with code 0 | 0 |
| 7 | biome check 5 触及文件 | Checked 5 files. No fixes applied. | 0 |
| 8 | CLI 清单重新生成 + digest 对比 | **digest `e517f74331aba5f81a42ad0e2a3e4fa0a6eeb3adaa7c2c7163427f96cdc183cd` 精确复现**，与 `checkpoints/MT075/inventory-after.json` 唯一差异键 = `generatedAt`（时间戳）；544 入口 / 153 数据表 / 24 闭环全部一致 | 0 |
| 9 | MUT5 变异复验（平台面放行公司管理员） | AC1 用例 `deployment admin and platform operator pass; company admin is refused` fail（24 pass / 1 fail）；还原后 25/0/0 复绿，文件 SHA-256 还原为 `9253bae5…` 逐字节一致 | — |

补充：容器内曾出现一次 `eventsource` 包缺失——本 review 工作树新建后从未 `bun install`，属环境缺失非交付缺陷；`bun install --frozen-lockfile`（1415 packages）后一切可复现。

## 3. 七项裁决逐项

### A. 分类完备性与真实性 — ✅ 通过
- **47/4 独立对账**：从重新生成的清单独立枚举——platform 47 = `/api/admin/*` 44 条（真实 Hono 路由表）+ SCIM 写动词 3 条（PUT/PATCH/DELETE `/api/auth/scim/*`，在清单内）；company 4 = workspace-scope admin 四条管理入口；workspace-scope 第 5 入口 `GET /`（自服务列出）不分类，正确。总入口 544 = MT001 的 539 + 5，unclassified 0，闭环 23→24（新增 `workspace-admin`）。
- 装配盲区闭合语义核实（inventory.ts diff，与并行树 i7-mt010 持有的 before 版本 `e58bde59…` 逐字节 diff）：`coworkerBag.enterpriseWorkspaceScope` 用**真实路由工厂**装配（authenticate 恒 null、admin 通道缺省 = 清单里的 503 形态），不伪造可用；5 处编辑全部为加法，无既有行为改动。
- 超出路由表的管理入口：SSO 三条登记路径（better-auth 面，在 `POST /api/auth/*` catchall 之内，Hono 路由表不可枚举）由规则表 `pathPattern` 精确登记，实现者已披露；运行时另有 `ADMIN_ONLY_AUTH_ROUTES` 守卫（方法无关）在前。无遗漏的管理入口面发现。

### B. 双面判定语义 — ✅ 通过
- 平台面：`company_admin` → deny `PLATFORM_ADMIN_REQUIRED`；deny 决策对象仅含 `{outcome, code, plane}`，无任何 actor/tenant/上下文细节——错误码不泄露。未分类入口两面均 deny `MANAGEMENT_ENTRANCE_UNCLASSIFIED`（plane=null），fail-closed 成立（测试正反两向钉死 + 我的 MUT5 复验证明放行会被测试捕获）。
- 公司面：受信上下文（`assertTrustedAdminContext` WeakSet 信任边界，只读消费 MT006 签发半边）+ `context.tenantId === 目标 tenantId` 双重校验；伪造上下文与它公司上下文均 deny（真实库用例覆盖）。
- 显式三维绑定授权：subject × tenantId × entrance 三维 `===` 精确匹配、无通配；异主体/异公司/异入口均不命中（测试钉死）；登记错误（空字段、入口非公司面）在**装配期**响亮抛错。
- 审计五要素齐备：主体（actorKind+actorSubject）、入口（entrance）、租户（tenantId）、授权依据（grantId+grantedBy+reason）、时间（at）——事件本体与 `details` JSON 双落。

### C. 审计通道 — ✅ 通过（复用 MT007 先例，无旁路）
- `recordManagementAuditEvent` 走**受限 operator 事务**，写 `enterprise_security_events`——与 MT007 撤权审计同表、同一条 RLS INSERT 策略（`enterprise_security_event_operator_insert`：withCheck 同时钉 `app.tenant_id` + `app.operation_id`，schema 处核实）；本函数只 pin `operation_id`，租户 pin 由调用方事务负责，写入失败原样上抛。
- 事件类型 `management_action.cross_plane` 是本模块自己的封闭集合，`revocation.ts` 字节未动（哈希 = prereq）。
- 真实库证据（我复跑通过）：operation-pin 内读回恰好一条、五要素全在 details；**无 pin 读不可见**——RLS 语义真实生效。MUT3（去掉 operation pin → 真实 INSERT 被策略拒绝）在存档中由真实数据库错误佐证。无任何旁路写路径（grep 全树，审计写入仅此一处）。

### D. inventory.ts 回写 — ✅ 通过（digest 漂移只含分类数据）
- 7 处编辑逐行核对（对 i7-mt010 before 版本 diff）：import、summary 契约字段 `managementPlanes`、workspaceScope 真实装配、coworkerBag 条件展开、`CLOSURE_BY_PREFIX` + `CLOSURE_LABELS` 各一条、summary 计算段——全部加法，无行为改动。
- `summary.managementPlanes` 由**同一 `classifyManagementPlane`** 在真实装配入口上计算（结构保证分类与清单一致，非两份手写清单）。
- digest `e517f743…` 在本树原样状态**精确复现**（§2#8），与 archived inventory-after.json 逐键一致（仅时间戳）；`schemaVersion` 保持 1，契约加法披露属实。

### E. workspace-scope-routes.ts 改动 — ✅ 通过（逐行 diff 核实）
- 与 before 版本（并行树持有的 `29299ecb…`）完整 diff：① import；② 新增 `requireClassifiedCompanyEntrance` 本地守卫（挂载前缀 + 路由路径 → 清单 id 同形）；③ `MANAGEMENT_ENTRANCE_UNCLASSIFIED: 500` 错误映射；④ 4 个管理路由 try 块首行接入守卫。
- 行为定性：对已正确分类的入口**零行为变化**（守卫静默通过）；唯一行为增量是 fail-closed 分支（分类漂移 = 装配错误 → 500，不是请求方的 4xx），与实现者披露一致。自服务 `GET /` 未加守卫（非管理入口），正确。业务 handler 逻辑零改动。

### F. 实现者披露核验 — ✅ 通过（两项均实证）
- **F-① config.test 独立核验**：复现 **140 pass / 1 fail**（失败 = `enables Google authentication when its complete deployment contract is present`）。根因定位：`config.auth` 实际值含 `emailPassword: false`，而测试的 `toEqual` 精确形状断言无此字段。该不一致在 **git HEAD 即存在**——`HEAD:server/src/config.ts` 第 966 行恒写入 `emailPassword`（来自上游提交 `30a04b85`「OpenMuse Mobile 邮箱密码登录」），`HEAD:server/tests/config.test.ts` 第 296 行的断言未同步更新。**与本票无关性三重实证**：① `src/config.ts` 当前哈希 = prereq manifest 值 `06f86e2d…`（MT075 未触及）；② `config.test.ts` 导入图 = {bun:test, node:fs, shared/logger, src/config}，不含本票任何触及文件；③ 该文件与本树同源的并行树（i7-mt010/i7-mt014 config.ts 同哈希）同构。实现者 D3 披露准确。附注：review brief 的「预期 155/0」已过期——该文件现状 141 用例（上游合并重塑后），155 为 MT013 时代的旧计数。
- **F-② 执行器范围声明 grep 实证**：`authorizeCompanyManagementAction` / `authorizePlatformManagementAction` / `createManagementCrossGrantRegistry` / `recordManagementAuditEvent` 在 `server/src` 生产代码中**零调用方**；唯一生产 import = `workspace-scope-routes.ts` 的分类守卫（`assertClassifiedCompanyEntrance`）。「跨面授权生产执行器属 MT076-079」的声明与代码事实一致：本票交付判定 seam，无生产路径能触发跨面放行。

### G. TDD 链与 5/5 变异；RED-1 真实性 — ✅ 通过
- RED-1：存档显示模块缺失型失败（`Cannot find module '../../src/enterprise/tenancy/admin-separation'`，0 pass / exit 1）——与我在环境缺依赖时无意复现的失败形态同类，机制真实。
- 25 用例构成核对（5+4+3+7+6）与四条验收的 describe 映射成立；GREEN 终态 25/0 与全量 = 各自树基线 + 25（实现者树 334+25=359/13 文件存档；本树 363+25=388 复跑）自洽。
- MUT1–MUT5 存档失败计数（8/3/1/1/2）与变异语义逐一对应；我对 MUT5 的独立复验（等价变异：使 `company_admin` 判定分支不可达）复现 AC1 用例失败（24 pass / 1 fail——存档 2 fail 因实现者变异形态略有不同，同被捕获，非测试弱点）；还原后逐字节复绿。MUT3 存档为真实数据库 RLS 拒绝错误（非断言失败），佐证审计通道真实受策略约束。
- 附注：MUT3/MUT4 存档摘录末尾 `exit=0` 为 tail 摘录的采集方式产物（文件无 bun header），非测试证据缺陷——我的变异复验运行 exit=1。

## 4. 发现（非 MT075 缺陷，coordinator 需知）

- **Finding-1（工作树集成缺陷，中）**：本 review 树含 MT014 的**测试侧**（`runtime-config.test.ts` + `support/runtime-config.ts`，均为 prereq manifest 条目）但缺 MT014 的 **src 侧**——`src/enterprise/tenancy/runtime-config.ts`（777 行，MT014 checkpoint `0a8bc3cd…`）、`src/db/schema/enterprise-runtime-config.ts`（`d4230a4f…`）、`db/schema/index.ts` 的一行 re-export。原样状态下 `runtime-config.test.ts` 硬错（module 缺失，非 skip），全量 = 359 pass / 1 error / 14 文件。我以 MT014 checkpoint 哈希校验的副本临时补齐后全量 = **388 pass / 0 fail / 0 skip**（8760 expect），随后逐字节还原（manifest 34/36 OK + 2 授权漂移复验；`schema/index.ts` 与 HEAD diff 为空）。brief 的「388/15 文件」中文件数系笔误：报错的 runtime-config.test.ts 本就在 14 文件之内，388/0/0skip 达成时即 14 文件。**MT075 五交付无责**（runtime-config.ts 不在其可写清单，缺失状态在 MT075 领取前的 manifest 冻结态即存在）。
- **Finding-2（上游既有，低，已裁定无关）**：§3-F-① 的 config.test 1 例失败，根因在 BASE 的上游提交对，留任相关票据处理。
- **观察-1（设计内，向 coordinator 明示）**：平台面判定 seam（`authorizePlatformManagementAction`）同样尚无生产调用方；今日 `/api/admin/**` 的运行时强制仍是既有 `requireUser`/`requireAdmin` 角色守卫（套件钉死 tenant_admin → 部署角色 user → 403，AC1 前半的生产行为由此保证）。MT075 交付的是分类 + 判定 + 登记的 seam，接入 HTTP 中间件属 MT076-079。
- **观察-2（措辞，极低）**：MT075.md 称「`/api/admin/**` 全部 46 条 + SCIM 写动词」，实际清单内 `/api/admin/*` 为 44 条 + SCIM 3 条 = 47。关键数字（47/4、544、digest、unclassified 0）全部验证一致，仅行文口径不精确。
- **观察-3（极低）**：SSO 三条管理路径经 `pathPattern` 分类为 platform（供判定），但清单 summary 的 platform=47 天然不含它们（Hono 路由表只见 catchall）；catchall `POST /api/auth/*` 本身在清单计为未分类管理面之外。实现者已在代码注释与报告披露，运行时另有方法无关的 ADMIN_ONLY 守卫；未发现特权路径。

## 5. 结论

**MT075 复审通过（approved）。** 五交付（分类规则表 + 双面判定 + 显式三维授权登记 + 受限 operator 真实 RLS 审计 + MT001 清单回写）与 Issue #118 四条验收逐一对应并经独立复跑证实：聚焦 25/0/0skip、全量 388/0/0skip（补齐并行票缺失 src 后）、typecheck 0、biome 0、digest `e517f743…` 精确复现。七项裁决 A–G 全部成立；F-① 失败与本票无关性三重实证；skipped 未被计为通过。无阻断发现；Finding-1（工作树缺 MT014 src 侧）与观察-1（判定 seam 未接生产中间件，属 MT076-079）转交 coordinator。digest 供 MT132 消费前须按披露重冻结。
