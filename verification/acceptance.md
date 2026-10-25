# PKG12（#471）验收矩阵与交付证据 — 同一交付版本

- **同一交付版本**：集成分支 `1123786563/issue-459-integration` HEAD `e8a8b858f4f654b619088d1de076f08736241cea`（= 本工作区 `t12-pkg12-acceptance` 创建时的 HEAD；Session 开始与结束 `git status` 均干净，本轮只新增本目录证据与脚本，不改生产代码）。以下所有复跑、演示与结论都绑定该 SHA；头两轮复跑（10:25）与改正后的第三轮复跑（10:31）在同一 HEAD 上进行。
- **环境**：容器 `issue459-ent-pg`（127.0.0.1:5436，Run 专用，沿用未删）；测试库 `openbot_enterprise_issue459`（由 MT 任务链完整 provision，driven 复跑与 live 演示共用）；受限角色 `ent_i459_{dir,data,op}`→`ob_ent_*`。live 栈：业务 server `:3321`（本工作区 server 源码 + 5 变量渠道 env）、Web app（vite）`:3322`，better-auth email/password 管理员 `t12-admin@test.local`，企业身份 `t12-tenant / t12-team`（tenant_admin）。
- **门禁说明**：PKG11 灰度入口在本轮的两态都测了——默认关闭（legacy 回归 + 写入口 503）与开启（`OPENBOT_PACKAGE_MARKETPLACE_ENABLED=true` + pilot 元组 `t12-tenant/t12-team`，全部安装/升级/生命周期演示）。

## 1. A01–A12 验收矩阵

