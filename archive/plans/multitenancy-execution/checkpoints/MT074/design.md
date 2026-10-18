# MT074 设计 — 供应商计费调用面 + 回调归属锁定（波次 16 补位）

日期：2026-10-18。树=w16-mt074（BASE f0520524 + 284 项 prereq，MT073-integration 后满树）。
事实源：`briefs/MT074-brief.md`（票面验收四条 + 交付面）+ 父 Spec #6 §7（计费/付款账户路由/
错误处理）+ CONTEXT.md「计费与积分」+ MT028 fail-closed 先例。前置链 22 任务已按修正序在专用库
真实 apply（19 前置修正序 + MT029→MT073→MT060，journal 22 任务 42 步，verification/01）。
基线 **1222 pass / 0 fail / 47 文件** 复现（verification/00）；环境令牌按 brief 预授权无需微修
（"令牌已根治"，基线原文全绿）。

## 0. 票面验收 → 实现面映射

| # | 验收（brief 原文） | 实现面 | 证明（聚焦套件用例组） |
|---|---|---|---|
| AC1 | 调用者身份在进入公司范围前确认；供应商只能收到其登记公司的必要计费字段 | `provisionCompanyCustomer`：**活查成员资格门先于一切公司计费事实读取**（非成员/停用/跨公司调用者一律 `VENDOR_CALLER_REQUIRED`，供应商零调用、映射/账户事实零读取）；载荷闭形 `{externalId, name}`，值全部服务端派生——customer key 从 MT069 唯一映射（`resolveCompanyCustomer`，无映射 `CUSTOMER_MAPPING_REQUIRED` 绝不臆造）、name 从 enterprise_tenants 行；输入形状没有客户字段，塞入 externalCustomerId/customer/payer 键一律 `PAYER_ACCOUNT_FIXED`（MT070 同款走私守卫） | 调用面组（活跃成员正向：fake vendor 恰被调一次、载荷键集恰二、值=映射键+公司名；非成员/停用/双公司成员跨公司声明的反侧；身份门先于映射门的顺序证明——无映射公司+非成员调用者 → 身份码而非映射码；无映射/无活跃公司账户/隔离账户各拒绝码；供应商 4xx/5xx/异常 → 结构化 refused 不抛） |
| AC2 | 供应商回调只能作用于其登记公司的付款人与账单；跨公司回调拒绝 | `applyVendorCallback`：回调归属**只从供应商侧客户键经唯一映射解析**（claimed tenant 只比对、永不决定——MT028 纪律）；全部门通过后返回锁定的付款人事实（映射公司 + 该客户键下的活跃公司账户 id/type/status）——这是本 seam 唯一披露的账户事实，跨公司/未映射/不一致声明在读取任何账户事实前拒绝（`VENDOR_CALLBACK_CROSS_COMPANY` / `VENDOR_CALLBACK_UNMAPPED`），拒绝结果零账户事实、零写入 | 回调组（诚实回调正向：返回恰为登记公司的账户事实；未映射键（含个人账户客户键）拒绝且零公司归属；claimed ≠ 映射 → CROSS_COMPANY 且审计不含 claimed 值；claimed = 映射 → 放行（compare-only）；映射客户无活跃公司账户拒绝） |
| AC3 | 回调期间成员资格中断，处理按 MT028 的 fail-closed 规则 | 回调处理时**活查 acting principal 在映射公司的成员资格**（`STATE_INITIATOR_INELIGIBLE` 同款：在途中断 → `VENDOR_CALLBACK_MEMBER_INELIGIBLE` 拒绝、零作用、不烧任何状态——恢复后同一回调重投递可成功）；acting principal 是服务端事实输入（供应商载荷结构上无此字段） | 停用后回调拒绝、恢复后同参重投递成功（两态对照）；成员行被删除的回调仍被拒绝且审计落行（无外键审计面，非成员拒绝行可记录） |
| AC4 | 调用与回调全程留审计（不含敏感明文） | `billing_vendor_interactions`：每次调用/回调尝试（applied 与 refused 一视同仁）各恰一行——方向/公司/主体/客户键/操作/结局/拒绝码/闭形 detail；detail 只含非值事实（`{fields:[…], vendorStatus?}`），闭形 CHECK 禁秘密载体键（envelope/plaintext/secret/value/password/token/apiKey）；客户键与公司名等值不进 detail（canary 扫描）；`listInteractions` 按公司/客户键/方向过滤读（新在前） | 审计组（每次尝试恰一行计数；detail 键集恰断言 + 序列化 canary 零命中；拒绝码配对；list 过滤读；DB CHECK 反证——applied+denial_code、秘密载体键 detail 的裸插入被 CHECK 拒绝） |

## 1. 领域模型：`billing_vendor_interactions`（唯一新持久化对象）

