# 目录与产物归处

创建/迁移 Agent 文档、执行记录或验证证据时读取；本规则优先于旧方案的路径约定，历史命令和事实保持原样。

## 按内容归类

| 内容 | 归处 |
| --- | --- |
| Agent 规则/技能约束 | `.agents/rules/`；根 `AGENTS.md` 只作触发入口 |
| 批准需求/范围/验收、架构决定、方案/接口/步骤、业务 Ticket | `docs/specs/`、`docs/adr/`、`docs/plans/`、`docs/plans/tickets/` |
| 方案研究/原型/取舍 | 对应方案目录，或 `docs/plans/research/` 并从方案引用 |
| Issue快照、scope/DAG、Brief/Ledger、调度/恢复、测试/Review/OCR报告、finding、截图/日志/回执 | `.archive/runs/<run-key>/` |
| CI/测试实际读取的清单、fixture、用例及配置 | 对应 `tests/`、`scripts/` 或模块配置，进入版本控制 |
| 临时构建/runner输出 | 工具缓存；交付所需证据另归档 |

方案写目标/接口/步骤/验收方法，运行结论与日志写归档，两者互相引用版本/入口；批准决定回写 Spec/ADR，不能只留在归档。影响执行的测试输入不能移入被忽略的 `.archive/`，移动时同步脚本/测试/CI。

## 按流程保留证据

- 轻量：范围、来源/验收、验证命令/结果，可在最终回复记录；需长期/跨会话才落盘，无须 Run。
- 标准：一份归档说明即可索引计划、验证及独立 Review，无须 DAG、逐文件哈希、policy manifest 或冻结回执。
- 完整、多实施者、跨 Run 恢复、专用自动化：使用以下 Run 合同。仅增加只读 reviewer 或保存普通报告不触发整套协议。落盘报告均按上表归类。

## Run 布局

新 run-key 为日期、任务/Issue短名、不可变 Run ID 的短后缀；Orca 用真实 Run ID，其他任务用 UUID，碰撞延长后缀。同一次工作复用目录，修复在内部编号；旧目录先核/补身份才复用，不批量改名。

index 记录完整 ID、规范仓库/主机/工作区、方案身份/哈希、原始 BASE、交付目标；按需创建 `scope.json / issues/`、`dag.json / state.json / events.jsonl / ledger.md`、`briefs/`、`checkpoints/`、`verification/`、`reviews/ / ocr/`、`receipts/ / workers/ / logs/`，不建空目录。

初始化确定持久拥有者的唯一绝对物理 `archive_root`，写 index、Ledger、全部 Brief 报告参数。Worker 写该根，或主控显式收取带哈希报告；远端暂存根须有到权威根的传输映射并收取核验，不能各工作区相对建第二根。清理会删除该根时，先完成[恢复引用迁移](coordination-state.md)。

无人值守/机器协调/跨 Run 恢复保存不可变 policy manifest，列实际适用 AGENTS/规则/技能的规范路径、来源和版本/内容哈希，变化建 revision，不覆盖旧版。policy_sha256 是完整manifest字节SHA-256，不是revision；epoch引用须一致。其他完整任务记录适用来源/版本即可。恢复、终审、交付写入前核当前政策；变化保存 policy_changed、影响与旧证据承接/失效依据，必要重验，不默认全失效或全有效。入口含 @RTK.md 缺失时记录来源缺口，仅阻塞受影响能力，不猜内容或擅自写回外部入口。

方案/修复方案存 `docs/plans/<date>-<issue-or-task>/`，只引用归档。新工具报告参数指向本规则位置；固定旧输出无法配置时记录技术债，改默认值须验证调用方。

runner原始临时输出用 `.e2e/<run-key>/<task>-<attempt>/`，参数/汇总按 [testing.md](testing.md)。Run verification 保存最终证据、原输出路径/版本/哈希及归档副本；临时输出不替代留存。共享资源与跨日Ledger另用 [coordination-state.md](coordination-state.md)持久根，Run仅存回执/引用。

## SDD 工具目录适配

仅使用 SDD 时读取本节；按 [execution.md](execution.md)核能力，记录技能版本、计划绝对路径/哈希、真实工具目录和 Run ID。固定 `.superpowers/sdd/<plan>/` 保留其目录，不改工具或用链接混淆方案；手工等价流程使用 Run 唯一Ledger，不编回执。

- 工具 progress.md 为唯一活动Ledger，Run只索引与归档检查点；Orca只用自身Task/Dispatch和Run Ledger，不另起SDD状态。
- Review/交付/压缩交接前保存Ledger、Brief、报告、完整范围的可恢复副本并核源/目标、检查点和可读性。跨写者/Run/主机按 [checkpoints.md](checkpoints.md)冻结同代清单，普通单工作区不逐轮事务快照；journal/fsync/原子发布由工具执行，Agent核回执，不维护第二协议。
- 恢复核Run/最后快照、工具目录、plan-path、Ledger、Git；缺目录仅从同身份已验快照恢复，冲突对账事件/代码，不按mtime选或造空Ledger重派。
- 清理前最终快照、全部Ruling、未提交内容和证据须在临时目录外可恢复；否则保留，删除技能目录不等于持久化。

## 保留与交付

`.archive/` 被忽略，不随普通提交/clone/新Worktree传递；跨工作区显式复制核清单/哈希，共享/交付走已授权渠道并记接收位置，不造远程链接。团队长期批准事实及可执行测试保留版本控制；本机归档不替代远程交付。提交脱敏证据另需授权，不能强加整个归档。

清理前核原报告、检查点、索引已转移且可读；含敏感内容依下节与检查点例外保留，脱敏副本不冒充原文。

## 脱敏、外发与可访问证据

原始证据要求来源/时间/版本/裁决可追溯，不要求复制敏感全文。Issue/评论/附件、终端/测试输入输出、OCR背景/文件和截图，归档或外发provider前须扫描并人工定向核对凭据/token、连接串、完整环境、个人/客户数据；记录范围/工具、脱敏位置与复核结果，不重泄露原文。

不能确认安全则暂停外发，用已有授权的受控存储/引用；无安全方式保留受保护源并记 protected/unverifiable，不创建无授权副本。快照记来源/原版本/脱敏字段/原文引用；逐字节完整性与受控指纹按 [checkpoints.md](checkpoints.md)，不保存可猜测秘密裸哈希。脱敏影响审查语义则保留覆盖缺口。

待人审证据须有接收方实际可读的授权入口、owner、完整性manifest和retain_until，至少保留至人工复核结束后90天，较长契约优先。定期核权限/存储；过期、主机丢失、不可恢复即入纠正队列。保留期内迁移更新引用并试读，到期删除由保留责任人决定，不能因Worktree收尾删除。

## 旧目录迁移

1. 区分方案、测试输入、历史证据、活跃状态并保留他人改动。仍被协调器/Worker/CI/脚本使用者先核对使用者、规划停止/对账或显式交接。
2. 记录旧→新映射及移动前后SHA-256，更新相对链接/方案入口；历史日志旧路径保留并注明映射。
3. 验证引用、读取方、内容完整性后才清旧处；混合历史目录暂留清单，不宣称全目录已清理。
4. 产品/部署/操作手册最终随模块/工具维护；本轮不批量搬历史手册，方案行为细节仍可在方案目录。
