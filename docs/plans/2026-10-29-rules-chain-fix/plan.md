# 规则链路精简修复计划

- 依据：[审计报告](../research/2026-10-29-agent-rules-chain-audit.md) §4–§5；用户指令“按照方案修复”（2026-10-29 会话）
- 档位：完整（授权/验证/审核/交付门禁的规则配置）
- 基线：HEAD `efb30cccd` + 其他会话未提交改动（新增 `coordination-maintenance.md`、`artifacts-maintenance.md`，修改 artifacts/coordination-format/coordination-state/orchestration），作为只读基线保留；快照见 `.archive/runs/2026-10-29-rules-chain-fix-bb934734/before/`
- 授权：仅本地修改；不提交、不推送、不改 Orca 定时任务、不改外部适配器仓库

## 本轮范围

| Task | 方案项 | 文件 | 验收 |
| --- | --- | --- | --- |
| T1 | P0-1 入口单源 | CLAUDE.md | 仅指向 AGENTS.md |
| T2 | P0-2 方案 B 指纹如实化 | fingerprints.md、coordination-format.md、delivery-gates.md | 不以指纹相等放行“需求未变”；声明适配器现状 |
| T3 | P0-5 过时声明 | coordination-format.md、checkpoints.md | 以 config 登记入口/哈希/回执为准 |
| T4 | P1-1 机器合同判定表 | execution.md + 5 处引用方 | 唯一判定表，边界复述改指针 |
| T5 | P1-2 状态机单源 | coordination-format.md、closed-issue-audit.md | 散文仅 delivery-gates；机器不变量保留 |
| T6 | P1-3 计数器表 | coordination-format.md、review.md、closed-issue-daily-run.md、orchestration-agents.md | 三计数器唯一定义 |
| T7 | P1-5 审查镜像构造 | checkpoints.md | 共享对象库 + 不复制可重建依赖；子模块远端还原门禁不变 |
| T8 | P1-6 编排合并 | orchestration.md ← orchestration-protocol.md、orchestration-review.md | 原条款全部保留，入链更新 |
| T9 | P1-7 merge queue 单源 | delivery-gates.md、testing.md | 一处权威 |
| T10 | P2-1 校验脚本 | scripts/check-agent-rules.mjs、package.json | 链接/锚点/入口覆盖/CLAUDE 指针检查通过 |

## 不在本轮（待用户决定）

- P0-3 OCR 频次例外（需确认 2026-10-20 裁决）
- P0-4 调度频率与空轮快速路径（需确认 daily/hourly）
- P0-2 方案 A（改外部适配器）
- P2-2 format 拆分迁仓、P2-3 变更节流、P2-4 SDD 冻结

## 验收与审核

1. `bun scripts/check-agent-rules.mjs` 通过
2. 独立只读 reviewer 按审计报告 §5.5“约束不减”检查单逐项核对前后快照，分列行为/Spec/质量结论
3. 仅文档与脚本：OCR 对 `.mjs` 适用性按 `.opencodereview/rule.json` 判定
