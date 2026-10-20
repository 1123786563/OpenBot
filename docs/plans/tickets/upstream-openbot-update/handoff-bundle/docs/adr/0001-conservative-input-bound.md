# 保守计数 + 自执行截断取代"精确计数"作为计费输入上界

OpenAI 兼容 chat-completions 适配器(GLM 等)没有调用前精确计数能力:provider 不提供计数 API,本地分词器与真实 tokenizer 不一致。已批准的 hard-cap 语义(原 Spec)本就允许"预扣估算用量、结算按实际冲销",因此我们把输入上界的准入标准从"精确计数证明"改为**保守计数 + 自执行截断**:发送前把请求截断到保守口径的配置上限内,provider 收到的输入按我方口径必然不超上限;计数器经验校准(字节下限 × 安全系数,内置常量,不加环境键)低估造成的超支由既有 `usage_over_bound` 结算失败路径捕获并留人工对账。拒绝的替代方案:精确计数(bigmodel 无 API,永远拒一切调用)、数学可证上界(1 token/byte,松到不可用)、仅估算不截断(无强制力)。code-run 路径维持原 Spec 的 fail-closed,等 sandbox 能强制 token 预算。

依据 Spec:docs/specs/2026-10-13-provable-input-bound-design.md(决策 1b/2/3/4/5)。
