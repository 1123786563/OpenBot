# OpenBot 模块拆解建议

日期：2026-10-23。状态：初步分析；用户已认可模块化方向，尚未启动重构。后续详细设计见[模块化架构详细设计](../specs/2026-10-23-modular-architecture-design.md)，新增合同与迁移步骤仍按该文状态处理。

目标：依据当前代码结构与 GitHub 后续规划，让业务规则集中在少量明确的 Interface 后面，提高 Module 的 Depth、修改的 Locality 和调用方的 Leverage。本文不改变现有批准合同，不恢复已作废需求，不把逻辑拆分等同于进程或数据库拆分。

本轮读取范围、版本与原始 Issue 快照见 [分析证据入口](../../.archive/runs/2026-10-23-module-decomposition/index.md)。该归档只在当前工作区可用。

## 1. 推荐方向

先在现有单仓库、现有部署形态内建立业务 Module，再选择性提取 package。现有 app/server/worker 是运行与客户端分工；它们与业务 Module 是两个维度。一个业务 Module 可以拥有服务端实现、客户端调用代码和测试，而不要求它们放进同一个目录。

建议以十二个核心 Module 描述平台职责，保留 Craft、Workshop、OpenMuse、自动化入口和 Learning 等独立扩展 Module。十二不是强制 package 数量：先规定唯一事实所有者和调用 Interface，目录迁移随后按实际收益推进。

不建议第一步把所有目录搬到 packages，不建议按 controller/service/repository 为全仓再增加一层，也不建议按技术供应商建立业务权威。小文件、短函数或 export barrel 本身不产生 Depth。

## 2. 当前结构应如何理解

| 当前位置 | 当前角色 | 拆解含义 |
| --- | --- | --- |
| app/ | Web 工作台，按 routes、lib、components 分布 | 保留路由框架；业务状态与调用逐步按 Module 聚合，路由负责页面组合。 |
| server/ | 业务规则、持久化、HTTP、执行装配 | 是本轮模块化的主战场，不需要先拆部署。 |
| worker/ | 当前入口复用 server 的 routines sweep 和 work queue | 是自动化调度宿主；不要因名字叫 worker 就放入全部后台业务。 |
| shared/ | 跨宿主 DTO、校验、协议与公共能力 | 只保留真实跨宿主合同；不能成为所有内部类型的公共出口。 |
| toolkit/ | 共享 turn、工具、锁与 CopilotKit 适配能力 | 通用合同与供应商私有协议分开；不将历史运行实现默认为新业务权威。 |
| agent-computer/、agent-sandbox/、supervisor/ | 浏览器、代码环境及动态进程宿主 | 保持必要的进程隔离，通过受控 Adapter 接入业务 Module。 |
| agent-mastra/、agent-langgraph/ 等 | 外部 Bot harness | 与 server/src/mastra 的内置执行 Adapter 分开看待。 |
| desktop/、apps/openmuse/ | 原生客户端与独立产品集成 | 复用业务权威，保留客户端协议差异；子模块内部重构需另读其规范。 |
| bifrost/ | 模型网关实现 | 保留模型接入职责，不承接 OpenBot 的余额或业务授权权威。 |

## 3. 十二个核心 Module

以下 Interface 名称是表达目标的候选用例，不是已冻结的代码合同。外部 Interface 包括输入输出、错误、幂等、事务、撤权和性能约束，不能仅以 TypeScript 方法数量判断。

