# orca-dag-wave2 · mt2c 执行报告

- Worker session: `951b2338-4320-4416-ba5b-bdd81520df35` / task `task_3e95da30e12a` / dispatch `ctx_73c86cf6ea77`
- Worktree: `mt2c`（从 main@最新 新建；未 commit、未 push——GitHub 全程只读）
- 处理票（按序）：#121 (MT078) → #143 (MT100) → #167 (MT124)

## 逐票结论

### #121 / MT078 业务审计与身份审计分域，计费管理需明确授权 — **SATISFIED**

实现：
- `server/src/db/schema/enterprise-audit.ts`（新）：`enterpriseAuditEvents`（domain ∈ business|identity|platform CHECK；operator SELECT=tenant pin / INSERT=tenant+operation 双 pin 策略）+ `billingCompanyManageGrants`（PK(tenant,principal)+actions 位集 1|2|4 CHECK 1-7，双侧复合 FK→enterprise_memberships）
- `migrate-test.ts` 新任务 `MT078`（建表+策略+GRANT+FORCE RLS；expand-only），同步 `migration-tool.test.ts` ALLOWED_TASK_IDS
- `server/src/enterprise/tenancy/audit-domains.ts`（新）：`recordTenantAuditEvent`（operator 事务双 pin+脱敏）、`auditDomainAllowed` 域矩阵（company→business only ∧ active ∧ role∈{auditor,tenant_admin}；platform→identity|platform）、`queryTenantAuditEvents`/`exportTenantAuditEvents`（判定门先于读）、`createBillingManagementService`（grant/revoke/assert + performBillingManagementAction：判定门→发放→business 域审计）

测试（真实 PG RLS，`openbot_enterprise_mt2c`，受限 ob_ent_* 三角色）：
- `bun test ./tests/multitenancy/audit-domains.test.ts` → **26 pass / 0 fail**（AC1-AC4：域矩阵、RLS 地板、停用即时失效、tenant_admin 不自动获得计费管理、动作位不覆盖、跨公司空、幂等回放、受限角色 has_table_privilege 结构隔离反证、拒绝同形不泄露）
- `bun test ./tests/multitenancy/migration-tool.test.ts` → **42 pass / 0 fail**

### #143 / MT100 桌面切换或退出组织时清理公司媒体与订阅状态 — **SATISFIED**

实现：
- `desktop/src-tauri/src/org_switch_cleanup.rs`（新）：组织态区域 `<root>/.openbot/organizations/<sha256(authority)>/`（media/cache 子目录+subscriptions.json）；`forget_organization_state` 顺序=数据先删、凭据最后删，幂等可重试，末尾验证全空→completed；证据日志有界 64 行、仅标识符与计数（无明文）
- `main.rs` 新命令 `leave_organization`（Shell root 门控；target 取自 PersistedRecord::Present(context).authority 或 current_organization 指针；context 匹配才清 VAULT_KEY+legacy SAVED_COOKIE）
- `desktop/src/OrgSwitchCleanup.tsx`（新组件）：completed 显示计数证据；未完成显示"Nothing was half-cleaned — try again"并保留重试。**有意不挂 App.tsx**——接线归 MT101/MT102，避免重复实现（票注明示范围）

测试：
- `cargo test org_switch_cleanup`（desktop/src-tauri）→ **7 pass / 0 fail**
- `cargo test`（全量）→ **748 pass / 0 fail**
- `bun test desktop/src/OrgSwitchCleanup.test.tsx`（happy-dom+testing-library，`within(document.body!)` 查询）→ **3 pass / 0 fail**

### #167 / MT124 企业入口装配接入统一上下文与授权 — **SATISFIED**

实现：
- `server/src/enterprise/tenancy/assembly-enterprise.ts`（新）：`createEnterpriseConversationEntryRoutes({factory, service})`——4 条会话路由每条先 `factory.fromRequest` 建立上下文（**与部署主入口同一个工厂**，非平行实现）；thread 归属由服务自己的授权判定（跨公司/不存在同形 404）；错误映射逐字节复用 `enterpriseConversationErrorResponse`，仅补 TENANT_REQUIRED/WORKSPACE_REQUIRED→400 canonical
- `conversations/routes.ts` 导出 `enterpriseConversationErrorResponse`（防漂移注释）
- `index.ts` 装配切换：`createEnterpriseConversationEntryRoutes({factory: enterpriseCapabilities.entry, service: enterpriseCapabilities.conversations})`（最小 diff：import 一行+装配一处）
- `ENTERPRISE_ENTRY_DISPOSITIONS`（9 条：4 会话=unified-entry-context/MT124；GET workspace-scope=shared-session-resolution/MT124；4 admin=company-admin-context/MT075）+ `inventory.ts` `applyEnterpriseEntryDispositions` 回写（mergeEntrances 前，仅盖 ownerTicket===null 的精确匹配）

测试（真实 PG + 同一工厂双装配对照）：
- `bun test server/tests/multitenancy/assembly-enterprise.test.ts` → **17 pass / 0 fail**（AC1 拒绝矩阵 401/400/403；AC2 同一工厂 scope 等价+fail-closed；AC3 六组同 service 双装配 status+body 全等、外来 thread 与不存在同形且 legacy 同形；AC4 处置表自洽+两个真实构造器路由表精确匹配+buildInventory 9 条全盖章 owned）
- `bun test ./tests/multitenancy/inventory.test.ts` → **30 pass / 0 fail**（盖章兼容既有断言）

## 回归

