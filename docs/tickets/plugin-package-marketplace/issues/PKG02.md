<!-- openbot-plugin-packages:PKG02:v1 -->
## Parent

https://github.com/1123786563/OpenBot/issues/459

## What to build

公司管理员在当前团队查看包安装预览并确认后，只生成一份可追踪的安装；成员能看到真实安装状态，安装本身不授予 Bot 执行能力。

## Scope boundary

最小安装/修订/计划/资源链接/变更回执存储，安装 API，预览确认和已安装视图；按本票需求扩表，不预建后续全部能力。

## Acceptance criteria

- [ ] 预览显示精确版本、digest、当前团队、资源、需要的连接/权限，保存 10 分钟；预览无供应商调用。
- [ ] 只有当前公司有权 tenant_admin 可提交；平台管理员不自动获得公司管理权。
- [ ] 相同 plan 并发确认、不同 plan 同包确认均不重复安装；同键异请求 409；已提交的同键重放在计划过期后仍返回原结果。
- [ ] 首次 expectedRevision=null；已存在安装用 revision CAS，过期/变更/撤回计划明确拒绝。
- [ ] 真实受限 PostgreSQL 角色验证公司/团队 FK、RLS、成员失效及事务本地上下文清除；缺角色或测试库记 blocked。
- [ ] 安装显示 needs_grant；仅安装不能读取账号、调用工具或让 Skill 获得工具权限。
- [ ] 两个团队/公司同包安装互不影响；跨范围 install/plan ID 与不存在保持同形响应。
- [ ] 确认失败保留非秘密输入并可重作计划；范围切换取消待确认计划，服务端仍独立拒绝伪造范围。

## Blocked by

- https://github.com/1123786563/OpenBot/issues/460
- https://github.com/1123786563/OpenBot/issues/74

GitHub 同步建立正式 blocked-by；本节保留可读备份。前置状态关闭也须核验其交付已审查并集成，不能用假桩代替。

## Verification

真实数据库并发安装/幂等测试、管理 API 越权测试、浏览器预览到安装状态演示。

新增套件按 ADR 0008 分为 native 或 Bun-driven，由 tester-army e2e 统一调度/报告；targeted Bun 可定位行为，但不能代替统一入口证据。E2E_BUN_ONLY 按真实 group.name 筛选；真实角色/测试库缺失须标 blocked，不能将 skipped 或零测试当通过。

## Handoff

- source_issues：父 Issue 完整方案快照；本票覆盖 A02, A03, A04, A12。
- consumes：PKG01 的不可变发布与制品；#74 已有企业连接器目录/安装归属；可信 Scope 与公司管理员写通道。
- produces：PackagePlanDTO、PackageInstallDTO、10 分钟安装预览与 actor+幂等键回执；范围唯一的 install/revision/resource links。
- owned_scope：最小安装/修订/计划/资源链接/变更回执存储，安装 API，预览确认和已安装视图；按本票需求扩表，不预建后续全部能力。 不修改其他业务领域的权威数据或既有 Issue 范围。
- owner_role：主控拆 Task；后端归 backend_implementer，前端归 frontend_implementer，按稳定接口串行；验证对应 backend_validator/frontend_validator；独立 reviewer 给 Spec 与质量结论。
- 详细实现映射：本地实施计划 T2, T3, T4, T7, T8；该计划按技术 Task 编排，本票按完整业务结果验收。执行前读取父方案并生成本票自己的单个 Task Brief。
- checkpoint：记录执行工作区、BASE/HEAD、已审查提交或未提交快照哈希、实际测试输出与 Review/OCR 轮次。
- resume_hint：先读 Ledger/Git/前置接口，仅恢复未 verified 的 Task；不要重做已有连接器安装系统。
- 约束：包不是授权；成员、Bot、账号、范围和动作分别检查；不能回退其他范围/账号或 legacy；不得保存 token 到包配置、日志、预览或模型。
- 本票的发布和 ready-for-agent 标签不是代码提交、推送、合并、生产执行授权；用户尚未要求开始实施。
