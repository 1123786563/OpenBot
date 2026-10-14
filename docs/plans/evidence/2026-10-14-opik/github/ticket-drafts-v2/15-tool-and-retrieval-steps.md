## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

工具提议、真实 execute 与缺少回执三者分开记录与展示；未知浏览器执行不显示成功；检索步骤与片段可定位且无秘密 canary。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 工具提议、真实 execute 与缺少回执三者分开记录与展示。
- [ ] 未知浏览器执行不显示成功。
- [ ] 检索步骤与片段可定位；输入输出、错误与日志无秘密 canary。
- [ ] 步骤类型判定不依赖框架内部实现细节。

## Blocked by

- #20 内置执行的模型调用记录

## Handoff

Produces: 步骤类型枚举 + 提议/执行/回执缺失判定.
Covers parent acceptance: A2, A3, A4.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
