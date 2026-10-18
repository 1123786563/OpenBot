# MT036 实施计划 —— 知识库的团队归属与受限查询（Issue #79）

角色：backend_implementer。BASE f0520524（prereq-manifest 108 项已复算一致）。
无提交/推送/合并/生产迁移/部署。RED→GREEN→REFACTOR；变异全捕获；交付未提交工作树 + checkpoints/MT036/ + reports/MT036.md。

## 事实源

- Issue #79（gh 实取）：四条验收 + Scope boundary（知识库归属字段与查询限制、跨库一致性约定、知识库侧受限查询入口）+ Verification `bun test server/tests/multitenancy/kb-ownership.test.ts`（含知识库专用测试库）。覆盖 A1/A2/A4。
- 父 Spec §4.2（知识库=tenant_id+workspace_id）、§6（检索先定允许集合再检索端限制；公司范围 Key 只作受控内部能力）、§2（KB 服务身份空 kbScope=公司内全库——旧 Key 不能承担普通团队调用）。
- ADR 0004 accepted；CONTEXT.md「公司与团队」。
- 先例：MT008 判定注册表（只读消费）、MT009 知识依赖+诚实边界（本票补「对运行者本人可见」）、MT011 canonical 不可见语义+列表形态、MT012 §7 RLS 模板、MT014 新表+新 schema 文件范式、MT015 键纪律、MT079 夹具包装范式。

## 设计

两个独立数据库：主库（enterprise，权威授权面）+ KB 库（kb_mastra，内容面）。一致性由**调用时授权**（主库 MT008 注册表求值，无缓存）+ **同步版本**（两侧可比对版本令牌）保证；绝不假装跨库外键。

### 新文件（全部新建）

1. `server/src/enterprise/tenancy/kb-ownership.ts`（主库侧权威）：
   - `KNOWLEDGE_RESOURCE_KIND = "knowledge"`；KB 注册 = `enterprise_resources` 行（kind='knowledge'）。
   - `KbOwnershipRegistration`：{tenantId, kbId, workspaceId, status, visibility, revision, aclEpoch, policyRevision}。
   - `kbSyncVersionOf(reg)`：确定性版本令牌 `kb-sync/v1/w=<workspaceId>/r=<revision>/e=<aclEpoch>` —— KB 侧必须镜像的同步版本。
   - `createKbOwnershipAuthority({data, registry?})`（assertDataDatabase + assertTrustedScope）：
     - `registrationFor(scope, kbId)`：MT008/MT011 同款事务形状（read committed + lock/statement timeout + 事务本地 app.* + advisory 共享锁同键族），受限 data 角色下经真实 RLS 读注册行（kind 过滤）+ grant + membership + tenant policy_revision → 注册事实 | null。
     - `authorizeKnowledgeBase(scope, kbId)`：同一事务内经**同一注册表**求值 → allow | canonical RESOURCE_NOT_FOUND（not-found-semantics 复用，只读消费）。
     - `listVisibleKnowledgeBaseRegistrations(scope)`：候选行 kind='knowledge' + scope 租户/团队，逐行注册表求值只留 allow（列表=decide 的复数形态）。
   - `compareKbOwnershipSnapshot(reg, snapshot)`（纯函数）：missing/tenant 不符 → `KB_OWNERSHIP_MISSING`；workspace 不符 → `KB_OWNERSHIP_WORKSPACE_MISMATCH`；版本令牌不符 → `KB_SYNC_VERSION_STALE`；一致 → ok。一致性门只在授权放行后执行（请求者已被告知存在性），拒绝码确定性、零值回显。
2. `server/src/kb/db/ownership-schema.ts`（KB 库侧归属状态表）：
   - `knowledge_base_ownership_states`：knowledge_base_id（PK，FK→knowledge_bases cascade）、tenant_id、workspace_id、sync_version（KB 侧镜像的同步版本）、updated_at。expand-only 新表，不动 knowledge_bases 既有列。