| # | 验收（父 #459 矩阵） | 结论 | 同一版本上的证据（测试文件 / 用例数 / 本轮复跑） | 复审 / 报告 | 演示证据 |
| --- | --- | --- | --- | --- | --- |
| A01 | 相同版本相同内容摘要稳定；同版本异内容、路径逃逸、symlink、超限包、未知格式拒绝 | **PASS** | `server/tests/package-artifact.test.ts` 43、`package-catalogue.test.ts` 25、`package-storage`(driven) 17 —— 全部绿（r2-A / r3-C）；catalogue 详情含 digest `b5b2a8e1…`/`be9ea955…`/`7f1e4c39…` | reviews/T01-fix-r1、pkg01-02-r2；T-INF-r1 | API `PKG01_detail_current.json`（两版本 digest 并列） |
| A02 | 两公司安装同包互不继承配置/连接/grant；跨范围 ID 与不存在同形 | **PASS** | driven `package-storage` 17、`package-grants` 18、`package-expert` 15、`package-withdraw` 7（company-a/company-b 真角色夹具，跨公司同形拒绝） | reviews/pkg01-02-r2、T05-r1、T08-r1 | API：本租户 live 安装 + 越权形态由驱动组覆盖（浏览器侧只有本租户会话，不冒充跨公司演示） |
| A03 | 并发/重复 apply 只建一份安装；同幂等键异输入、过期计划、修订变更拒绝 | **PASS** | driven `plugin-install` 35、`package-install.integration` 20（并发/CAS/幂等）+ `package-grants` 18；本轮 live 幂等重放：同一 idempotency-key 连按两次 → 两次 `200` 同一 install（r1 revision 不变） | reviews/T06-r1、T03-fix-r1 | `PKG02_apply_replay.json`、`PKG04_expert_create.json`（replay 同 agentId） |
| A04 | Skill 声明工具、仅安装、仅连接账号均不能越过 Bot grant；秘密不出现在预览/日志/模型 | **PASS** | native `package-grants-routes` 19；driven `package-grants` 18、`package-runtime` 11；app 授权套件（见 A11 行的 app 复跑）；live：grant→`ready`、revoke→`needs_grant` | reviews/T05-r1、T03-fix-r1 | `PKG03_grant/ready/revoke`（api/）、`PKG02-package-detail-installed`（Bot 授权区文案） |
| A05 | 全入口撤权后不再有新 dispatch；撤权前已 dispatch 的效果有回执或 unknown | **PASS** | driven `package-dispatch` 17（含撤权=0 外发、崩溃/超时→unknown 不重发）、`package-dispatch-call` 10、`package-unknown` 9；撤权后 `needs_grant` 复现 | reviews/T05-r1、T06-r1、T10-r1 | `PKG03_needs_grant_after_revoke.json`、`PKG10_*`（unknown 台账 + 不重发文案） |
| A06 | 升级新增工具/schema/effect 需重新授权；旧 Run 不装载新 Skill；回滚不复活旧 grant | **PASS** | driven `package-upgrade` 8、`package-runtime` 11；live 升级 plan 带 `diff.addedResources`（note-assistant/expertTemplate）、回滚 plan 带 `removedResources`；回滚后安装 r5 仍就绪（专家 Bot 自有 grant 保留，旧普通 grant 未复活） | reviews/T06-r1 | `PKG06_upgrade_plan_diff.json`、`PKG06_rollback_plan_diff.json`、浏览器 `PKG06-*` 截图 |
| A07 | 审批期间改参/切范围/断连接/换代次后旧提案不能执行 | **PASS（driven 级）** | driven `package-dispatch` 17（改参/断连/换代次用例）、`package-entrypoints` 11（审批恢复六门重验）；浏览器/真 Run 级演示见 A12 blocked 说明 | reviews/T09-r1→T09-fix-r2（B1 关闭）、T05-r1 | API 级：install detail 的 `allowedActions`/blockers 与撤权组合；真 Run 恢复 blocked |
| A08 | 卸载保留 Bot/私人编辑/运行证据；共享 connector 不被另一包卸载破坏 | **PASS** | driven `package-lifecycle` 8；浏览器：卸载后 tombstone（已卸载/不可用）仍显示 **unknown 调用台账** 与资源清单；重装（`重新安装插件包`）后 r5 已启用且 `needs_grant`（旧 grant 不复活） | reviews/T07-r1 | `PKG07-uninstalled.*`、`PKG07-reinstalled.*`、`PKG10-detail-after-lifecycle.*` |
| A09 | 旧安装迁移不丢私人改动、不猜范围；回退不把包 Run 变 legacy | **PASS（附 finding F-T12-1）** | driven `package-migration`（统一门禁 r3 绿；legacy-catalogue 导出 1.0.0 已发布可安装）；legacy 市场回归 `marketplace-routes` 9/9 + live 旧专家安装 201/幂等 200（见 §4）。**r3 之后同一门禁重跑因 live 演示写入的全局 skills slug 冲突转红** → F-T12-1 | reviews/T11-r1（七条 AC + 回退演练） | `gate-closed-legacy.json`（旧目录 9 专家/11 技能 + 安装回执） |
| A10 | 创建专家幂等且 profile/ownership/包 Skill grant 原子一致；禁止远端 endpoint 注入 | **PASS** | native `package-expert-routes` 15；driven `package-expert` 15；live：创建 201 + 同 key 重放 200 **同一 agentId**，回执 `grantRevision:1`、resources=[summarize]；浏览器模板向导同样成功（真实 agentId） | reviews/04-r1（PASS）、T03-fix-r1 | `PKG04_expert_create.json`、`PKG04-expert-created.*`（"专家已创建 + Bot ID + 授权回执"） |
| A11 | Scope 快速切换与迟到响应不污染新范围缓存；中英、键盘与失败重试正常 | **PASS（app 套件 4 个 BASE 红披露）** | app 插件包 8 文件 73 用例：42 通过/27 跳过/4 失败（失败=Run BASE `b117c3c3e` 同命令第一手复现，见 F-T12-5）；scope 切换/迟到响应用例在 `plugin-package-install.test.tsx`；浏览器证据为 zh-CN 真渲染 | — | 全部浏览器 `.innerText.txt`（zh-CN 文案逐条核验） |
| A12 | 缺制品、operator、测试数据库或受限角色时明确不可用/blocked，不以 skip 或空报告当通过 | **PASS** | native `package-assembly` 4（401-非-404/503 降级）、gating 27 + gating-matrix 34（入口关闭 503 词表）；live：关闭态 plan `503 MARKETPLACE_ENTRY_DISABLED`；本报告 blocked 清单显式列明（PKG09 真 Run、真实账号 smoke） | reviews/T01-fix-r1、T11-r1 | `gate-closed-legacy.json`、§6 blocked |

