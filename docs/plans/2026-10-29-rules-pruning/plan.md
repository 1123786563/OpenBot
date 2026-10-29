# Agent 规则精简实施方案

> 使用 writing-plans 编写，按 execution.md 的完整档等价流程在当前工作区执行；当前 Agent 实施，最后一次独立只读审核。方案不授权提交、推送或外部写入。

**Goal:** 落地全面审计的第一阶段：减少重复正文和调用成本，保持全部现有门禁及机器合同。

**Architecture:** 规则含义由单一所有者定义，其他入口通过明确触发的链接消费。保留目录与专用强约束，不引入新适配器、状态字段或技能编排。

**Tech Stack:** Markdown；链接、差异、条款映射和流程场景核验。

**Spec:** 本会话全面审计报告第6节A类方案及用户“帮我进行精简”的实施授权。审计快照与当前事实在本轮重新核对。

## 约束与验收

- 保留授权、风险分档、真实测试/独立审核、OCR适用条件、完整范围、条件写、隔离/秘密保护、安全恢复/清理和人审门禁。
- 不修改 coordination-format.md、JSON Schema/向量、运行配置、外部工具和产品Spec/ADR；默认容量/波次/并发/时间及稳定窗口条件不变。
- 不以新规则自我豁免本次审核；纯Markdown变化按现行review.md记录OCR不适用，不能称OCR通过。
- 保留其他Agent的协调记录。单写入者本地修订与只读review使用同一工作区，不创建无用Worktree或协调事务。
- 活跃Run沿用原契约；恢复时依原有策略变化规则核验，不自动套用新文本。
- 逐条记录删减/引用归属；链接有效、正文可测量减少，独立审核无有效critical/high/medium。

## Task 1：集中通用规则的重复引用

**Files:** AGENTS.md；.agents/rules/{artifacts,issue-delivery,orchestration-protocol}.md。

**Interfaces:** execution决定分档，issue-delivery决定完整摄取/rescan，review决定审核/finding，artifacts决定产物；消费方只引用，不再次定义。

- [x] 保留触发分支，去除重复分档/摄取/证据描述；同一边界的完整刷新结果可以共享，所有原刷新时点继续执行。
- [x] 简化Run/SDD描述但保留唯一Ledger、策略/身份、同代恢复、秘密和保留语义；不为缩短正文新增无必要文件。
- [x] 记录旧条款到新正文/引用合同的映射，核对普通轻量/标准/完整及只读路径。

## Task 2：缩短Orca与每日运行入口

**Files:** .agents/rules/{coordination-state,orchestration,closed-issue-daily-run}.md。

**Interfaces:** coordination-format/Schema拥有精确字段和事务语义，coordination-state保留调用前提/资源全集/未知处理，orchestration-review拥有终审与整改，daily拥有每日生命周期与公平算法。

- [x] 去除工具指南已提供的长命令示例和专用合同已有的重复字段/状态/审核展开。
- [x] 保留同Run/任务/前置树、K/C/P、修复波次/公平、epoch/稳定窗口和全部交付门禁；提示词只保留目标/入口/授权边界。
- [x] 核对关系变更、结果不明、第五波恢复、人审拒绝、目标前移和清理场景，无能力仍阻塞。

## Task 3：核验、独立审核与报告

**Files:** 本轮.archive/runs目录的映射、检查、独立报告和结果索引。

**Interfaces:** 冻结前后内容与授权范围→独立review；修复仅覆盖有效finding，必要时复核受影响差异。

- [x] 运行git diff --check、全规则链接/JSON Pointer检查，核对原有机器合同及范围外文件未被本轮改动，统计字符数。
- [x] 用条款映射核查全部被替换正文，并对至少12类正常/失败流程作场景检查；不以文本脚本冒充行为等价证明。
- [x] 按requesting-code-review启动一次干净上下文独立review，检查语义遗漏、弱化和循环引用；处理有效问题。
- [x] 保存当前文件哈希、审核及最终量化结果；报告未验证项，不提交/推送。

## 失败处理

缺少唯一承接条款时保留原文；引用循环导致无定义时恢复定义到原所有者。审核发现约束丢失则修复并复核；外部并发修改先核归属，不覆盖。无法证明等价的风险降档/减少审核/新工具交付留待后续具名方案，不混入本次修订。
