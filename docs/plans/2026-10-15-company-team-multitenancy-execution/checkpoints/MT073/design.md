# MT073 设计 — 账务可见性：付款人订单、公司财务授权与团队用量视图（Issue #116）

BASE f0520524 + 268 项 prereq（波次 15 树 w15-mt073，无本地 commit）。前置链 19 任务已按
brief 修正序在专用库真实 apply（MT000 自检 + MT004→MT008→MT112→MT012→MT014→MT010→MT009→
MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028→MT070→MT031→MT042→MT059，journal 20 任务
38 步，verification/04）。基线 **1124 pass / 0 fail / 43 文件** 复现（verification/00）；
entry-context.test.ts:191 环境令牌按 brief 预授权 RECTIFIED 微修 w14int→w15e_test
（双哈希 verification/05-*，断言语义不变：专库+受限 data 角色+绝不回退开发库）。

## 票面验收 → 设计映射

| AC | 内容 | 设计 |
|---|---|---|
| AC1 | 普通公司成员看不到其他人的订单与支付资料（即使共用公司余额） | 既有 `PaymentOrderReadScope={actorId}` 创建人过滤是唯一订单读取面（payments/store 的 readOrder/listOrdersInWindow/countOrdersInWindow/readLatestLiveOrder + statements 的 invoices/invoice 全部经 ownerScopeCondition 过滤 created_by；checkoutPayload 注释即「只回显给创建者」）。本票**零修改**该路径，套件用真实 PaymentStore 钉死：同公司两成员各自订单互不可见（读→null、列表/计数不含对方、latest 不含对方）。 |
| AC2 | 具备公司财务管理授权的主体可查看公司账务与团队用量；无此授权则不可 | 新增**显式授权事实** `billing_company_finance_grants`（tenant+principal 主键，granted_by 记录管理动作；grantee 与 grantor 侧都是复合 FK→enterprise_memberships，非成员行结构上不可能）。授权门 `assertCompanyFinanceReader`：活跃成员资格（活查 status='active'，A5 邻接：停用立即失效）+ 授权行存在，二者缺一 → 同一哨兵 `COMPANY_FINANCE_REQUIRED`（不可见语义，不区分「无资格/非成员/公司不存在」，不泄露存在性——A2）。tenant_admin **不**自动获得财务读取（「明确管理动作授权」，MT010「个人资源不因 tenant_admin 身份可分享」同款纪律）——无授权行的 tenant_admin 被同一哨兵拒绝。授权门先于一切账务事实读取（拒绝路径零事实读）。 |
| AC3 | 团队用量汇总与公司总额一致，且不含个人直连消费 | `companyBooks`（授权门后）返回：byTeam/byUser = **消费 MT070 `usageSummary`**（归属×预扣投影，只读）；公司总额 = **账户侧独立投影**（credit_reservations WHERE external_customer_id=公司映射客户，held=reserved.maximum 之和、charged=settled.charged 之和）。两口径一致性 = 归属覆盖不变量的真实检验（公司账户每笔持有都有归属行——MT070 D2 合同），非同源重复计算。个人直连（个人账户上的 writer 预扣，无归属行）在两个口径都不出现：归属侧按 tenant 过滤、账户侧按公司映射客户过滤。测试：多次公司预扣后 ΣbyTeam==公司总额==ΣbyUser；随后个人账户预扣，全数不变。 |
| AC4 | 旧按创建人限制的订单读取没有被放宽为全公司成员可读（回归测试） | 回归钉死：**财务授权存在且生效后**（grantee 持有效授权行），store 读取仍按 created_by 过滤——授权行不触及 PaymentOrderReadScope（类型上不相关：授权面不产 scope，订单面不读授权表）；跨成员 readOrder→null、list/count/latest 不含他人订单。 |

## 交付形状

**新文件（4）**
- `server/src/db/schema/company-finance.ts` — `billing_company_finance_grants`：
  PK(tenant_id,principal_id)；FK tenant_id→enterprise_tenants；复合 FK (tenant,principal)→
  enterprise_memberships（grantee 必须是成员）；复合 FK (tenant,granted_by)→memberships
  （grantor 必须是成员，MT010 granted_by 纪律）；tenant_id 索引。跟随 MT069/MT070 D2 裁决的
  billing 域访问模型（owner 通道、无 RLS；受限 ob_ent_* 零授权=结构隔离，套件
  has_table_privilege 全枚举反证钉死）——授权是账务读取面的事实，与 billing_customers/
  call_attributions 同域同通道。
