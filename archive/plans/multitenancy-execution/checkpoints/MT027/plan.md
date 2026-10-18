# MT027 / Issue #70 实施计划 —— 连接凭据与站点登录归属，可用不等于可读明文

- 角色：backend_implementer（Pi，Orca task_f6f9948a2f78 / dispatch ctx_502a08e5b331）
- BASE：`f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（prereq-manifest 首行一致；107 项哈希领取时逐项复算一致）
- 前置核验：Blocked by #57（MT014 runtime-config）与 #53（MT010 personal-share）均已验证集成在本工作区（reports/MT014.md、MT010.md；模块与哈希在位）。本票对其只读消费。
- 无提交/推送/合并/生产迁移/部署授权；交付 = 未提交工作树 + `checkpoints/MT027/` + `reports/MT027.md`。

## 票面 → 交付映射（Issue #70）

| 验收 | 交付面 |
| --- | --- |
| 1 个人凭据只对本人可用可读；同团队其他人不能使用也不能读取 | `enterprise_credentials.classification='personal'`（owner_principal_id 复合 FK 证明本公司成员）+ 判定门：use/disclose 仅属主放行；同团队他人、跨团队同事、公司管理员（MT075 admin-separation 先例）一律 canonical RESOURCE_NOT_FOUND |
| 2 团队/公司凭据按动作授权可用；明文读取独立授权且留审计 | `enterprise_credential_actions`（action ∈ {'use','disclose'} 闭集，行级独立——use 授权绝不蕴含 disclose）；团队凭据要求对象归属团队的 active 成员资格 + 'use' 行；公司凭据要求 active 公司成员资格（epoch 对 scope 核对）+ 'use' 行；`disclosePlaintext` 需要 'disclose' 行，成功披露写 `enterprise_credential_audit`（append-only，data 无 SELECT） |
| 3 跨公司凭据 ID 调用 → 不可见语义 + 不触发供应商调用 | 判定门 deny = MT011 canonical `{outcome:"deny",code:"RESOURCE_NOT_FOUND"}` 与不存在逐字节同形；allow 变体独占携带 envelope——deny 结构上无可执行材料，测试以供应商探针（allow 分支才计数）证明 0 次触发；复合 FK 内嵌 tenant_id 使跨公司归属行结构上不可能（23503 兜底） |
| 4 列表与详情默认脱敏；响应/日志/错误零明文 | 视图类型无 envelope 字段（结构脱敏）；列表只含本人个人 + 本人有 active 成员资格团队的团队凭据 + 本公司公司凭据（计数不泄露跨范围存在性）；模块零 console、零 process.env；拒绝消息只含代码；canary 机密全路径扫描测试钉死 |

票面边界：取用 lease = MT029；OAuth 归属 = MT028；既有部署级 `credentials`/`saved_logins` 表的消费接线 = 下游票。本票交付：存储归属（新权威注册表）、明文读取授权判定 + 审计、脱敏展示视图、新表 RLS。

## 设计

### 存储面（新 `server/src/db/schema/enterprise-credentials.ts`，MT027 迁移 expand-only）

1. `enterprise_credentials`：一行 = 一个连接凭据或站点登录的真实归属。PK `(tenant_id, id)`；`kind` CHECK ∈ ('connection','site-login')；`classification` CHECK ∈ ('personal','team','company')；行形 CHECK：team ⇔ workspace_id NOT NULL、personal ⇔ owner_principal_id NOT NULL（company 两者皆 NULL）。`target`（非机密寻址：origin/provider）、`display`（非机密展示元数据）、`envelope`（仅密封密文，明文永不入库）、`status` ∈ ('active','revoked')。复合 FK 内嵌 tenant_id：`(tenant_id, workspace_id) → enterprise_workspaces`（团队属于该公司）、`(tenant_id, owner_principal_id) → enterprise_memberships`（属主是该公司成员）——跨公司归属行结构上不可能。
   RLS（FORCE）：data 仅租户范围 SELECT；operator 租户范围 SELECT/INSERT/UPDATE；directory 零授权。
2. `enterprise_credential_actions`：动作授权事实。PK `(tenant_id, credential_id, principal_id, action)`；action CHECK ∈ ('use','disclose')；`granted_by` NOT NULL。复合 FK：credential 归属本公司、principal 与 granted_by 均为该公司成员。RLS：data 仅「本人行」SELECT（tenant+principal）；operator 租户范围 SELECT/INSERT/DELETE（撤销 = 删行，MT010 先例）。
3. `enterprise_credential_audit`：明文披露审计，append-only。PK `(tenant_id, id)`；action CHECK = 'plaintext.disclosed'；`detail` 只含非机密事实快照（kind/classification/target）。无 credential FK（MT069 审计先例：审计不随对象消亡）。RLS：data 仅租户范围 INSERT（成员不能互查审计）；operator 租户范围 SELECT；任何角色无 UPDATE/DELETE。

### 服务面（新 `server/src/enterprise/tenancy/credential-ownership.ts`）

- `SecretVault` seam（注入）：`seal(plaintext)→envelope` / `open(envelope)→plaintext`；模块自身不持钥匙、不 import env。生产装配接 `credentials.ts` 的 encryptSecret/decryptSecret（index.ts 纯追加），测试用内存 vault。
- `createCredentialOwnershipAdminService(operator, vault)`（受限 operator 通道，fail-closed）：register（形状校验、display 闭形、seal 后入库）、revoke（status 翻转）、grantAction/revokeAction。拒绝只含代码，零值回显。
- `createCredentialOwnershipDecisionService(data, vault)`（受限 data 通道）：assertTrustedScope → 事务（read committed + lock/statement timeout + 事务本地 set_config + advisory 共享锁，键序 tenant→principal→membership→workspace-membership→credential，与 resource-policy 完全同形）→ 真实 RLS 下读事实 → 判定。
  - `authorizeUse(scope, id)`：allow {redactedView, envelope} | canonical deny。personal=属主；team=对象归属团队的 active 成员 + 'use' 行；company=active 公司成员（epoch 对 scope 核对，personal-share 先例）+ 'use' 行；revoked/跨范围/不存在 = 同一 canonical deny。
  - `disclosePlaintext(scope, id)`：同门但要求 'disclose' 行（或 personal 属主）；allow 时 open + 同事务写审计 + 返回明文；deny 时无审计、无 open、canonical deny。
  - `listVisible(scope)` / `describeCredential(scope, id)`：脱敏视图（类型上无 envelope 字段）；列表可见性 = 本人个人 ∪ 有 active 成员资格团队的 team ∪ 本公司 company；effectiveActions 反映本人 'use'/'disclose' 行。
- 输出深冻结；模块零 console / 零 process.env（源码级断言钉死）。

### 装配与注册（授权扩展点，纯追加）

- `server/src/db/schema/index.ts` 追加 1 行 barrel 导出。
- `server/scripts/multitenancy/migrate-test.ts` 纯追加 MT027 任务（0001 建三表 + 0002 RLS/授权）。
- `server/tests/multitenancy/migration-tool.test.ts` 仅穷举断言追加 "MT027" + 裁决注释（ruling #5 第 12 次先例）。
- `server/src/index.ts` 装配段纯追加 `credentialOwnership`（decisions=data 通道；admin=operator 通道，缺通道 null fail-closed；MT010 personalShareRules 同款）。

### 测试（新 `server/tests/multitenancy/credentials-ownership.test.ts` + `support/credentials-ownership.ts`）

沿用 MT008/MT010 夹具链（isolation fixture 全身份矩阵 + 真实受限角色 + 真实 RLS）；测试内经 MT003 工具 dry-run→apply MT027 迁移。describe 按验收 1–4 + 存储契约分组；供应商探针（allow 分支计数）证明验收 3；canary 全路径扫描证明验收 4；catalog 探针（superuser 只读）钉 FORCE RLS 与最小授权矩阵。缺 env 显式 skip、绝不回退开发库。

## 验证门槛（brief）

1. 基线：`bun test tests/multitenancy/ --timeout 60000`（改动前存档，brief 期望 638/0/23）。
2. 专用容器 pgvector/pgvector:pg16 @127.0.0.1:55514（占用则 +1 并记录）；`enterprise-test-db.ts migrate`；迁移依赖序 base + MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069 (+MT027)。
3. 聚焦：`bun test tests/multitenancy/credentials-ownership.test.ts` 全绿 0 skip。
4. 全量回归：基线 + 新增全绿；typecheck 0；biome 触及文件 0 新增（收尾复跑存档）。
5. 变异测试全捕获（对判定门每个防线做外科手术式变异）。
6. checkpoints/MT027/ 全套（before/after 哈希、red-green、mutation、verification 编号存档）+ reports/MT027.md（披露 D1-Dn）+ worker_done --report-path。

## TDD 波次

- RED：先写测试（+test support 夹具），模块不存在 → `Cannot find module`（功能缺失型 RED）。
- GREEN：schema + 模块 + 迁移注册 + 装配 + barrel + allowlist 断言 → 聚焦全绿。
- REFACTOR：biome/类型收窄，语义零变化；全量回归复绿。
