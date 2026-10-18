# MT123 设计 — 启动装配净化域（Issue #166）

## 0. 事实源与前置核验

- BASE f0520524（= prereq-manifest BASE）；268 项 prereq 快照 before-hashes 逐项复算 268/268 一致（0 drift）。
- 前置 MT122（entry-context）/ MT014（runtime-config）/ MT005（scope-gate）/ MT013（startup-checks）
  均已 verified 并集成于本树。
- 环境三步配方从零：容器 mt123-impl-pg（pgvector/pgvector:pg16 @127.0.0.1:55584）；
  库 openbot_enterprise_w15d_test + _assigned + openbot_kb_w15d_test（KB 属主 ent_w15d_kb 先于建库）；
  七变量 env（checkpoints/MT123/test-env.sh，0600）；`enterprise-test-db.ts migrate` + 修正链序
  19 前置任务 generate+apply（MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→
  MT069→MT016→MT041→MT027→MT028→MT070→MT031→MT042→MT059），journal 19/19 在册。
- 基线复现：`bun --no-env-file test tests/multitenancy` = **1124 pass / 0 fail / 43 文件**（verification/00）。
  唯一前置修正：entry-context.test.ts 环境身份断言令牌 w14int→w15d_test（波次 14 集成同款冲突、
  同款最小令牌微修先例，断言语义不变；question 通道升级 msg_aaf2dbd7e6bf 10 分钟无应答后按 brief
  两条硬性规定交集执行，披露于报告 §R）。

## 1. 问题（启动流程默认状态的三类残留）

启动装配（index.ts）此前无条件保留三类部署级默认状态：

1. **默认公司**：`config.deploymentId ?? tenantPackage.tenantId`（index.ts 1094/1527/1573/3977）——
   租户包的 tenantId 充当部署身份回退，成为进程范围的隐式"当前公司"（线程指纹、计费客户键等
   部署派生键全部从它出发）。Spec §2：*租户相关业务状态需按公司/团队解析，不能保留部署范围的
   隐式当前公司*。
2. **默认线程标识**：`createThreadIdentity(config.deploymentId ?? tenantPackage.tenantId)`——
   进程级单例，全部 legacy mint 调用点（channels/routes、group store、proactive、memory defaults）
   共用同一枚部署指纹。
3. **单用户绕过**：`initializeDevActorUser(database, config.singleUser)` + createApp 的
   `createDeploymentRequireUser` 在 `config.singleUser` 时挂载 `createDevRequireUser`（免认证 guard）。

## 2. 交付形状

### 2.1 新文件 `server/src/enterprise/tenancy/startup-defaults.ts`

- **`resolveStartupDefaults(facts)`**（纯函数，输出深冻结）：
  - facts：`{ multitenancy, deploymentId?, tenantPackageTenantId?, singleUser, singleUserEnvRaw?,
    devNoAuthEnvRaw?, entryContextWired }`；
  - 单租户（回归，与 legacy 启动逐字节同义）：`defaultCompanyTenantId = tenantPackageTenantId ?? null`、
    `threadIdentitySeed = deploymentId ?? tenantPackageTenantId ?? null`、
    `devBypassMounted = singleUser`；
  - 多租户（净化）：`defaultCompanyTenantId = null`（租户包 tenantId 不再充当隐式当前公司）、
    `threadIdentitySeed = deploymentId ?? null`（显式 DEPLOYMENT_ID 只是部署命名——线程指纹区分
    部署所必需——不是公司身份；缺它时线程身份一律 per-scope 派生）、`devBypassMounted = false`。
- **`evaluateStartupAssemblyReadiness(facts, defaults)`**（纯函数，MT013 同纪律：缺口一次列全）：
  多租户模式四类装配缺口——MT122 entry context 工厂缺席；显式 DEPLOYMENT_ID 缺席（否则线程种子
  会落回租户包默认公司）；config.singleUser 为真；OPENBOT_SINGLE_USER / OPENBOT_DEV_NO_AUTH 原始
  残留（与 MT013 evaluateDevBypassResidue 同口径，显式关闭不算残留）。单租户模式恒 ok（无就绪诉求）。
- **`buildStartupDefaultsRecord(facts, defaults, readiness)` + `applyStartupDefaultsVerdict(record, hooks)`**
  （MT013 同款：恰好一条结构化审计记录 `multitenancy-startup-defaults-validation`；拒绝 exit(1)；
  log/exit 可注入供单测）。
