# MT029 设计 — 凭据取用 lease：固定用途、作用域且可撤销（Issue #72）

角色：backend_implementer（Orca task_56d683e2165c / dispatch ctx_7d0876176885，树 w15-mt029，BASE f0520524）。
事实源：Issue #72 票面 + 父 Spec §5/§8（A2/A4/A5）+ ADR 0004 + CONTEXT.md；前置交付只读消费：MT027
credential-ownership（凭据归属与 use 权威判定）、MT018 public-bot-usage（公共 Bot 凭据选择=使用者本人）、
MT007 revocation/enterprise_security_events（审计面先例）、MT026/MT028（持久行 + 闭集生命周期先例）。

## 票面四条验收 → 实现面映射

| AC | 票面 | 实现面 |
|----|------|--------|
| 1 | lease 只能用于签发时声明的用途与作用域；改用途或改范围被拒绝 | lease 行在签发时固定 (tenant, workspace, principal, purpose, expires_at)；`validate(leaseId, claimed)` 的 purpose/claimed scope 与持久行逐字段比对，任何不匹配 = canonical deny（不泄漏存在性）；claimed 只参与比对、永不改写持久行（MT026/MT028 先例） |
| 2 | 撤销或过期后，正在进行的取用在下一次校验点失效；后续新取用被拒绝 | `validate` 每次都读实时行：status='active' 且 expires_at > now() 且持有人成员资格仍 active（epoch 匹配）且凭据权威（MT027 use 权威）仍成立——无任何缓存/宽限；revoke = 原子 UPDATE 翻转 status |
| 3 | 公共 Bot 的其他使用者无法获得创建者个人凭据的 lease | `issue` 在签发事务内重验 MT027 use 权威：personal ⇒ 仅属主本人（同团队他人/双团队成员/管理员/跨公司一律 canonical RESOURCE_NOT_FOUND，与「不存在」同形）；team ⇒ 该团队 active 成员 + use 动作行；company ⇒ 本公司 active 成员 + use 动作行 |
| 4 | 每次签发、使用与撤销留审计（不含明文） | 专用 append-only `enterprise_credential_lease_audit`（data 只 INSERT / operator 只 SELECT / 任何角色无 UPDATE DELETE）：issued / validated / revoked 三种闭集动作行；detail 闭形非机密事实（credential_id/purpose/workspace/ttl/checkpoint），类型与结构上无 envelope/plaintext 位 |

## 结构（一域两表一服务 + 测试夹具，纯新增 + 三处授权扩展点）

### 新文件
1. `server/src/db/schema/enterprise-credential-lease.ts`
   - `enterprise_credential_leases`：id = 不透明 lease 令牌（randomUUID，服务端生成）；
     (tenant_id, credential_id) 复合外键 → enterprise_credentials（凭据必属本公司，结构性不可能跨公司）；
     (tenant_id, principal_id) 复合外键 → enterprise_memberships（持有人必是本公司成员）；
     (tenant_id, workspace_id) 复合外键 → enterprise_workspaces（作用域团队必属本公司）；
     purpose 闭集 CHECK（'bot-run' | 'connector-call' | 'site-access'）；
     status CHECK（'active' | 'revoked'）；expires_at > created_at 窗口 CHECK。
     RLS：data SELECT/INSERT pin tenant+principal（持有人只见本人 lease；签发走 data 通道——
     与 MT027 disclosePlaintext 同通道纪律）；operator SELECT/UPDATE pin tenant（撤销走 MT027
     revoke 同款管理通道）；data 零 UPDATE/DELETE（lease 不可被持有人篡改）；directory 零授权。
   - `enterprise_credential_lease_audit`：tenant_id+id 主键；lease_id/credential_id 无外键
     （MT069 先例：审计不随对象消亡）；action 闭集 CHECK（'issued'|'validated'|'revoked'）；
     detail jsonb 闭形 CHECK（禁 envelope/plaintext/secret/value/password/token 键）；
     data INSERT（tenant pin）+ operator SELECT（tenant pin），无 UPDATE/DELETE 授权。
