# MOD10 计划（#630：封装账务查询支付收款与权益交付 Interface，S4 M07）

状态：冻结（2026-10-26）。实施基点 `3e06f8eb9`（集成 HEAD）。实施 Agent claude；Brief 全文内嵌。

## 0. 侦察事实（编排者已核实 @ `3e06f8eb9`）

- M07=`server/src/billing/`：95 文件 43,695 行。**MOD10 环例外 0 条**——本票纯「出口建立+真实财务入口迁移」，无例外消除义务（Consumes/Produces 段以票面验收为准）。
- 关键子结构：`billing/payments/`（routes+service，http.ts :79-80 import）、`entitlement.ts`、`reconcile.ts`/`account-reconcile.ts`/`statements.ts`（对账/账单）、`payer.ts`+`payer-{accounts,binding,company,legacy,personal}.ts`（Payer 族）、`webhook-signature.ts`、`credits.ts`/`credits-writer.ts`（MOD09 已消费的内部子 Module）、`company-finance-visibility.ts`、`recovery-*` 族、`routes.ts`/`service.ts`（billing 主路由与服务）。
- 装配点：runtime.ts :153-163 一带（companyFinanceVisibility/credits/creditWriter/lago/outbound）；http.ts :73-89（asyncJobsView/Credits/CreditWriter/payments routes/PaymentService/realtimeUsage/rewardGranter/billing routes）。
- 存量测试：billing-credits 族、billing-entitlement、billing-company-renewal、billing-lago-client、admin-credit-grant 等（native+integration 混合；完整清单执行者普查）。
- 验收⑤「对账只读」与③「重复/迟到收款保留独立渠道事实」、④「收款成功权益失败独立恢复」为现状行为钉；①权限分离（company-finance-visibility vs 成员/Bot 管理面）现状钉。

## 1. 目标形态

### A. `server/src/billing/public.ts`（新增全权）

财务业务出口门面（能力面以代码+合同证实后冻结，候选族）：
- `accountQuery`（账务查询：余额/流水/账单 statements 一族读取）；
- `orders`（订单事实：payments 订单读取/状态）；
- `entitlementDelivery`（权益交付/重放查询：entitlement 现有判定）；
- `resolvePayer`（固定 Payer 解析：payer 族现有裁决，验收②回调按服务器订单 Payer）；
硬约束：不暴露 credits/credits-writer 内部写面（MOD09 已立消费通道，本票不 re-export）；零新策略；类型经组内签名提取（MOD05-08 先例）；只 import M07 组内（billing/**+payer 族）+合法类型方向。

### B. 迁移臂（普查先行）

实际财务入口改经 A：主候选=`billing/routes.ts` 与/或 `billing/payments/routes.ts` 的账务查询/订单/权益 handler（生产挂载 http.ts 已核实）——**执行者先普查冻结实际迁移清单**（消费点×模块×处置全表入报告）；对账（reconcile/statements 管理面）与退款/调整处置面**不迁移不暴露**（验收⑤具名授权维持）。事实不符→停下上报。

### C. `server/tests/multitenancy/billing-entries-public.test.ts`（新增全权）

1. 委托等价；2. 验收①权限分离（company-finance 现状钉+门面零成员/Bot 管理写面）；3. 验收②回调 Payer=服务器订单映射（现状源级钉）；4. 验收③重复/迟到收款渠道事实+权益幂等（现状钉+存量对照）；5. 验收④权益失败独立恢复查询（现状钉）；6. 验收⑤对账只读+处置具名（结构断言）；7. 存量 billing 套件两树对照（双侧落盘、完整命令；**真库重放 stdout 独立落盘**——MOD09 F-3 纪律）。

## 2. owned_files（冻结）

A/C 新增全权；`billing/routes.ts`、`billing/payments/routes.ts`（受限：普查后冻结的 handler 经门面）；`assembly/runtime.ts`/`assembly/http.ts`（受限最小接线 hunk）；`tests/config/e2e-bun-suites.json`（**仅当新测试落 driven 层时按 MOD09 外科登记先例登记**——编排者裁决①先例，插入格式照 mod09-r1 检查点；预期情况是 native 层可直接收集则零改动）。其余全仓只读（credits.ts/credits-writer.ts/payments/service.ts/entitlement.ts/payer 族/reconcile 族内件零改动；M04-M06 出口不碰）。事实不符→停下上报；纯类型零运行时适配可先行但置顶登记。

## 3. 验证门

checker 654 零 delta；typecheck 恰 3；审计 26 缺口（native 608 若新测试 native；driven 登记 +1 则照 MOD09 先例）；D 全部根入口（或 driven 层照登记）；存量 billing 套件两树对照（双侧落盘+重放 stdout 落盘）；biome 我方零新增。

## 4. 验收映射

①→C2；②→C3；③→C4；④→C5；⑤→C6。
