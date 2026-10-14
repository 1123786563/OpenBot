## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

创建者按当前管理权查询自己 Bot 的运行列表与安全详情；伪造归属、猜测 ID 与跨 scope 游标不能扩大访问；移交或撤权后历史、分页与缓存立即不可读。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 仅当前有管理权的创建者与范围内管理员可查询；public 聊天权、伪造归属、猜测 ID 与跨 scope 游标不能扩大访问。
- [ ] 列表与详情返回实际状态、耗时、安全内容与版本引用；provider usage 缺失时返回明确 unavailable。
- [ ] 移交或撤权后历史详情、分页与缓存立即不可读。
- [ ] 不暴露任意上游查询代理；两个测试 scope 的相同资源 ID 互相隔离。
- [ ] 上游不可用时返回可解释错误，不伪装为空列表。

## Blocked by

- #7 观测后端模块骨架与路由注册 seam
- #13 观测归属存储 schema 与可信绑定
- #16 run 终结语义与 basic 远程路径能力标记

## Handoff

Produces: 只读查询 REST 契约（请求/响应/错误语义/游标）.
Covers parent acceptance: A2, A5, A6, A10, A12.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
