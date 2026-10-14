## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

为观测界面建立 runs / datasets / evaluations / admin 四个双子语命名空间与路由约定，使四条前端链（运行、评测集、实验、管理）各自独占文案文件，既不争用既有共享文案文件，也不彼此争用。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 观测界面文案按运行、评测集、实验、管理拆成四个双子语命名空间，四条前端链各自独占文案文件，既不需要编辑既有共享文案文件，也不会彼此冲突。
- [ ] disabled、empty、forbidden、basic、omitted、truncated、syncing、unavailable 八类状态在英文与中文均有明确文案且语义不混用。
- [ ] Bot 维度与管理维度路由约定确定并可被后续页面直接复用；直接输入路由时仍执行权限校验。
- [ ] 四个子命名空间的归属矩阵（哪条前端链写哪个文件）写入交接说明，接手 agent 不会写错文件。

## Blocked by

None (can start immediately).

## Handoff

Produces: 四个子命名空间的 key 约定与归属矩阵（哪条前端链写哪个文件）+ 路由命名约定.
Covers parent acceptance: A5.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
