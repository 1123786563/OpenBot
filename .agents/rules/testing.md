# 验证流程与测试容器

运行任何测试或验证前，先读 [测试 ADR 0008](../../docs/adr/0008-test-runner-tester-army-e2e.md)。按以下顺序执行，把命令、退出码、实际用例数、跳过项和清理结果写入 `.archive/runs/<run-key>/verification/`；方案只保留验收方法和证据入口。

1. 根据改动范围选择最小的相关测试，再运行适用的类型检查、Lint、构建和验收检查。规范入口按测试 ADR 确定，`package.json` 只提供具体 argv，命令存在不构成批准例外；`bun run test:ci` 会额外核验实际执行的测试数量及未收集的测试文件。报告跳过项、环境限制和失败，不把退出码 0 单独当作覆盖证据。
2. 需要 Docker 时，先记录已有容器及其归属。仅复用已证明版本和数据隔离适合的依赖，不因测试结束而停止它们；若需新建，使用独立的 Compose project、唯一名称或测试标签，并记录新建的容器 ID。测试脚本自行创建的容器也纳入本次记录。跨 Run 的数据库、端口、Compose project、缓存和输出目录按[共享协调状态](coordination-state.md)先登记再使用。
3. 在运行测试的同一流程中设置清理步骤（shell `trap` 或程序 `finally`），使成功、失败和中断时都能关闭本次新建的容器。`docker run` 和 `docker compose run` 的一次性容器优先使用 `--rm`；独立 Compose project 在测试后使用**同一个 project 名、Compose 文件、project-directory、env-file 与必要 profile**执行 down。其他新建容器按已记录 ID 停止并移除。清理失败须报告容器 ID 和错误。
4. 清理后再次检查这些 ID 或测试 project，通过 inspect/同 project 的全状态列表确认本次新建容器 ID 已不存在（停止仍残留不算移除），并核对本轮网络/挂载/名称占用已释放或有明确保留归属；未通过检查时不得报告验证完成。保留测试日志、退出码与清理结果。只清理本次创建且已核对归属的资源；已有服务、其他 Agent 的容器及数据卷保持原状。
5. 运行器临时结果放在 `.e2e/<run-key>/<task>-<attempt>/`，使用 `E2E_UNIT_OUTPUT` 等已支持参数指定唯一目录，并使汇总脚本读取同一目录。不能配置输出位置时，将固定目录作为独占资源，运行后立即复制归档。最终证据保存到 Run 的 `verification/`，记录检查点、命令、退出码、用例数、失败/跳过、原始文件清单及 SHA-256，并按 [checkpoints.md](checkpoints.md)将输出声明为交付物或绑定源检查点的 rebuildable_output；核验归档可读后才释放输出目录。`.e2e/` 是临时工作区，不是最终留存位置。

## 规范入口、诊断与交付 CI

层级为：有效测试 ADR 的规范入口 → 有权批准的具名例外 → 辅助诊断。ADR 0008 要求 e2e 统一入口、调度和报告，依赖 Bun 的套件通过其驱动层执行。直接 `bun test` 仅可用于诊断，不能以其绿灯代替 e2e 的正式验收和收集覆盖对账。

当前 `package.json` 的 `test:tls` 直接调用 bun test，按此层级记为辅助诊断/待迁移入口，不是本规则批准的例外；即使 CI 调用了它也不改变 ADR。TLS 正式证据须从 e2e 统一调度及覆盖报告取得；未接入或不可运行时保留验证缺口。具名例外须有批准者/approval_ref、套件范围、替代报告/覆盖方法、有效期及回迁条件；本次规则修订不擅改 ADR 或测试脚本。

关闭/贴标/交付前登记目标 SHA 的必需检查集合：读取目标分支保护/ruleset 的 Required Checks，并核对该 SHA 中标准 CI 工作流及其 event/path 条件（当前 CI 入口为 `.github/workflows/ci.yml`，聚合 job 为 verify）。保存查询时间、配置版本、check 名称/应用身份、run URL、head SHA、结论及被跳过原因。Required Checks 与适用标准 CI 均须 completed/success，必要 live 验收另补；pending、failure、cancelled、未运行、无法读取均保持 blocked。skipped/neutral 只有经工作流条件和改动范围证明不适用、独立审核确认时可排除；仅聚合绿灯不能掩盖必要 job 被跳过。没有配置 Required Checks 不等于无需标准 CI。只有目标交付契约从未配置适用标准 CI 时，才可按有权批准的交付契约采用等价完整验证和独立批准依据；CI 故障、权限不足、暂时不可读、pending 或结果缺失不属于该例外，始终 blocked。此远端交付门禁不阻止无远端 SHA 的本地草稿修订，后者不宣称完成目标交付。

使用 merge queue 前，核对目标 SHA 的 CI 工作流支持 `merge_group` 的 `checks_requested`，且必需 job 的 event/path 条件实际覆盖该候选；当前 `.github/workflows/ci.yml` 尚未声明该触发器，不能假定队列检查已接入。队列实际启用须另完成 CI 接入及候选 SHA 的门禁验收；本规则修订不启用队列或修改工作流。终审/OCR 也须有能在合入前约束该候选的必需检查，不能只靠普通 PR 绿灯。候选失效或重建时按 [交付门禁](delivery-gates.md)重新绑定验证与审查结果。

## 被测版本与数据边界

真实 API/UI/服务验收在测试前后核对：本轮源码 manifest、子模块 SHA/脏检查点，以及每个被测服务的实际版本。记录进程入口/cwd 与启动来源，或镜像 ID/digest、构建来源和 bind mount 路径，并关联到冻结检查点；同时记录脱敏配置身份、数据库迁移状态和测试输入。镜像标签、容器仍运行、端口可连或旧日志均不能单独证明版本一致。没有版本端点时，从冻结工作区重建/启动并保存构建和进程证据；无法证明一致则为 blocked，不能拿旧服务的绿灯验收新代码。代码、服务或配置漂移后重定检查点并重验受影响行为。

涉及数据库写入的测试必须显式使用隔离的 `TEST_DATABASE_URL` 和已核实可写范围，复用容器不等于允许复用应用数据。优先使用 [数据库测试辅助函数](../../server/tests/support/database.ts)解析测试连接，不回退到 `DATABASE_URL` 或默认应用库；库名带 test 也不能替代所有权核验。测试前列出 fixture 主键/命名空间、迁移/重置/清理动作及级联影响，仅清理本轮拥有的数据。共享应用库、未知数据所有者或越界权限下不得执行破坏性用例；创建/删除库、schema 或外部资源仍依现有授权。报告只保留脱敏服务身份和配置指纹，不记录连接秘密。

支付、邮件、消息队列、对象存储及第三方 SaaS 等非数据库外部副作用，运行前必须登记服务身份、现有授权、测试专用账号/租户/命名空间、写入范围和清理归属，按共享协议取得可表示的排他声明；没有可登记资源键时先扩展统一适配器，不能另起私有锁。禁止对生产或归属不明资源执行写入、扣费、发送和删除用例。测试后按请求 ID 对账并只清理本轮资源；无法证明隔离、副作用边界或清理结果时保持 blocked，不以只读配置或调用成功宣称验收完成。

本仓库的 `docker compose up -d agent-sandbox` 和 `scripts/start.sh` 可能操作共享的开发 project，`scripts/stop.sh` 还会停止整个本地栈。测试若需要临时沙箱，应指定独立 project，或先确认它是本次新建的服务，再只清理该服务。不要对共享 project 执行 `docker compose down`；清理测试 project 时不加 `-v`，以免删除数据卷。
