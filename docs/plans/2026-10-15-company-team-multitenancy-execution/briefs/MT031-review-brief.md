# MT031 独立复审 brief

角色：独立复审者（**只读复审**——发现问题写 findings，不改代码）。
对象：MT031 插件目录域。树=r14-mt031（BASE+240+增量 8 文件）。
- 生产：server/src/enterprise/tenancy/plugin-catalog.ts、server/src/db/schema/enterprise-plugins.ts、server/src/db/schema/index.ts、server/src/index.ts、server/scripts/multitenancy/migrate-test.ts（窄缝，brief 预授权）
- 测试：plugin-install.test.ts、support/plugin-install.ts、migration-tool.test.ts（穷举断言 +=）
实现报告：archive/plans/multitenancy-execution/reports/MT031.md；证据：archive/plans/multitenancy-execution/checkpoints/MT031/。

## 必做
1. 三步配方 provision（库名 openbot_enterprise_r14b_*，端口 55572）。
2. 聚焦 plugin-install.test.ts（实现者：35/0）+全量（1025/0/39）复跑。
3. 变异抽验 ≥3 条+RESTORE。
4. 冻结面 240 哈希核对。
## 专项核对
- **变异掩蔽披露**：实现者报 7/8 KILLED+1 掩蔽（1 条变异被既有用例提前捕获，非新增用例钉死）——复核掩蔽定性是否成立：该变异的捕获用例是否真实存在于**基线**（非本票新增）；若只被本票新用例捕获则定性错误。
- **RED 证据**：实现者 RED 0 pass→GREEN-3 35/0——核对 RED 阶段确实因模块缺席而 0 pass（非环境失败伪装）。
- migrate-test.ts/migration-tool.test.ts 窄缝改动是否严格限于 MT031 任务追加（无既有对象改动）。
## 输出
archive/plans/multitenancy-execution/reports/MT031-review.md：verdict+分级 findings；worker_done。
