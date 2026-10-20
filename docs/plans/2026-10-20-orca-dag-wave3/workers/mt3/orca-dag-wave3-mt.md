# orca-dag-wave3 MT 批次核验报告（#49 / #56 / #86 / #87 / #88）

- 运行：orca-dag-wave3（domain_ready.mt 首批 5 张）
- Worktree：`/Users/wuyongjun/orca/workspaces/OpenBot/mt3`（自 main@2306caaa 新建）
- 日期：2026-10-20
- 方法：B 类核验优先——逐票 `gh api` 读正文与验收，再对照当前 main 树核验等价实现；有等价实现即以测试证据收尾（SATISFIED / 零改动），无等价实现给出 FAILED 与阻塞原因。GitHub 全程只读；未 commit 未 push。
- 结论速览：**#49 SATISFIED、#56 SATISFIED（均零改动）**；**#86 / #87 / #88 FAILED（无等价实现，见逐票缺口与建议派发）**。

---

## 测试环境配方（容器 orca-w3-mt-pg，pgvector/pg16，127.0.0.1:5565）

任务给定的 `TEST_DATABASE_URL=.../mt3` 不满足仓库测试门禁：`server/scripts/multitenancy/migrate-test.ts` 与
`server/tests/support/enterprise-database.ts` 都强制 `openbot_enterprise_*` 命名（回环主机）。按仓库配方在同一容器内建：

1. `CREATE DATABASE openbot_enterprise_mt3;`（MT 套件库）
2. `cd server && DATABASE_URL=TEST_DATABASE_URL=.../openbot_enterprise_mt3 OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES=on bun scripts/migrate.ts` → `{"type":"migrations-applied","status":"ok"}`（roles.sql→migrate 顺序配方，即 bootstrap 于 migrate 内完成）
3. `CREATE DATABASE openbot_enterprise_mt3_ent;` + `ENTERPRISE_TEST_SETUP_DATABASE_URL=.../openbot_enterprise_mt3_ent` 及三个 role URL 下 `bun scripts/enterprise-test-db.ts migrate` → ok（provision `enterprise_{directory,data,operator}_login` + 能力角色成员关系）
4. 直跑套件时五个 env 全部指向 `openbot_enterprise_mt3`（单一库拓扑；见下方“系统性发现 1”的补充 DDL）

### 环境变量集（直跑 bun test 用）

```
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5565/openbot_enterprise_mt3
ENTERPRISE_TEST_SETUP_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5565/openbot_enterprise_mt3
ENTERPRISE_TEST_DIRECTORY_DATABASE_URL=postgres://enterprise_directory_login:enterprise-test-only@127.0.0.1:5565/openbot_enterprise_mt3?options=-c%20role%3Dob_ent_directory
ENTERPRISE_TEST_DATA_DATABASE_URL=postgres://enterprise_data_login:enterprise-test-only@127.0.0.1:5565/openbot_enterprise_mt3?options=-c%20role%3Dob_ent_data
ENTERPRISE_TEST_OPERATOR_DATABASE_URL=postgres://enterprise_operator_login:enterprise-test-only@127.0.0.1:5565/openbot_enterprise_mt3?options=-c%20role%3Dob_ent_operator
```

---

## #49 — MT006 公司与团队列表、选择与管理入口：【SATISFIED，零改动】

- 等价实现定位：
  - 实现：`server/src/enterprise/tenancy/workspace-scope-routes.ts`（真实 Hono 路由，选择头 `x-openbot-tenant` / `x-openbot-workspace`，仅选择不授权）+ 夹具内真实 `createCompanyAdminAuthorizer`（事务内重验 tenant_admin 与 epoch）。
  - 测试：`server/tests/multitenancy/workspace-scope.test.ts`（文件头明确 “MT006（Issue #49）：工作范围选择与团队管理”）。票面声明的 `selection-api.test.ts` 不存在，本文件即等价交付（前序 wave 以 MT006-brief 命名落地）。
