# MT069（Issue #112）设计 — 公司计费 Customer 映射与公司/个人账户类型（expand）

BASE f0520524。票面实取 `gh issue view 112`（brief 中 "#111" 为笔误；#111 是 MT068）。
无提交/推送/合并/生产迁移授权——交付为未提交工作树 + `checkpoints/MT069/`。

## 领域模型（CONTEXT.md 术语）

- **Tenant = 公司**。**Company Credit Account（公司积分账户）** = 公司在工作台中的共同积分
  余额归属；个人余额（personal）与之分别管理，个人消费不计入公司支出（父 Spec A13 邻接）。
- **Credit Ledger** 权威台账：金额 ×100 缩放整数（CREDIT_SCALE=100）——金额尺度/精度纪律
  本票不得触碰（AC4）。
- 计费 Customer（`billing_customers`）按 externalId 键控，是本地派生的外部计费身份投影。
- 覆盖验收：A9（账户类型前置）、A12（迁移兼容）、A13（付款账户固定、不混淆）。

## 票面四验收 → 实现映射

| AC | 票面 | 实现面 |
|---|---|---|
| AC1 | 公司与 Customer 的映射唯一且稳定；重复映射被拒绝 | `billing_customer_mappings`：tenant_id PK（一家公司至多一行）+ external_customer_id 唯一索引（一个 Customer 至多映射一家公司）——两方向唯一都在 DB 层拒绝；服务层预检给出类型化 `CUSTOMER_MAPPING_CONFLICT`，完全相同的重复绑定幂等返回既有行（稳定、零写入）。服务无任何 UPDATE/解除路径（稳定 = 只能新增一次） |
| AC2 | 账户类型是显式字段，不从字符串或用户身份猜测 | `billing_credit_accounts.account_type`：注册时必须显式给出 company/personal（服务 API 按类型分入口：`registerCompanyAccount` / `registerPersonalAccount`，不存在"从身份推断类型"的入口）；DB 行形状 CHECK 强制 company ⇔ tenant_id 非空、personal ⇔ owner_user_id 非空 |
| AC3 | 未知类型记录被隔离而不是默认归为某一类 | `quarantineUnknownAccount` 显式通道：未知归属 → 行落 `status='quarantined'`（account_type/account_key 必为 NULL，CHECK 强制），绝不默认成 company 或 personal；已分类行再隔离 → `ACCOUNT_ALREADY_CLASSIFIED`；隔离行之上再注册 → `ACCOUNT_ALREADY_EXISTS`（分类晋升属 MT070+，本票不静默改类） |
| AC4 | 金额尺度、精度与既有约束保持不变 | 回归测试钉死：(a) 四张既有计费表（billing_customers/credit_grants/credit_ledger/credit_reservations）列清单在 MT069 迁移前后不变（information_schema 硬编码断言）；(b) 真实 writer 全链路（grantCredits→reserveCredits→settleReservation）在迁移后行为不变（×100 整数、幂等、CHECK used≤total 仍拒绝超支） |

Brief 追加：**映射与账户操作留审计** → `billing_account_audit`（bind/register/quarantine
每个成功写入操作一行，actor 由受信调用方传入）。

## Ownership：全部新文件（expand-only）

**新文件（4）**
- `server/src/db/schema/payer-accounts.ts` — 三张新表（drizzle 定义，与任务迁移 SQL 一一对应）
- `server/src/billing/payer-accounts.ts` — 服务（唯一写入面：bind/resolve/register×2/quarantine/get/audit 读）
- `server/tests/multitenancy/payer-accounts.test.ts` — 聚焦套件（票面 Verification 指定路径）
- `server/tests/multitenancy/support/payer-accounts.ts` — 夹具（公司 A/B + 用户 + billing_customers 专用种子；owner 连接 = 生产计费路径同款访问模型）

**授权窄例外（3，逐行可辨、before/after 哈希存档）**
- `server/scripts/multitenancy/migrate-test.ts` — 纯追加 MT069 任务（单步 `payer_accounts_tables`；工具自声明契约，MT004→MT026 同款）
- `server/tests/multitenancy/migration-tool.test.ts` — 仅穷举断言追加 "MT069"（ruling #5 第 7 次先例，带裁决注释）
- `server/src/db/schema/index.ts` — 装配段纯追加一行 barrel 导出（brief 明确授权扩展点）

## 访问模型裁决（billing 域，非 enterprise RLS）

