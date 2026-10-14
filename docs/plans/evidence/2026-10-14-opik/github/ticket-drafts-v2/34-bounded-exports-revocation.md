## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

有权用户请求运行/实验的机器可读导出并查看状态；导出有界异步且不改变正常 Agent 结果；每次下载重新校验当前权限，撤权后旧链接立即失效。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 导出仅使用授权安全 DTO，不含原文附件、凭证、未处理正文、可执行 HTML 或私有原文 URL。
- [ ] 任务、文件与分页引用绑定 scope/Bot；客户端不能指定上游项目或用 export ID 跨范围读取。
- [ ] 页面区分 queued、running、ready、failed、revoked；仅 ready 且当前有权才可下载。
- [ ] 移交或撤权后旧链接立即失效；下载经受控接口，不产生绕过授权的长期公开链接。
- [ ] 导出有界异步，不改变正常 Agent 结果；无法建立可信绑定时不导出该 run 的业务内容。

## Blocked by

- #11 采集侧脱敏投影与安全内容策略
- #17 创建者只读查询接口

## Handoff

Produces: 导出任务与下载鉴权契约.
Covers parent acceptance: A4, A6, A10, A11.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
