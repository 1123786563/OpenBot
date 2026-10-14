## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

对真实自托管实例验证 OTLP 写入、查询、项目、数据集、实验与删除契约，产出后续所有上游序列化唯一依据的 manifest。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 对真实实例逐项验证 OTLP 写入、查询、项目、数据集、实验与删除，全部 pass 后才产出 manifest。
- [ ] manifest 记录服务 tag/digest、SDK 精确版本、对应上游提交、实际请求响应 fixture、ID 映射、删除证据与支持的正文上限。
- [ ] canary 凭据、账号标识与原始附件不出现在任何实际写入或诊断输出中。
- [ ] 删除后记录在真实实例确实查不到；缺环境或跳过实测时不得报告验证成功。

## Blocked by

- #9 Opik 可选部署与版本锁定清单

## Handoff

Produces: VerifiedOpikContract manifest（版本、fixture、ID 映射、删除证据、正文上限）.
Covers parent acceptance: A1, A11, A13.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
