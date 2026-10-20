# Mastra Agent 执行迁移 DAG 与恢复索引

日期：2026-10-19。范围为“仅编写计划”。主计划：[详细实施计划](2026-10-19-mastra-agent-execution-migration.md)。需求来自本会话，不关联或自动创建 GitHub Issue。

## 规划基线与事实源

- 工作区：`/Users/wuyongjun/trea/OpenBot`；branch：`main`；规划 BASE：`1dc117b65dbb958e73d6c1a0a4a6ee6fa0f48717`。
- 需求：用户询问迁移 Mastra 所需改造，继而要求编写详细计划；未要求实施。
- 分析：`docs/plans/research/2026-10-19-mastra-agent-migration-assessment.md` 和 `2026-10-19-mastra-official-capabilities.md`。
- 规划时哈希：`.archive/runs/legacy-plans/2026-10-19-mastra-agent-execution-migration/baseline.json`；是规划证据，不是实施增量 Review Package。
- 现有用户改动：drizzle meta snapshot 与其他任务脚本/计划，保留在原位置。本次只新增本任务文档。
- 执行前：重核 HEAD/工作区、批准 Spec、接口、测试与既有 Ledger；显式转移未提交文档。实施 BASE 与 Task 检查点由真正执行时写入 Ledger，不复用规划日期推断完成状态。

## DAG

```mermaid
flowchart LR
  T0[范围与实施基线] --> T1[锁定版本/恢复探针]
  T1 --> T2[最小工具执行]
  T2 --> T3[AG-UI 完整流]
  T3 --> T4[完整历史/附件]
  T4 --> T5[受控模型与计费]
  T5 --> T6[持久审批恢复]
  T6 --> T7[记忆与学习]
  T7 --> T8[网页 Runner]
  T8 --> T9[后台任务]
  T9 --> T10[交接/旁路读取]
  T10 --> T11[导入/切换/回滚]
  T11 --> T12[客户端验收]
  T12 --> T13[启动/观测/双实例]
  T13 --> T14[清理/Review/OCR]
```

所有边为规划阶段根据 Interface 消费和共享文件推断的执行顺序，不是 GitHub 显式 Issue 依赖。严格串行使 copilot.ts/index.ts/执行模块与数据库共享状态具有唯一写入者；后续优化并行前必须另核所有权和测试共享状态。

## 节点记录

source_issues 对所有节点均为 `[]`；source_request 为本会话。`owned_files / interfaces / verification` 的完整定义采用主计划对应 Task 的规范段落，表内提供定位摘要，避免两处复制漂移。

| id | acceptance | depends_on | owner_role | validator_role | owned_files / interfaces / verification | status |
| --- | --- | --- | --- | --- | --- | --- |
| T0 | 需求批准状态真实，工作区和基线可恢复 | [] | coordinator | reviewer | Spec、baseline、entrypoints；主计划 §5 | ready |
| T1 | 锁定模型/多步/跨进程恢复证据 | [T0] | backend_implementer | backend_validator | compatibility、探针；§6 | pending |
| T2 | 授权工具闭环、提示与并发隔离 | [T1] | backend_implementer | backend_validator | execution-contracts/instructions/tools/execution；§7 | pending |
| T3 | fullStream 到完整 AG-UI 语义 | [T2] | backend_implementer | backend_validator | stream-events/ag-ui-agent；§8 | pending |
| T4 | parts/附件/intent 单写入及隔离 | [T3] | backend_implementer | backend_validator | conversation-runtime/message-parts/service；§9 | pending |
| T5 | 每模型步骤受预算与结算约束 | [T4] | backend_implementer | backend_validator | governed-agent/model adapter；§10 | pending |
| T6 | 精确审批、持久恢复、一次执行 | [T5] | backend_implementer | backend_validator | continuation store/schema/approval；§11 | pending |
| T7 | 记忆审核与学习快照不丢功能 | [T6] | backend_implementer | backend_validator | context/learning provider；§12 | pending |
| T8 | 真实挂载网页受控 Mastra 运行 | [T7] | backend_implementer | backend_validator | copilot/resolver/runner/index；§13 | pending |
| T9 | 后台入口使用同一治理与引擎 | [T8] | backend_implementer | backend_validator | headless/run-turn/index；§14 | pending |
| T10 | 交接、续跑与旁路读取全覆盖 | [T9] | backend_implementer | backend_validator | handoff/approval continuation/history readers；§15 | pending |
| T11 | 幂等导入、单写切换、不丢数据回滚 | [T10] | backend_implementer | backend_validator | legacy-import/cutover/CLI；§16 | pending |
| T12 | 原 UI、HITL、停止和重连兼容 | [T11] | frontend_implementer | frontend_validator | channel-chat/copilot 前端适配及测试；§17 | pending |
| T13 | 可选 Intelligence、观测、重启及跨实例隔离 | [T12] | backend_implementer | backend_validator | config/index/observability/integration；§18 | pending |
| T14 | 最终检查及完整独立/OCR 审查通过 | [T13] | backend_implementer + coordinator | backend_validator + reviewer | 旧路径清理、证据、OCR；§19 | pending |

每个实现 Task 另有独立 reviewer；validator PASS 不能代替 Spec/质量批准。T0 ready 不意味着允许开始生产实现。

## Ledger 初始化约定

实施时创建计划专属 `ledger.md`。每节点记录：实际 agent_type/模型/推理、Brief、前置已审查检查点、HEAD、前后快照/增量 patch/哈希、RED/GREEN/静态命令与结果、validator/reviewer 报告、OCR finding/ruling、blocked 原因与下一步。只有内容已集成到当前串行工作区且同哈希验证/Review 通过才改为 verified。

恢复先读批准 Spec/ADR/CONTEXT、Git 和 Ledger。状态至少 ready/pending/running/blocked/verified；模型调用失败、测试 skip、未运行数据库验收、退出码 0 但 OCR 漏文件都不是 verified。

## DAG 自检

- 节点唯一：T0–T14 共 15 个；依赖引用均存在，无自环，线性拓扑序与表序相同。
- 源需求 contains：本迁移范围包含 T0–T14；没有将“包含”误用为外部 Issue 依赖。
- 无孤立遗漏：D01–D08、五类 Review Focus 与全部入口均在主计划 §21 映射；外部产品/子模块范围显式排除。
- 当前没有任何实施节点 verified，未运行测试，也未发布。
