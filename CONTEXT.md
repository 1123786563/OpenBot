# OpenBot

OpenBot 是一个可自托管的 Bot 工作台部署:内置 Bot 通过 OpenAI 兼容网关调用模型,部署可选装配 Lago 计费(套餐、积分、订单)。本文件是领域术语表,只记词汇,不记实现。

## Language

### 计费与积分

**Grant(发放)**:
一笔存入积分台账的可用额度,带来源(plan/promo/signin)、总量与过期时间。
_Avoid_: 充值(口语,来源不明)、credit pack

**Reservation(预扣)**:
一次被计费调用在发生前原子预留的容量上限;结算时按实际用量冲销,拒绝/取消时释放。
_Avoid_: hold(指预扣在台账上的可见形态时可用"hold",不要与 Reservation 混为一谈地泛指)

**Credit Ledger(积分台账)**:
积分变动的唯一权威记录;金额以 ×100 缩放整数(CREDIT_SCALE=100)存储。
_Avoid_: 账单、流水

**Settlement(结算)**:
一次调用结束后按 provider 报告的实际 token 用量对预扣冲销的确定性动作;失败不静默。
_Avoid_: 扣费(口语)

**Reconciliation(对账)**:
对支付、订单、发放、台账多方的只读一致性核查,发现漂移供人工处置;不做自动修复。
_Avoid_: 审计(audit 指操作留痕,不是一致性核查)

### 计费准入

**Credit Gate(信用门控)**:
调用前检查部署积分余额与策略并创建预扣的第一道准入;拒绝时对人说的话是"no credits left"。
_Avoid_: 限流、配额检查

**Admission(准入)**:
在 provider 被调用之前证明"本次请求的输入/输出上界可被强制"的第二道检查;门控放行 ≠ 准入放行。
_Avoid_: 预检(precheck)

**Provider Bounds(边界证明)**:
准入所要求的证明材料:输入侧如何计数并约束、输出侧如何由 provider 强制封顶。
_Avoid_: 限制列表、quota

**Conservative Count(保守计数)**:
对有效请求 token 数的确定性上界估计(按序列化字节与经验校准参数计算);允许高估,由结算兜底低估。
_Avoid_: 精确计数(除非确有精确来源)、估算(不表态方向)

**Self-enforced Bound(自执行上界)**:
由我方(而非 provider)在发送前把请求约束到配置上限内的强制方式,当前实现为消息截断。
_Avoid_: provider cap(专指输出侧 provider 强制的 max_tokens)

**Truncation(截断)**:
自执行上界的实现动作:丢弃最旧的非系统消息直到保守计数 ≤ 配置输入上限;保 system 与最新一条。
_Avoid_: 压缩(compression,未来若做摘要需另立术语)