- **`scopeThreadIdentity(resolved)`**（纯函数，消费 MT122 entry-context 的落点）：入参是 MT122
  `requireEntryBusiness(...).runtimeConfig()` 的 `ResolvedRuntimeConfig`（MT014 threadIdentitySeed ←
  `(tenantId, workspaceId)` 确定性派生），返回该 scope 专用的 `createThreadIdentity(seed)`。多租户
  模式下这是线程身份唯一合法来源：per-scope，绝不读进程全局。

### 2.2 装配（index.ts 最小改动，谨慎边界内）

- 租户包加载后、线程标识构造前：`resolveStartupDefaults(...)`（entryContextWired 取
  `Boolean(enterpriseCapabilities?.entry)`）；
- 多租户模式：`applyStartupDefaultsVerdict`（缺口拒绝启动——AC4 与 MT013 一致）；
- `createThreadIdentity(startupDefaults.threadIdentitySeed)`（单租户表达式与 legacy 逐字节同义；
  多租户 readiness 保证种子非 null，防御性 null 检查 fail-closed）；
- `initializeDevActorUser(database, startupDefaults.devBypassMounted)`（单租户同值；多租户恒 false）。
- app.ts / startup-checks.ts / global-exceptions.ts 零改动（本票不新增全局端点、不动 MT013 判定面）。

### 2.3 测试 `server/tests/multitenancy/startup-defaults.test.ts`（Issue #166 Verification 命令）

- 纯函数组（无 DB）：AC1 净化输出（默认公司/默认线程标识/dev bypass 三类残留均为空 + 深冻结 +
  显式 DEPLOYMENT_ID 保留）；单租户回归（三类默认状态原样、与 legacy 表达式逐字节同义）；
  readiness 四类缺口逐项 + 一次列全；单租户 readiness 恒 ok；verdict 记录/退出纪律；
  scopeThreadIdentity per-scope 差异 + 稳定性 + 无共享可变状态。
- DB 组（专用库三受限角色 + RLS，零授权 mock；缺 env 显式 skip）：
  - AC1 运行时断言：真实施装（MT122 工厂 + 双公司/团队）下 per-scope 身份随 scope 走——公司 A
    a1/a2、公司 B 各自指纹互异、同 scope 稳定；每次调用新实例（无进程级共享可变身份）。
  - AC3 装配对照：真实 createApp 双模式（单租户 vs 多租户+entryContext）——注册路径集合逐项相同；
    代表性无选择头请求（/health、/ready、/api/me）状态码与 DTO 键集逐项相同；多租户 app 对带
    选择头请求按 canonical 码拒绝（401 + AUTH_REQUIRED，MT122 入口级拒绝半边在新装配合仍生效）。

### 2.4 变异自证（每安全分支 ≥1，全部 KILLED）

- MUT1 多租户臂：defaultCompanyTenantId 回落租户包 tenantId（默认公司复辟）→ AC1 净化用例失败。
- MUT2 单租户臂：threadIdentitySeed 丢弃租户包回退（只认 deploymentId）→ 单租户回归用例失败。
- MUT3 readiness：删 entryContextWired 缺口 → 装配缺口用例失败。
- MUT4 devBypass：多租户 devBypassMounted 跟随 singleUser → AC2 用例失败。
- MUT5 scopeThreadIdentity：seed 换成常量（进程默认）→ per-scope 差异用例失败。

## 3. AC → 证明映射

| AC | 证明 |
|----|------|
| AC1 启动后无进程级可变"当前公司/团队"状态（有测试断言） | resolveStartupDefaults 多租户输出 defaultCompanyTenantId=null + 深冻结 + 赋值抛错；scopeThreadIdentity per-scope 差异/稳定/新实例；MUT1/MUT5 |
| AC2 单用户与开发绕过多租户不可用；单租户行为不变（回归） | devBypassMounted 多租户恒 false + readiness 双残留 + config 残留；单租户回归组逐字节同义断言；MUT2/MUT4 |
| AC3 API 路径、状态码与 DTO 能力对照 | 双模式真实 createApp 路径集合 + /health /ready /api/me 状态码与 DTO 键集对照 + 选择头 canonical 拒绝 |
| AC4 装配缺口被就绪校验发现（MT013 一致） | readiness 四类缺口一次列全 + verdict exit(1) + index.ts 装配真挂载；MUT3 |

## 4. 冻结面与窄缝

- 268 项 prereq 哈希收尾复核（after-hashes）。
- 窄缝改动逐项披露：`tests/multitenancy/entry-context.test.ts` 环境令牌微修（3 行：断言+注释，
  断言语义不变，波次 14 集成同款先例）；`scripts/multitenancy/migrate-test.ts` / migration-tool.test.ts
  / schema index 本票零改动（无 DB 交付面）。
