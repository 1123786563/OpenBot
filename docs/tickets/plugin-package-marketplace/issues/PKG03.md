<!-- openbot-plugin-packages:PKG03:v1 -->
## Parent

https://github.com/1123786563/OpenBot/issues/459

## What to build

管理员给有可信团队归属的 Bot 授予包内 Skill 后，用户可在一次真实 Run 中使用固定版本的指令，撤销后后续加载立即被拒绝。

## Scope boundary

Skill 包资源解析、范围 grant、Skill 运行 pin、Bot 授权页面及真实对话执行；不包含供应商工具派发。

## Acceptance criteria

- [ ] 必须同时满足安装 enabled、Bot 可见及明确范围 grant；清单 needs、全局 legacy grant 都不能替代。
- [ ] 同名 Skill 在两个包或两个范围并存，不覆盖全局 slug；复制编辑生成私人 Skill，不修改包内容。
- [ ] Run、pin、outbox 原子提交，worker 不可能启动无 pin 的包运行；重试同 attempt 读取相同版本。
- [ ] 撤销 grant/成员资格后，正在进行的会话下一次 Skill 读取被拒；升级包不能向旧 Run 注入新指令。
- [ ] 逻辑私有 Bot 缺实际执行范围解析时返回 PACKAGE_BOT_SCOPE_UNAVAILABLE，不复制其身份或回退默认环境。
- [ ] 使用权限不包含修改源 Skill 的权限；管理员也不能因管理身份读取私人 Bot 内容。
- [ ] UI 查询 key 包含 tenant/workspace/principal；切范围及迟到响应不污染新范围。

## Blocked by

- https://github.com/1123786563/OpenBot/issues/461

GitHub 同步建立正式 blocked-by；本节保留可读备份。前置状态关闭也须核验其交付已审查并集成，不能用假桩代替。

## Verification

完成安装→授权→真实 Run 使用 Skill→撤权后拒绝演示；对原子 pin、跨范围和同名资源做集成检查。

新增套件按 ADR 0008 分为 native 或 Bun-driven，由 tester-army e2e 统一调度/报告；targeted Bun 可定位行为，但不能代替统一入口证据。E2E_BUN_ONLY 按真实 group.name 筛选；真实角色/测试库缺失须标 blocked，不能将 skipped 或零测试当通过。

## Handoff

- source_issues：父 Issue 完整方案快照；本票覆盖 A02, A04, A06, A11。
- consumes：PKG02 的 install/revision；现有 Bot ownership、Run/attempt 与工具策略；包 Skill 只引用不可变资源。
- produces：范围 PackageGrantDTO、同 Run 事务提交的 Skill pins、仅按当前 Bot/范围提供的 Skill summaries/content。
- owned_scope：Skill 包资源解析、范围 grant、Skill 运行 pin、Bot 授权页面及真实对话执行；不包含供应商工具派发。 不修改其他业务领域的权威数据或既有 Issue 范围。
- owner_role：主控拆 Task；后端归 backend_implementer，前端归 frontend_implementer，按稳定接口串行；验证对应 backend_validator/frontend_validator；独立 reviewer 给 Spec 与质量结论。
- 详细实现映射：本地实施计划 T3, T5, T6, T7, T8；该计划按技术 Task 编排，本票按完整业务结果验收。执行前读取父方案并生成本票自己的单个 Task Brief。
- checkpoint：记录执行工作区、BASE/HEAD、已审查提交或未提交快照哈希、实际测试输出与 Review/OCR 轮次。
- resume_hint：先读 Ledger/Git/前置接口，仅恢复未 verified 的 Task；不要重做已有连接器安装系统。
- 约束：包不是授权；成员、Bot、账号、范围和动作分别检查；不能回退其他范围/账号或 legacy；不得保存 token 到包配置、日志、预览或模型。
- 本票的发布和 ready-for-agent 标签不是代码提交、推送、合并、生产执行授权；用户尚未要求开始实施。
