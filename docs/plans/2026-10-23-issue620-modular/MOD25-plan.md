# MOD25 收口计划（#645，根 #620）——冻结版 v1

> 收口票：收窄已迁移范围的旧出口与存量例外 + AR01–AR18 全范围证据映射 + 收口级验证。不新增业务功能、不补做原功能票未实现项、不强制提取 package。票面红线：「只删无消费者旧路径」「阻塞验收不伪装已完成」。

## §0 普查事实（2026-10-27 侦察，基点=集成分支 HEAD d4dc024ed）

1. **存量例外 629**（cycle 531 / deep-reference 98）。逐条解析级核验：**live=629、stale=0**——零条目当前可移除（改道半条件全部未发生）。守卫脚本 `scripts/check-module-imports.ts` **不检测失效例外**（无 stale 告警机制，登记为事实）。
2. **可改道集=148 条**（目标模块公开出口已建且所需符号全部被覆盖；kind 感知复核 value 错配 0）：110 type-only + 33 value + 5 mixed；涉 111 个源文件；跨模块零异常。分布：M01 79 / M03 30 / M08 24 / M04 13 / AUTOMATION 2；ticket 归属 MOD04×77/MOD05×30/MOD12×24/MOD06×13/MOD14×2/MOD15 重类目×2。**VOICE 域 16 条存活例外中 9 条在集内**（server 侧 voice/dictation→auth/agents/channels）；其余 7 条（app 侧→stream-scope 等）符号未被出口覆盖=不收。
3. **不可收窄**：445 条 partial（所需符号未上公开出口——扩门面=超票面，不收）、36 条目标模块无公开出口。
4. **旧出口删除候选=0**（三门面内件仍有活消费者、plugin-packages 内件为 ASSEMBLY 组合根保留臂、readPinnedSkills 测试钉+票面具名保留；MOD19「死出口四处」登记在本树不可验证——事实披露：本 Run 证据目录仅存于主 checkout，不在集成树）。
5. **AR01–AR18 证据载体池已普查**：无任何测试件具名引用 AR 编号=映射工件本身即本票交付物；AR05（撤权/版本串行化）、AR10（未知费用/重放）证据偏薄（各有存量件但专项交错/重放钉少）——如实标「薄」不补强为新测试（补写交错级集成测试超出收口票机械范围，登记转后续票）。
6. **OCR r2 遗留**：`reviews/closure-ocr-r2-ruling.md` 编号修复 DAG 九 medium（M-1..M-9），「R5/R6 完整收口前必须销项」；其中 **M-2（checker validateConfig 校验 category 枚举+baseline 分支 configErrors 非空报错）标注「解环工作启动前必须」**=本票例外手术的前置必办。
7. **OCR 范围核算**：前次完整 OCR 终点 `e804c4de3`（2026-10-25）。其后落点的本 Run 提交=MOD11 `a44860553`/MOD12 `dcbaf1405`/MOD13 `d4e6140c5`/MOD14 `9e352088c`/MOD18 `ec94fdc2e` + MOD15 `16f97f260`/MOD19 `9dd28588d`/MOD22 `7acec616d`/MOD23 `d5ba262c1`/MOD16 `592512b6b`/MOD20 `7b8e3f1fd`/MOD21 `46c77a0c5`/MOD24 `d4dc024ed`（14 票，first-parent 并集 **124 文件**）+合并提交 `4824cacde` 三处冲突解决 hunk（app.ts/index.ts/e2e-bun-suites.json）。**本票收口 OCR 范围=124 文件并集+3 冲突 hunk**；main 汇入的 210 文件已由 #618/#358/#619 各自 Run 验收，不混入。

## §1 工作包

### P1 前置硬化（M-2，例外手术先决）
`scripts/check-module-imports.ts`：① `validateConfig` 校验 category 枚举合法值（cycle/deep-reference 等现用值集合）；② `--baseline` 分支遇 configErrors 非空时报错退出（不再静默）。行为面：仅校验面，不改判定逻辑。

### P2 例外收窄（核心机械工作）
- 对 148 条可改道集（清单=`docs/plans/2026-10-23-issue620-modular/MOD25-redirectable-set.json` 的 redirectable 数组）逐条：源文件 import 说明符从内件路径改为该模块 `public.ts`（或 `integration.ts`，取符号实际所在出口）路径；**保留 import kind**（type-only 保持 `import type`）；`module-imports.json` 同步删除对应例外条目。
- **分批**：B1=110 type-only（零运行时风险）；B2=33 value+5 mixed（运行时装载面变化——公开出口均系本 Run 所建 re-export 门，装载集=内件原集超集；每批后跑门）。
- 每文件改道后该文件对目标内件的 import 须清零（同文件多条例外合并为一次出口 import 亦允许，diff 最小优先）。
- 预期：例外 629→**481**（−148）；违规 0；幻影 0；环数≤45（public 边免计环，实测如实登记）。
- **风险闸**：value 批如出现 TDZ/测试回归→停下登记障碍，等编排者裁决（不强行改道）。

