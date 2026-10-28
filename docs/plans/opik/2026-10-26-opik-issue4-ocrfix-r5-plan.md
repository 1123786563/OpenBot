# Opik #4 — OCR R5 修复波（OCR-R5-FIX）方案

- Run：2026-10-24-opik-issue4（run_e829d8e2ba6d）；BASE main b117c3c3e，集成 HEAD 0626daffd（tip 9455a1804）。
- 依据：外层 OCR R5 补全报告 `ocr/final-review-ocr-r5-resumed.md`（95 findings / 94 解析：2 critical / 7 high / 33 medium / 52 low）；编排者对全部 critical/high 逐条独立核实（结论见 ledger「OCR R5 补全结果 + 94 findings 分诊」）。
- 裁决：FREV R5 的 PASS-with-findings 撤回重评；本修复波消除全部有效 critical/high/medium 后重跑终审（FREV R6）+ 全范围 OCR 复审，再走合并。

## 全局约束（每流 Brief 同款）

1. 授权=本地修复+安全提交；不推送、不合 main、不动 GitHub。
2. BASE=集成 tip；任务 Worktree 各自独立分支；owned_files 不相交（下表），不碰他人文件。
3. 每条 finding 先 RED（复现缺陷的最小证据）再修（GREEN）；OCR 判定与代码不符时，以代码为准写反证报告，不硬改。
4. 52 条 low 原则披露不修；同文件顺手修（≤10 分钟）的可修，逐条列进报告。
5. server 测试入口遵循既有配方（opik4-base-pg@127.0.0.1:55433 / bun-test-compat import）；不新增 Bun 套件清单遗漏（e2e-bun-suites.json 结构损坏为已知存量，只在确需登记时与主控协调）。
6. 报告写 `.archive/runs/2026-10-24-opik-issue4/workers/ocrfix-<x>-report.md`，逐 finding 列：判（属实/反证/降级）、修法、验证证据。

## 流划分与文件所有权

| 流 | Worktree/分支 | 范围（finding → 修复目标） | owned_files |
| --- | --- | --- | --- |
| ocrfix-a | opik4-ocrfix-a | server 核心 33 条（1 high + 12 medium + 20 low 分诊）：**remote-run.ts:226 守卫空转（HIGH）**、bindings 内存上限(725)/settle fire-forget(985)、opik-http 逐个 await(702)、queries/runs R3-03 列表纪律(547)、remote-run receiptSigning 重复(488)/materializeUpstream 重复(310)/endedAt(297)、execution-billing 结算循环(517)、scoring/judge FREV-05 规则实验取消闸门(695)、index.ts:1110 守卫接线、execution-runner signal(419)、profile-policy、scope.ts、context/model-span/span-support/config/routes | server/src/ai-observability/{bindings,opik-http,remote-run,retention 除外,execution-billing,execution-runner,execution-seam,model-span,span-support,context,executions 除外}.ts、queries/runs.ts、scope.ts、routes/{runs,admin-summary}.ts、scoring/judge.ts、agents/profile-policy.ts、src/config.ts、src/index.ts |
| ocrfix-b | opik4-ocrfix-b | **0209 迁移整包**：C1 statement-breakpoint、C2 experiment_executions 收敛、HIGH 排名窗口、M UPDATE 排除稳定键、M retention_deletions 键联结；retention.ts 3 medium（legacy 复查/F5E1-F3/绑定行推断）+ 判定护栏测试 | server/drizzle/0209_opik_stable_resource_scope.sql、server/src/ai-observability/{retention,executions}.ts、db/schema/ai-observability-executions.ts（如需） |
| ocrfix-c | opik4-ocrfix-c | **HIGH `.use()` 绕过**（生产 RunBuiltAgent 路径接线 + 生产形测试）、M OTLP anchors 认证头(4492)、M runId 幂等键(4891)、M 分层纪律(64) | server/src/copilot.ts、toolkit/src/copilotkit/agents.ts（如需）、新测试文件 |
| ocrfix-d | opik4-ocrfix-d | agent-langgraph 预算：HIGH 输出上限未钳制(232)、M outputCap 未扣 projectedInput(257)、budget.ts 其余 medium | agent-langgraph/src/{index,budget}.ts |
| ocrfix-e | opik4-ocrfix-e（收尾流） | 取证脚本：HIGH f7e/f8d setup-env 固定口令、HIGH f8d 判定不可能 PASS、HIGH f6b 守卫、f7b/f5e1/f7e/opik-e2e-ingest medium 组 | scripts/{f5e1,f6b,f7e,f8d}/**、server/scripts/{f7b,opik-e2e-ingest}.ts |

集成次序：a/b/c/d 并行（3 流并行先例，K=4 内）→ 逐流独立审核 → 串行集成 → 组合验证 → ocrfix-e → 审核 → 集成 → FREV R6 → OCR 复审 → 合并。

## 迁移语义决定（ocrfix-b 前置裁决）

- 0209 文件名在集成分支保持不变；**重编号（→0216 系）发生在合并 main 时**（0209 与 main 0209_enterprise 撞号，fixw13 先例）。
- experiment_executions 的收敛 SQL 与 0209 既有 8 表同模式；legacy 行保留 legacy 键的语义照 0209:26-30 头注。
- 排名窗口改为"主体胜者集合内再排 trace"；UPDATE 增加"目标已是稳定键则跳过"；retention_deletions 收敛后 deleteLocal 键联结以删除行收敛后的 scope_key 为准，retention.ts 侧补 legacy 键复查。

## 验证门禁

- 每流：定向测试全绿 + typecheck 增量零新增（基线 65）。
- b 流追加：fresh DB（opik4-base-pg 配方）跑 migrate 全链 + seed legacy 行场景断言（executions 表收敛、排名修正、retention 删除不再 PINNED）。
- 集成后：组合树（1259/0 基线）+ FREV R6 + 全范围 OCR 复审。