- AC 覆盖对照（describe 一一对应）：
  1. 列表只返回真实有资格的公司/团队（membership 事实判定；跨公司用户独立条目）→ `criterion 1` describe。
  2. 选择只影响作用域解析 + 无资格空状态不回退默认/第一项 → `criterion 2`（gateTransactionProbe 亦证明锁序与版本递增、审计写入走集中管理入口）。
  3. 公司管理员创建/停用团队、管理成员名单；不能读非成员团队业务内容 → `criterion 3` + `criterion 4`（管理权≠业务读权，越权用例在案）。
  4. 管理动作 公司→主体→公司成员→团队→团队成员 锁序 + 版本递增 + 审计 → criterion 3 的集中入口事务重验与 fixture 的 gate 事务探针。
- 验证证据：`bun test ./server/tests/multitenancy/workspace-scope.test.ts` → **34 pass / 0 fail，exit 0**（含上述 env；DB 侧按“系统性发现 1”补齐 MT004 RLS/GRANT 后全绿）。
- 备注：`docs/plans/2026-10-15-company-team-multitenancy/dag-ledger.md:20` 已记录选择头最终命名 `x-openbot-tenant-id` / `x-openbot-workspace-id` 于 server/src/index.ts 企业会话 wiring；MT006 套件按裁决 #1 旧名 `x-openbot-tenant` 断言，为票面时点契约，不构成缺陷。

## #56 — MT013 多租户模式开关与启动就绪校验：【SATISFIED，零改动】

- 等价实现定位：
  - 实现：`server/src/enterprise/tenancy/startup-checks.ts`（文件头 “MT013：多租户模式的启动校验”）+ `server/src/config.ts:3033-3052`（`OPENBOT_MULTITENANCY` 开关解析）+ `server/src/enterprise/tenancy/startup-defaults.ts`（MT123 启动净化）。
  - 测试：`server/tests/multitenancy/startup-checks.test.ts`（41 用例；三拒绝路径+通过路径+豁免清单+结构化记录）。票面声明 `readiness.test.ts` 不存在；`startup-checks.test.ts` 即等价交付（文件头标注 “MT013（Issue #57）” 为票号笔误——GitHub 上 MT013=#56、MT014=#57，`runtime-config.test.ts` 头部 “MT014（Issue #57）” 与 GitHub 一致可互证）。
- AC 覆盖对照：
  1. 未登记入口/单用户绕过/不安全角色任一不满足 → 拒绝启动并列出**全部**缺口（三项全评估完才下 verdict，exit 非 0）→ startup-checks 三 evaluator + 编排器用例。
  2. 单租户回归 + 多租户无旧默认回退 → `startup-defaults.test.ts`（MT123：多租户 devBypassMounted 恒 false + readiness 残留判定 config/env 双面；单租户输出与 legacy 启动表达式逐字节同义）。
  3. readiness 机器可读 → `MultitenancyStartupRecord`（type/mode/accepted/timestamp/checks{coverage,devBypass,databaseRoles,globalExceptions}）一条结构化记录进启动日志，可供 MT130/MT143 消费。
  4. 开关缺失/非法按安全侧 → `config.test.ts` OPENBOT_MULTITENANCY 块：缺省 off；on/true/1 显式开；off/false/0 显式关；`ON/yes/enabled/maybe` 抛错带理由（不进入多租户模式）；空串读作缺省。
- 验证证据（均 exit 0）：
  - `bun test ./server/tests/multitenancy/startup-checks.test.ts` → **41 pass / 0 fail**
  - `bun test ./server/tests/multitenancy/startup-defaults.test.ts` → **24 pass / 0 fail**（需 env 同上）
  - `bunx e2e run --config e2e.unit.config.ts server/tests/config.test.ts` → **158 passed / 158**（ADR 0008 两层制：该文件为 e2e-compat native 套件，`bun test` 直跑会因 `registerHooks` Node-only 报错，属已知分工）

## #86 — MT043 认领、重试与人工取消保持归属：【FAILED — 无等价实现】