- `bun test ./tests/multitenancy/`（全量，. /tmp/mt2c-env.sh）→ **1229 pass / 3 fail**；3 fail 全部为基线红（见下）
- typecheck（server `bun run typecheck`）→ 仅 `scripts/bootstrap-local-gateway.ts` 两处（HEAD 基线红，文件未在本任务改动集）
- biome：本任务新增/修改文件全部干净；`server/src/index.ts` 剩余 6 处违规经 HEAD 副本对照确证为基线既有

### 基线漂移记录（非本 worker 引入，未修）

1. `billing-visibility.test.ts` ×1：support 未传 ownerPayerRef（assertOwnablePayerRef 抛错）——兄弟 mt2b 范围，main 基线即红
2. `team-public-rules.test.ts` ×2：knowledge 依赖指向已删除/不存在 KB 期望 deny 实际 allow——887f0cff「全量移除 KB 子系统」后的语义缺口，被测文件不在本任务 diff
3. `bootstrap-local-gateway.ts` typecheck ×2：联合类型窄化（`probeRun.result`/`negotiationRun.reasonCode`），HEAD 基线红
4. `server/src/index.ts` biome ×6：HEAD 副本对照同款报错（noConsole×3、noNonNullAssertion、noUnusedImports、organizeImports）

## 测试库配方（容器 orca-w2-mt2c-pg @ 127.0.0.1:5567，pgvector pg16）

- 派发指定库名 `mt2c` 被 enterprise URL 校验拒收（强制 `openbot_enterprise_*` 前缀）→ 实际使用 `openbot_enterprise_mt2c`（沿 mt2 报告先例）+ `openbot_enterprise_mt2c_assigned`
- 制备：DROP/CREATE → `enterprise-test-db.ts migrate`（main 链含 0163）→ 从 0163_restore_drifted_tables.sql 提取 CREATE TABLE 名并 DROP → `ALTER TABLE enterprise_resources DROP COLUMN IF EXISTS visibility` → 按序 25 个 MT 任务（MT004…MT067，含新增 MT078 共 26）→ roles.sql 三角色（ent_mt2c_{dir,data,opr}）
- 环境脚本 `/tmp/mt2c-env.sh`（7 变量）、制备脚本 `/tmp/mt2c-provision.sh`（journal 26 任务，failed:[]）

## 改动清单（sha256）

#121 (MT078):
```
47f1c2f53afa96f170d536f2277f2264bc7566dfd87f5bb19482979c58c2ee47  server/src/db/schema/enterprise-audit.ts
cc2a0f47630edc79057b214a7a3279874c70e9cf1fde78d4d0b15b76e6d9cb7a  server/src/db/schema/index.ts
55d9ac17c7478fc8a91184680e44c3c00738bf7ccc97f247884261cb928f04aa  server/scripts/multitenancy/migrate-test.ts
f3fe2c4b94550e76c5bb0c23d77630f04a5be7294d33e0ab6fbc35c605e96722  server/src/enterprise/tenancy/audit-domains.ts
38346cb8fc60bce5ade66130856d763a153575a14f3748a01d16cde6b5a1e0b3  server/tests/multitenancy/support/audit-domains.ts
f8cef1b48968f5d653201551a974af5803239e9868cfd36af44f4504965021e1  server/tests/multitenancy/audit-domains.test.ts
1911baf4c7deaea284c22c5bf383312c9a6812cf91aa5210fdc22cf4249acea5  server/tests/multitenancy/migration-tool.test.ts
```

#143 (MT100):
```
0394294c2860de879aead1493da3b6a4bb38928dd79349e2338c252d442aff2f  desktop/src-tauri/src/org_switch_cleanup.rs
f4fa01481369818a9bfaa040cfae968a013713b0f26e4c71e96009a210c66361  desktop/src-tauri/src/credential_namespace.rs
736ec57c225820035caed5c149f08f7239eba86a8e8dc47afecb06184836d5cd  desktop/src-tauri/src/organization_auth.rs
68b7937dcfc5cdb29e6c3aba4738473bd1c7b393ad19f39e9663791c823a8f05  desktop/src-tauri/src/lib.rs
1dccea4e0e3a83982ff57c5624b2ae8336f3463466ef128dbdb0cbbebfc414c6  desktop/src-tauri/src/main.rs
3ff6467746f6dffc85b25a92da9cbc3834e581c60317a76037d7bd3428a42991  desktop/src/OrgSwitchCleanup.tsx
5063959d681ddbbf6c783cf499de746b7a7df0fefe8687a2ab633c3e976ad140  desktop/src/OrgSwitchCleanup.test.tsx
```

#167 (MT124):
```
0b6e05e9c97bd3e779a4d78da82305e6795837bec3a0b78adb01bd44ca86a91d  server/src/enterprise/tenancy/assembly-enterprise.ts
a36ec5c0a80a62cb977fe377b25fbb7f3b8a86dd1f2cb20a244e868211cc9e6c  server/src/enterprise/conversations/routes.ts
cd2d0143643557105d4b4f1c28fd42e19e30fe32dcc90f8c84a60d99413cd45c  server/src/index.ts
bcba27cdb335d0d704fe90df04af49e1a7ac78785e8a21fbf87db82f06b1fbb1  server/scripts/multitenancy/inventory.ts
377c74974d81deed24ccd30241ce7385796fdfded7369ab43ee83804ba16c896  server/tests/multitenancy/support/assembly-enterprise.ts
d2275782bcff0ab58746d6386fab657ba68b55bc9e9911ab1006a781d5cf640a  server/tests/multitenancy/assembly-enterprise.test.ts
```
