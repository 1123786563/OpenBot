# MT039 设计 — 个人记忆与来源选择保持个人权限（Issue #82）

日期：2026-10-19。树=w16-mt039（BASE f0520524 + 284 项 prereq 快照，含波次 14/15 全部 verified 交付）。
事实源：Issue #82 票面 + 父 Spec §4.2/§5/§6/§11 + ADR 0004 + CONTEXT.md。本文件是实施设计与变异计划；
结论性数字以 checkpoints/MT039/verification/ 亲跑证据为准。

## 0. 票面四条验收 → 实现面映射

| # | 验收（票面原文） | 实现面 | 证明（聚焦套件用例组） |
|---|---|---|---|
| AC1 | 同团队另一人无法读取或搜索某人的个人记忆 | `personal-memory-isolation.ts` 的 recall/read 决定门：受信 Scope → 数据库事务内成员重验（公司 active + epoch 匹配 + 团队 active）→ 主语=使用者本人（enterprise_principals 经受限 data 角色解析 user_id，**入参形状里没有 owner 参数**）→ 归属协会行经真实 RLS（tenant 臂 + restrictive 主体自读臂）读本人行 → 命中才触达 personal_memories 行内容；他人（同团队/同公司/跨团队/跨公司）一律 canonical `RESOURCE_NOT_FOUND` 单一形状，错误与计数零存在性泄露 | AC1 组（属主正向读/搜；同团队另一人读/搜同一条 → deny 同形；跨团队/跨公司/公司管理员同拒；撤权（公司 epoch 前进/团队停用）后立即失效；集合为空时逐条读取同样 not-found） |
| AC2 | 记忆来源选择只列出调用者有权访问的库与文档 | `selectMemorySources(scope)`：先定允许集合（消费 MT036 权威 `listVisibleKnowledgeBaseRegistrations`——注册表求值 + 跨库一致），再逐库列文档（KB 库 `knowledges` 行按 tenant + 允许库集合 + 未删除过滤）→ 无权库/文档根本不出现，列表计数不泄露 | AC2 组（可见库+文档列出；同团队另一人的私有库不出现；跨团队/跨公司库不出现；私有文档不出现；无权调用者得到空集；请求收窄 narrowRetrievalScope 同源验证——愿望清单里无权 id 被静默排除） |
| AC3 | 缓存键含个人与范围标识，切换用户/团队不串用 | `personalMemoryCacheKey`（纯函数，消费 MT015 scoped-keys 同族纪律）：`pmem/v1/t=<tenant>/w=<workspace>/p=<principal>/u=<user>/c=<company>/o=<override>/<domain>/<digest(logical)>`——个人（principal+user）与范围（tenant+workspace+配置版本）全部原样入键；逻辑段单向摘要；身份单射（无 trim/归一化）；零环境读取 | AC3 组（同团队两用户同逻辑键互不命中；同用户跨团队互不命中；同用户同团队确定性；配置版本变化旧键失效；逻辑段摘要不泄露；非法身份响亮拒绝；用 keyed cache 实证切换不串用） |
| AC4 | 公共 Bot 使用时记忆按使用者本人权限解析，不使用创建者记忆 | `resolvePublicBotMemoryAccess(scope, {resourceId})`：MT018 同款本地镜像切片（kind='bot' + visibility='workspace' + active + workspace=scope.workspace + 公司/团队成员重验）→ 记忆主语一律取 scope 的 principalId（使用者本人），创建者主体只在事务内作存在性守卫、绝不进入输出；输出 = 使用者本人的记忆主语 + 本人可见来源集合 | AC4 组（使用者解析出本人主语；召回只见本人记忆、创建者记忆零出现——同团队创建者与使用者各持独立记忆行实证；创建者私有 Bot/跨团队 Bot = canonical not-found；输出形状零创建者材料逐字段断言） |

## 1. 领域模型：`enterprise_memory_scopes`（新表，唯一新持久化对象）

`personal_memories` / `memory_sources` 是旧域表（只带全局 `owner_user_id`）。父 Spec §4.2 明文
「禁止只用全局 user_id 将不同公司的业务数据混在一起」，故按 MT060 协会表先例（openmuse_task_scopes）
新增归属协会表，一行 = 一条个人记忆在一个 (公司, 团队, 主体) 三元组上的归属：

```
enterprise_memory_scopes
  memory_id    text PK  FK→personal_memories(id) ON DELETE CASCADE   -- 根记录（受约束关联）
  tenant_id    text NOT NULL  ┐ 复合 FK→enterprise_workspaces(tenant_id,id) CASCADE
  workspace_id text NOT NULL  ┘   （同时证明 workspace 属于该公司）
  principal_id text NOT NULL  ┐ 复合 FK→enterprise_memberships(tenant_id,principal_id) CASCADE
  user_id      text NOT NULL  ┘ FK→users(id) CASCADE（OpenBot 全局用户；不变量 owner_user_id=user_id）
  attribution  text CHECK in ('created','backfill') NOT NULL
  created_at   timestamptz DEFAULT now() NOT NULL
  INDEX (tenant_id, workspace_id, principal_id, memory_id)  -- 范围读取
```