| Module | 现有代码映射 | 拥有的事实与行为 | 调用方应学习的 Interface |
| --- | --- | --- | --- |
| 身份与目录 IdentityDirectory | auth/、identity/、people/ 的身份目录部分、enterprise/tenancy/ 的目录部分 | 用户、会话、公司/团队目录与成员邀请；未来 BA 目录写入权威 | 认证当前身份、发现本人资格、受控目录命令；隐藏 BA 数据表、hook 和迁移投影。 |
| 业务授权 Access | enterprise/authz/、tenancy/scope-gate.ts、revocation.ts、资源授权与共享代码 | 可信业务范围、对象动作授权、来源版本、撤权检查 | 解析可信上下文、准入指定资源动作、在敏感检查点重验；组织选择不能直接产生权限。 |
| Bot 目录 BotCatalog | agents/、team-bots/、enterprise/experts/ | Bot 身份、档案、固定专家版本和团队发布 | 创建/解析 Bot、读取固定版本、发布/撤回；不创建模型调用或执行外部工具。 |
| 会话 Conversation | channels/、enterprise/conversations/、mastra/conversations.ts、conversation-runtime.ts、消息 intent 相关实现 | 会话归属、成员与动作、消息顺序、历史和单写者协议 | 授权历史读取、幂等追加、订阅变化；隐藏 engine message 与 intent 对账。 |
| 运行 RunLifecycle | enterprise/runs/、mastra/continuation-*、approvals/ 中运行衔接部分、work/ | Run/Attempt、lease/generation、状态转换、暂停/恢复、事件与恢复定位 | 启动、停止、响应等待、读状态/事件；隐藏领取、续约、恢复 claim 和执行 Adapter 装配。 |
| 模型访问 ModelAccess | gateway/、bot-services/、enterprise/models/、runs/governed-execution.ts 的调用治理部分 | 可用模型、模型访问授权、虚拟 Key、能力与可执行上限、受控模型调用 | 查询当前可用模型、授权/撤销、发起受管调用；隐藏 Bifrost Customer、价格同步及协议差异。 |
| 账务 Billing | billing/、billing/payments/ | Payer、Reservation、Settlement、Credit Ledger、支付订单、收款事实与权益交付 | 原子预留、幂等结算、证据化释放/处置、订单及权益查询；付款与模型访问分别管理。 |
| 工具与连接 ToolAccess | plugins/、credentials.ts、passwords/、enterprise/tenancy/ 内相关租约实现 | 连接授权、工具可见性、凭据使用、动作审批与副作用记录 | 发现可用工具、准备/执行受管动作、查真实结果；隐藏 Composio/OpenConnector/MCP 差异。 |
| 执行环境 ExecutionEnvironment | computer/、sandbox/、codesandbox/、host-access/、相关远端客户端 | 范围绑定环境、会话/环境代次、受控能力租约、浏览器和代码能力 | 按可信执行事实取得受限环境句柄；隐藏 token、地址、scope headers 与缓存寻址。 |
| 个人记忆 PersonalMemory | memory/、hindsight/、openmuse-personal/memories.ts 的业务适配 | 候选、本人审核、来源、生效时间、召回、遗忘和清理证据 | 提出候选、审核、更正、授权召回、遗忘、查依据；隐藏 bank、远端文档、同步队列与降级。 |
| 观测与评测 Observability | ai-observability/、telemetry/、相关审计读取 | 脱敏观察、运行投影、案例/数据集版本、实验和导出 | 记录受控观察、按权限查询、提交隔离评测；模型 Judge 仍消费 ModelAccess/Billing。 |
| 插件包 PackageLifecycle | plugin-packages/、enterprise/plugin-packages/、marketplace/ 的包功能 | 受信包版本、安装、升级/回滚、撤回与资产保留 | 预览差异、安装固定版本、升级/回滚、停用/卸载；消费 Bot/Skill/Tool 已有合同。 |

每个 Module 对外一个有归属的 Interface，可包含数个业务用例。内部可以有多个 Seam 和 Adapter；不要为了让根目录少几个名称，把无关业务塞入一个巨型 Interface。

### 扩展 Module 保持业务完整

- Craft：生成应用、会话、工作区、产物和预览发布；预览票据/Origin/TLS 是其内部 Module，不应泄漏为每个调用方的装配责任。
- Workshop：工作场景与计划、执行入口和结果展示；消费 RunLifecycle 与环境能力，不再另建执行状态权威。
- OpenMuse：邮件、日历、文件、任务、草稿、通知等分别保留自己的业务 Module；mobile-bff 只聚合和转译，不能把所有 openmuse-* 机械合成一个大 Interface。
- Automation：routines、responsibilities、proactive、delivery 分别拥有触发条件、频率、交接和投递语义，共同向 RunLifecycle 提交工作。不能各自重新实现 turn、预算和恢复。
- Learning：继续作为独立可选 Module。学习技能与 PersonalMemory 的本人审核/遗忘合同不同，不能合并为一个通用 memory Interface。
- Voice/Dictation：保留媒体会话与转写语义，复用模型准入、预算与工具/环境资格。

