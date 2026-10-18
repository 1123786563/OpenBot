# MT073 独立复审 brief
角色：独立复审者（只读；变异重放除外）。树=r15-mt073（BASE+272+增量 8：company-finance-visibility.ts、schema company-finance.ts、窄缝、billing-visibility.test.ts+support、entry-context.test.ts[令牌 w15e 版]）。报告：reports/MT073.md；证据：checkpoints/MT073/。
## 必做
1. 三步配方（openbot_enterprise_r15c_*，端口 55588；令牌按 w15e 环境对齐）。
2. 聚焦 billing-visibility.test.ts（16/0/90）+全量（1140/0/44）。
3. 变异抽验 ≥3（M01-M07；必含 M04 锚点排版修正后的账户侧总额失去客户过滤变体）。
4. 冻结面核对（after-hashes 8 文件基准）。
## 专项
- AC1 普通成员看不到他人订单/支付资料（共用公司余额也不行）。
- AC2 财务管理授权主体可见性+无授权不可见（授权矩阵用例）。
- AC3 团队用量汇总=公司总额一致性（**不含个人直连消费**的排除断言）。
- AC4 旧创建人限制未被放宽回归用例存在性。
- 一任 run-mutations.sh 三 bug（M04 锚点等）修正披露与执行版脚本一致性；首步自证双证（哈希+行为）复核。
## 输出
reports/MT073-review.md+worker_done。