三张新表跟随 **billing 域既有访问模型**（owner 连接、无 RLS）——与 billing_customers、
credit_grants、credit_ledger、credit_reservations 完全一致。理由：
1. MT069 是账务域（分组 Epic #200 N 账务）expand：映射与账户都是**计费事实**，不是
   成员关系/工作空间事实；生产扣费解析（MT070+）运行在计费域 owner 通道。
2. personal / quarantined 行 tenant_id 为 NULL，公司租户 pin 的 RLS 臂结构上无法表达。
3. 受限业务角色（ob_ent_directory/data/operator）对 billing 域**零授权**——结构隔离比
   RLS 更强（连 SELECT 都不可达）；套件用 `has_table_privilege` 断言钉死该事实。
   "数据库验证使用专用 PostgreSQL + 受限业务角色"的门槛由整个 multitenancy 套件
   （既有 22 文件全量回归 + 本票结构隔离断言）共同满足，详见报告披露。

## 表设计（任务迁移 SQL 与 drizzle 定义一一对应）

### `billing_customer_mappings`（AC1）
- `tenant_id` text PK，FK → enterprise_tenants(id) ON DELETE CASCADE
- `external_customer_id` text NOT NULL，FK → billing_customers(external_id) ON DELETE CASCADE，
  UNIQUE `billing_customer_mappings_customer_unique`（一个 Customer 至多一家公司）
- `created_at` timestamptz NOT NULL DEFAULT now()
- 无 updated_at、无 UPDATE 授权面：映射写入一次后不变（稳定）。

### `billing_credit_accounts`（AC2/AC3）
- `id` text PK（`bca-` + 16 hex，服务生成）
- `external_customer_id` text NOT NULL UNIQUE（`billing_credit_accounts_customer_unique`），
  FK → billing_customers ON DELETE CASCADE —— **稳定标识之一**：一个计费 Customer 至多一个账户行
- `account_type` text NULL，CHECK IN ('company','personal') —— 显式分类；NULL 仅隔离态合法
- `status` text NOT NULL，CHECK IN ('active','quarantined')
- `tenant_id` text NULL，FK → enterprise_tenants CASCADE（company 账户归属）
- `owner_user_id` text NULL，FK → users(id) CASCADE（personal 账户归属；部署级用户，
  非 enterprise principal——个人账户不要求公司成员身份）
- `account_key` text NULL —— **稳定标识之二**：`'company:'||tenant_id` / `'personal:'||owner_user_id`，
  派生 CHECK 自证一致（MT112 anchors 同款纪律），partial UNIQUE（`billing_credit_accounts_key_unique` WHERE account_key IS NOT NULL）
- `quarantine_reason` text NULL
- `created_at` timestamptz NOT NULL DEFAULT now()
- 行形状 CHECK（单条 `billing_credit_accounts_row_shape`）：
  - quarantined ⇒ account_type IS NULL AND tenant_id IS NULL AND owner_user_id IS NULL
  - active+company ⇒ tenant_id NOT NULL AND owner_user_id IS NULL
  - active+personal ⇒ owner_user_id NOT NULL AND tenant_id IS NULL
- 配对 CHECK：`(status='quarantined') = (quarantine_reason IS NOT NULL)`（隔离必留原因 = 审计纪律）
- 派生 CHECK：`account_key = CASE account_type WHEN 'company' THEN 'company:'||tenant_id WHEN 'personal' THEN 'personal:'||owner_user_id ELSE NULL END`

### `billing_account_audit`（brief AC4：留审计）
- `id` text PK（`baa-` + 16 hex）
- `action` text NOT NULL CHECK IN ('customer_mapping.bound','credit_account.registered','credit_account.quarantined')
- `actor` text NOT NULL（受信调用方传入的身份；服务校验非空）
- `tenant_id` / `external_customer_id` / `account_id` text NULL（动作主体；不同动作子集非空）
- `detail` jsonb NULL（如 quarantine reason、account type）
- `occurred_at` timestamptz NOT NULL DEFAULT now()
- 索引：(tenant_id, occurred_at)、(external_customer_id, occurred_at)

## 服务设计（`server/src/billing/payer-accounts.ts`）

`createPayerAccountService(db: Database)`，错误以计费 seam 哨兵码抛出
（`Error("CODE: …")`，与 credits-writer/identity-binding 同纪律）：

