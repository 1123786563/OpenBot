# Issue #4 execution DAG — 2026-10-16 continuation

- Root: `1123786563/OpenBot#4`（37 formal children #7–#43，全部 OPEN，无嵌套子 Issue）
- Fresh source read: 2026-10-16 GitHub GraphQL（`blockedBy`/`blocking`），快照 `.omc/state/opik-issue4/snapshots/all-subissues.json`（主 repo）+ 本 worktree `docs/plans/evidence/2026-10-16-issue4/`
- Integration baseline: **main `bab7c0b9`**（前次会话裁定：唯一集成基线；旧分支仅为候选证据，须显式移植+复验）
- Integration branch: `1123786563/opik-integration-main`（自 bab7c0b9 新建）
- 修正：2026-10-15 版 DAG 的 T19 依赖写作 "T07,T17"，实际 GitHub #25 blockedBy = #17(T11), #13(T07)。本版以 2026-10-16 实读为准。

## Nodes（depends_on 来自 GitHub blockedBy，2026-10-16 实读）

| id | issue | depends_on | produces（Handoff 摘要） | A 映射 | 状态(2026-10-16) |
|---|---|---|---|---|---|
| T01 | #7 | — | 模块骨架+路由注册 seam+请求上下文注入 | A5 | 已验证并集成 |
| T02 | #8 | — | i18n 四子命名空间+路由约定 | A5 | 已验证并集成 |
| T03 | #9 | — | versions.json+部署清单+环境变量 | A1 | 已验证并集成 |
| T04 | #10 | T03 | VerifiedOpikContract manifest | A1,A11,A13 | 已验证并集成 |
| T05 | #11 | — | 安全投影 API+策略版本 | A4 | 已验证并集成 |
| T06 | #12 | — | ObservationScope 解析+双测试 scope | A5,A12 | 已验证并集成 |
| T07 | #13 | T06 | 归属存储 schema+绑定/解析 API | A1,A5,A11,A12 | 已验证并集成 |
| T08 | #14 | T04,T05,T07 | OpikPort+HTTP 适配器 | A1,A4,A10,A13 | 已验证并集成 |
| T09 | #15 | T08 | 配置开关+健康+有界写 | A1,A10 | 已验证并集成 |
| T10 | #16 | T09 | run 终结语义+basic 能力标记 | A2,A3,A5,A10 | 已验证并集成 |
| 已验证并集成 | #17 | T01,T07,T10 | 创建者只读查询 API | A5,A6 | 未开始 |
| T12 | #18 | T02,T11 | 运行列表页 | A5,A6,A10 | 已验证并集成（retry 后） |
| T13 | #19 | T12 | 运行详情页+可用性状态 | A2,A3,A5,A10 | 未开始 |
| T14 | #20 | T05,T10 | 内置执行模型调用记录 | A2,A3,A4 | 已验证并集成 |
| T15 | #21 | T14 | 工具提议 vs 真实执行+检索 | A2,A3,A4 | 已验证并集成 |
| T16 | #22 | T14 | LangGraph callback 受治路径 | A2,A13 | 已验证并集成 |
| 实现中 ctx_2eb670449145 | #23 | T16 | 跨服务传播+ID 映射 | A2,A13 | 未开始 |
| T18 | #24 | T13,T15,T17 | 步骤树 UI | A2,A3,A5 | 未开始 |
| T19 | #25 | **T11**,T07 | 数据集 schema+不可变版本 | A7,A11,A12 | 已验证并集成 |
| T20 | #26 | T11,T19 | 案例审查+保存接口 | A4,A7 | 已验证并集成 |
| T21 | #27 | T02,T20 | 数据集页面 | A4,A5,A7 | 未开始 |
| T22 | #28 | T19 | 实验 schema+冻结配置提交 | A7,A9 | 已验证并集成 |
| T23 | #29 | T16,T20,T22 | 隔离执行+生产写工具拒绝 | A4,A8 | 未开始 |
| T24 | #30 | T23 | 有界并发+重授权+取消/lease | A6,A10,A12 | 未开始 |
| T25 | #31 | T24 | 评测计费准入+结算接线 | A8 | 未开始 |
| T26 | #32 | T22 | 规则评分器 | A7,A9 | 未开始 |
| T27 | #33 | T25,T26 | 受控模型 Judge | A4,A7,A8 | 未开始 |
| T28 | #34 | T26 | 结果查询+失败分类 | A5,A7,A9 | 未开始 |
| T29 | #35 | T28 | 对比接口+兼容性判定 | A9 | 未开始 |
| T30 | #36 | T21,T28 | 实验页面 | A5,A7,A8 | 未开始 |
| T31 | #37 | T29,T30 | 对比页面 | A9 | 未开始 |
| T32 | #38 | T09 | 采集入口认证+控制台保护 | A4,A5,A13 | 已验证并集成 |
| T33 | #39 | T11,T32 | 管理员汇总+故障排查 | A5,A6,A10,A12 | 未开始 |
| T34 | #40 | T05,T11 | 有界异步导出+即时撤权 | A4,A6,A10,A11 | 已验证并集成 |
| T35 | #41 | T19,T22,T34 | 保留期+真实删除验证 | A6,A11,A12 | 未开始 |
| T36 | #42 | T13,T33,T34 | 管理员汇总页+导出状态页 | A5,A6,A10,A11 | 未开始 |
| T37 | #43 | T17–T36(除 T16 外 20 项) | 端到端验收+真实实例证据 | A1–A13 | 未开始（终验节点） |

注：T37 的 GitHub blockedBy 列出 #23–#42 共 20 项（不含 #22/T16）；T16 经 T17 传递可达。

## 校验

- 37 节点 = GitHub subIssues 37 条；无自环、无环（拓扑排序通过）、无未知依赖。
- contains（#4→37 子）与 depends_on（blockedBy）分离；关闭状态≠已交付（全部 OPEN）。
- 父 #4 为聚合验收（A1–A13），不重复实现子 Ticket 已覆盖工作；A1–A13 由上表映射节点 + T37 汇总覆盖。

## 波次（按 ready 视图推进，不按票号）

- **Wave A（并行）**：T01 独立评审；T02/T05/T06 定稿（候选→分支提交+门禁）；T03 集成（cherry-pick+门禁复跑，coordinator）；T04 移植+live 复验。
- **Wave B**：T07/T08/T09 移植+复验+移植评审；T10 移植+完整独立评审；T32 评估/完成。
- **Wave C+**：T11、T14 →（T12/T19/T34、T15/T16）→ 按 ready 视图滚动。
- **终局**：T37 真实自托管 Opik 端到端 + A1–A13 证据 + 全分支独立审阅 + OCR。

## 调度约束

- 每节点记录：Orca Run/Task/Dispatch ID、worktree、BASE/HEAD 或未提交检查点（含 SHA256）、review package 哈希、验证命令与输出、评审结论。
- 下游 `ready` 仅当上游检查点已独立评审并集成进 integration-main 且门禁复跑通过。
- 资源互斥：live Opik 栈（COMPOSE_PROJECT_NAME=opik-issue4-validation）同一时刻仅一个 worker 独占；drizzle 迁移序号同一时刻仅一个 writer；测试数据库按任务独立（openbot_test 系约定沿用）。
