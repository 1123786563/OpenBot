<!-- openbot-plugin-packages:PKG08:v1 -->
## Parent

https://github.com/1123786563/OpenBot/issues/459

## What to build

部署管理员可将某版本隐藏或安全撤回；下架只影响发现，撤回会阻断所有范围和旧 Run 的新派发。

## Scope boundary

发布/下架/撤回管理命令、release 锁、范围 readiness 与撤回状态展示。

## Acceptance criteria

- [ ] 平台发布命令不能借此读取公司配置或替公司授权；公司管理员不能执行全局撤回。
- [ ] listed=false 不撤销已安装包运行资格；state=withdrawn 阻断所有后续派发，包括旧 pin。
- [ ] 撤回与 dispatch 同一 release 锁串行化；已发请求保留结果/unknown，不强行标取消。
- [ ] 被撤回版本不能新安装、升级或回滚进入；不同摘要不能覆盖同版本。
- [ ] 所有团队 UI 反映真实 unavailable 和原因，不泄露其他团队安装名单。
- [ ] V1 不自动 GC，被安装/Run/unknown/保留策略引用的制品和记录仍在。

## Blocked by

- https://github.com/1123786563/OpenBot/issues/464

GitHub 同步建立正式 blocked-by；本节保留可读备份。前置状态关闭也须核验其交付已审查并集成，不能用假桩代替。

## Verification

跨两团队的真实派发竞争与平台/公司权限检查，CLI 下架与撤回的差异演示。

新增套件按 ADR 0008 分为 native 或 Bun-driven，由 tester-army e2e 统一调度/报告；targeted Bun 可定位行为，但不能代替统一入口证据。E2E_BUN_ONLY 按真实 group.name 筛选；真实角色/测试库缺失须标 blocked，不能将 skipped 或零测试当通过。

## Handoff

- source_issues：父 Issue 完整方案快照；本票覆盖 A01, A05, A12。
- consumes：PKG01 发布记录和制品、PKG05 dispatch 锁协议；现有平台/公司管理面分离。
- produces：listed 与 published/withdrawn 两个独立状态、可审计撤回结果、全局一致的派发阻断。
- owned_scope：发布/下架/撤回管理命令、release 锁、范围 readiness 与撤回状态展示。 不修改其他业务领域的权威数据或既有 Issue 范围。
- owner_role：主控拆 Task；后端归 backend_implementer，前端归 frontend_implementer，按稳定接口串行；验证对应 backend_validator/frontend_validator；独立 reviewer 给 Spec 与质量结论。
- 详细实现映射：本地实施计划 T1, T4, T6, T7, T8, T9；该计划按技术 Task 编排，本票按完整业务结果验收。执行前读取父方案并生成本票自己的单个 Task Brief。
- checkpoint：记录执行工作区、BASE/HEAD、已审查提交或未提交快照哈希、实际测试输出与 Review/OCR 轮次。
- resume_hint：先读 Ledger/Git/前置接口，仅恢复未 verified 的 Task；不要重做已有连接器安装系统。
- 约束：包不是授权；成员、Bot、账号、范围和动作分别检查；不能回退其他范围/账号或 legacy；不得保存 token 到包配置、日志、预览或模型。
- 本票的发布和 ready-for-agent 标签不是代码提交、推送、合并、生产执行授权；用户尚未要求开始实施。
