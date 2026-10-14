# OpenBot 与 Bifrost 对接设计访谈

状态：设计讨论中，未批准实施。仅记录用户已确认的决定、代码事实及待解决分支。

## 已确认决定

- Q1：以 OpenBot 登录用户作为积分消费主体，每人独立余额；目标关系为一个 OpenBot 用户对应一个 Bifrost 用户。Bifrost 侧用户实体的落地能力仍待核验。
- Q2：外部 Bot 从 OpenBot 获取 Bifrost 地址、虚拟 Key 和模型标识，直接调用 Bifrost。必须继续评估 Bifrost 执行积分预算的及时性与可靠性，尚未确认超额风险容忍度。
- Q3：外部 Bot 的实际使用者绑定并授权到 OpenBot 用户，消费该用户的积分。
- Q4：Key 默认允许使用已配置、已启用且管理员开放的全部模型；Bot 的模型选择按其支持的能力筛选。
- Q5：严格防止积分超支，请求前跨 Bot 共享地原子预留可强制执行的成本上限；不足则拒绝。Bifrost 原生周期预算不足以满足此保证，具体扩展范围和机制待确定。
- Q6：接受逻辑一一对应，不要求创建可登录 Bifrost 的用户实体；治理主体使用哪种对象待核验。
- Q7：首次模型调用或向 Bot 授权时按需开户，幂等创建；创建前检查身份、授权和可用积分。
- Q8：按“用户 × Bot 授权”分别发放 Key，所有 Key 共享用户积分；可独立撤销及区分各 Bot 消费。
- Q9：以 Bifrost 实际美元成本按部署统一、可配置的固定比例兑换积分；保留历史结算依据。比例数值、精度及舍入策略待确定。
- 原始要求：Key 有有效期和预算；OpenBot 同步 Bifrost 模型目录、用户虚拟 Key 和模型价格，并支持模型选择。开户时机待讨论。

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
- OpenBot CreditWriter 已有按 customer 行锁的事务预留、幂等结算和释放，可探索复用；当前运行接线仍为部署 customer。参考 `server/src/billing/credits-writer.ts:276`。
- 现有预留过期后不再占用可用容量，但仍允许迟到结算；不能未经恢复设计就复用到严格防超支方案。参考 `server/src/billing/credits-writer.ts:691`。
- 现有输入计数是经验校准，不是 provider 真实 token 的数学上界；ADR 0001 允许低估后进入人工对账，与本次严格防超支存在适用范围冲突，须明确新路径策略。参考 `docs/specs/2026-10-13-provable-input-bound-design.md`、`docs/adr/0001-conservative-input-bound.md`。
- Bifrost 模型目录含供应商模型列表和价格数据，价格有多种维度，不能默认只有输入/输出 token 两列。
- 仓库内 `bifrost` 为子模块，与 `/Users/wuyongjun/trea/bifrost` 独立 checkout 均处于 `f10954f77efa515e593f83a860cb29b88fd95c08`。当前研究针对该版本，未验证运行中的版本与配置。
- `AGENTS.md` 引用的 `docs/agents/domain.md` 不存在；当前领域术语读取根 `CONTEXT.md`。

## 设计树与待解决分支

- 用户主体：已确认个人用户、逻辑治理主体与按需开户 → 治理对象映射；停用/删除行为；存量部署积分迁移。
- 调用路径：已确认直连与严格原子预留 → Bifrost 扩展范围和预留权威；可计费能力与可强制成本上限；消费事件和幂等结算；同步失败处理。
- Bot 授权：已确认按使用者绑定及每授权独立 Key → 绑定和撤销流程；可信 Bot 范围；凭据发放与轮换。
- 模型范围：已确认管理员开放且按能力筛选 → 目录/价格同步与失效；未知价格处理；模型选择归属和默认值。
- 积分预算：已确认共享用户余额与固定美元兑换比例 → 比例数值/精度/舍入；发放/充值/过期对预算影响；预留和结算权威；预算周期。
- Key 生命周期 → 数量；有效期；续期；轮换；在途请求与撤销。

已确认的身份、凭据粒度及调用路径见 `docs/adr/0002-per-user-bot-model-access.md`；预算执行机制仍未批准。