- `server/src/billing/company-finance-visibility.ts` — 授权面+账务视图唯一新面：
  `grantCompanyFinanceReader`（重复授权 → `FINANCE_GRANT_EXISTS`，MT010
  SHARE_ALREADY_ACTIVE 同款显式拒绝；grantee/grantor 非活跃成员 → `FINANCE_GRANT_INVALID`）、
  `revokeCompanyFinanceReader`（删行=撤销，无可达中间态，幂等返回 revoked 布尔）、
  `financeReadersOf`、`assertCompanyFinanceReader`（单一哨兵 COMPANY_FINANCE_REQUIRED）、
  `companyBooks`（门→映射→账户→writer.availableBalance→MT070 usageSummary→账户侧总额）。
  消费面全部只读：payer-accounts（MT069）、credits-writer.availableBalance（余额权威）、
  company-reservation.usageSummary（MT070）。writer/payer/MT070 服务文件零修改。
- `server/tests/multitenancy/billing-visibility.test.ts` — 票面 Verification 指定路径。
- `server/tests/multitenancy/support/billing-visibility.ts` — 夹具（company-reservation 夹具
  同款纪律：缺 env 显式 skip 不回退；前缀 mt073- 级联清扫）。

**授权窄追加（3，brief 预授权，逐项披露）**
- `server/scripts/multitenancy/migrate-test.ts` — 纯追加 MT073 任务（单步
  company_finance_grants，2 条语句）+ 注册表 1 行（迁移链第二十任务）。
- `server/tests/multitenancy/migration-tool.test.ts` — 仅穷举断言追加 "MT073"（ruling #5
  第 14 次先例，带裁决注释）。
- `server/src/db/schema/index.ts` — barrel 字母序追加 1 行 `export * from "./company-finance"`
  （code-runs 与 components 之间）。

**无装配面**：本票无 HTTP 路由/`index.ts`/`app.ts` 改动（库层 seam；订单路由继续传
`billingReadScopeOf` 的创建人 scope——AC1/AC4 的正反面；授权管理动作的接线属下游票，
MT069/MT070 D6 同边界）。

## TDD 计划

RED-1：migration-tool.test.ts 追加 "MT073" → 1 fail（穷举断言）。
GREEN-1：migrate-test 注册表 MT073 任务 + schema 文件 + barrel → 穷举断言全绿。
RED-2：billing-visibility.test.ts + 夹具引用未存在模块 → Cannot find module fail。
GREEN-2：实现 company-finance-visibility.ts → 聚焦全绿；apply MT073 迁移。
之后：全量回归（≥1124+新增）、typecheck 0、biome 触及 0、变异自证+RESTORE、
checkpoints/MT073 全套、reports/MT073.md。

## 变异计划（每安全语义 ≥1）

M01 授权门移除（companyBooks 无门直读）、M02 活跃成员资格活查移除（停用后仍可读）、
M03 撤销删行退化为 no-op、M04 账户侧公司总额过滤放宽（external_customer_id 条件移除→
个人直连消费混入）、M05 重复授权放行（FINANCE_GRANT_EXISTS 移除）、M06 grantor 成员资格
校验移除（FK 结构兜底为复合防线，单层移除需验证服务层预检有效性）、M07 租户过滤移除
（usageSummary/账务视图跨公司泄漏——若消费面已过滤则为等价变异，按 MT070 M06 先例补复合）。

## 诚实边界（预登记）

- 订单/账单读取在本票**零行为变更**（AC1/AC4 是回归钉死而非新面）；「订单与账单读取授权」
  的既有创建人语义不变，财务授权不放宽它（C3 裁决）。
- 授权管理（谁有权 grant/revoke）的 HTTP 接线不属本票（下游）；seam 层记录 granted_by
  并校验同公司成员资格。
- 团队用量视图是账务投影，台账（credit_ledger）仍是金额唯一权威（MT070 D5 口径）。
