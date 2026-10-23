<!-- openbot-modular-architecture:2026-10-23:MOD25:v1 -->
# MOD25：收窄旧深层出口并完成目标范围架构验收

根架构 Issue：https://github.com/1123786563/OpenBot/issues/620。阶段：收尾：累计验收。本票覆盖：AR01–AR18；S8；已验证前置必须实际集成。

## 目标与范围

对前述渐进交付累积对账，收窄已迁移范围的旧出口和存量例外，完成 AR01–AR18 全范围证据映射；不强制提取 package。

本票不新增业务功能、不替代已存在的功能 Issue；优先封装当前已启用行为。接口内部调整保持现有对外合同。

## 依赖与开工条件

- 内部 blocked-by：[MOD01 #621](https://github.com/1123786563/OpenBot/issues/621)、[MOD02 #622](https://github.com/1123786563/OpenBot/issues/622)、[MOD03 #623](https://github.com/1123786563/OpenBot/issues/623)、[MOD04 #624](https://github.com/1123786563/OpenBot/issues/624)、[MOD05 #625](https://github.com/1123786563/OpenBot/issues/625)、[MOD06 #626](https://github.com/1123786563/OpenBot/issues/626)、[MOD07 #627](https://github.com/1123786563/OpenBot/issues/627)、[MOD08 #628](https://github.com/1123786563/OpenBot/issues/628)、[MOD09 #629](https://github.com/1123786563/OpenBot/issues/629)、[MOD10 #630](https://github.com/1123786563/OpenBot/issues/630)、[MOD11 #631](https://github.com/1123786563/OpenBot/issues/631)、[MOD12 #632](https://github.com/1123786563/OpenBot/issues/632)、[MOD13 #633](https://github.com/1123786563/OpenBot/issues/633)、[MOD14 #634](https://github.com/1123786563/OpenBot/issues/634)、[MOD15 #635](https://github.com/1123786563/OpenBot/issues/635)、[MOD16 #636](https://github.com/1123786563/OpenBot/issues/636)、[MOD17 #637](https://github.com/1123786563/OpenBot/issues/637)、[MOD18 #638](https://github.com/1123786563/OpenBot/issues/638)、[MOD19 #639](https://github.com/1123786563/OpenBot/issues/639)、[MOD20 #640](https://github.com/1123786563/OpenBot/issues/640)、[MOD21 #641](https://github.com/1123786563/OpenBot/issues/641)、[MOD22 #642](https://github.com/1123786563/OpenBot/issues/642)、[MOD23 #643](https://github.com/1123786563/OpenBot/issues/643)、[MOD24 #644](https://github.com/1123786563/OpenBot/issues/644)。发布后以下引用与 GitHub 原生 blocked_by 对齐。
- 外部 blocked-by：无新增硬依赖；相关功能票需在实施前核对，不能自动扩大范围。
- 根 Issue 的 contains 仅表示聚合，不代替执行依赖。若原功能缺陷影响本票验收，先回原功能票处理并补有证据的依赖，不静默并入本票。

## 单任务阅读集

根 Issue 的架构快照、Global Constraints，以及本票目标/直接前置产出的 Interface。仓库文件为 `docs/specs/2026-10-23-modular-architecture-design.md` 和 `docs/plans/modular-architecture/`；只读所属模块、直接依赖、对应 C 合同/链路/AR，不加载全仓历史。

当前上述文档尚未提交到远端，根 Issue 已嵌入完整快照及 SHA-256，可在纯远程环境阅读。实施恢复时核对当前仓库，不把本地路径当作已发布 Git 文件。

## 文件与角色范围

- `目标范围各 Module public/integration 出口与旧 Adapter`
- `tests/config/module-imports.json`
- `scripts/check-module-imports.ts`
- `docs/specs/2026-10-23-modular-architecture-design.md 与分册`
- `当前实际 consumer 与架构覆盖测试`

上述是工作包范围与预定落点，不是对整个目录的无限写权限；派发前按具体函数/route 冻结单 Task owned_files。超出范围先说明受影响合同与原因。

角色：按实际 Task：backend_implementer / frontend_implementer；对应独立 validator；独立 reviewer 做 Spec + 质量审查。跨端仅在不能沿稳定 Interface 拆分时使用 implementer。

## Consumes / Produces

- Consumes：直接依赖票的已验证并集成 Interface、当前公开 wire、对应原功能合同与现有数据事实；不能引用另一票的私有 store。
- Produces：无新增循环/深层绕过的依赖图、唯一写入者/消费者清单、具名保留臂与完整验证/Review/OCR。
- 全部 Interface 必须定义输入/结果、当前资格、幂等键、版本、事务/锁与超时/未知结果行为；供应商类型与秘密保留内部。

## 验收标准

- [ ] AR01–AR18 均有当前代码/检查点证据，实际启用客户端与触发入口无遗漏
- [ ] 未迁移/不适用/真实环境阻塞逐项区分，阻塞验收不伪装已完成
- [ ] 只删无消费者旧路径，数据库事实/账务/秘密与用户资产保留
- [ ] 最终 Review/OCR 覆盖全部交付范围，报告覆盖不完整不能放行
- [ ] 提取 package 仅记录真实复用条件与另票建议，不因目录数强制拆包

## 验证与失败处理

依赖/写入/消费者静态对账，适用类型/Lint/构建、业务与真实端验收，独立 Review 与全范围 OCR。

优先复用匹配当前代码的有效证据，再补缺失的 Interface 行为/真实集成验证。回退保持单一写入者与稳定持久事实；未知副作用或费用不能为回退而删除/释放。不能验证的场景明确报告阻塞；完成前修复真实有效 critical/high/medium finding。

## 全局约束与交付要求

- 本票是渐进架构改造 backlog。本轮授权是设计与 GitHub 建单；实际代码实施需后续明确选择本票并核验批准依据，不授权提交/推送/合并/生产迁移/发布。
- 保持现有产品行为、稳定 ID、原 Payer、公开 wire、同连接事务与撤权/审计合同；目标 Interface 是设计，不代表已存在。不得为重构实施候选 BA/Personal Space、恢复旧 #6/ADR 0004 或恢复 KB。
- 先核对当前 Git、实际消费者、相关原功能票和同版本测试证据。原功能未完成或缺环境时具名记录，不能凭空新增功能或把未知当通过；必要时据证据缩小拆分本票。
- 执行前按 writing-plans 冻结本票精确文件/函数/签名/测试；范围内沿 SDD、专业实现/验证、独立 reviewer、OCR 执行。只读验证者不改业务代码。前置须 verified 且已集成，不以关闭/ready 标签替代证据。
- 你不是工作区唯一协作者；保留其他人的修改。共享 app/index/copilot、schema 入口和测试配置串行接管。未授权提交时用完整未提交检查点，证据归 `.archive/runs/<run-key>/`。
- 先读 AGENTS.md 及触发规范、架构规则与根 CONTEXT；子模块改动先读其 AGENTS/CONTEXT。验证遵守 ADR 0008：根 e2e 统一调度，Bun/外部套件按实际 manifest 分类，不以零用例/跳过/仅退出码 0 证明通过。
- 完成报告包括实际消费者/写入所有者、接口改动、验收证据、保留臂与回退；目录存在或 export 能编译不单独算完成。

根 Issue：https://github.com/1123786563/OpenBot/issues/620。本票：https://github.com/1123786563/OpenBot/issues/645。
