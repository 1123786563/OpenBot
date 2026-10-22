# 实施准备度与下一步入口

状态：**待用户审阅**。细化已交付，未实施生产代码。唯一活跃规格为本目录 implementation-spec.md + theme-contract.json；任务为 task-dag.md/tasks.json；逐页验收为 route-acceptance.json。无需重新发现风格或重新迁移HeroUI组件底座。

第二轮补充以 [implementation-detail.md](./implementation-detail.md) 为准；可复制交接正文见 [code-agent-prompt.md](./code-agent-prompt.md)。原稿“无歧义”只表示产品目标确定，DetailPanel生命周期方案仍需执行前技术验证，不能据此冒称已证明可行。

## 产品目标已确定的范围

- T01主题值与全部39个现有ob Token覆盖、完整HeroUI原生变量所有权、legacy别名、accent/muted语义。
- T02 wrapper视觉修改落点、variant/size、ref/事件/form/anchor与portal语义保持。
- T03 280/256/64骨架、672/1024/720列、DetailPanel主区480与400/480右栏、自动响应式不污染持久化偏好。
- T04–T07 Bots/详情/配置/可观测链/聊天的既有数据边界与顺序；不造全局搜索、审批中心、统计或统一任务API。
- 后续T09 Craft的C1124/900与viewport切换、稳定实例/草稿/iframe；T10–T20设置/账务/知识库/后台/独立流程的布局及逐页验收。

这些节点均为pending。无歧义不等于已批准/可越权执行；当前范围仅文档。浏览器fixture缺口不妨碍规格审阅和静态实施准备，妨碍对应生产场景签收。

## 最少需要用户决定的事项

| 决定 | 本稿建议 | 影响 |
| --- | --- | --- |
| D01 审阅新主题/布局与实施范围 | 批准本稿后先授权B1 T01–T08（23页+共享主题骨架），其余仍待分批授权 | 当前唯一实施范围门槛；不是要求重新选风格 |
| D02 真实验收数据环境 | 提供已有安全测试部署/身份和入口，或明确允许隔离测试部署准备fixture；不在真实公司操作付款/授权/清理/外发来验收 | T05–T08的正向/拒绝/流式场景及后续预览/知识库签收 |
| I-01 Bot观测入口组 | 默认排除；若要做，另定入口位置及canManage可见规则 | 不阻塞基础B1；未包含在T04/06 |
| I-02 后台enterprise/observability归组 | 默认保留直达/既有导航，另定目标用户/入口/门禁 | 不阻塞本稿；不把“缺入口”当换肤附带修复 |

I-03 已收敛：不合并全局与Craft会话。普通CSS选择已在Spec决定，不再向用户逐项追问。D01可直接在实施指令中完成；D02若现成fixture可由执行Agent安全读取获得，无需再请求凭据。不存在需要改变公司/个人账户归属的开放决定；如未来发现Spec与服务合同冲突，停相关Task、记录证据，不能自行重新解释领域。

## 推荐下一条启动指令

> 我已审阅并批准 `docs/design/2026-10-20-workspace-redesign/handoff/refinement/implementation-spec.md`、`theme-contract.json` 及其B1计划，授权实施 T01–T08；使用当前worktree，保留全部既有未提交迁移。先重新核验基线，把计划正式移入 `docs/plans/2026-10-20-workspace-redesign-b1.md`，并在原目录留归档指针，避免双事实源。按仓库SDD角色与只读验证/独立Review/OCR流程串行执行；使用未提交检查点，不commit/push/merge/deploy、不安装产品依赖。只读使用可用测试部署与已有fixture，缺少安全身份/运行时则记录精确阻塞，不触碰真实业务数据。B2及后续未授权。

如果需要执行者准备隔离测试数据，请在上述指令追加测试部署范围和允许的fixture动作；不需要把账号密码贴在聊天中。当前“不再派发子Agent”约束适用于本轮细化；未来这条SDD启动指令才显式授权未来派发，不把文档中的建议当作本轮权限。

## 首批执行 Brief（短版，未来派发前补实际检查点）

- 工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`；branch `feat/heroui-v3-migration`；本轮核验HEAD `203d0f0244b2f898218fa12027089c631e8448d9`。
- 根事实源：用户批准本目录Spec的启动消息；CONTEXT.md；原HeroUI迁移合同；本目录baseline/route-rescan/route-acceptance；ADR0008。没有新Issue，不创建对外Issue。
- 执行路径：T01→T02→T03→T04→T05→T06→T07→T08。每次只派一个完整Brief，角色 frontend_implementer；验证frontend_validator；独立reviewer判Spec/quality。当前规划Agent未实施，也不冒充实现角色。
- 写权限：仅当前Task tasks.json owned_files与未来明确指定报告/行为测试文件；同一时刻每文件唯一owner。按 implementation-detail §5 可在检查点与写入停止后登记串行转移；公共接口缺陷另建修复Task，不同时写。
- Consumes：PRE检查点哈希、已审查的上游POST、各Task接口、固定Token。Produces：实际增量package、POST、验证索引、独立review结果；无本地提交。
- 验收：P01–23，主题/portal/44px/焦点/长内容/四视口/双主题双语，Bot权限与运行链、聊天IME/附件/流式/URL/电脑控制。布局阈值属于行为变化；B1-A–I详见verification-plan。
- 审查范围：任务前后真实增量；T08另审B1完整交付与workspace OCR，旧脏基线独立归因；不能用空BASE..HEAD审查。必要修复使用新编号修复计划，不重派H01–H15。
- 失败：环境缺项与产品失败区分；验证者只读，不能删测试或修到通过；有效中高finding修复/复审后才能verified。共享样式对未实施页面做回归冒烟，不宣告它们已完成。
- 收尾：更新持久Ledger、证据与低风险延期；不提交/推送/合并/发布；未经新范围授权不继续B2。

## 本轮停止点

只交付可审阅文档与静态证据。尚未运行生产测试、类型检查、构建、实际产品浏览器、独立代码Review或OCR；不将文档结构检查冒称实现验收。后续正式计划落位、测试环境确认和生产写入均留待明确启动范围。
