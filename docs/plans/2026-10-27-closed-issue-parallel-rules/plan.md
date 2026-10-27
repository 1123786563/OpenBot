# 已关闭 Issue 闭环与并行规则 Implementation Plan

> **For agentic workers:** Follow the repository's direct rule-document revision path in the verified current workspace, with independent validation/Review and OCR. No production implementation, service deployment, CI/automation enablement, commits or remote writes are authorized.

**Goal:** 将用户批准的五项闭环与并行建议写入 `.agents/rules`，保留授权、独立性和交付门禁。

**Architecture:** 一个每日批次 Run、一个协调者、一个串行集成及副作用入口。保留 v3 Ledger 外壳，通过既有 evidence/refs 引用新增的不可变 Run 调度与修复波次 manifest；policy revision 和显式迁移负责语义切换。

**Tech Stack:** Markdown、JSON Schema 2020-12；既有本地 Ajv 用于离线结构诊断，无新依赖。

**Spec:** 用户“帮我修订进去”，批准前一轮流程报告的五项改进。事实源和反例见 `.archive/runs/2026-10-27-closed-issue-flow-audit-82c31d60/report.md`。

## Global Constraints

- 只改规则、对应 schema 和本方案；保留上一轮六项修订及所有无关业务修改。
- C 默认 4；贴标闭环必须留动作预算且 C 至少 2。动作仍独立 slot，预留不绕过公平性或授予写权限。
- P 默认 2，最多 4，记录实际资源降额；未授权并行实现时写代码阶段全局串行，审计测试仍须隔离。
- 选票时原子推进公平游标；在途票不重选，完成事件可乱序且不再推进游标。
- 修复预算按冻结波次计数；同一 Task 每波至多一次写入尝试，不因改 ID/Issue/Run 重置历史预算。
- Run/波次结构用独立 manifest 验证，不给 v3 Ledger 塞未知字段；旧数据必须停止写入、保守迁移和验收后才使用新语义。
- 不部署协调与恢复服务，不修改 CI，不启用自动化，不宣称缺失能力就绪。

## Review Focus

- C=4、P=2 时两个 audit 仍能给就绪动作留出名额；失败/取消释放预留可重放，不能突破总量。
- 三类均有任务时连续派发及逆序完成仍公平；崩溃恢复不占第二个 slot。
- 多张无共同父票的修复有唯一 source_issues 和终审并集，不能把读范围当写授权。
- 五个 Task 首次修复只用一个波次；重复启动同 Task、追加任务或新波次均不能偷用旧额度。
- 旧总 Dispatch 次数不降低，未完成历史 slot 安全结算后再切换；模型候选、权限和资源边界保持。

## Task 1: 修订闭环和并行契约

**Files:** `.agents/rules/closed-issue-daily-run.md`、`coordination-format.md`、`coordination-schema.json`、`orchestration.md`、`orchestration-protocol.md`、`execution.md`、`worktrees.md`，必要时同步 `closed-issue-audit.md` 的入口指针。

**Interfaces:** Consumes 已批准流程反例和当前 v3；Produces 调度/波次 manifest 定义、动作预留与并发契约、批次归属、迁移和验收样例；部署仍为外部前置。

- [ ] 保存本轮基线，先验证旧 schema 不认识新 manifest；记录结构诊断边界。
- [ ] 写入 C/P、动作名额预留、选票游标及乱序结算语义。
- [ ] 写入每日批次 Run 例外、串行集成/副作用和修复波次计次。
- [ ] 同步 schema 独立定义、迁移、验收表、自动化提示词和相关入口。
- [ ] 做 JSON、完整 schema、边界样例、原指纹向量、相对链接及 diff 检查；独立 Review 五项范围与安全边界并处理 finding。
- [ ] 完整 OCR；缺少安全隔离能力时保存实际覆盖阻塞及恢复条件，不把 preview 当通过。

**Failure handling:** 证据/能力不足时保留工作区及已完成规则，不部署替代服务、不扩大授权。运行证据归本 Run 的 revision，不写入方案正文。