2. `server/src/enterprise/tenancy/credential-lease.ts`
   - `createCredentialLeaseService(data)`（受限 data 通道；决策面）：
     - `issue(scope, { credentialId, purpose, ttlSeconds? })`：assertTrustedScope → 受限 data
       事务（read committed + lock/statement timeout + 事务本地 set_config + advisory 共享锁，
       键序 tenant → principal → membership → workspace-membership → credential，与 MT027 判定
       入口同族）→ 重读 MT027 权威事实（凭据 active + decideCredential 同款 use 判定）→ allow
       才 INSERT lease（active, expires_at = now + ttl）→ 同事务写 issued 审计 → 返回
       { leaseId, expiresAt, purpose }（零秘密材料）。deny 一律 canonical RESOURCE_NOT_FOUND
       （缺失/跨公司/已撤销/无权威对外同形，不泄漏存在性）。
     - `validate(scope, { leaseId, purpose, checkpoint? })`：同族事务 → 读 lease 行
       （谓词内嵌 tenant+id+持有人+workspace 比对，RLS pin tenant+principal 双保险）→ 六道
       校验全过才 allow：status active / 未过期 / purpose 相等 / scope 相等（workspace+principal
       持久行 vs claimed）/ 持有人存活（公司成员 active 且 epoch === scope.memberEpoch +
       团队成员 active）/ 凭据权威重验（MT027 use 判定现读）——AC2 的「下一次校验点」。
       allow 同事务写 validated 审计（checkpoint 进 detail）；deny canonical 同形。allow 返回
       { leaseId, credentialId, purpose, expiresAt }（零 envelope/plaintext——密封材料只能经
       MT027 authorizeUse 的 allow 分支离开，lease 判定不复制密文面）。
   - `createCredentialLeaseAdminService(operator)`（受限 operator 通道；管理面）：
     - `revoke({ tenantId, leaseId })`：原子 UPDATE status active→revoked（WHERE status='active'），
       幂等；同事务写 revoked 审计。
     - 凭据级联：MT027 revokeCredential（status→revoked）⇒ validate 权威重验立即 deny（AC2）；
       MT027 凭据行 DELETE ⇒ lease 复合外键 cascade（无悬挂 lease）。
   - 模块零 console、零 process.env；拒绝消息只含代码；无任何明文/信封字段（结构脱敏）。
3. `server/tests/multitenancy/support/credential-lease.ts` — 夹具（包 resource-policy +
   credentials-ownership 基座：真实两公司三团队名册 + 受限通道 + MT027 服务）+ 审计读回
   （受限 operator 真实 RLS）+ 目录探针（超户只读：RLS 旗标/授权矩阵）。
4. `server/tests/multitenancy/credential-lease.test.ts` — 验收套件（Ticket 指定路径；
   AC1–AC4 + 存储栅栏；缺 env 显式 skip 带理由，skipped 不计通过）。

### 授权扩展点（纯追加，前像哈希存档于 before-hashes.txt）
5. `server/src/db/schema/index.ts` — barrel 追加 1 行（enterprise-credential-lease）。
6. `server/scripts/multitenancy/migrate-test.ts` — 纯追加 MT029 任务（迁移链第二十；
   两步：建表 + RLS/最小授权）。
7. `server/tests/multitenancy/migration-tool.test.ts` — 仅 allowlist 断言追加 "MT029"
   （ruling #5 沿用，带裁决注释）。
8. `server/src/index.ts` — 装配段追加 `credentialLease`（data 通道判定 + operator 通道管理，
   缺通道 fail-closed = null；与 MT027/MT028 同纪律）。

## 词汇

- **lease（取用凭据的租约）**：一条固定 (凭据, 持有人, 作用域, 用途, 有效期) 的可撤销授权行。
  签发权威 = MT027 use 权威的现行事实；每个校验点现读重验。
- **purpose（用途）**：闭集 'bot-run'（Bot 运行中的凭据使用）/ 'connector-call'（连接器直调）/
  'site-access'（站点登录使用）。validate 的 claimed purpose 与持久行不等即拒（AC1）。
- **checkpoint（校验点）**：执行链在敏感动作处调用 validate 的时点（票面备注：MT046 起接入）；
  本票交付 validate 语义本身，不接线执行链。

## 环境备注（本轮亲跑，终态）

- 容器 mt029-impl-pg（pgvector/pgvector:pg16 @127.0.0.1:55581，仅回环）；库
  openbot_enterprise_w14int（主库，对齐冻结断言——见下）+
  openbot_enterprise_w15a_test（歧义对照，保留）+ _assigned +
  openbot_kb_w15a_test（KB 属主 ent_w15a_kb 先于建库）；psql 逐条 -c。
- **brief 歧义与处置**：主库名 openbot_enterprise_w15a_test 与冻结 prereq
  entry-context.test.ts:191 硬断言 openbot_enterprise_w14int 冲突（w15a 名 ⇒
  全量唯一 fail 即该断言，证据链存档）。已 `orca orchestration ask` 升级
  （msg_9adf8abcfaaf，答复 pending）；依 wave14-integration 先例（环境对齐
  冻结断言）按选项 A 执行：同容器新建 openbot_enterprise_w14int 主库 +
  全链 20 任务重放（journal 20/38）。最终数字以 w14int 主库为准
  （1151/0/44）；w15a 对照 1147/1/44。若协调者改判，切换仅 env 级。
  详见 reports/MT029.md §0。
