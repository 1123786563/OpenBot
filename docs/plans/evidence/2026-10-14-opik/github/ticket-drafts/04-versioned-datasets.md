## Parent

https://github.com/1123786563/OpenBot/issues/4

## What to build

创建者从可用脱敏运行或审查后的合成案例建立评测集，在页面检查输入、参考结果与工具 fixture 后保存并查看冻结版本。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 候选来自有权访问的安全运行；只有指标的记录不能被自动伪造为文本样本，需提供审查后的合成或脱敏案例。
- [ ] 页面及接口支持案例审查和保存，说明脱敏语义限制，拒绝原始附件和任意生产工具。
- [ ] 版本冻结安全输入、参考、fixture、hash、策略版本、来源与上游定位；候选及后续修改不改变已保存版本。
- [ ] 上游与本地引用部分成功可恢复或清理，pending/syncing 不冒充成功。
- [ ] 当前 scope/Bot 授权覆盖版本详情，跨 Bot 复用需显式授权复制；猜测版本 ID 或撤权不能读取。
- [ ] 保存案例采用 30 天保留引用，未保存候选随源追踪生命周期；物理清理由生命周期 Ticket 完成。
- [ ] 真实 Opik 证明独立快照及固定 hash，页面覆盖双语、空/故障/同步和审查提示。

## Blocked by

- Draft 2: 创建者查看受授权的安全运行记录 (replace with the real GitHub issue link and native blocked-by edge after breakdown approval).