一行 = 一次供应商计费交互尝试（outbound call 或 inbound callback，applied 与 refused 都是
事实）。跟随 MT069 `billing_account_audit` 同款**审计面纪律**：

```
billing_vendor_interactions
  id                   text PK（bvi- + 16 hex，服务端生成）
  direction            text CHECK in ('call','callback') NOT NULL
  tenant_id            text NULL        -- null = 不可归属（未映射回调）；审计随事实，不臆造
  principal_id         text NULL        -- acting 身份（服务端事实或被拒声称者）
  external_customer_id text NULL        -- 供应商侧客户键（映射值或观察值）
  operation            text NOT NULL    -- 'customer.provision' / 回调类型标签（≤128 非空）
  outcome              text CHECK in ('applied','refused') NOT NULL
  denial_code          text NULL        -- 行形配对 CHECK：applied⇒NULL、refused⇒非空非''
  detail               jsonb NULL       -- 闭形 CHECK：object 且禁秘密载体键
  created_at           timestamptz DEFAULT now() NOT NULL
  INDEX (tenant_id, created_at)；INDEX (external_customer_id, created_at)
```

- **无外键**（MT069 audit 先例：审计不随对象消亡；且「非成员/成员行已删」的拒绝行必须可
  记录——membership 复合外键会让拒绝本身抛 23503）。结构隔离不靠 FK/RLS：跟随 MT069/MT070/
  MT073 D2 裁决的 **billing 域访问模型**（owner 通道、无 RLS），受限 ob_ent_* 四角色对本表
  **零授权**（套件 has_table_privilege 全枚举反证钉死）。
- **语义边界**：这是尝试留痕（attempt trail），不是收件箱——供应商事件去重/重放防线在既有
  webhook inbox（billing/service.ts，零改动）；本表不承担幂等去重职责。

## 2. 服务面：`createVendorBillingService({ database, vendor })`（唯一新代码面）

- **注入的供应商客户端** `BillingVendorClient`：`postCustomer({externalId, name}) → {status}`。
  供应商词汇（Lago wire 字段）只存在于注入实现，服务面 provider-neutral；测试用 fake 观测
  「供应商是否被调用」（Spec §测试纪律），绝不开真实 socket。
- **调用面 `provisionCompanyCustomer({tenantId, principalId})`**：
  1. 形状守卫（走私键 → `PAYER_ACCOUNT_FIXED`，零 IO 零行）；
  2. **身份门**：活查 (tenant, principal) 成员资格 status='active'——先于一切计费事实读取；
     不过 → 审计 refused(`VENDOR_CALLER_REQUIRED`, ext=null) + 哨兵拒绝；
  3. 映射：`resolveCompanyCustomer`（MT069 只读消费）→ null → 审计 refused(`CUSTOMER_MAPPING_REQUIRED`)；
  4. 账户：`getAccountByCustomer`（MT069 只读）→ 须为 status='active' 且 type='company' 且
     tenantId 恰为调用公司的账户行 → 否则审计 refused(`COMPANY_ACCOUNT_REQUIRED`)（隔离行不是付款人）；
  5. 载荷：`{externalId: 映射键, name: tenants.name}`——类型闭形，无第三字段通道；
  6. 供应商调用：2xx → 审计 applied + 返回 `{outcome:'applied', vendorStatus, customer}`；
     非 2xx → 审计 refused(`VENDOR_REJECTED`, vendorStatus) + 结构化返回；抛错 →
     审计 refused(`VENDOR_UNREACHABLE`) + 结构化返回（传输结局是事实不是异常，lago.ts 同口径）。
- **回调锁 `applyVendorCallback({externalCustomerId, operation, actingPrincipalId, claimedTenantId?})`**：
  1. 形状校验；
  2. **归属解析**：按客户键查唯一映射（唯一事实源）→ 无映射 → 审计 refused(`VENDOR_CALLBACK_UNMAPPED`,
     tenant=null——不臆造归属) + 哨兵；个人账户的客户键同样不在映射表 → 同码（个人路径对公司回调零作用）；
  3. **跨公司比对**：claimedTenantId 在场且 ≠ 映射公司 → 审计 refused(`VENDOR_CALLBACK_CROSS_COMPANY`,
     落在映射公司，detail 不含 claimed 值——MT028 deny 面纪律) + 哨兵；相等 → 仅放行（claimed 永不决定）；
  4. **存活门（AC3，MT028 fail-closed）**：活查 acting principal 在**映射公司**的成员资格
     active → 中断/删除 → 审计 refused(`VENDOR_CALLBACK_MEMBER_INELIGIBLE`) + 哨兵；不烧状态，
     恢复后重投递可成功；
  5. 付款人：该客户键下须有活跃公司账户（同调用面口径）→ 否则 refused(`COMPANY_ACCOUNT_REQUIRED`)；
  6. 审计 applied + 返回锁定的付款人事实 `{tenantId, externalCustomerId, account{id,type,status}}`
     ——seam 唯一披露的账户事实；调用方只能对它行动。
