# OpenBot 与 Bifrost 对接设计访谈

状态：设计讨论中，未批准实施。仅记录用户已确认的决定、代码事实及待解决分支。

## 已确认决定

- Q1：以 OpenBot 登录用户作为积分消费主体，每人独立余额；逻辑对应关系经 Q6/Q10 明确为 Bifrost Customer。
- Q2：外部 Bot 从 OpenBot 获取 Bifrost 地址、虚拟 Key 和模型标识，直接调用 Bifrost；预算保证经 Q5/Q10 明确为同步原子预留。
- Q3：外部 Bot 的实际使用者绑定并授权到 OpenBot 用户，消费该用户的积分。
- Q4：Key 默认允许使用已配置、已启用且管理员开放的全部模型；Bot 的模型选择按其支持的能力筛选。
- Q5：严格防止积分超支，请求前跨 Bot 共享地原子预留可强制执行的成本上限；不足则拒绝。Bifrost 原生周期预算不足以满足此保证。
- Q6：接受逻辑一一对应，不要求创建可登录 Bifrost 的用户实体。
- Q7：首次模型调用或向 Bot 授权时按需开户，幂等创建；创建前检查身份、授权和可用积分。
- Q8：按“用户 × Bot 授权”分别发放 Key，所有 Key 共享用户积分；可独立撤销及区分各 Bot 消费。
- Q9：以 Bifrost 实际美元成本按部署统一、可配置的固定比例兑换积分；保留历史结算依据。
- Q10：接受扩展 Bifrost 的设计范围；以 Customer 对应个人用户。OpenBot 是积分台账、原子预留、结算及授权的权威；Bifrost 在供应商调用前同步申请预留，失败则拒绝，结束后可靠提交消费结果。此确认不等同于授权当前访谈阶段实施生产代码。
- Q11：模型可同步展示，但只有价格完整且成本上限可强制执行的“模型 × 调用方式”才能启用。未知价格不能作为免费；能力拒绝需给出原因。
- Q12：断开、取消或结果未知时保留预留，可靠确定费用后结算或确认无费用后释放；Key 到期不取消既有结算责任，须设计恢复流程。
- Q13：默认 15 分钟 Key，有效期可配置；原授权有效时 Bot 可自动获取后续凭据。撤销授权立即禁用对应 Key。
- Q14：每次请求锁定当时兑换比例及价格依据，按用户累计细小费用尾差，避免逐次向上取整。初始兑换比例数值仍未指定，不能把存储缩放值当作兑换比例。
- Q15：第一版只允许管理员登记并认证的服务端 Bot；Bot 独立服务身份与用户授权必须同时有效。Key 只发给 Bot 服务端，不在浏览器或普通聊天消息中展示明文。
- Q16：每个 Bot 默认模型可由会话覆盖；接受推荐的选择顺序“用户全局默认 → 用户在该 Bot 的默认 → 当前会话选择”。所选模型不可用时明确报错或重新选择，第一版不自动换模型。
- Q17：每 5 分钟从 Bifrost 同步目录及价格，可管理员立即同步；失败保留最后成功快照，默认超过 15 分钟新鲜度上限后暂停受影响模型的新调用。时间可配置。既有请求按锁定依据结算；同步不自动扩大管理员开放范围。
- Q18：OpenBot 是授权及 Key 生命周期权威；Bifrost Key 删除/禁用视为不可用，归属等关键字段漂移时暂停发放/续期并告警。手工 Key 不自动接管，也不能绕过个人积分准入。
- Q19：兑换比例为启用计费的必填配置，不提供隐含默认数值；显示当前比例，变更只影响新请求。
- Q20：第一版选择全面覆盖调用能力（文本、图像、语音、Embedding、实时接口等），不采用只支持文本的首版建议。各能力仍必须满足 Q11 的完整价格与可强制成本上限；不代表当前 Bifrost 已支持全部接口或能够启用所有模型。
- Q21：内置及外部 Bot 的普通模型 API 调用统一经过 Bifrost，共享个人积分准入。订阅凭据 harness 为独立路径，明确其计费方式，不伪装成 Bifrost 积分消费。
- Q22：外部身份使用一次性绑定链接/码，用户登录 OpenBot 后确认 Bot 和外部身份，再建立绑定及模型授权；工作台使用登录身份。授权直到撤销、Bot 停用或账户停用；有效授权下自动续期 Key。
- Q23：用户明确尚未上线，允许清理旧部署计费数据，改为个人账户体系，不要求保留或迁移旧部署余额。此处记录设计上的重建策略；实际执行前须核验环境与精确数据范围，不在设计访谈中执行清理。个人积分发放、奖励及购买归属仍需具体定义。
- Q24：按准入时有效积分完成既有请求结算；未用部分释放后若已过期则不再可用，过期后新请求不能使用该 Grant。
- Q25：撤销授权、停用用户/Bot 后立即阻止新请求及新供应商尝试，并尽力取消在途请求；已产生费用仍结算，未知结果保持预留。即使 Bifrost 不可达，OpenBot 准入也拒绝失效授权，不能仅依赖 Key 禁用同步。
- 原始要求：Key 有有效期和预算；OpenBot 同步 Bifrost 模型目录、用户虚拟 Key 和模型价格，并支持模型选择。

