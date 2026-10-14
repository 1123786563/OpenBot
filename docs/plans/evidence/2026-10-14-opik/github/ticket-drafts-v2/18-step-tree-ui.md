## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

创建者在既有详情页展开可信步骤树，定位具体模型、工具与检索操作并关联跨服务过程；basic 路径不显示不存在的内部步骤。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 创建者在既有详情页展开可信步骤树，定位具体模型、工具与检索操作。
- [ ] 跨服务过程可关联；ID 映射不暴露内部实现。
- [ ] basic 路径不显示不存在的内部步骤；能力标记与列表一致。
- [ ] 键盘、窄屏与双语成立；恶意内容只作文本渲染。

## Blocked by

- #19 创建者运行详情页与可用性状态
- #21 工具提议 vs 真实执行与检索步骤
- #23 跨服务与动态进程上下文传播与 ID 映射

## Handoff

Produces: 步骤树组件与只读步骤查询契约.
Covers parent acceptance: A2, A3, A5.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
