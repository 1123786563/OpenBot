# [mt-M2] 批次核验报告：#69、#75、#76、#78、#82（MT026/32/33/35/39）

批次：[mt-M2]，worktree `1123786563/mt011` @ HEAD `3ca32d49`。日期：2026-10-19。
零代码改动（`git status` 仅本报告未跟踪；本报告覆盖上一批 [mt-M1] 报告，票号见标题）。

## 总览

| 票 | MT | 结论 |
|---|---|---|
| #69 | MT026 公司 SSO/SCIM 配置归属与定向停用 | **SATISFIED（零改动）** |
| #75 | MT032 工具调用时重新校验连接与 Bot 授权 | **BLOCKED-GAP** |
| #76 | MT033 技能与组件发布、数据函数作用域 | **BLOCKED-GAP** |
| #78 | MT035 Host Access/签入帮助/危险动作审批归属 | **BLOCKED-GAP** |
| #82 | MT039 个人记忆与来源选择个人权限 | **BLOCKED-GAP** |

与 [mt-M1] 同一形态：本批 1 张已实施 + 4 张 B 类真待实施。四张缺口票在
server/ 下零命中（`grep -rln "MT032|MT033|MT035|MT039" server/` 无结果），
53 个 multitenancy 测试文件头注释声明的票号不含这四个，
`migrate-test.ts` 的任务计划表只有 MT026 有条目——缺口是"整个票未实施"，
不是路径漂移。每张需新 tenancy 模块 + fixture + 迁移计划 + 测试
（同族 MT026 体量：3 测试文件 + 4 src 模块 + 2 步迁移），远超 ≤20 行
IMPLEMENTED 门槛，且四张并行超"每批最多 1 张产品侧 IMPLEMENTED"硬约束，
全部留专项派发。

## #69 MT026 — SATISFIED（零改动）

### 等价实现定位（票面路径漂移已校正）

票面声明 `bun test server/tests/multitenancy/sso-scim.test.ts`——该文件不存在。
实际落地（均头注释标 Issue #69）：

- 测试：`server/tests/multitenancy/sso-scim-config.test.ts`（13 用例）、
  `scim-directory.test.ts`（14）、`identity-binding.test.ts`（6）
- fixture：`server/tests/multitenancy/support/sso-scim.ts`
- 实现：`server/src/enterprise/tenancy/{sso-scim-config,scim-directory,identity-binding,oauth-state}.ts`、
  `server/src/db/schema/enterprise-sso-scim.ts`、`enterprise-oauth-state.ts`
- 迁移：migrate-test.ts 内 MT026 计划（0001 表 + 0002 RLS，2 步）

### AC 逐条实证（describe 标题直接点名 AC）

- **AC1 SCIM 停用只影响公司 A**：`MT026 AC1: company A's SCIM deprovision
  touches company A only`、`MT026 AC1: a deactivated binding stops all directory
  reactions`、`MT026 reprovision: the directory may lift only what it wrote` ✅
- **AC2 SSO 配置仅本公司管理员、跨公司不可见**：`MT026 SSO config: only the
  company's own admin can read or modify`（含 `no config 读到与别家相同的
  NOT_FOUND（invisible semantics）`、伪造上下文在数据库访问前被拒、受限
  operator/data role 跨公司 SELECT 零行三重围栏）✅
- **AC3 SCIM 不能建改他公司成员关系**：`MT026 AC3: SCIM provisioning cannot
  create or modify other companies' memberships`、`the directory can never
  grant a management role` ✅
- **AC4 回调按服务端持久状态归属**：`MT026 AC4: callback attribution follows
  the server-persisted state`、`MT026 AC4 storage fence: intents are reachable
  only by exact state`（外加 unknown state 拒绝、kind/ttl/user 存在性校验）✅

### 命令与输出（Bun 层，ADR 0008 两层制）

```
bun test ./server/tests/multitenancy/sso-scim-config.test.ts  → 13 pass / 0 fail
bun test ./server/tests/multitenancy/scim-directory.test.ts   → 14 pass / 0 fail
bun test ./server/tests/multitenancy/identity-binding.test.ts →  6 pass / 0 fail
```

共 33/33 绿、0 skip。

### 环境动作（非代码改动，DB 容器 orca-all-mt011-pg 保留）

- 批次说明给的 `postgres://postgres:postgres@127.0.0.1:5562/mt011` 与容器实际
  不符：容器为 `enterprise_setup`/`openbot_enterprise_mt011`，且已预配
  `ent_mt011_{directory,data,operator}_login` 三个受限 role（密码未知）。
  用容器超级用户 `ALTER ROLE` 重设三个 login 密码后组 URL。