- **写入纪律**：create-once（`pinMemoryScope`）。同记忆重放同三元组 = 幂等返回 existing（零写入）；
  携带不同范围标识 = `MEMORY_SCOPE_MISMATCH` 响亮拒绝且已存行不动。零 UPDATE 授权——归属不可改写
  是结构不是纪律（MT060 同款）。
- **不可见语义**：无协会行 = 对一切 scope 不可见（不存在/隔离/跨范围对外不可区分；与 MT011
  canonical not-found 逐字节同形）。
- **RLS**（MT060 同模式，无扫描臂——记忆无 MT042 重建消费者）：REVOKE PUBLIC+四能力角色 →
  ENABLE+FORCE → data 租户臂 SELECT + **restrictive 主体自读臂** → operator 租户+主体上下文
  读/插/删 → 最小 GRANT。目录角色无任何策略与授权。
- **backfill**（迁移第三步 `legacy_memory_backfill`）：幂等——只为 owner principal 恰有唯一一条
  workspace membership 的旧记忆行补归属（attribution='backfill'）；零条或多条保持无行 = 受控隔离
  （Spec §9.2「无法唯一归属的历史对象进入受控隔离清单，不按猜测分配」）。NOT EXISTS +
  ON CONFLICT DO NOTHING 可重放零重复。
- **迁移链位次**：MT039 任务（3 步）注册为迁移链第 23 任务（MT060 之后、链尾），波次 16 brief 钉定。

## 2. 服务模块：`server/src/enterprise/tenancy/personal-memory-isolation.ts`

单文件隔离域（MT036/MT060 单文件先例），纯新增、对既有交付只读消费：

- **消费面（全部只读，零改动）**：MT008 资源策略注册表与 not-found 语义、MT010 判定事务纪律
  （受信 Scope → read committed + lock/statement timeout → 事务本地 set_config → advisory 锁 →
  受限 data 角色真实 RLS）、MT036 KB 权威（`createKbOwnershipAuthority` 判定/列表）、
  MT018 公共 Bot 镜像切片模式、MT015 scoped-keys 键纪律。
- **出口（5 个 seam + 1 个纯函数）**：
  1. `resolveMemoryActor(scope)` → 记忆主语解析：`{ ownerUserId, tenantId, workspaceId, principalId }`。
     入参形状里没有 owner 参数——「读谁的记忆」永远是「调用者本人」，同团队另一人结构上无路径。
     deny = canonical not-found（成员失效/主体不存在对外不可区分）。
  2. `pinMemoryScope(scope, {memoryId})` → 归属 pin（create-once；记忆行 owner_user_id 必须 =
     解析出的本人 user，否则 canonical not-found——别人的记忆 id 不能被 pin 到自己名下）。
  3. `recallScope(scope, {search?})` → 本人可见记忆集（协会行 RLS 读取 + join 记忆行
     enabled/未删/子串搜索）。搜索词只作用于本人行。
  4. `readMemory(scope, {memoryId})` → 单条读取；协会行不可见 = canonical not-found（同团队
     另一人读同一条得到同一 deny 形状，零泄露）。
  5. `selectMemorySources(scope)` → AC2 来源选择：允许集合（MT036 权威）→ 库视图 + 文档清单
     （KB 库 knowledges 行，tenant + 允许库 + 未删）；`narrowSourceWishlist(scope, ids)` →
     愿望清单收窄（复数形态，无权 id 静默排除）。
  6. `resolvePublicBotMemoryAccess(scope, {resourceId})` → AC4 公共 Bot 使用者本人解析（§0/AC4）。
  7. `personalMemoryCacheKey(identity, domain, logicalKey)` → AC3 缓存键（纯函数）。
- **信任边界**：`assertTrustedScope` 只放行 seam 签发的 Scope；上下文形状先于信任判定
  （TENANT_REQUIRED/WORKSPACE_REQUIRED 同款）；拒绝只含代码，绝不回显值；模块零 console、零 process.env。
- **装配边界（诚实披露）**：与 MT036/MT037/MT038 同判例——本票交付决定域与迁移注册；
  生产装配（index.ts 把记忆工具/公共 Bot 运行入口接到本决定域）属下游消费票，本票不接路由。

## 3. 缓存键形状（AC3）

```
pmem/v1/t=<tenantId>/w=<workspaceId>/p=<principalId>/u=<userId>/c=<company>/o=<override>/<domain>/<digest40(logicalKey)>
```

