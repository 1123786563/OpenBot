# 验证流程与测试容器

运行任何测试或验证前，先读 [测试 ADR 0008](../../docs/adr/0008-test-runner-tester-army-e2e.md)。按以下顺序执行，把命令、退出码、实际用例数、跳过项和清理结果写入 `.archive/runs/<run-key>/verification/`；方案只保留验收方法和证据入口。

1. 根据改动范围选择最小的相关测试，再运行适用的类型检查、Lint、构建和验收检查。根目录测试命令以 `package.json` 为准；`bun run test:ci` 会额外核验实际执行的测试数量及未收集的测试文件。报告跳过项、环境限制和失败，不把退出码 0 单独当作覆盖证据。
2. 需要 Docker 时，先记录已有容器及其归属。优先复用已运行且适合测试的依赖，不因测试结束而停止它们；若需新建，使用独立的 Compose project、唯一名称或测试标签，并记录新建的容器 ID。测试脚本自行创建的容器也纳入本次记录。
3. 在运行测试的同一流程中设置清理步骤（shell `trap` 或程序 `finally`），使成功、失败和中断时都能关闭本次新建的容器。`docker run` 和 `docker compose run` 的一次性容器优先使用 `--rm`；独立 Compose project 在测试后用**同一个 project 名**执行 `docker compose -p <测试项目名> down --remove-orphans`。其他新建容器按已记录的 ID 停止并移除。清理失败须报告容器 ID 和错误。
4. 清理后再次检查这些 ID 或测试 project，确认本次新建的容器不再运行；未通过检查时不得报告验证完成。保留测试日志、退出码与清理结果。只清理本次创建且已核对归属的资源；已有服务、其他 Agent 的容器及数据卷保持原状。
5. 测试的结果目录放在.e2e/目录下

本仓库的 `docker compose up -d agent-sandbox` 和 `scripts/start.sh` 可能操作共享的开发 project，`scripts/stop.sh` 还会停止整个本地栈。测试若需要临时沙箱，应指定独立 project，或先确认它是本次新建的服务，再只清理该服务。不要对共享 project 执行 `docker compose down`；清理测试 project 时不加 `-v`，以免删除数据卷。