## 已核验事实（2026-10-14，本地源码，未运行部署）

- OpenBot 当前计费接口默认读取部署 customer 的积分，并未把登录用户 ID 作为每用户余额归属传入。参考 `server/src/billing/credits.ts`、`server/src/billing/routes.ts`。
- OpenBot 积分台账是积分事实源，具有预扣与结算概念；外部 Bot 直连后不会自动经过现有 OpenBot 模型调用门控。
- Bifrost 虚拟 Key 支持有效期、启停、轮换、美元预算及请求/token 窗口限额。预算不是积分单位。参考 `bifrost/framework/configstore/tables/virtualkey.go`、`bifrost/framework/configstore/tables/budget.go`。
- Bifrost 在响应后按 usage 和模型价格计算成本，治理 tracker 异步更新使用量；不能据此认定为请求前最大成本原子预扣。参考 `bifrost/plugins/governance/main.go`。
- 进一步核验：预算准入只比较当前已用金额与上限，不加上本次预计成本，不原子预留；单实例增量累加使用 CAS，但这不构成请求前准入与预留的原子性。参考 `bifrost/plugins/governance/resolver.go:216`、`bifrost/plugins/governance/store.go:2148`。
- 治理 tracker 默认每 10 秒执行 reset/dump；跨实例使用持久化和 baseline 合并，不是全局请求级原子预留。10 秒是该 worker 的间隔，不能当作端到端预算同步保证。参考 `bifrost/plugins/governance/tracker.go:96`。
- Bifrost 原生预算要求正值 `reset_duration`，属于自动重置的周期预算，不能直接等同于一次性积分余额；调整预算上限保留已用量，清零需显式操作。参考 `bifrost/transports/bifrost-http/handlers/governance.go:560`、`bifrost/plugins/governance/store.go:374`。
- 当前 OSS 治理路由没有独立用户 CRUD；虚拟 Key 的 `AssignedUser` 属于非持久化 enterprise resolver 字段。逻辑一一对应、使用 Customer 或新增实际用户实体仍需决策。参考 `bifrost/transports/bifrost-http/handlers/governance.go:1803`、`bifrost/framework/configstore/tables/virtualkey.go:290`。
- 当前管理详情 GET 可返回 Key 明文，不能把它当作无敏感信息的目录同步；列表与关联查询有不同脱敏行为。参考 `bifrost/framework/configstore/tables/virtualkey.go:375`、`bifrost/transports/bifrost-http/handlers/governance.go:2355`。
- Bifrost Customer 支持 CRUD、多 Key 归属及主体预算；可承载个人治理主体，尚需确认映射方案。其原生共享预算仍不提供请求前原子预留。参考 `bifrost/framework/configstore/tables/customer.go:9`。
- Bifrost PreLLM 可在 provider 前 short-circuit，普通插件 error 仅记录警告，不自动阻断；fallback 按 attempt 重跑 pre/post hook。因此可探索同步预留，但必须显式拒绝、防旁路及处理重试/流式取消/失败计费。参考 `bifrost/core/schemas/plugin.go:240`。
- Bifrost 部分缺价格路径会计算为零成本，严格计费不能将未知价格当作免费。参考 `bifrost/framework/modelcatalog/datasheet/cost.go:2265`。
- 全能力核验：当前路由包含 Chat/Responses、Embedding、音频、图像、视频、Batch/Async、Realtime WebSocket/WebRTC。路由存在不代表严格计费已实现；各能力须有供应商级证据及验证。参考 `bifrost/transports/bifrost-http/handlers/inference.go:870`。
- Realtime 有每 turn/billing unit 的 pre/post hook 接入点，但未实现本次最大成本预留或余额控制的强制关停，连续音频等能力需额外边界控制。参考 `bifrost/transports/bifrost-http/handlers/livemeter.go:586`。
- Async 有任务提交与结果查询，但当前通用 Async 未发现取消路由；Batch 有取消接口。不能把本地取消或 Key 到期当作供应商停止计费的证据。参考 `bifrost/transports/bifrost-http/handlers/asyncinference.go:65`。
- OpenBot CreditWriter 已有按 customer 行锁的事务预留、幂等结算和释放，可探索复用；当前运行接线仍为部署 customer。参考 `server/src/billing/credits-writer.ts:276`。
- 现有预留过期后不再占用可用容量，但仍允许迟到结算；不能未经恢复设计就复用到严格防超支方案。参考 `server/src/billing/credits-writer.ts:691`。
- 现有输入计数是经验校准，不是 provider 真实 token 的数学上界；ADR 0001 允许低估后进入人工对账，与本次严格防超支存在适用范围冲突，须明确新路径策略。参考 `docs/specs/2026-10-13-provable-input-bound-design.md`、`docs/adr/0001-conservative-input-bound.md`。
- Bifrost 模型目录含供应商模型列表和价格数据，价格有多种维度，不能默认只有输入/输出 token 两列。
- 仓库内 `bifrost` 为子模块，与 `/Users/wuyongjun/trea/bifrost` 独立 checkout 均处于 `f10954f77efa515e593f83a860cb29b88fd95c08`。当前研究针对该版本，未验证运行中的版本与配置。
- `AGENTS.md` 引用的 `docs/agents/domain.md` 不存在；当前领域术语读取根 `CONTEXT.md`。

