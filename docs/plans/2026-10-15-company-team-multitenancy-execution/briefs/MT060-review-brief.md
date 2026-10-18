# MT060 独立复审 brief
角色：独立复审者（只读；变异重放除外）。树=r15-mt060（BASE+272+增量 8：openmuse-task-tenancy.ts、schema openmuse-task-tenancy.ts、窄缝、openmuse-tasks.test.ts+support、entry-context.test.ts[令牌版]）。报告：archive/plans/multitenancy-execution/reports/MT060.md；证据：archive/plans/multitenancy-execution/checkpoints/MT060/。
## 必做
1. 三步配方（openbot_enterprise_r15d_*，端口 55589；令牌按树内版本环境对齐）。
2. 聚焦 openmuse-tasks.test.ts（31/0/168）+全量（1155/0/44）。
3. 变异抽验 ≥3+RESTORE。
4. 冻结面核对。
## 专项
- AC2 **任务锁与租约按公司隔离：A 公司锁不阻塞也不被 B 复用**——核对证明方式（真并发竞态用例 or 串行等价证明），判定证明力是否充分。
- AC3 回填迁移：dry-run preview 只读（零写入）与执行结果逐行一致+回放幂等+双团队/无成员零行+attribution='backfill'。
- AC4 后台触发遵守 MT042 作用域重建（机器身份/权威行语义在任务触发路径的真实接线）。
- 四任披露：GREEN-1 存档 7 fail（三处 GREEN 中断缺陷）修复的 diff 范围核对（无夹带）。
## 输出
archive/plans/multitenancy-execution/reports/MT060-review.md+worker_done。
