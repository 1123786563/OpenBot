# 验证流程与测试容器

测试、类型检查、Lint、构建或验收时读取。软件测试先读 [ADR 0008](../../docs/adr/0008-test-runner-tester-army-e2e.md)，argv查当前 package.json；规则/文档以链接、差异、流程场景核验，不强跑无关产品测试。

## 运行与清理

1. 选择最小相关测试及适用类型/Lint/构建/验收，保留命令、退出码、实际用例数、失败/跳过/环境限制；exit 0不单独证明覆盖。`bun run test:ci`另核用例数与未收集文件。证据按 [artifacts.md](artifacts.md)，方案只留方法/入口。
2. Docker运行前列已有容器/归属，仅复用已证明版本和数据隔离适合的依赖。新建用独立Compose project/唯一名/标签，记录脚本创建者在内的全部容器ID；跨Run数据库/端口/project/缓存/输出先按 [coordination-state.md](coordination-state.md)声明。
3. 同一流程用trap/finally覆盖成功/失败/中断清理。一次性run优先 `--rm`；Compose down须使用创建时相同project、文件、project-directory、env-file、profile，其余按已记ID停止移除。只清本轮已核归属资源，已有服务/他人容器/数据卷保持。
4. 清理后inspect ID或同project全状态，确认容器已移除（仅停止不够），网络/挂载/名称占用释放或有明确保留owner；失败报告ID/错误，未核实不宣称验证完成。
5. 输出放 `.e2e/<run-key>/<task>-<attempt>/`，E2E_UNIT_OUTPUT等参数与汇总脚本同目录；固定输出不可配置则先独占，运行后立即复制归档。保留源码版本、命令/退出码、用例/失败/跳过；完整/跨Run另存输出清单/哈希并按 [checkpoints.md](checkpoints.md)绑定源树。必要报告可读才释放目录。

## 规范入口、诊断与交付 CI

优先级：有效测试ADR规范入口 → 有权批准的具名例外 → 辅助诊断。e2e统一入口/调度/报告，可驱动Bun套件；直接bun test仅诊断，不能替代正式验收/收集覆盖。TLS等驱动套件也需收集/执行报告，命令名/CI调用不证明覆盖。例外须有批准者/approval_ref、套件范围、替代报告/覆盖、有效期和回迁条件；改规则不自动改ADR/脚本。

目标SHA的Required Checks与适用标准CI必须completed/success，必要live验收另补。关闭/贴标/交付前查目标保护/ruleset和该SHA工作流event/path条件（入口 `.github/workflows/ci.yml`），记录查询时间/配置版本、check名/应用、run URL/head SHA、结论/跳过原因。pending/failure/cancelled/未运行/不可读均blocked；skipped/neutral仅在条件与范围证明不适用且独立审核确认后排除。聚合绿灯不能掩盖必要job跳过；无Required Checks不等于无标准CI。

只有交付契约从未配置适用标准CI时，才可凭有权批准契约采用等价完整验证/独立批准；CI故障/权限不足/暂不可读/pending/结果缺失不是例外。远端门禁不阻止无远端SHA的本地草稿，不因此宣称目标已交付。SHA变化的行为/Review/OCR承接按 [review.md](review.md)，CI仍绑定实际SHA。

merge queue启用前核目标工作流 `merge_group/checks_requested` 及必需job条件覆盖候选；终审/OCR也须能作为合入前必需检查。以当前workflow核能力，不凭普通PR绿灯推断接入；本规则不启用队列或修改workflow。候选失效/重建按 [delivery-gates.md](delivery-gates.md)重绑证据。

## 被测版本与数据边界

真实API/UI/服务验收前后，核源码manifest、子模块SHA/脏检查点及每个服务实际版本：进程入口/cwd/启动来源，或镜像ID/digest、构建来源、bind mount；绑定冻结树，同时记脱敏配置身份、迁移状态和测试输入。镜像标签、端口、运行容器或旧日志不能证明同版。无版本端点则从冻结树重建/启动并保留构建/进程证据；不能证明一致则blocked，漂移后重定检查点并补验。

数据库写测试须用隔离TEST_DATABASE_URL和已核可写范围，优先 [数据库辅助函数](../../server/tests/support/database.ts)，不回退DATABASE_URL/应用库。容器复用或库名含test不证明owner。事先列fixture主键/命名空间、迁移/重置/清理与级联，只清本轮数据；应用共享库/未知owner/越界权限不做破坏用例。建删库/schema/外部资源仍依授权，报告不含连接秘密。

支付/邮件/队列/对象存储/SaaS副作用测试先登记服务身份、授权、测试专用账号/租户/命名空间、写范围与清理owner并取得排他声明；缺资源键先扩统一适配器，不私造锁。不对生产/归属不明资源扣费、发送、写删。事后按请求ID对账，仅清本轮资源；隔离/副作用/清理不能证明则blocked，调用成功不等于验收。

`docker compose up -d agent-sandbox`、`scripts/start.sh`可能操作共享开发project，`scripts/stop.sh`会停整个栈。临时沙箱用独立project，或证明服务为本轮新建后仅清该服务；不对共享project down，测试project down不加 `-v`。
