# MOD01 实施计划（Issue #621 · S0 基线与写入所有者）

Run：2026-10-23-issue620-orchestration（Orca run_b80194003f42）。计划版本：v1（2026-10-24）。
Brief 原文：`docs/plans/tickets/modular-architecture/MOD01.md`（哈希基线见 Run `issues/brief-sha256-baseline.txt`）。

## Global Constraints

- **用户原则（2026-10-24 确认）**：本 Run 原则上只移动文件，仅在需要适配时才写代码。MOD01 为清单+检查器票：**除 3 个新基建文件与报告外，现有文件零改动、零搬移**；业务行为保持。
- 行为保持：不改产品行为、稳定 ID、Payer、公开 wire、同连接事务与撤权/审计合同；不实施候选 BA/Personal Space。
- 无本地提交授权：任务以未提交检查点交付；禁止 git commit/push。
- 验证遵守 ADR 0008；不以退出码 0 单独证明通过。
- 共享入口 app/index/copilot 本票只读。

## owned_files（冻结）

| # | 文件 | 权限 |
| --- | --- | --- |
| 1 | `scripts/check-module-imports.ts` | 新增，全权 |
| 2 | `tests/config/module-imports.json` | 新增，全权 |
| 3 | `tests/module-imports.test.ts` | 新增，全权 |
| 4 | `reports/MOD01-inventory.md`、`reports/MOD01-report.md` | 新增 untracked 证据（编排者收割入 Run，不参与交付增量） |

其余全部只读。超范围改动=违规，须先回编排者。

## Task 步骤（单任务串行）

1. 阅读集加载（AGENTS.md → architecture/testing 规则 → 设计稿 A01–A12 → module-catalog M01–M12 与表族 → migration-plan S0/AR01/AR02 → MOD01 Brief 原文）。
2. S0 写入清单：以 Web 文本聊天切片逐跳追踪（浏览器调用 → HTTP 入口 → 会话/Run 建立 → Mastra 执行 → 受管模型 → 计费/消息落库），每写点记录 文件:行/动作/写表或远端/所有者归属；未知归属具名，不默认 shared。
3. 检查器实现：解析 relative/alias/workspace/type-only import；按 JSON 映射+例外判定；违规与例外扩大非零退出；模块级环检测；目录级无限豁免禁止。
4. 例外基线：从当前树实际扫描收敛生成，每条含 source/target/reason/ticket/exit_condition。
5. 测试：正例（真实入口+全量基线一致）+ 反例（新深层引用/循环/未知映射 → 非零）；fixture 不落业务目录。
6. 验证并写报告：typecheck 无新增错误、checker 当前树通过、测试全绿；报告含命令/退出码/用例数/增量 SHA-256。

## Consumes / Produces

- Consumes：module-catalog 所有权映射、migration-plan S0 验收、现有公开 wire（只读）。
- Produces：写入所有者清单（证据入 Run）、可执行增量 import 检查器、存量例外登记（后续票的退出条件输入）。

## Review Focus（独立审核重点）

- 清单是否覆盖首条链路全部实际写点；未知归属是否具名而非默认 shared。
- 检查器是否覆盖 alias/workspace/type import 与环检测；例外是否可收敛、无目录级豁免。
- 反例是否真实触发非零；业务文件是否零改动（git status 仅 4 类新文件）。
- 报告诚实性：跳过、环境限制、无法解析形态是否如实列出。

## 验收映射（AR01/AR02 · S0）

见 Brief 原文 4 条验收标准；完成标准=清单全归属+检查器可用+例外可追踪+行为零变化。