## 4. 关键 Seam 与取舍

### 4.1 IdentityDirectory 与 Access 分开

Better Auth 可以管理身份和目录；当前公司/团队选择及目录管理角色不能代替对象动作授权。IdentityDirectory 产出稳定身份与当前成员事实；Access 在资源动作时结合这些事实、对象归属与授权来源作决定。

撤权相关目录修改、持久版本、业务投影、审计和 outbox 的原子合同不能因目录拆分而拆散。初期保留同库事务，由受控命令入口组合两者；不要先改为异步同步两个独立系统。长任务恢复使用原始身份和归属重新准入，不能把一次 TrustedScope 永久缓存。

### 4.2 RunLifecycle 与执行引擎分开

RunLifecycle 决定身份、范围、Run/Attempt、付款、预算、等待和终态。Mastra Adapter 只执行已经准入的一次执行，交回事件、真实工具结果和挂起事实。AG-UI 是客户端协议，不能成为业务状态权威。

现有 execution-contracts.ts 已有 ExecutionBinding、ExecutionRequest、ResumeRef 等，可先整理为内部执行 Seam；它目前携带较多引擎细节，不宜原样提升成所有调用方的公共合同。普通入口只学习启动/等待/取消/读取结果。

保留真实需要的内置 Mastra、远程 Bot 与测试 Adapter。旧引擎保留臂按既有迁移合同处理，不为“可插拔”额外保留完整旧执行系统。ADR 0010 明确不同时引入第二个 durable workflow 调度权威。

### 4.3 Conversation 独立拥有消息写入协议

当前 enterprise/conversations 直接引用 Mastra 消息、存储和转换，同时 mastra/conversation-runtime 又依赖 ConversationService。按目录直接抽 package 会带出双向依赖。

先把消息追加、intent、排序和历史一致性聚到 Conversation；Mastra 消息编解码及存储桥接作为其内部 Adapter。RunLifecycle 只消费授权历史和追加结果。使用现有完整消息能力定义合同，不能为了供应商无关退化为只有 role/content 的文本模型。

### 4.4 ModelAccess 与 Billing 不做永久大合并

现有 billing 大量引用 gateway，gateway 又引用多模态定价维度和付款类型，表明“某模型是否真正可调用”的规则分布在两侧。应把模型可用性、已验证计费维度、价格版本和可强制上限的组合判断收拢到 ModelAccess 的准入实现中；Billing 保留账户容量和资金事实。

调用方提交固定付款依据与受管调用意图，内部获得验证后的价格/上限，执行 Reservation→dispatch→Settlement；未知终态保持 Pending Settlement。不能让每个聊天、语音、实验、记忆后台任务自己拼这条链路。

支付订单与收款/权益交付并不依赖某个模型网关，因此仍由 Billing 的内部子 Module 独立维护。跨 Module 同事务准入通过已有事务上下文组合，保留账务原子性。

### 4.5 ToolAccess 与 ExecutionEnvironment 不互相替代

ToolAccess 决定某个外部动作是否可执行、是否需审批、是否已执行；ExecutionEnvironment 决定在哪里、以哪个范围和环境代次执行。能连接一个沙箱不等于有权执行任意工具。

推荐环境句柄在构造时绑定服务器解析的归属，后续方法自行携带正确协议与代次。不能继续以 botId 单独定位可变环境，也不能让调用方自行拼 tenant/workspace headers。#618 与 ADR 0006 为此提供直接依据。所有敏感动作仍要按当前合同重验，句柄不是长期离线授权。

外部副作用未知与重复审批处理由动作生命周期实现集中保证；Run 的等待与恢复通过其 Interface 协作。可在初期保留 approvals 目录，先明确“审批决定”和“运行等待”分别由谁写。

### 4.6 PackageLifecycle 不执行任意插件

包负责描述和版本化装配；运行仍经 BotCatalog、ToolAccess、Learning 与 RunLifecycle。目录中的包可见，不等于已安装、已授权或可运行。升级不能改写在途运行已绑定版本。供应商 SDK 与任意代码加载不进入包的公共 Interface。

