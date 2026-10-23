<!-- openbot-modular-architecture:2026-10-23:MOD09:v1 -->
# MOD09：收拢受管模型调用与双重预算结算链路

根架构 Issue：https://github.com/1123786563/OpenBot/issues/620。阶段：第三批：执行。本票覆盖：AR09/AR10；#5 多模态/异步功能继续由原票承接。

## 目标与范围

一次模型调用经 Run token 协作者与 Billing 资金预留后才 dispatch；集中价格/上限依据、真实用量处理和未知费用恢复，减少入口自拼规则。

本票不新增业务功能、不替代已存在的功能 Issue；优先封装当前已启用行为。接口内部调整保持现有对外合同。

## 依赖与开工条件

- 内部 blocked-by：[MOD07 #627](https://github.com/1123786563/OpenBot/issues/627)、[MOD08 #628](https://github.com/1123786563/OpenBot/issues/628)。发布后以下引用与 GitHub 原生 blocked_by 对齐。
- 外部 blocked-by：无新增硬依赖；相关功能票需在实施前核对，不能自动扩大范围。
- 根 Issue 的 contains 仅表示聚合，不代替执行依赖。若原功能缺陷影响本票验收，先回原功能票处理并补有证据的依赖，不静默并入本票。

## 单任务阅读集

根 Issue 的架构快照、Global Constraints，以及本票目标/直接前置产出的 Interface。仓库文件为 `docs/specs/2026-10-23-modular-architecture-design.md` 和 `docs/plans/modular-architecture/`；只读所属模块、直接依赖、对应 C 合同/链路/AR，不加载全仓历史。

当前上述文档尚未提交到远端，根 Issue 已嵌入完整快照及 SHA-256，可在纯远程环境阅读。实施恢复时核对当前仓库，不把本地路径当作已发布 Git 文件。

## 文件与角色范围

- `server/src/enterprise/models/`
- `server/src/enterprise/runs/governed-execution.ts`
- `server/src/gateway/ 的 dispatch Adapter`
- `server/src/billing/credit-reserve.ts 及现有结算入口`
- `server/src/assembly/ 的具名预算组合`
- `现有 governed-execution/reserve/settle 测试`

上述是工作包范围与预定落点，不是对整个目录的无限写权限；派发前按具体函数/route 冻结单 Task owned_files。超出范围先说明受影响合同与原因。

角色：按实际 Task：backend_implementer / frontend_implementer；对应独立 validator；独立 reviewer 做 Spec + 质量审查。跨端仅在不能沿稳定 Interface 拆分时使用 implementer。

## Consumes / Produces

- Consumes：直接依赖票的已验证并集成 Interface、当前公开 wire、对应原功能合同与现有数据事实；不能引用另一票的私有 store。
- Produces：ModelAccess 受管 invoke 与内部 InvocationBudget 合同；Run/Billing 各写自己的事实；保持单连接/远端协议原子要求。
- 全部 Interface 必须定义输入/结果、当前资格、幂等键、版本、事务/锁与超时/未知结果行为；供应商类型与秘密保留内部。

## 验收标准

- [ ] token 与资金均放行后才调用 provider，第二阶段失败不误 dispatch
- [ ] ModelAccess 不 import Run store，以装配注入预算协作者
- [ ] 固定原 Payer/价格版本，取消或断流不释放未知费用
- [ ] reserve/settle/ack 重放不重扣，原恢复协议继续可用
- [ ] token 确认不冒充资金结算，不把网络调用放进长数据库事务

## 验证与失败处理

并发耗尽、dispatch 前/后超时、重复用量/ack、取消、未知终态；真实协议证据按既有能力复用。

优先复用匹配当前代码的有效证据，再补缺失的 Interface 行为/真实集成验证。回退保持单一写入者与稳定持久事实；未知副作用或费用不能为回退而删除/释放。不能验证的场景明确报告阻塞；完成前修复真实有效 critical/high/medium finding。

## 全局约束与交付要求

- 本票是渐进架构改造 backlog。本轮授权是设计与 GitHub 建单；实际代码实施需后续明确选择本票并核验批准依据，不授权提交/推送/合并/生产迁移/发布。
- 保持现有产品行为、稳定 ID、原 Payer、公开 wire、同连接事务与撤权/审计合同；目标 Interface 是设计，不代表已存在。不得为重构实施候选 BA/Personal Space、恢复旧 #6/ADR 0004 或恢复 KB。
- 先核对当前 Git、实际消费者、相关原功能票和同版本测试证据。原功能未完成或缺环境时具名记录，不能凭空新增功能或把未知当通过；必要时据证据缩小拆分本票。
- 执行前按 writing-plans 冻结本票精确文件/函数/签名/测试；范围内沿 SDD、专业实现/验证、独立 reviewer、OCR 执行。只读验证者不改业务代码。前置须 verified 且已集成，不以关闭/ready 标签替代证据。
- 你不是工作区唯一协作者；保留其他人的修改。共享 app/index/copilot、schema 入口和测试配置串行接管。未授权提交时用完整未提交检查点，证据归 `.archive/runs/<run-key>/`。
- 先读 AGENTS.md 及触发规范、架构规则与根 CONTEXT；子模块改动先读其 AGENTS/CONTEXT。验证遵守 ADR 0008：根 e2e 统一调度，Bun/外部套件按实际 manifest 分类，不以零用例/跳过/仅退出码 0 证明通过。
- 完成报告包括实际消费者/写入所有者、接口改动、验收证据、保留臂与回退；目录存在或 export 能编译不单独算完成。

根 Issue：https://github.com/1123786563/OpenBot/issues/620。本票：https://github.com/1123786563/OpenBot/issues/629。