## 设计树与待解决分支

- 用户主体：已确认个人用户、Customer 治理主体、按需开户及旧计费数据可重建 → 个人积分发放和订单归属；删除后的结算留存。
- 调用路径：已确认直连、OpenBot 原子预留权威及 Bifrost 扩展范围 → 支持能力的上限证据；消费事件和幂等结算；同步故障/恢复及多次供应商尝试处理。
- Bot 授权：已确认登记服务端 Bot、按使用者绑定及每授权独立 Key → 绑定和撤销流程；凭据发放与轮换。
- 模型范围：已确认首版全面覆盖、统一普通模型路径、管理员开放、能力准入、同步/失效时间及模型选择顺序 → 各能力上限证据；实时/异步调用恢复；请求价格锁定的供应商适用条件。
- 积分预算：已确认共享用户余额、必填固定兑换比例与累计尾差 → 精度；个人积分发放与购买归属；积分过期对已预留额度的影响。
- Key 生命周期：已确认每授权独立、15 分钟自动续期及撤销禁用 → 轮换重叠与恢复；授权长期有效期；在途请求终止策略。

已确认架构决定见 `docs/adr/0002-per-user-bot-model-access.md` 与 `docs/adr/0003-bifrost-openbot-credit-admission.md`；完整设计仍在访谈中，尚未批准实施。
