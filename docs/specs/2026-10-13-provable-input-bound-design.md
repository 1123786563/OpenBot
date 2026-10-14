# Provable Input Bound for Billed Model Calls — DRAFT

> 状态:**已批准**。5 项决策已拍板(2026-10-13,全部按推荐选项),可进入实现(Superpowers)阶段。
> 决策依据 ADR:`docs/adr/0001-conservative-input-bound.md`;术语见根 `CONTEXT.md`。
> 与 `docs/superpowers/specs/2026-10-11-billing-reliability-design.md`(下称"原 Spec")冲突时以原 Spec 为准。

## Goal

让配置了 Lago 计费的部署,在 OpenAI 兼容 chat-completions 适配器(bigmodel/GLM 等)上,能够满足计费准入对"输入 token 上界"的证明要求,使被计费的模型调用可以真正发生——而不放松原 Spec 已决定的 hard-cap 不变量。

## Current shape(现状,全部有代码依据)

- 计费调用准入分两层:
  1. **信用门控**(`index.ts` `setModelUsageGate`):检查策略配置 → 预扣(`reserveCredits`,原子、幂等)→ 返回 bounds + lifecycle。
  2. **边界证明**(`copilot.ts` `meteredModel`):provider 调用前,`bounds.input.enforced` 必须是 `counted`(精确调用前计数)且计数 ≤ 配置上限;输出侧写 `max_tokens`(provider 强制)。
- `counted` 的合同注释明确拒绝估算:"a character count or a wrong tokenizer is not an admission authority"(`copilot.ts:410`)。
- chat-completions 适配器没有调用前精确计数能力(provider 无计数 API;本地 tokenizer 与 GLM 分词器不一致),`index.ts:3399` 因此硬编码 `input.enforced: "unsupported"` → **所有计费调用被拒**(`input_bound_unsupported`)。
- 结算侧已有完整兜底:实际用量超过 bound → `usage_over_bound` → 结算失败、预扣**不释放**、留人工对账(不静默扣、不静默放)。
- code-run 路径按原 Spec 维持 fail-closed,等 sandbox 合同能执行 token 预算,不在本 Spec 范围。

## 关键语义澄清(为什么"估算"与 hard-cap 不矛盾)

原 Spec 的决定原文:"reserve **estimated** usage atomically and settle **actual** cost and release unused capacity"、"Reject work before invoking the provider/sandbox if its maximum **cannot be reserved**"。

即:预扣本来就是估算;上限的强制力由三段链条共同提供:

1. 预扣时按配置上限预留容量(已实现);
2. 调用前把有效请求约束到 ≤ 上限(本 Spec 要补的一环);
3. 结算时实际用量超上限 → 拒绝结算、保留预扣、进对账(已实现)。

"exact pre-call count" 是实现层注释收紧出的要求,不是原 Spec 的要求。本 Spec 提议把准入要求从"精确计数证明"改为"**自执行上界**":provider 收到的输入,按我们的保守口径,不超过配置上限。

## Design(已批准形态)

### 保守计数器(决策 2 已决:经验校准)

- 新模块 `server/src/billing/input-bound.ts`:输入 chat-completions 请求(params:messages/tools/system),输出保守 token 计数。
- 公式:`count = ceil(serializedBytes / BYTES_PER_TOKEN_FLOOR × SAFETY_FACTOR) + PER_MESSAGE_OVERHEAD × messageCount`;校准常量内置(GLM 经验:floor 2 bytes/token、安全系数 1.25、per-message 开销 4),不新增环境键(决策 4)。
- 计数器是纯函数、确定性、可注入(测试注入假分词器验证上界性质),**不引入运行时分词器依赖**。

### 自执行上限(决策 1b/3 已决:截断)

- `bounds.input` 返回 `enforced: "counted"` + `countInputTokens`(保守计数);准入逻辑不变(计数 > 上限 → `input_over_limit` 拒绝,预扣释放)。
- 在 `meteredModel` 的请求变换处(现有 `maxOutputTokens` 写入点旁边)增加输入侧变换:若保守计数 > 配置输入上限,按截断策略(决策 3)裁剪请求后重数,直到 ≤ 上限;仍超(单条消息都放不下)→ `input_over_limit` 拒绝。
- 因此 provider 收到的请求,按保守口径必然 ≤ 上限;低估造成的实际超支由既有 `usage_over_bound` 结算路径捕获,行为不变。

### 配置形状(决策 4)

- 复用 `BILLING_MODEL_MAX_RESERVATION_TOKENS` 的 input 上限作为截断目标,不新增环境键。
- 计数器参数(bytesFloor / 安全系数 / overhead)作为该键同级的可选键或默认值内置——**待定**,倾向:内置合理缺省 + 常量,避免配置面膨胀;确有部署差异化需求时再加键。

### 观测

- 截断发生时记录 `billing-model-input-truncated`(debug 级,含裁掉的消息数)。
- 结算 `usage_over_bound` 在本设计下成为"计数器校准漂移"的信号,保留现有告警语义,不新增级别。

## Error handling and verification(继承原 Spec + 新增)

- 继承:整数账、幂等键、失败即拒(fail-closed)、超限进对账,全部不变。
- 新增测试(实现阶段 TDD):
  1. 计数器上界性质:对注入的假分词器,保守计数 ≥ 真实计数(含工具调用、系统消息、多模态占位)。
  2. 截断:超限请求被裁到 ≤ 上限;全放不下的单条消息拒绝且预扣释放。
  3. 端到端:门控→预扣→准入→provider→结算全链路在 chat 适配器上放行一次真实调用(现网已在 `lago-e2e` 部署可验)。
  4. 回归:原 `input_bound_unsupported` 行为的测试改为针对"未配置计数器的模型"路径(如未来新增适配器默认 unsupported)。

## Boundaries and dependencies

- 只动:`index.ts` 的 gate bounds 构造、`copilot.ts` 的 meteredModel 请求变换、新模块 `billing/input-bound.ts`、配置缺省值。
- 不动:预扣/结算/台账/对账、code-run fail-closed、支付链路。
- Lago 侧无变化(计量上报仍是完成后按实际 token)。

## Decisions required(决策清单)

| # | 决策 | 选项 | 推荐 |
|---|---|---|---|
| 1 | 上界证明标准 | 1a 精确计数(维持拒一切)/ 1b 保守计数+自执行截断 / 1c 保守计数仅准入 | **1b ✅ 已决** |
| 2 | 计数器标准 | 数学可证(1 token/byte,不可用)/ 经验校准+结算兜底 | **经验校准 ✅ 已决** |
| 3 | 截断策略 | 丢最旧消息 / 只拒绝不裁剪 | **丢最旧,保 system+最新 ✅ 已决** |
| 4 | 配置形状 | 复用现有键 / 新增键 | **复用,计数参数内置常量 ✅ 已决** |
| 5 | 范围 | 仅 model 路径 | **是,code-run 维持 fail-closed ✅ 已决** |
