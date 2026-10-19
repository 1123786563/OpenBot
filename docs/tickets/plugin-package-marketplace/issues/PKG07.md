<!-- openbot-plugin-packages:PKG07:v1 -->
## Parent

https://github.com/1123786563/OpenBot/issues/459

## What to build

管理员能看到影响范围后停用或卸载包；新执行被阻断，已有 Bot、私人 Skill、账号及历史证据仍按原权限存在。

## Scope boundary

enabled/disabled/uninstalled 状态、generation、影响预览、资源保留与重装语义。

## Acceptance criteria

- [ ] 停用/卸载后不存在新的派发；与在途调用竞态按 dispatched 线性化点处理，不谎称撤回已发生效果。
- [ ] 保留安装 tombstone、旧 revision/pin/审计和未知操作，不硬删全部历史。
- [ ] 用户已创建 Bot/编辑 Skill/任务产物/连接账号继续由各领域管理，卸载不自动删除。
- [ ] 两个包引用同一个 connector install 时，卸载一个包不破坏另一个；底层连接停用则正确反映共同不可用。
- [ ] 重装复用 installation identity，增加 generation；重新启用也不能复活旧 grant/审批。
- [ ] 跨范围停用/卸载与不存在同形，不能改变他团队状态。
- [ ] UI 显示实际影响、关联资产和需重新授权的下一步。

## Blocked by

- https://github.com/1123786563/OpenBot/issues/463
- https://github.com/1123786563/OpenBot/issues/464

GitHub 同步建立正式 blocked-by；本节保留可读备份。前置状态关闭也须核验其交付已审查并集成，不能用假桩代替。

## Verification

共享 connector 双包场景、在途派发并发及重装测试；浏览器卸载后确认专家/私人编辑/回执仍可按权限访问。

新增套件按 ADR 0008 分为 native 或 Bun-driven，由 tester-army e2e 统一调度/报告；targeted Bun 可定位行为，但不能代替统一入口证据。E2E_BUN_ONLY 按真实 group.name 筛选；真实角色/测试库缺失须标 blocked，不能将 skipped 或零测试当通过。

## Handoff

- source_issues：父 Issue 完整方案快照；本票覆盖 A05, A08。
- consumes：PKG04 专家创建来源、PKG05 派发与共享底层 connector 引用。
- produces：tombstone 安装、单调 generation、已撤 grant、明确重装/启用提示与资产链接。
- owned_scope：enabled/disabled/uninstalled 状态、generation、影响预览、资源保留与重装语义。 不修改其他业务领域的权威数据或既有 Issue 范围。
- owner_role：主控拆 Task；后端归 backend_implementer，前端归 frontend_implementer，按稳定接口串行；验证对应 backend_validator/frontend_validator；独立 reviewer 给 Spec 与质量结论。
- 详细实现映射：本地实施计划 T4, T6, T7, T8；该计划按技术 Task 编排，本票按完整业务结果验收。执行前读取父方案并生成本票自己的单个 Task Brief。
- checkpoint：记录执行工作区、BASE/HEAD、已审查提交或未提交快照哈希、实际测试输出与 Review/OCR 轮次。
- resume_hint：先读 Ledger/Git/前置接口，仅恢复未 verified 的 Task；不要重做已有连接器安装系统。
- 约束：包不是授权；成员、Bot、账号、范围和动作分别检查；不能回退其他范围/账号或 legacy；不得保存 token 到包配置、日志、预览或模型。
- 本票的发布和 ready-for-agent 标签不是代码提交、推送、合并、生产执行授权；用户尚未要求开始实施。