- kind 前缀 `pmem` 与 MT015 四种键前缀互不相同（同类同参不跨 kind 碰撞）。
- 个人段（p/u）+ 范围段（t/w/c/o）全部原样入键（单射）；身份语法 = 单行、无 "/" "=" 空白与控制字符、
  首字符字母数字，越界响亮拒绝（`MEMORY_KEY_INVALID_*`，零值回显）；逻辑段 SHA-256 截断 40 hex
  （机密不可能入键、不可反推）；派生纯函数零环境读取（MT015 同纪律）。
- domain 限小写 kebab（`recall`/`context`/`sources` 等调用方域标签）。

## 4. 测试面：`server/tests/multitenancy/personal-memory.test.ts`（票面钉定文件名）

- 支持：`tests/multitenancy/support/personal-memory.ts` = MT008 资源夹具（身份矩阵 + 受信 scope
  + 三受限通道）+ MT036 KB 夹具形态（KB 库行 + 主库 knowledge 注册 + 镜像行）+ 记忆行/来源行种子
  （setup 通道披露 stand-in：personal_memories/memory_sources 是旧域表，种子走属主通道；判定侧
  从不使用 setup 通道——全部被测读取经受限 data/operator 角色与真实 RLS）。
- 迁移链：测试 beforeAll 幂等 apply（brief 依赖序 + MT039 链尾；applied | up-to-date 双收敛），
  与 MT036 先例一致；KB 库 drizzle-kb journal 幂等。
- 环境契约：七变量缺一整套显式 skip（跳过原因写在用例名，skipped 不计通过），绝不回退开发库。
- 既有交付（MT036/MT037/MT038/MT015/MT018/MT010）全部只读消费：本套件任何用例都不修改它们。

## 5. 窄缝（共享文件，纯追加，逐项披露）

1. `server/scripts/multitenancy/migrate-test.ts`：追加 MT039 任务块（3 步）+ TASKS 注册表尾部一行。
2. `server/tests/multitenancy/migration-tool.test.ts`：穷举断言追加 `"MT039"`（排序位 MT031<MT039<MT041，
   ruling #5 先例第 21 次沿用，brief 预授权窄缝）+ 票面预授权注释。
3. `server/src/db/schema/index.ts`：barrel 追加 `./enterprise-memory-scopes`（字母序正确位）。

## 6. 变异计划（每安全分支 ≥1；注入→聚焦捕获→字节复原→复绿）

| 变异 | 注入点 | 预期捕获 |
|---|---|---|
| MUT1 | `recallScope` 移除协会行主体自读约束（去 restrictive 臂语义/主体谓词放宽为真） | AC1 同团队另一人读/搜用例失败 |
| MUT2 | `readMemory` 把 canonical deny 换成按记忆行直查（存在即返回） | AC1 他人单条读取用例失败（泄露） |
| MUT3 | `selectMemorySources` 允许集合旁路（列全部租户库/文档） | AC2 无权库/文档用例失败 |
| MUT4 | `personalMemoryCacheKey` 丢个人段（p/u 不入键） | AC3 跨用户串用用例失败 |
| MUT5 | `personalMemoryCacheKey` 丢团队段或身份归一化（trim 小写） | AC3 跨团队串用/单射性用例失败 |
| MUT6 | `resolvePublicBotMemoryAccess` 输出改用归属行 owner_principal（创建者） | AC4 输出形状/创建者记忆零出现用例失败 |

RESTORE：全部变异从 pristine 副本逐字节复原；RESTORE 后聚焦复绿 + 哈希逐位核对。

## 7. 验证顺序（三步配方从零）

1. `bun install`。
2. 容器 `mt039-impl-pg`（pgvector/pgvector:pg16 @127.0.0.1:55594，loopback trust）；psql 逐条 -c：
   KB 属主角色（NOSUPERUSER…LOGIN）先于建库；三库 openbot_enterprise_w16c_test / _assigned /
   openbot_kb_w16c_test。
3. 七变量 env（0600 用后删）：TEST_DATABASE_URL、三个受限登录角色 URL、MT003_ASSIGNED_TEST_DATABASE_URL、
   KB_TEST_DATABASE_URL、ENTERPRISE_TEST_SETUP_DATABASE_URL（同指主库）。
   `enterprise-test-db.ts migrate`（150 表 + ob_ent_* 角色供给）→ 修正链序 19 前置 → MT029→MT073→MT060
   （逐任务 generate+apply --manifest 闭环）→ 基线复现 1222/0/47。
4. TDD RED→GREEN→REFACTOR（聚焦套件）→ 变异 + RESTORE → 重放链（含 MT039，23 任务）→
   全量回归（= 基线 + 新增）→ typecheck 0 → biome 触及文件零增量。