### 4.7 PersonalMemory 不等于索引供应商

OpenBot 是审核与权限事实源，Hindsight 是内部索引/推理 Adapter。先收拢 memory、hindsight 及 OpenMuse 记忆读取路径的业务规则；只把 provider 细节藏起来，不能合并不同来源或将本人确认当成范围扩大。Learning 继续保持独立语义。

### 4.8 Observability 是观察者，评测是受控调用者

纯追踪关闭时不能阻断普通业务；安全审计失败是否拒绝动作遵守其自己的强制合同，不能一起降为 best effort。评测会产生真实模型成本，必须作为普通受控调用者走同一准入链路，不能通过 Opik SDK 另走免费或无授权路径。

## 5. 后续 Issue 对模块设计的影响

| 规划来源 | 对拆解的直接要求 | 状态解释 |
| --- | --- | --- |
| [BA #503](https://github.com/1123786563/OpenBot/issues/503)，[G0 #504](https://github.com/1123786563/OpenBot/issues/504) | 优先明确 IdentityDirectory/Access，三端共享可信选择，恢复不能复活旧能力。#580/#581 对 Run 固定范围与 payer；#595 对 OpenMuse BFF 协议；#613 对实际入口覆盖。 | 候选，G0 未完成；115 项是根正文给出的规划规模，不是 115 项已授权实施。 |
| [Bifrost #5](https://github.com/1123786563/OpenBot/issues/5) | ModelAccess 与 Billing 各有权威，通过单一受管调用路径组合；多模态、异步和个人 Key 不能旁路。 | 已批准设计；仍有开放验收/恢复票。旧 ADR 0004 引用已被作废决定取代，不能借此重启旧整改。 |
| [Hindsight #376](https://github.com/1123786563/OpenBot/issues/376) | PersonalMemory 封装审核、召回、同步、降级和遗忘；#395/#396 涉旧路径退出与跨入口验收。 | 开放规划；旧多租户前置引用需要重核，不能自动转成 BA 的批准验收。 |
| [插件包 #459](https://github.com/1123786563/OpenBot/issues/459) | PackageLifecycle 聚合版本/安装；#464 工具执行、#468 恢复、#469 未知外部效果消费已有运行权威。 | 方案与建单，未授权本轮实施；含 archive 仓库依赖，执行前需另核。 |
| [Craft #358](https://github.com/1123786563/OpenBot/issues/358)，[#618](https://github.com/1123786563/OpenBot/issues/618)，[#619](https://github.com/1123786563/OpenBot/issues/619) | 环境归属封装到 ExecutionEnvironment；预览 Origin/票据/TLS 封装到 Craft 内部预览 Module；端口配置需要单一来源。 | 开放缺陷/验收，不可因已有目录而认定已完成。 |
| [Opik #4](https://github.com/1123786563/OpenBot/issues/4) | 观测投影与业务权限分开；评测复用受管调用；可选部署保持隔离。 | 开放规划；纯观测与有成本评测的失败策略分开。 |
| [上游吸收 #489](https://github.com/1123786563/OpenBot/issues/489) | research provider、连接引导、Computer 体验落入原 Module 的 Adapter；不新增第二套记忆/执行权威。 | 详细设计采用、已建单；根正文未声称代码实施。 |
| [Mastra #472](https://github.com/1123786563/OpenBot/issues/472) 与 ADR 0010 | 将现有迁移结果作为整理起点，保持 OpenBot 治理与会话单写者。 | 已关闭且当前有对应实现；关闭说明仍披露真浏览器/真实供应商等证据缺口及最终 OCR 端点问题，本文不重新认证其完成度。 |

旧 Issue #6 及其子树已作废，不纳入后续重构队列。ADR 0011 接受 Better Auth 方向；不能反向恢复 ADR 0004。ADR 0007 Personal Space 仍为 proposed：设计可预留未来独立范围的扩展位置，但本轮不能直接改成可空 tenant 或把个人模式宣称已实现。

## 6. 依赖与目录组织

推荐调用关系：客户端与触发 Module → Access 准入后的业务用例 → RunLifecycle → 执行 Adapter；执行过程分别消费 Conversation、ModelAccess、ToolAccess、PersonalMemory。ModelAccess 使用 Billing，ToolAccess 使用 ExecutionEnvironment。PackageLifecycle 装配固定 Bot/Skill/Tool 版本，不接管运行。所有观察通过 Observability 的受控 Interface 投影。

这描述责任流，不是可直接作为 import DAG 的图；例如 Access 的实时撤权协作与 IdentityDirectory 的同事务修改，需要在设计中显式组合。业务拥有者不能为躲避循环而复制状态权威。

建议渐进增加 server/src/assembly/ 保存配置装配、工厂组合、启动与关闭，将 index.ts 缩减为入口。每个现有业务目录逐步提供 public.ts，跨 Module 只从声明的公开出口读取；public.ts 不做全量 re-export。允许 HTTP Adapter 在装配层依赖多个 Module，但业务实现不能任意深层引用对方 store。

现有 db/schema、Drizzle 迁移暂留原位，先写清表的唯一写入者与允许的跨表事务。import schema 不自动等于违规；重点检查是否绕过了另一 Module 的不变量。共同数据库并不要求共同业务写权限。

shared 按真实跨端合同归属组织，如 conversation/run/model-access 的 wire DTO；可信 Scope、租约签发与秘密引用保留服务端。toolkit 中与 CopilotKit 私有方法和旧 Intelligence 协议绑定的实现继续留在明确 Adapter 内，逐调用点确认用途后再决定提取或退役。

前端先在 app/src/lib 的现有领域目录内聚合 query keys、mutation、DTO 转换和功能状态。公司/团队选择、缓存代次及长流终止由一个共享协调 Module 负责；路由消费这些 Interface。避免一次搬空 routes/components，并避免每个客户端重写一份授权真相。

## 7. 调整顺序与验证目标

| 阶段 | 具体调整 | 放行标准 |
| --- | --- | --- |
| 0：确认所有者 | 固定版本，列业务入口/表写入者/跨目录消费者，区分已批准与候选需求。 | 每条关键事实有唯一所有者；未决冲突与外部前置具名。 |
| 1：整理装配 | 先迁移 index/app/copilot 中的工厂组合和路由装配到有明确依赖的 assembly 文件，保留原行为。 | 启用/关闭矩阵、启动失败、路由鉴权次序和 shutdown 行为保持；入口没有新增业务规则。 |
| 2：收拢主干 | 逐条整理 IdentityDirectory/Access、Conversation/RunLifecycle、ModelAccess/Billing。BA 新合同须等 G0 与 Spec 获批。 | 通过公开 Interface 验证撤权、重复请求、未知费用、消息单写者和恢复；不产生第二个权威。 |
| 3：深化环境与工具 | 从 #618 代表的单条 Craft→sandbox 链路开始，绑定可信环境句柄；其余入口逐项迁移。 | 同 Bot 不同范围隔离、缺 scope 拒绝、file/serve/event/snapshot 全链路一致；外部结果未知不自动重放。 |
| 4：收拢扩展 | PersonalMemory、PackageLifecycle、Observability 逐条接入稳定主干；保留业务扩展的独立职责。 | 新增 Hindsight/Opik/provider Adapter 不修改所有入口；版本、停用、遗忘和评测计费行为可验证。 |
| 5：选择性提 package | 仅对已有多个真实宿主消费者、可独立验证且依赖单向的 Module 提取 package。 | import 图无环；没有为让 package 编译而扩大公共 Interface；迁移所有真实消费者。 |

独立包候选首先考虑稳定跨宿主合同和实际复用能力；不要在阶段 0 就承诺把每个核心 Module 都变成 workspace package。保留同库事务，除非有单独批准的部署/数据迁移需求。

对每个深 Module，从其 Interface 验证业务结果。内部数据库使用项目认可的真实或本地替代环境；远端自有环境以生产传输 Adapter 和测试 Adapter 验证；第三方使用内部注入的 Adapter，并补所需真实集成证据。已有同版本有效测试先复用；新 Interface 覆盖旧行为后，才删除过度依赖内部结构的测试，不双层堆叠相同断言。

本轮只提出设计与验收目标，没有执行代码重构、测试、独立实现 Review 或 OCR，不据此宣称系统运行正确或所有 Issue 已验证。