**结论**：A01–A12 全部在 `e8a8b858f` 上有可复核证据；无 orphan acceptance；不把"模块存在"当证据。blocked 项：①PKG09 真 Run 审批恢复（无企业模型凭据，driven 11/11 覆盖语义）；②真实账号/供应商 smoke（无凭据）。二者恢复条件见 §6。

## 2. 统一入口复跑（ADR 0008）

全部命令、环境与退出码原始日志在 `verification/t12-rerun-log/`（`r2-*` 为 10:25 首轮，`r3-*` 为容器连接耗尽修复后 10:31 的最终轮；首轮 B/C 段与 D 段受 `too many clients` 污染全部作废，仅 A/E/F/G/H 段有效）。

| 步骤 | 命令（摘要） | 退出码 | 用例数 / skip | 日志 |
| --- | --- | --- | --- | --- |
| A. native 包面全家（13 文件，node e2e） | `bunx e2e run --config e2e.unit.config.ts server/tests/package-{artifact,assembly,catalogue,expert-routes,grants-routes,index-ops,install-routes,lifecycle-routes,read-routes,unknown-routes,upgrade-routes,gating,gating-matrix}.test.ts` | **0** | **228 passed / 12 files**（artifact 43、assembly 4、catalogue 25、expert-routes 15、grants-routes 19、install-routes 26、lifecycle-routes 7、read-routes 16、unknown-routes 5、upgrade-routes 7、gating 27、gating-matrix 34）+ index-ops 17（gate 内） | `r2-native-package-suite.log` |
| B1. gate package chain（12 文件统一门禁） | `E2E_BUN_ONLY="server/tests/multitenancy/package chain" bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | **0** | driver 断言通过（内部 12 套件；内层计数见 C 行 165） | `r3-gate-package-chain.log` |
| B2. gate package-migration | 同上，组 `server/tests/multitenancy/package-migration` | **0**（r3）；r3b 重跑 **1**（F-T12-1） | 1/1 | `r3-gate-package-migration.log`、`r3b-gate-package-migration.log` |
| B3. gate tool-invocation | 同上，组 `server/tests/multitenancy/tool-invocation` | **0** | 1/1（内层 11） | `r3-gate-tool-invocation.log` |
| B4. gate package-dispatch-call | 组 `server/tests/package-dispatch-call` | **0** | 1/1 | `r3-gate-package-dispatch-call.log` |
| B5. gate package-index-ops | 组 `server/tests/package-index-ops` | **0** | 1/1 | `r3-gate-package-index-ops.log` |
| B6. gate package-entrypoints | 组 `server/tests/package-entrypoints` | **0** | 1/1（内层 11） | `r3-gate-package-entrypoints.log` |
| C. driven 直跑（5 URL 真角色 env，server/ 下 `bun --no-env-file test --timeout=120000`） | 12 个链内套件逐个直跑 | **0 ×12** | **176 passed / 0 fail**：plugin-install 35、storage 17、runtime 11、grants 18、expert 15、dispatch 17、unknown 9、upgrade 8、lifecycle 8、withdraw 7、entrypoints 11、install.integration 20；tool-invocation 11；migration 见 B2 | `r3-driven-*.log` |
| D. app 包面全家（8 文件，node e2e） | `bunx e2e run ... app/tests/plugin-package-{catalogue,dispatches,experts,grants,install,lifecycle,upgrade}.test.tsx app/tests/packages-page.test.tsx` | **1** | 73 tests：42 passed / 27 skipped / 4 failed / 5 errors —— 4 红为 Run BASE 同命令复现（F-T12-5），不冒充通过 | `r3-app-package-suites.log` |
| E1. `bun run --filter server typecheck` | — | **2** | 3 处既有基线错（`scripts/bootstrap-local-gateway.ts` TS2339 ×3，零新增） | `r2-typecheck-server.log` |
| E2. `bun run --filter app typecheck` | — | **2** | 62 处既有基线错，**插件包相关文件 0 处**（逐条过滤核验） | `r2-typecheck-app.log` |
| F. 改动面 biome（vs Run BASE 77 文件） | `git diff --name-only b117c3c3e..HEAD -- '*.ts' '*.tsx' \| xargs bunx biome check` | **0** | 0 error / **13 warning**（仅 `server/src/index.ts`、`server/src/plugins/tools.ts`；advisory） | `r2-biome-changed-surface.log` |
| G. `node scripts/e2e-coverage-audit.mjs` | — | **1**（既有缺口） | 12 处手工登记缺口照列：`package-dispatch/lifecycle/upgrade/withdraw`、`package-dispatch-call`（bun:test 层）、coverage-governance、execution-guarantees、bot-lifecycle、marketplace-install、skills-components、streams、group-membership | `r2-e2e-coverage-audit.log` |
| H. legacy `server/tests/marketplace-routes.test.ts` | node e2e | **0** | 9/9 | `r2-legacy-marketplace-routes.log` |
| I. `admin-separation`（已知 BASE 红复现） | server/ 下 bun 直跑 | **1** | 27 pass / 1 fail —— 与 T11 复审记录的既有红同形（路由表断言） | `r3-admin-separation.log` |

## 3. 收口波演示（API + 浏览器实跑，同一交付版本）

栈：worktree server `:3321`（本 HEAD 源码）+ vite app `:3322`；enterprise 渠道指向已 provision 的测试库；管理员会话为 better-auth email/password 真实登录（cookie 注入浏览器，非 mock）。脚本与逐步 JSON/innerText/PNG 均在 `verification/browser/` 与 `verification/live-stack/`（脚本可重放）。

| 演示 | 结果 | 关键证据 |
| --- | --- | --- |
| PKG01 市场浏览 → 包详情 | **PASS** | `PKG01-packages-catalogue.*`（catalogue 卡片：v1.0.0/已安装 r3/已启用/需要 Bot 授权）、`PKG01_detail_current.json`（digest/资源/版本） |
| PKG02 plan/apply 安装 → 状态可见（幂等重放） | **PASS** | API：plan 200 → apply **201**（r1, needs_grant）→ 同 key 重放 **200**（r1 不变）×2；UI：卸载态 `重新安装插件包` → 确认 → `已安装 r5 已启用`；`PKG02_apply_replay.json`、`PKG07-reinstall-preview/reinstalled.*` |
| PKG04 模板 → 创建专家 → 初始 grant 行 | **PASS** | API 201 + 重放 200 同 agentId + `grantRevision:1 resources:[summarize]`；UI 向导「专家已创建 + Bot ID pkg-expert-a3590612… + 授权回执」：`PKG04_expert_create.json`、`PKG04-expert-created.*` |
| PKG06 升级 diff 预览 → 确认升级 → 回滚 | **PASS** | API：upgrade plan `diff.addedResources[note-assistant/expertTemplate]` → apply r2；rollback plan `diff.removedResources` → apply r3/r5；UI：`查看升级`→`升级到 v1.1.0`→catalogue v1.1.0 r4；`查看回滚`→`回滚到 v1.0.0`→r5 就绪：`PKG06_*`、`PKG06-*` 截图 |
| PKG07 停用 → 重装（卸载→重装） | **PASS** | UI：`停用`→`已停用/不可用`（actions 收敛为 启用/卸载）→`启用`→`已启用/需要 Bot 授权`；`卸载`→确认「卸载插件包」→ tombstone；`重新安装`→r5（generation 递增，旧 grant 不复活）：`PKG07-*` 全套 |
| PKG10 制造 unknown → 详情台账 → 核对 422 | **PASS** | 注入一条真实形状 unknown 行（run+dispatch，写效果、receipt class write_timeout）；install `unknownDispatches:1`；台账/详情：`canQueryVendor:false / noAutoResendReason:NO_VENDOR_QUERY_PROTOCOL / recovery RUN_LEASE_INVALID`；`POST …/verify` → **422 `VENDOR_QUERY_PROTOCOL_UNAVAILABLE`**；UI 显示「供应商没有提供查询方式，OpenBot 也不会重发它」：`PKG10_unknown.json`、`PKG10-dispatch-inspect.*` |
| PKG09 审批流含包工具的恢复 | **BLOCKED（live）**（driven 证据在案） | live 无企业模型凭据，无法驱动真实 governed run 进入 waiting_approval→恢复；driven `package-entrypoints` 11/11 + T09-fix-r2（B1 关闭）覆盖恢复六门与 attempt 绑定。恢复条件见 §6 |

**演示中的选择器迭代**：首轮浏览器脚本的部分步骤因弹层选择器超时，已重写为每步新载入页面后重跑；中间失败截图（`*-FAILED`）为迭代噪声，未保留；最终证据即上表。

## 4. Legacy 回归（闸门关闭，默认态）

- 测试：`server/tests/marketplace-routes.test.ts` 9/9 绿；`package-gating` 27 + `package-gating-matrix` 34 覆盖"关闭态写入口 503 / 读与治理不变"。
- live API 抽查（`gate-closed-legacy.json`）：`GET /api/marketplace` 200（9 专家 / 11 技能，与 BASE 目录一致）→ `POST /experts/fullstack-engineer/install` **201**（新 private Bot + 技能授予）→ 重放 **200 同一 agentId**（旧幂等语义不变）；`GET /api/enterprise/plugin-packages` **200**（读开放）；`POST /plans` **503 `MARKETPLACE_ENTRY_DISABLED`**（写被闸门关闭）。关闭态下 legacy 行为不变。

## 5. V1 支持范围声明

本 Epic 通过**仅**代表：V1 **团队（公司/团队 PlatformScope）受信插件包**闭环——随包发布的受信目录、清单校验、团队范围安装/授权/升级/回滚/停用/卸载/重装/撤回、从模板创建专家、治理与 unknown 核对。

**不宣称支持**（不在本次验收内、不得解读为已支持）：Personal Space（ADR 0007 未批准）；缺执行范围的逻辑私有 Bot 多范围；外部格式（Cursor/OpenAI）导入兼容；任意代码执行/安装脚本；第三方发布与计费。真实账号/供应商 smoke 与真 Run 审批恢复为 **blocked**（见 §6）。**不把本 Epic 通过解释为全仓多租户总体门禁通过**。

## 6. 风险、遗留与 findings（交主控编号修复流程，本轮不修生产代码）

**本轮新发现（findings）**

- **F-T12-1（MEDIUM，A09 相关）**：`package-migration` driven 组对共享库既有全局 `skills.slug` 不稳健。r3（10:31，演示写入前）统一门禁绿；随后 live 演示的 legacy 专家安装写入全局 skills 行，同一门禁重跑红：`duplicate key … skills_slug_key`（`r3b-gate-package-migration.log`、`r3-driven-package-migration.log`）。生产迁移面对的就是存量 slug，需实现票确认 migrate-legacy 与"slug 全局唯一"的交互（幂等/冲突策略）。**恢复/复核条件**：在干净测试库重放 r3 顺序即绿；脏库行为需票级裁决。
- **F-T12-2（MEDIUM，部署供给缺口）**：drizzle 全量迁移路径只覆盖部分企业表 RLS/GRANT。以全新库 `openbot_enterprise_t12live` 实测：46 张 `enterprise_%` 表中仅 28 张有策略；`enterprise_workspace_memberships` 等 18 张无 policy 且 `ob_ent_*` 无权限，导致 scope 解析 `permission denied`（`t12-verify`/`t12-scope` 探针）。**结论**：生产/部署侧尚无企业表 RLS/GRANT 的 provisioning 路径（MT 任务链=测试工具路径，与 2026-10-19 记录同类）。本轮 live 演示因此使用已 provision 的 Run 测试库并在此披露；该缺口需归属实现票（部署 provisioning）。
- **F-T12-3（LOW，可观测性）**：`server/src/index.ts` 组装企业能力的 `catch (_error) { return null; }` 吞错且无日志，而启动拒绝文案称"the verification error is on the log above"（实际不在日志）；`plugin-packages/routes.ts` 的 `INTERNAL` 关闭映射同样丢弃原因。排障只能靠 standalone 探针（本轮如此定位 channel 角色错配）。
- **F-T12-4（LOW，环境/配置）**：server 启动一次性打开 >100 连接（多个 npm-`postgres` LISTEN 池叠加），在默认 `max_connections=100` 的 Postgres 上 `sorry, too many clients already` 拒启；本轮把 Run 容器调到 300 并重启（记录于 §7）。部署 compose/文档应给出上限与引导。
- **F-T12-5（LOW，基线红披露）**：app 插件包套件 4 个稳定红（install expired-plan / experts admin-create / grants admin-PUT / catalogue search）在 Run BASE `b117c3c3e` 同命令第一手复现：`t12b-base-app-8suites.log`（BASE 5 failed / 26 passed / 26 skipped，同一稳定 4 例 + 渲染冻结族 1 例）；本轮 r3 同 4 例，属既有基线；另有 1 例渲染冻结族飘动红（"list and detail draw…"/"needs-grant notice" 交替出现，act flush 可解，既有记忆）。27 skip 为套件内环境门控用例。**不冒充本次通过**。

**既有验证债/运维口径（前序 Run 记录，本轮复核仍在案）**：e2e 清单手工登记与重生成收口（coverage audit exit 1，12 处，§2-G）；T07/T11 `tasks/*-report.md` 未落盘（流程债）；`admin-separation` 路由表 BASE 既有红 27/28（本轮复现）；锁心跳（T08 low）；`toolCallId` 缺省 UUID（T05 low）；撤回生效=下次装配（无热重载，T08 low）；`markUnknown` 无生产清扫调用方（T10 low，运维口径）。

**Blocked（恢复条件）**

1. **PKG09 live Run 审批恢复**：需真实企业模型路由凭据（`INTELLIGENCE_*` 或 governed model route）+ 一个持包工具的 Bot 跑进 `waiting_approval`。现有证据：driven 11/11、T09-fix-r2。
2. **真实账号/供应商 smoke**：需外部连接器凭据与受限账号；T05 起记录为环境 blocked。

## 7. 环境与清理记录

- 容器 `issue459-ent-pg`：**保留**（未删）。本轮 `docker restart` 1 次（清掉前次中断会话泄漏的连接耗尽），`ALTER SYSTEM SET max_connections=300` + 重启 1 次（F-T12-4）。既存其他容器未触碰。
- 测试库：`openbot_enterprise_issue459` 供 driven + live；`openbot_enterprise_t12live` 为供给缺口实验库（保留，可删）。`openbot_t12_live`（前次中断会话创建、未迁移）已 DROP。
- live 栈进程：server :3321 与 vite :3322 为本轮启动，验收结束后停止（见报告）。
- 本轮新增文件：`verification/**`（证据 + 可重放脚本）、本工作区临时 BASE 对照树 `/tmp/t12-base2`（可删）。生产代码零改动。