- 票面声明 `server/tests/multitenancy/job-claim-cancel.test.ts` 不存在；`server/src/enterprise/tenancy/job-ownership.ts` 无 cancel/retry 入口（grep 零命中）。逐 AC 缺口：
  - AC1（无权取消→不可见语义）：OpenMuse 任务域已实现有测试（`openmuse-task-tenancy.ts:578-604` gatedControl，跨范围 cancel/pause/retry/resume → `missing`；`openmuse-tasks.test.ts:645-663`）；enterprise runs 有机制（`runs/store.ts:576-625` FOR UPDATE 三比一过滤 + RUN_NOT_FOUND 404）但无跨范围 cancel 测试；**平台 job 域（job_ownership/job_leases）无取消入口**。
  - AC2（重试保持归属/发起主体/配置版本）：机制在（`job-ownership.ts:404-477` 归属 create-once + `JOB_OWNERSHIP_MISMATCH`；`scan-executor.test.ts:524-573` 失败→释放→重认领为同一 job 同一 pin）但无“归属+发起主体+配置版本”三不变的单点断言测试。
  - AC3（取消传播到执行中敏感动作与外部执行含沙箱/浏览器）：**未实现**。仅模型流级 AbortController（`runs/runner.ts:157,298-301,503-507`，`runner-production.test.ts:1274`、`run-built-agent-cancellation.test.ts:241,289,477`）；`server/src/enterprise/runs/` 零处引用 computer/sandbox；craft interrupt fence 不由 job/run cancel 触发。**票面备注明示依赖 MT047(#90)/MT050(#93) 执行侧接口，二者均 open**——本 AC 在依赖落地前不可真实现（不得用假桩冒充）。
  - AC4（并发认领不双持租约）：机制原子（`job-ownership.ts:546-660` INSERT ON CONFLICT / 条件 UPDATE，宁误报不双授；`work_items` 用 FOR UPDATE SKIP LOCKED 且 `work-queue.integration.test.ts:73` 有十副本竞态测试），但 `job_leases` 无并发竞态测试（现有均为串行 claim→expire→re-claim）。
- 阻塞/建议：形式 Blocked by（#85 MT042）已满足（scan-executor 已并入 main）；实质缺口 = job 域 cancel/retry 入口新生产面 + AC3 依赖 MT047/MT050。建议专项派发（C 类，含 brief）：入口走 MT005 集中授权 seam + 不可见语义，测试落 `job-claim-cancel.test.ts`（AC1/2/4 可先行，AC3 等 MT047/MT050 接口）。

## #87 — MT044 入站邮件、GitHub 与 Webhook 的归属解析：【FAILED — 无等价实现】

- 票面声明 `server/tests/multitenancy/inbound-attribution.test.ts` 不存在（全历史无此路径）。现有入站通道为“Bots as coworkers”个人域管线：`server/src/responsibilities/trigger-routes.ts`（webhook/GitHub/Linear/Sentry/PagerDuty，`app.ts:2704`）、`github.ts`（`app.ts:2714`）、`email.ts`（SES/SNS，`app.ts:2709`）、`slack.ts`。逐 AC 缺口：
  - AC1（持久映射归属到公司/团队；载荷伪造字段忽略）：触发器行持久归属成立但**只解析到 user**（`responsibility_triggers` 无 tenant/company/team 列；`responsibility-triggers.test.ts:215-241` 证明 payload 自称 owner 被忽略）——公司/团队维度不存在。
  - AC2（无法解析→隔离队列+运维可见）：**未实现**。不可解析投递一律 401/403/404 拒绝且不落任何记录；树内 quarantine 实现均为计费域（`payer-accounts` MT069/070 线）与 MT120（亦未实现），无入站事件隔离队列/运维视图。
  - AC3（重复投递幂等）：已在 user 域实现且测试充分（`(owner_user_id, source, external_id)` 唯一 + onConflictDoNothing；`responsibility-triggers.integration.test.ts:108-131`、`responsibilities-store.integration.test.ts:109`；签名体哈希去重防换头重放）。
  - AC4（入站执行遵守 MT042 作用域重建）：重建自持久记录的模式成立（队列载荷仅 `{runId}`，`store.ts:289-380` 重读权威行）但**不经 MT042 scan-executor**（其只认 `task:`/`run:`/`trigger:<objectId>` 键中的平台任务，`scan-executor.ts:134,271-280`），无 tenant scope-gate 包裹。
- 阻塞/建议：形式 Blocked by（#85、#71）均已满足。缺口 = 触发器域租户列（新迁移，expand-only）+ 归属解析到 company/team + 隔离队列与运维视图 + MT042 挂接。属完整纵向切片，建议专项派发（C 类 + brief + 迁移设计），勿在本批次内赶工。

## #88 — MT045 主动建议与外部调用前后的事务边界：【FAILED — 无等价实现】

- 票面声明 `server/tests/multitenancy/proactive-tx.test.ts` 不存在。`server/src/proactive/`（engine/store/routes/restriction/types）为个人 owner 域功能（`ProactiveScope = {ownerUserId, channelId, agentId, threadId}`，schema 仅 owner 列）。逐 AC 缺口：
  - AC1（只投递归属范围内授权接收者）：个人域成立（投递回 owner 本人；`delivery/router.ts:130-131` 投递时重验；只读工具限制内容来源 `restriction.ts:101-121`），**无公司/团队归属维度与对应测试**（Spec A8 要求后台/外部执行保持原公司/团队归属）。
  - AC2（外部调用前后独立事务、无授权锁跨网络等待）：代码结构性合规（全仓 295 处 `.transaction(` 扫描零处事务回调内含 fetch/provider-send；proactive/delivery 用单语句原子认领 + outbox 状态机在事务外发送，`store.ts:381-390`、`router.ts:466-531`），但**无本域测试证明**（MT122 的 `entry-context.test.ts:444-493` 只证明入口闸门事务零网络拨号，不覆盖本域）。
  - AC3（外部调用失败重试幂等）：相邻机制在（outbox `dedupe_key` 唯一 + onConflictDoNothing；uncertain 不盲重发 `router.ts:558-567`；扣费幂等仅 MT071 settlement 线），无 proactive 域整合测试。
  - AC4（撤销后不投递、已投递不可被无权者读取）：个人域成立（revoked 停发 `router.ts:458-465`；建议仅 owner 可列 `store.ts:214-226`；bot 重置清理），无公司/团队撤销语义。
- 阻塞/建议：形式 Blocked by（#85）已满足。缺口 = proactive/职责/计划域租户化（schema + 引擎 + 授权检查）+ 事务边界专测。同样建议专项派发；注意票面备注“事务边界规则同样适用于 MT043/MT044，发现违例统一在此票修正模式”——三票派发时宜共享接口契约。

---

## 系统性发现（供协调者升级/派发，非本批次修复）

1. **#436（0163_restore_drifted_tables）与 MT 任务链的“已存在”冲突使全新库上的受限角色 MT 套件 provisioning 断裂。**
   - 机制：主链 0163 预建了 37 张表（含 `enterprise_workspace_memberships`/`enterprise_runtime_configs`/`job_*` 等），MT 任务（migrate-test.ts）create 步骤普通 `CREATE TABLE` 拒绝 "already exists"，其 RLS+GRANT 步骤**永不落地** → 全新库上受限角色套件 permission denied。
   - 实测（本 worktree 全新库）：`membership-model.test.ts`（#47）12/4 红（含 0163 表还缺 MT004 的 2 条 CHECK、2 条 FK——形状亦不收敛）；`runtime-config.test.ts`（#57）0/1 红（aa420f21 的 convergence 接受补丁只放行了拒绝、没补授权）；`startup-defaults.test.ts` DB 组红。**先于 #436 的既有库（journal 已满）不受影响**——这解释了 2026-10-19 verify 轮全绿而今日全新库全红。
   - 本批次处置：在测试库上以超级用户精确重放 MT004 `rls_policies` 步与 MT014 `runtime_config_rls` 步的语句（与迁移文本逐条一致，策略名已核对一致）后，#49/#56 证据套件与 runtime-config（29/0）、startup-defaults（24/0）全绿。**未改任何仓库文件。**
   - 建议修复方向（归属 #46 MT003 或 #436 follow-up 票）：MT 任务 create 步幂等化（IF NOT EXISTS / 存在性守卫）使 RLS+GRANT 步可落地，且 0163 类恢复需带齐 CHECK/FK/RLS/GRANT；membership-model 的 convergence 接受可复用 aa420f21 模式。
2. startup-checks.test.ts 文件头票号笔误（“MT013（Issue #57）”应为 Issue #56），纯注释不影响行为，随手修即可。

## 改动文件与哈希

- 仓库文件改动：**无**（生产代码、测试、docs 均零改动；未 commit 未 push；`git status` clean）。
- 本报告：`reports/orca-dag-wave3-mt.md`。
- 测试库侧（非仓库文件）：容器 orca-w3-mt-pg 内 `openbot_enterprise_mt3`（主链迁移 + MT004/MT014 RLS+GRANT 语句重放）、`openbot_enterprise_mt3_ent`（enterprise-test-db migrate 产物，本轮最终未用于证据拓扑）。
