<!-- openbot-plugin-packages:PKG01:v1 -->
## Parent

https://github.com/1123786563/OpenBot/issues/459

## What to build

部署者把受信包放入制品目录后，当前团队成员能在市场浏览真实包详情、版本和能力；无效包无法进入可安装目录。

## Scope boundary

制品构建与登记、只读目录接口、市场插件包列表与详情。

## Acceptance criteria

- [ ] schemaVersion=1、platformApi=1；清单与资源限制、路径检查及确定性摘要严格遵守父方案。
- [ ] 相同文件不同遍历顺序摘要相同；同一发布者/包名/版本不同摘要拒绝登记。
- [ ] 绝对路径、..、symlink、大小写冲突、超限、未知字段、非空包依赖拒绝；失败不能伪装可安装。
- [ ] 成员能看到真实名称、发布者、版本、资源种类和不可用原因；未装配制品显示 unavailable。
- [ ] 目录不返回账号、配置秘密、内部文件路径或其他团队安装事实。
- [ ] 列表搜索、分页和详情形成可浏览的 Web 纵向闭环；首次演示可用仅含 Skill 的受信 fixture。

## Blocked by

None（无任务前置；仍须有本次实施授权和有效执行工作区）。

GitHub 同步建立正式 blocked-by；本节保留可读备份。前置状态关闭也须核验其交付已审查并集成，不能用假桩代替。

## Verification

用纯文件制品测试证明摘要及拒绝；用真实认证请求和浏览器证明当前范围目录可见、错误可理解。

新增套件按 ADR 0008 分为 native 或 Bun-driven，由 tester-army e2e 统一调度/报告；targeted Bun 可定位行为，但不能代替统一入口证据。E2E_BUN_ONLY 按真实 group.name 筛选；真实角色/测试库缺失须标 blocked，不能将 skipped 或零测试当通过。

## Handoff

- source_issues：父 Issue 完整方案快照；本票覆盖 A01, A12。
- consumes：现有认证与团队 Scope、代码内专家/Skill 目录作为首个导出来源；不依赖新安装表。
- produces：VerifiedArtifact、MarketplaceV1 与范围内只读 PackagePage；后续安装按 packageKey/version/digest 选取精确版本。
- owned_scope：制品构建与登记、只读目录接口、市场插件包列表与详情。 不修改其他业务领域的权威数据或既有 Issue 范围。
- owner_role：主控拆 Task；后端归 backend_implementer，前端归 frontend_implementer，按稳定接口串行；验证对应 backend_validator/frontend_validator；独立 reviewer 给 Spec 与质量结论。
- 详细实现映射：本地实施计划 T1, T7, T8；该计划按技术 Task 编排，本票按完整业务结果验收。执行前读取父方案并生成本票自己的单个 Task Brief。
- checkpoint：记录执行工作区、BASE/HEAD、已审查提交或未提交快照哈希、实际测试输出与 Review/OCR 轮次。
- resume_hint：先读 Ledger/Git/前置接口，仅恢复未 verified 的 Task；不要重做已有连接器安装系统。
- 约束：包不是授权；成员、Bot、账号、范围和动作分别检查；不能回退其他范围/账号或 legacy；不得保存 token 到包配置、日志、预览或模型。
- 本票的发布和 ready-for-agent 标签不是代码提交、推送、合并、生产执行授权；用户尚未要求开始实施。