- `bindCompanyCustomer({tenantId, externalCustomerId, actor})`
  - 完全相同重复绑定 → 幂等返回既有行（零写入、零重复审计）
  - 公司已绑其他 Customer / Customer 已被其他公司绑定 → `CUSTOMER_MAPPING_CONFLICT`
    （预检 + DB 唯一双保险；并发竞态兜底映射 23505 → 同码，绝不产生第二行）
  - 成功 → 审计 `customer_mapping.bound`
- `resolveCompanyCustomer(tenantId)` → mapping | null（只读，无审计）
- `registerCompanyAccount({tenantId, actor})` —— 类型入口即显式字段；Customer **从映射派生**
  （唯一事实源，调用方无法错配）：无映射 → `CUSTOMER_MAPPING_REQUIRED`；该 Customer 已有
  账户行：同键 → 幂等返回，异键 → `ACCOUNT_ALREADY_EXISTS`；成功 → 审计 `credit_account.registered`
- `registerPersonalAccount({userId, externalCustomerId, actor})`：Customer 已被公司映射 →
  `CUSTOMER_COMPANY_MAPPED`（公司映射的 Customer 永远不是个人付款方）；同键幂等 / 异键
  `ACCOUNT_ALREADY_EXISTS`；成功 → 审计
- `quarantineUnknownAccount({externalCustomerId, reason, actor})`：已分类 →
  `ACCOUNT_ALREADY_CLASSIFIED`；已有隔离行 → 幂等返回；否则建隔离行（type/key 必 NULL）
  → 审计 `credit_account.quarantined`
- `getAccountByCustomer(externalCustomerId)`、`listAccountAudit({tenantId?, externalCustomerId?})`
- 输入校验：非空字符串纪律 → `PAYER_ACCOUNT_INVALID`

## 测试计划（`payer-accounts.test.ts`，专用库真实 PostgreSQL）

环境契约：缺 `TEST_DATABASE_URL`（或 `ENTERPRISE_TEST_SETUP_DATABASE_URL`）整套显式 skip，
绝不回退开发库、skipped 不计通过。夹具：公司 A/B + 2 用户 + 4 个 billing_customers，
owner 连接（生产计费访问模型）；dispose 级联清理。

约 21 用例：绑定创建+审计 / 幂等重绑零写入 / 两方向冲突拒绝 / resolve /
公司账户注册派生 Customer / 无映射拒绝 / 重注册幂等 / 个人账户注册 /
公司映射 Customer 拒绝个人 / 同用户第二个人账户拒绝（稳定标识）/
隔离创建（type/key NULL + reason）/ 隔离幂等 / 已分类再隔离拒绝 / 隔离行上注册拒绝 /
审计留痕逐动作断言 / ob_ent_* 零授权结构隔离 / 四表列清单回归 /
真实 writer 全链路回归（grant→reserve→settle，×100、幂等）/ used≤total CHECK 仍拒绝 / 输入校验。

## 变异计划（服务语义层，全部须 KILLED）

MUT1 公司方向冲突预检移除、MUT2 Customer 方向冲突预检移除、MUT3 映射必填守卫移除、
MUT4 公司映射 Customer 拒绝移除、MUT5 幂等重绑返回移除、MUT6 已分类隔离守卫移除、
MUT7-9 三处审计写入分别移除、MUT10 account_key 派生前缀错误、MUT11 actor 校验移除、
MUT12 注册幂等返回移除、MUT13 隔离幂等返回移除。

## 检查点与验证门槛

- 迁移：专用容器 `mt069-impl-pg`（pgvector/pgvector:pg16、trust、仅回环），双库
  `openbot_enterprise_mt069` + `openbot_enterprise_mt069_assigned`；base 迁移后按 brief
  依赖序 apply：MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→**MT069**。
- 全量基线复算（brief：577/0/22）；票后全量回归 ≥577+新增、0 fail、0 skip（含 MT003
  assigned 库真实 apply）；聚焦全绿；typecheck 0；biome 触及文件 0 新增。
- prereq manifest：领取时逐项复算转移项哈希 → `checkpoints/MT069/prereq-manifest.txt`。
- 证据：`checkpoints/MT069/{design.md, red-green.md, changes.diff, mutation/results.txt,
  verification/*, before-hashes.txt, after-hashes.txt, sha256-manifest.txt}`；
  报告 `reports/MT069.md`，worker_done 附 `--report-path`。
