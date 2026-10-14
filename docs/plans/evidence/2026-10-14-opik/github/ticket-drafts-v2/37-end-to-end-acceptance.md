## Parent

[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留 — https://github.com/1123786563/OpenBot/issues/4

## What to build

对真实自托管 Opik 跑通采集、查询、评测、ID 映射与删除的全范围验收，汇总 13 条验收标准的证据，并完成独立 review 与全范围 OCR 闭环。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

## Acceptance criteria

- [ ] 对真实自托管 Opik 跑通采集、查询、评测、ID 映射与删除，逐项形成证据。
- [ ] 父 Spec 的 A1–A13 每条都有可核验证据或明确缺口说明；跳过与缺环境不记为通过。
- [ ] 完成独立 Spec 合规与代码质量 review，并跑全范围 OCR，无有效 critical/high/medium findings。
- [ ] 适用测试、类型检查、Lint 与前端构建全部通过；受影响的 agent runtime 模块测试通过。
- [ ] 交付实际变更范围、接口契约、迁移与回退说明、验证命令与结果、检查点哈希。

## Blocked by

- #7 观测后端模块骨架与路由注册 seam
- #8 观测 UI 独立 i18n 命名空间与路由约定
- #9 Opik 可选部署与版本锁定清单
- #10 上游契约冒烟与 VerifiedOpikContract manifest
- #11 采集侧脱敏投影与安全内容策略
- #12 可信 scope seam 与企业预留拒绝
- #13 观测归属存储 schema 与可信绑定
- #14 Opik HTTP 适配器与 port 抽象
- #15 配置开关与健康状态（禁用零影响）
- #16 run 终结语义与 basic 远程路径能力标记
- #17 创建者只读查询接口
- #18 创建者运行列表页
- #19 创建者运行详情页与可用性状态
- #20 内置执行的模型调用记录
- #21 工具提议 vs 真实执行与检索步骤
- #22 LangGraph callback 接入同一受治理 OTel 路径
- #23 跨服务与动态进程上下文传播与 ID 映射
- #24 运行详情页步骤树
- #25 数据集 schema 与不可变版本冻结
- #26 案例审查与保存接口
- #27 数据集页面（审查 / 保存 / 版本）
- #28 实验 schema 与冻结配置幂等提交
- #29 隔离执行与生产写工具拒绝
- #30 持久任务编排：有界并发、每样本重授权、取消与 lease
- #31 评测调用的计费准入与结算接线
- #32 规则评分器
- #33 受控模型 Judge 评分
- #34 实验结果查询接口与失败分类
- #35 实验对比接口与兼容性判定
- #36 实验页面（提交 / 逐样本结果 / 取消）
- #37 实验对比页面
- #38 采集入口认证与控制台/私有 API 保护
- #39 管理员范围汇总与采集故障排查
- #40 有界异步导出与下载即时撤权
- #41 保留期与真实删除验证
- #42 管理员汇总页面与创建者导出状态页

## Handoff

Produces: 验收证据索引.
Covers parent acceptance: A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.
