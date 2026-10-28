# Agent 规则修订 Implementation Plan

> **For agentic workers:** Use the repository's rule-document revision path in the verified current workspace; finish with independent validation/Review and OCR. No commits, push, merge, deployment or automation enablement is authorized.

**Goal:** 修复用户已确认的六项规则问题，保持安全与独立审查边界。

**Architecture:** 维护现有规则文件及 v3 数据外壳；用既有 attempt、history、state_changed 回执表达人审后的修复，不新增协调服务或状态枚举。

**Tech Stack:** Markdown、JSON Schema 2020-12；现有本地 Ajv 用于离线结构验证，不新增依赖。

**Spec:** 用户先询问修法、后明确要求“按照以上意见进行修订”；六项范围记录于 `.archive/runs/2026-10-27-rules-audit-ef08f3e8/audit.md`，以本轮用户批准的修订建议为准。

## Global Constraints

- 本轮只修订规则、schema 与方案；当前工作区业务修改保持原状。
- 沿用候选表的 Claude 复审/终审限制；平台能力兼容不改变会话独立性。
- 取消子票须有覆盖父级对应要求的有效决定；父级自身/组合验收继续执行。
- 人审后的实现缺陷修复沿用原需求，旧拒绝决定不可覆盖或伪装成人工批准。
- 缺少协调/安全恢复能力继续阻塞对应写入/恢复；不部署服务、不改 CI、不启用队列或自动化。

## Review Focus

- 混合 verified/not_required 子票可结算；无决定、错误指纹或失败子项仍阻塞。
- 原需求未变的人审缺陷拒绝可进入新 attempt；无修复授权或原检查点不得直接重贴标签。
- 队列候选 SHA 变化后旧终审/OCR/CI 失效，入队本身不等于交付。
- 无 agent_type 平台不编造角色回执，也不放行同一实现会话自审。
- 未部署能力不能被文档、空配置或单 Run 声明冒充。

## Task 1: 修订规则与结构约束

**Role / owned_files:** 当前 Agent 按规则文档修订路径执行；`.agents/rules/{delivery-gates,testing,execution,orchestration-agents,closed-issue-audit,closed-issue-daily-run,coordination-state,coordination-format,checkpoints}.md`、`.agents/rules/coordination-schema.json`。

**Interfaces:** Consumes 用户确认的六项建议及原 v3 契约；Produces 同步的规则、v3 结构约束和具名验收样例。

- [x] 先以既有 Ajv 验证子票/父票边界输入，记录原 schema 接受不完整取消投影和非终态子票的结果。
- [x] 修正队列入队与目标写入顺序，CI 接入作为实际启用前置；统一 Agent 候选与平台兼容路径。
- [x] 修正父票混合聚合，按现有 history/state_changed 和 attempt 记录有授权的人审缺陷修复；同步每日队列、schema 及升级要求。
- [x] 给出能力登记/部署/试运行的可定位入口和缺失处理；补充协议验收样例，不编造实现。
- [x] 执行 JSON/schema/向量/链接/diff 检查；独立 reviewer 复核六项需求及安全边界，处理有效 finding。
- [ ] 对完整授权范围执行 OCR；如工具或安全范围隔离不可用，保存实际阻塞及恢复条件，不声称门禁通过。

**Failure handling:** 保留已完成改动及原始回执；只修本轮范围。证据不完整则报告验证或审查缺口，不修改用户基线、不提交。
