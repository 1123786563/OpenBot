# OpenBot 方案文档

`docs/` 只保存规范性设计和实施方案。按需读取对应入口，不要把运行日志、验证结果或 Review/OCR 报告写回这里。

| 内容 | 入口 |
| --- | --- |
| 实施方案、DAG 和方案细节 | [plans/README.md](plans/README.md) |
| 已批准或待裁决的架构设计 | [specs/](specs/) |
| 架构决策记录 | [adr/](adr/) |
| Agent 规范 | 根 [AGENTS.md](../AGENTS.md) → [.agents/rules/](../.agents/rules/) |
| 执行、验证、Review/OCR 和历史快照 | `.archive/runs/<run-key>/`，不放在 `docs/` |
| 产品、部署和运维参考 | [reference/README.md](../reference/README.md) |

测试实际读取的 manifest 位于 `tests/config/`；它们是版本化测试输入，不是验证报告。目录分类与迁移规则见 [产物归处规范](../.agents/rules/artifacts.md)。
