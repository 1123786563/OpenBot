## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

全部上游调用经单一 port 抽象，序列化只由契约 manifest 驱动；对抗性故障可注入且不伪装成功，上游异常不阻塞正常 Agent 结果。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 全部上游调用经单一 port 抽象；序列化只由契约 manifest 驱动，不各自发明请求格式。
- [ ] 超时、5xx、部分成功与归属漂移可注入；失败如实返回，不伪装成功或空列表。
- [ ] 上游慢响应或离线时调用有界，不阻塞正常 Agent 结果。
- [ ] 归属漂移等关键异常暂停后续写入并可告警，不静默继续。

## Blocked by

- #10 上游契约冒烟与 VerifiedOpikContract manifest
- #11 采集侧脱敏投影与安全内容策略
- #13 观测归属存储 schema 与可信绑定

## Handoff

Produces: OpikPort 接口 + 对抗性 fixture 注入方式.
Covers parent acceptance: A1, A4, A10, A13.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