### P3 OCR r2 九 medium 处置（纯重构类清零，四类移交）
- 本票办（纯结构/常量收敛，零行为面）：**M-1**（`server/src/app.ts` coworker/openMuseSeams 等孪生内联对象类型抽共享命名类型，`assembly/http.ts` HttpAssemblyDependencies 引用同一声明——编译器接管同步）、**M-4/M-5**（`billing/routes.ts`/`payments/routes.ts` 工厂顶部解一次回退常量收敛）、**M-9**（`runtime.ts` company-finance visibility 两实例提顶部构造一次复用）。
- 移交登记（保持 OCR r2 DAG 原指派）：**M-3**（http.ts cancel/audit-failed catch 补日志→M11 后续日志纪律票）、**M-6**（runtime 启动中段失败回滚窗口→lifecycle 设计票）、**M-7**（credentialLease 不可达链+6 operator 池零消费者→生产首条接线装配票）、**M-8**（mastraContinuationRouteDeps 已构造未挂载→mastra 接线票，迁移前既有缺口）。四项在收口报告逐项具名+原指派引用，不伪装清零。

### P4 AR01–AR18 证据映射工件
新建 `docs/plans/modular-architecture/acceptance-evidence.md`：18 行映射表（AR 编号→定义摘要→证据件路径与读数→覆盖定性 厚/薄/GAP）。载体池以侦察 §Q3 为准；AR05/AR10 标「薄」并注明既有件；检查点证据注明位于主 checkout `.archive/runs/2026-10-23-issue620-orchestration/checkpoints/`（集成树外的 Run 证据，具名路径引用）。**未迁移/不适用/真实环境阻塞逐项区分**（票面验收②）：VOICE 16 中 7 条未收窄（出口未覆盖=不适用）、driven 族 PG 环境事实、Bifrost 三门零装配（G-1 产品设计缺口）等逐项列。

### P5 收口钉套件
新建 `server/tests/multitenancy/mod25-closure-seam.test.ts`（native 形：e2e-compat、根入口收集、零 DB）：
- D1 收窄面钉：抽样≥10 条已改道消费点（源文件不再含内件路径 import+出口路径 import 在位）；
- D2 例外簿钉：module-imports.json 中 148 条 source|target 对零残留（程序化对照 redirectable-set.json）；checker category 枚举校验存在（M-2 源扫钉）；
- D3 常量收敛钉：billing/payments routes 回退常量各恰 1 处定义（M-4/M-5）；app.ts 命名类型在位且 http.ts 引用同名（M-1 源扫钉）；visibility 单例（M-9 源扫钉）；
- D4 AR 工件钉：acceptance-evidence.md 存在+恰 18 行 AR 映射+每行含路径与覆盖定性词（厚/薄/GAP）；
- D5 移交钉：M-3/M-6/M-7/M-8 四 ID 在 acceptance-evidence.md 或收口报告具名出现。

## §2 owned_files（冻结清单）

- `scripts/check-module-imports.ts`（P1）
- `tests/config/module-imports.json`（P2 簿记）
- 111 个改道源文件（P2；全清单=MOD25-redirectable-set.json redirectable 数组的 source 去重集，计划附数据文件为准）
- `server/src/app.ts`、`server/src/assembly/http.ts`（P3 M-1）
- `server/src/billing/routes.ts`、`server/src/payments/routes.ts`（P3 M-4/M-5）
- `server/src/assembly/runtime.ts`（P3 M-9）
- `docs/plans/modular-architecture/acceptance-evidence.md`（P4 新建）
- `server/tests/multitenancy/mod25-closure-seam.test.ts`（P5 新建）
- `docs/plans/2026-10-23-issue620-modular/MOD25-redirectable-set.json`（计划附件，编排者已落）

**只读面**：billing/gateway 内件（除 routes 常量行）、mastra/**、assembly 其余、三门面 public.ts（P2 不改出口内容——出口已覆盖是改道前提；如发现符号实际未覆盖=事实与计划不符，停下报障碍）、voice/dictation 内件、stream-scope.ts、desktop/**、app/** 除改道清单内文件。零新抽象零新功能。

## §3 验证门（全门两侧对照，台账 NEW 列逐件）

| 门 | 期望 |
| --- | --- |
| G1 checker | 例外 629→481（恰 −148）、违规 0、幻影 0、环≤45 实测如实；M-2 后：非法 category 条目被拒（负向自验） |
| G2 server tsc | 0（M-1 类型收敛后仍 0） |
| G3 app tsc 水位 | ≤基线且我方文件零归因 |
| G4 D 套件 | mod25-closure-seam 全绿（根入口 native） |
| G5 族对照 | 被改道文件所在族抽件（auth/agents/channels/approvals/craft/ai-observability 面）两侧同绿同数；driven 组环境阻塞两侧同形照登 |
| G6 biome | 我方全部文件零新增 |
| G7 审计对照 | committed manifest 零 hunk；审计仅 +D 件 |
| G8 M-1..M-9 状态表 | 五项清零实证+M-3/M-6/M-7/M-8 移交具名 |

## §4 登记节（报告必备）

- GAP/薄/阻塞逐项：AR05/AR10 薄证据定性、445 partial+36 no-public 不收原因、VOICE 7 条出口未覆盖、MOD19 死出口登记不可验证事实、OCR 范围口径（124 文件+3 冲突 hunk）。
- 收窄后 checker 实际读数（例外/环）与计划期望差异。
- M-3/M-6/M-7/M-8 移交项原文引用。
- 环境事实（PG 5435、deliverables/ 目录调度缺口等存量）。

## §5 收口后续（编排者执行，非本票实施面）

codex 终审+全范围 OCR（范围=§0.7）在 MOD25 verified 后按 Run 收口协议执行；推送/合 main 需用户届时授权。
