<!-- openbot-plugin-packages:PKG06:v1 -->
## Parent

https://github.com/1123786563/OpenBot/issues/459

## What to build

管理员能看清版本变化与权限增量，再升级或回滚；正在执行的旧 Run 继续锁定原资源，新权限不会自动生效。

## Scope boundary

upgrade/rollback 计划、revision CAS、授权差异、旧 pin 兼容与 Web 版本选择。

## Acceptance criteria

- [ ] 目标为精确 published 版本，不能请求时解析 latest；目标制品缺失/已撤回拒绝。
- [ ] 新增工具、read→write、schema digest 改变、连接要求变化均显示并需要明确重新授权。
- [ ] 旧 Run 不加载新 Skill、不获得新增工具；当前已移除/撤销工具即使在旧 pin 内也不能继续派发。
- [ ] 并发升级和旧 revision 请求产生确定 409，不覆盖他人刚提交的版本。
- [ ] 回滚新建 revision，generation/revision 不倒退，不复活旧 grant 或审批。
- [ ] 配置不兼容时要求完整目标配置重新规划，不能执行包迁移脚本或猜默认值。
- [ ] 升级不改用户已创建专家的私人配置，也不影响其他团队同包安装。

## Blocked by

- https://github.com/1123786563/OpenBot/issues/464

GitHub 同步建立正式 blocked-by；本节保留可读备份。前置状态关闭也须核验其交付已审查并集成，不能用假桩代替。

## Verification

两版本旧/新 Run 对照、真实 CAS 并发与权限增量审批检查；浏览器完成升级和回滚流程。

新增套件按 ADR 0008 分为 native 或 Bun-driven，由 tester-army e2e 统一调度/报告；targeted Bun 可定位行为，但不能代替统一入口证据。E2E_BUN_ONLY 按真实 group.name 筛选；真实角色/测试库缺失须标 blocked，不能将 skipped 或零测试当通过。

## Handoff

- source_issues：父 Issue 完整方案快照；本票覆盖 A03, A06, A07。
- consumes：PKG02 的计划事务、PKG03/05 的 Skill/工具 pins 和当前 grant；不可变多版本发布。
- produces：新的安装 revision、版本差异预览、当前授权与旧 pin 取交集的运行规则。
- owned_scope：upgrade/rollback 计划、revision CAS、授权差异、旧 pin 兼容与 Web 版本选择。 不修改其他业务领域的权威数据或既有 Issue 范围。
- owner_role：主控拆 Task；后端归 backend_implementer，前端归 frontend_implementer，按稳定接口串行；验证对应 backend_validator/frontend_validator；独立 reviewer 给 Spec 与质量结论。
- 详细实现映射：本地实施计划 T4, T6, T7, T8；该计划按技术 Task 编排，本票按完整业务结果验收。执行前读取父方案并生成本票自己的单个 Task Brief。
- checkpoint：记录执行工作区、BASE/HEAD、已审查提交或未提交快照哈希、实际测试输出与 Review/OCR 轮次。
- resume_hint：先读 Ledger/Git/前置接口，仅恢复未 verified 的 Task；不要重做已有连接器安装系统。
- 约束：包不是授权；成员、Bot、账号、范围和动作分别检查；不能回退其他范围/账号或 legacy；不得保存 token 到包配置、日志、预览或模型。
- 本票的发布和 ready-for-agent 标签不是代码提交、推送、合并、生产执行授权；用户尚未要求开始实施。
