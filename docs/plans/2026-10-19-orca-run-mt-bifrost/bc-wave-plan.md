# B/C 波次编排计划（R3–R4 dry-run，2026-10-19）

> 承接 run_7176face537b（A 类 106/106 已收尾）。本文件为 B/C 波次的范围复核、DAG 与派发方案，只读产物，未启动任何 Worker。

## 1. 复核结论（scope_revision 1 → 当前 main @ 0a85bb42）

- B 类 169 张：**全部 open**，声明的验证文件在当前 main 仍全缺（0 张转为纯验收）→ 全部真待实施。
- C 类 18 张：全部 open（无验证文件声明，按验收标准实施）。
- 可派发池 **187**（mt 98 / bf 85 / bp 4），其余 145 张被 open 依赖阻塞。
- 数据：`bc-reclass.json`（ready / blocked / waves / 逐票文件核验）。

## 2. DAG 波次（B/C 子图拓扑，20 波）

| 波 | 张数 | | 波 | 张数 |
| --- | --- | --- | --- | --- |
| W1 | 42 | | W11 | 4 |
| W2 | 21 | | W12–W15 | 3×4 |
| W3 | 16 | | W16 | 2 |
| W4 | 11 | | W17 | 1 |
| W5 | 8 | | W18 | 2 |
| W6–W7 | 13+13 | | W19–W20 | 1+1 |
| W8 | 16 | | | |
| W9–W10 | 14+10 | | | |

- W1 = 42：mt 24 / bf 17 / bp 1（明细见 `bc-reclass.json#waves[0]`）。
- W11 以后是深链长尾（mt 分册链 + bf 编号线），实际以补位方式滚动，不按波整批等待。

## 3. 阻塞与保守项

- **#107、#163（均在 W1）依赖 unverified_closed #106/#162**（查无实施证据）。保守处理：从 W1 剔除，待用户裁决（补实施 / 判 wontfix）。有效 W1 = 40。
- C 类 #146（移动端 submodule 基线核对）为此前标记的「B/C 无依赖仅 #146」入口，已含在 W1。
- 51 张 body-link 补挂、3 张 unverified_closed 裁决仍待用户决定（非阻塞实施，只影响范围整洁度）。

## 4. 派发方案（待授权）

- **流结构**：mt / bf / bp 三条域流，域内串行（共享 fixture、迁移表与回归资源），域间并行；每流独立 Orca worktree + 独立 PostgreSQL 测试库（沿用 openbot_mt002/bf011/bf021 命名模式）。
- **试点**：先各域取 1 张（建议 mt #48 MT005、bf #214 01.8、bp #371 BP03）跑通 implement→validate→review→integrate 完整链（B 类是新链路，与 A 类纯验收不同），试点 settle 后放量。
- **集成模式**：默认未提交检查点 + SHA-256 清单；每批 settle 后向用户请求提交授权（沿用 A 波次模式）。
- **资源纪律**（沿用 A 波次教训）：native 套件用 `bunx e2e run --config e2e.unit.config.ts`；drizzle 版本表坑；核验命令在仓库根 cwd；每批 settle 后 release。
- **并发预算**：3 流（试点后可申请扩至 4–6）。

## 5. 试点结果与系统性发现（2026-10-19，run_0eca8880c73e）

- **mt #48**：零改动复验收尾（实现经 checkpoint 253bf7e5 已在 main；票面声明 `team-eligibility.test.ts`，实际落地 `scope-gate.test.ts`，23/23 绿 + tsc 干净）。
- **bf #214**：零改动核验收尾（实现由 Bifrost-5 提交 fb66bd11 等带入；票面根本无 Verification 段）。
- **bp #371**：真实施中（billing payments/reconcile/schema 8 文件 +626/-60，含迁移 0161）。
- **系统性发现：票面声明路径不可靠**——#48 声明文件名与实际落地名不同；#214/#251/#341 无 Verification 段却被判 B。B 池 167 张的真实成分（已实施待核验 vs 真缺口）只能逐票核验分辨。廉价旁证（前工作流交付记录：multitenancy-execution 报告 8 张、Bifrost-5 ledger 10 张，见 `b-triage.json`）只覆盖小部分。
- **后续批次 Brief 统一改为**：先按域核验 main 是否已含等价实现（声明路径过时是常态），已含且 AC 全实证则零改动复验收尾；有缺口才补实现。

## 6. 启动前检查单

- [ ] 用户授权：范围（187 全量 vs 试点先行）、并发预算、集成模式。
- [ ] Orca orchestration 技能按版本重读（`orca skills get orchestration`），preflight Pi 后端与角色映射。
- [ ] 对账：无遗留活跃 Orca Task/Dispatch；资源注册表无悬挂预留（A 波次已确认 reclaimable=0）。
- [ ] scope_revision 1 → 2 变更事件写入 Ledger（本次复核即 rescan 产物）。