- 五个 env 齐备才不 skip：`TEST_DATABASE_URL` +
  `ENTERPRISE_TEST_SETUP_DATABASE_URL` + 三个 role URL。**缺
  ENTERPRISE_TEST_SETUP_DATABASE_URL 时整套 13 skip 但 exit 0**（静默陷阱，
  已实证踩过）。
- MT026 迁移库内原本未应用（首跑 9 fail：`relation
  "enterprise_scim_directory_bindings" does not exist`）。用
  `migrate-test.ts generate MT026 --out /tmp/mt011-mt026` + `migrate MT026
  --apply --manifest ...` 应用（journal +2）。该套件自身不引导迁移，
  需 CLI 先行应用。

### 改动文件 / 遗留

无代码改动。遗留：无。

## #75 MT032 — BLOCKED-GAP（未实施）

- 全仓库无 `MT032` 命中；票面 `tool-invocation.test.ts` 不存在；
  migrate-test.ts 无 MT032 计划。
- 依赖已就位（可作实施基座）：MT031 `plugin-install.test.ts`+`plugin-catalog.ts` ✅、
  MT018 `public-bot-usage.test.ts` ✅、MT029 lease seam
  `credential-lease.ts`（issue/validate/revoke，即本票应消费的校验半边）✅。
- 缺：工具调用入口授权校验点、缓存与失效、失败语义（拒绝原因可解释且不泄露
  他人连接存在性）——新模块 + fixture + 迁移计划 + 测试，数百行级。

## #76 MT033 — BLOCKED-GAP（未实施）

- 无 `MT033` 命中；`skills-components.test.ts` 不存在；server/src 无任何
  skill/component 发布归属模块；migrate-test.ts 无计划。
- 依赖已就位：MT031 ✅、MT009 `team-public-rules.test.ts`（受众规则先例，
  票面注明共用）✅。
- 缺：技能/组件发布与受众、版本按范围解析、组件数据函数以调用者身份授权、
  撤销即失效 + 测试，数百行级。

## #78 MT035 — BLOCKED-GAP（未实施）

- 无 `MT035` 命中；`host-access.test.ts` 不存在；migrate-test.ts 无计划。
- 现状：`server/src/host-access/{broker,routes,schema,tools}.ts` 既有模块
  **零租户引用**（grep tenant/company/companyId 无结果）——需要 MT 化而非
  新建。依赖 MT034 `shared-approvals.test.ts` ✅。
- 缺：host access/签入帮助归属授权、危险动作审批归属一致性、执行中撤权
  失效 + multitenancy 测试。
- **既有审批回归基线已取（本批实测，供后续派发）**：
  - `approvals-question-resume.integration.test.ts`（Bun 层，提问/恢复）5/5 ✅
  - `approvals-policy.integration.test.ts`（Bun 层）7/7 ✅
  - `remote-approval-context.test.ts` **原生层**（用 `node:module` 的
    `registerHooks`，Bun 下直接 SyntaxError）2/2 ✅
  - `approvals-questions.test.ts` **原生层**（同上）2/2 ✅
  - 后两个必须 `bunx e2e run --config e2e.unit.config.ts <file>` 跑，
    `bun test` 会红——与 ADR 0008 分层一致。

## #82 MT039 — BLOCKED-GAP（未实施）

- 无 `MT039` 命中；`personal-memory.test.ts` 不存在；migrate-test.ts 无计划。
- 现状：`server/src/memory/*`（defaults/ingestion/intelligence/routes/
  sensitivity/store/tools/types）零租户引用——需 MT 化。依赖 MT038
  `document-lifecycle.test.ts` ✅、MT010 `personal-share-rules.test.ts` ✅
  （MT015 `cache-keys.test.ts` 是缓存键作用域先例）。
- 缺：个人记忆存储/查询权限、来源选择按调用者、缓存键含个人+范围、
  公共 Bot 按使用者解析 + 测试，数百行级。

## 批次副作用清单

- DB：容器 orca-all-mt011-pg 保留；`openbot_enterprise_mt011` 上 journal +2
  （MT026 两步）；三个 `ent_mt011_*_login` role 密码重设为
  mt011-dir / mt011-data / mt011-op；测试 fixture 行自带前缀清理。
- /tmp：`/tmp/mt011-mt026/`（生成的迁移 SQL + manifest，可删）。
- Git：无提交、无推送；未提交区仅本报告。
