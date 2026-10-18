# MT123 独立复审 brief
角色：独立复审者（只读；brief 明示的变异重放除外）。树=r15-mt123（BASE+272+增量 4：startup-defaults.ts、index.ts、entry-context.test.ts[令牌 w15d 版]、startup-defaults.test.ts）。报告：archive/plans/multitenancy-execution/reports/MT123.md；证据：archive/plans/multitenancy-execution/checkpoints/MT123/。
## 必做
1. 三步配方 provision（库名 openbot_enterprise_r15a_*，端口 55586；**注意 entry-context.test.ts 令牌钉 w15d——按实现者同款环境对齐：同容器另建 openbot_enterprise_w15d 库+env 指向**，或按报告 §5-R1 处置复刻；修正链序+bun install）。
2. 聚焦 startup-defaults.test.ts（24/0/75）+全量（1148/0/44）。
3. 变异抽验 ≥3（含 MUT4 多租户绕过可装配+MUT1 默认公司复辟）重注入→捕获→字节复原。
4. 冻结面 272 项哈希核对（entry-context.test.ts 令牌差异=已披露整改，核对 diff 恰为断言 1 行+注释 2 行）。
## 专项
- AC1「有测试断言」真实性：进程级可变当前公司/团队状态的消除是否真有断言钉死（深冻结赋值抛错等）。
- AC2 单租户回归：singleUser=true 保留与多租户绕过恒不装配的双向断言。
- AC3 对照测试：createApp 双模式注册路径多重集/状态码/DTO 逐字段对照的存在性。
- AC4 装配缺口就绪校验与 MT013 判定纪律一致性。
- R1 令牌 RECTIFIED 双哈希与 wave14-integration §4-2 先例同构性。
## 输出
archive/plans/multitenancy-execution/reports/MT123-review.md（verdict+分级 findings）+worker_done。