- **读面 `listInteractions({tenantId?, externalCustomerId?, direction?})`**：新在前，过滤读。
- 错误纪律：计费 seam 哨兵码（`CODE: message`），与 payer-accounts/credits-writer/company-reservation
  一致；模块零 console、零 process.env；拒绝消息只含代码与 id，不回显 claimed 值。

## 3. 交付形状

**新文件（4）**
- `server/src/db/schema/vendor-billing.ts` — `billing_vendor_interactions` drizzle 定义（jsonbDocument
  闭形 CHECK；billing 域访问模型注释）。
- `server/src/billing/vendor-billing.ts` — 上述服务面（消费 MT069 payer-accounts 只读、
  enterprise_memberships/enterprise_tenants 只读）。
- `server/tests/multitenancy/vendor-billing.test.ts` — 验收套件（brief 指定域：billing）。
- `server/tests/multitenancy/support/vendor-billing.ts` — 夹具（billing-visibility 夹具同款纪律：
  缺 env 显式 skip 不回退；前缀 mt074- 级联清扫；fake vendor 客户端 + 成员资格翻转 + 超户
  has_table_privilege 反证探针）。

**授权窄追加（3，brief 预授权「窄缝纯追加披露」，逐项披露）**
- `server/scripts/multitenancy/migrate-test.ts` — 纯追加 MT074 任务（单步 `vendor_billing_interactions`，
  3 条语句）+ TASKS 注册表 1 行（迁移链第二十三个任务）。
- `server/tests/multitenancy/migration-tool.test.ts` — 仅穷举断言追加 "MT074"（ruling #5
  第 21 次先例，带裁决注释）。
- `server/src/db/schema/index.ts` — barrel 字母序追加 1 行 `export * from "./vendor-billing"`。

**无装配面**：本票无 HTTP 路由/`index.ts`/`app.ts` 改动（库层 seam；调用面/回调锁的 HTTP 接线
属下游票，MT069/MT070/MT073 D6 同边界）。既有 webhook inbox、lago.ts、credits-writer、
payments/* 零修改。

## 4. TDD 计划

RED-1：migration-tool.test.ts 追加 "MT074" → 1 fail（穷举断言）。
GREEN-1：migrate-test 注册表 MT074 任务 + schema 文件 + barrel → 穷举断言全绿；apply MT074 迁移。
RED-2：vendor-billing.test.ts + 夹具引用未存在模块 → Cannot find module fail。
GREEN-2：实现 vendor-billing.ts → 聚焦全绿。
之后：全量回归（≥1222+新增）、typecheck 0、biome 触及 0、变异自证+RESTORE、
checkpoints/MT074 全套、reports/MT074.md。

## 5. 变异计划（每安全语义 ≥1，全部必须被聚焦套件捕获）

M01 调用面身份门移除（非成员可发起供应商调用）、M02 载荷最小性破坏（name 换源/多字段）、
M03 映射必填守卫移除（无映射仍调供应商）、M04 账户守卫移除（无活跃公司账户仍调用）、
M05 隔离账户放行（quarantined 当付款人）、M06 回调未映射守卫移除、M07 跨公司比对移除、
M08 回调存活门移除（中断后仍 applied）、M09 回调付款人守卫移除、M10 供应商非 2xx 当 applied、
M11 调用审计移除（applied 零行）、M12 拒绝审计移除（refused 零行）、M13 detail 值泄漏
（客户键/公司名进 detail）。
完成后服务文件 SHA-256 复验与交付哈希逐位一致（RESTORE 闭环）。

## 6. 诚实边界（预登记）

- 「必要计费字段」本票口径 = 客户开通调用（postCustomer）的 `{externalId, name}` 闭形——
  这是从 MT069 唯一映射与公司行可服务端派生的全部事实；订阅/用量等其他供应商调用面的
  最小披露属下游票。
- 回调锁只建立归属与披露锁定付款人事实，不动余额/台账（credits-writer 零改动）；回调的
  业务效果（入账/订阅激活）与 HTTP 接线属下游票。
- 未映射回调审计行 tenant_id 为 NULL（不臆造归属）——审计「全程」指每次**尝试**一行，
  不等于每行都有公司归属。
- 尝试留痕 ≠ 收件箱去重（既有 inbox 职责，零改动）。
- brief 无 GitHub 票号（波次 16 补位票），实现以 brief 票面验收为事实源；epic #200 表格的
  MT074=#117（历史余额迁移）与本 brief 交付面不一致，本票按 brief 执行并披露此分歧。
