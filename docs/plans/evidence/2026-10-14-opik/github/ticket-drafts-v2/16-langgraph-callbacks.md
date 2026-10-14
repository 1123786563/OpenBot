## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

默认 LangGraph 路径的框架 callback 进入同一受治理 OTel 路径，不另开未处理的自动上传；模型、工具与检索父子关系正确后才标记 detailed。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 默认 LangGraph 路径的框架 callback 进入同一受治理 OTel 路径，不另开未处理的自动上传。
- [ ] 模型、工具与检索父子关系在真实实例验证正确后才标记 detailed。
- [ ] 输入输出、错误与日志无秘密 canary。
- [ ] 其他远程路径保持 basic 与原协议，不因该接入被改变。
- [ ] agent runtime 模块自身测试通过，不依赖服务端未完成能力。

## Blocked by

- #20 内置执行的模型调用记录

## Handoff

Produces: LangGraph 侧 tracing 接入方式与版本约束.
Covers parent acceptance: A2, A4, A13.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