3. `server/src/kb/application/service/kb-restricted-query.ts`（知识库侧受限查询入口）：
   - 请求者类型 = 服务端签发的受信 PlatformScope（assertTrustedScope）。内部 API-Key `Identity`（tenantId+role+kbScope，无 principal）**结构性进不来**：普通请求复用内部 Key 得不到任何公司全域视野（验收 4）。
   - `listKnowledgeBases(requester)`：authority.listVisible → KB 库按 id+tenant+未删读行 → 逐行 ownership state 存在且 compare ok 才进列表（缺失/不一致一律不浮现）。
   - `getKnowledgeBase(requester, kbId)`：authorize deny → canonical invisible；allow → KB 行缺失 → 同 invisible；ownership state 缺失/不一致 → KB_OWNERSHIP_* 确定性拒绝（不放大内容）。
   - `narrowRetrievalScope(requester, kbIds)`：检索前把请求 KB 集合收窄到「授权+一致」集合（§6：先定允许集合，再在检索端限制；补 MT009 D4 边界——依赖引用对运行者本人可见）。
4. `server/drizzle-kb/0001_*.sql` + meta（KB 库迁移，drizzle-kit 生成；drizzle-kb.config.ts schema 数组追加 1 行）。
5. `server/tests/multitenancy/kb-ownership.test.ts` + `server/tests/multitenancy/support/kb-ownership.ts`（包装 createResourcePolicyFixture + KB 测试库）。

### 明确不改

- migrate-test.ts / migration-tool.test.ts：**主库零迁移**（复用 enterprise_resources + MT009 依赖表 + MT008 注册表）→ 无任务注册、无窄例外。KB 库迁移走 KB 域自己的 drizzle-kb 通道（migrate-test 工具只作用于企业测试库，D 披露）。
- enterprise-tenancy schema、index.ts、tenancy 既有模块：零字节改动。KB schema.ts（knowledge_bases 四表）：零改动。

## 环境契约

- 容器 `mt036-impl-pg`（pgvector/pgvector:pg16，127.0.0.1:55515 起预检，占用 +1 记录）。
- 库：`openbot_enterprise_mt036_test`（+`_assigned`）+ **`openbot_kb_mt036_test`**（知识库专用测试库，专用受限登录 `ent_mt036_kb`，NOSUPERUSER NOBYPASSRLS，属主通道跑 drizzle-kb 迁移）。
- env 七变量：ENTERPRISE_TEST_SETUP_DATABASE_URL、TEST_DATABASE_URL、ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL、MT003_ASSIGNED_TEST_DATABASE_URL、KB_TEST_DATABASE_URL。0600 env 文件，不落报告。
- beforeAll：迁移链 MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069（brief 依赖序，幂等 dry-run→manifest apply）；KB 库 runMigrations（drizzle-kb journal 幂等 + advisory lock）。
- 缺 env 显式 skip 绝不回退开发库；验收运行必须 0 skip。

## 测试矩阵（验收映射）

- AC1 列表/查询只返回当前范围；他司库 ID 不可见：a1 列表只含 A1 KB；b1/a2 取 A1 KB → canonical RESOURCE_NOT_FOUND 逐字节=不存在；suspended → 不可见；计数不泄露。
- AC2 归属变更立即反映：move（operator 策略内 UPDATE workspace_id+revision bump + KB 侧状态行同步更新）→ a1 立即失去、a2 立即获得；连发查询一致；无任何缓存层（结构性）+ 变更前旧令牌查询被拒。
- AC3 跨库引用同步版本+调用时授权：MT009 依赖行（kind=knowledge）→ 主库注册缺失/KB 行缺失/workspace 不一致/版本 stale → 各自拒绝；一致+授权 → 放行；检索收窄：未授权 KB 不进检索集合。
- AC4 内部服务身份不可获无限范围：内部 Identity 形状（无 principal）→ 入口拒绝（KB_REQUESTER_INVALID / assertTrustedScope）；伪造 scope → 拒；真实 seam scope → 正常；受信入口不读 kbScope——授权只来自注册表事实。

## 变异计划（≥5，全部捕获）

MUT1 kind 过滤移除；MUT2 列表注册表求值移除；MUT3 同步版本比对移除；MUT4 受信门移除；MUT5 KB 库租户过滤移除；MUT6 workspace 比对移除。
