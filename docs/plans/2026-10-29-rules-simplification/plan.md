# Agent 规则流程简化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本轮为规则文档修订，当前 Agent 执行，末尾一次独立审核；不启动代码实施派发。

**Goal:** 按用户已接受的审核方向，为普通修复提供轻量路径，减少无关变动造成的重复审核。

**Architecture:** execution.md 唯一定义轻量、标准、完整三档流程；review.md 唯一定义证据承接。其余入口同步引用；每日自动化和 Orca 多 Agent 保留专用强约束。

**Tech Stack:** Markdown；只读链接、差异和流程场景核验；独立 Review 与 OCR。

**Spec:** 本会话的六项审核结论、三档流程建议及用户“先帮我调整”的实施授权。

## Global Constraints

- 保留外部写入授权、他人改动、测试数据隔离、真实内容验收和清理前保全要求。
- 不修改 JSON 协调合同、适配器实现、批准产品 Spec/ADR 或启用自动化。
- 本次规则语义修订按修改前规则完成独立审核与 OCR，不用新规则自我豁免。
- 不提交、推送或执行 GitHub 写入；已有未跟踪内容保持原状。

## Review Focus

- 普通 bugfix 能走轻量路径，权限/计费/持久化与规则门禁变更仍走完整路径。
- 轻量任务不会经 Issue、归档、测试或交付的引用隐式升级为完整流程。
- SHA 变化允许有据承接，相关代码/环境/需求变化和不明影响不能沿用旧通过。
- 每日审计和多 Run 的互斥、身份、预算与完整审查约束继续有效。
- low 不制造审批循环；真实正确性与验收缺口不通过降级放行。

### Task 1: 同步流程分档与证据边界

**Files:** AGENTS.md；.agents/rules/{execution,review,issue-delivery,delivery-gates,checkpoints,artifacts,testing,coordination-state}.md。

**Interfaces:** Consumes 已有授权/事实源/专用编排合同；Produces execution.md 三档入口和 review.md 证据承接合同。其他文件只消费这两个定义。

- [ ] 修改上述规则，消除普通任务必需的 DAG/多 Agent/OCR/事务归档要求；不改专用自动化合同。
- [ ] 核对相对链接、git diff --check、范围和至少八类流程场景；结果归档。
- [ ] 由干净上下文的独立 reviewer 审查完整修改，修复有效问题，再执行限定本轮范围的 OCR。
- [ ] 核对最终 diff、原有未跟踪内容和审核覆盖，报告结果及任何未通过门禁。
