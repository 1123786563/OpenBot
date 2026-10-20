> 路径约定：下文代码、命令及产物路径相对仓库根目录；Markdown 链接相对本文。

# Task 9: 故障演练、独立 Review 与最终 OCR

**依赖与角色：** T8；backend_validator / reviewer；OCR 由主协调器调用。

**共享约束：** [验收基线](acceptance.md)、[4.2 交付条件](completion.md)。

**Files / owned_files:** 验证者仅写本轮 `reports/`；可生成测试临时目录；不得改业务代码和测试源码。发现缺失测试时由主协调器派发原实现者补充。

**Interfaces:**

- **Consumes:** T8 集成检查点（含操作手册）。
- **Produces:** 故障演练报告、Spec/quality Review、最终 OCR 报告和 finding rulings。

- [ ] 运行 `E2E_UNIT_SCOPE=scripts bun run test -- scripts/orca-dag-*.test.ts`，确认测试选择参数按实际 runner 使用文件列表传入；报告逐套件用例数，不接受零用例通过。
- [ ] 使用假的 GitHub/Orca transport、临时真实 Git 仓库，演练分页失败、重复消息、崩溃恢复、资源冲突、过期尝试和证据失效；不启动真实收费模型调用。
- [ ] 对 F1–F6 各保存一条完整行为轨迹：失败修复闭环、集成回归资源争用、在途范围承接、双进程跨 Run 互斥、无实施父节点同步、求解期间消息响应及预算恢复。记录测试名称、检查点哈希和结果；缺任一轨迹不得以其他测试通过替代。
- [ ] 主协调器通过 Orca 派发独立 Pi reviewer，只读审查完整工具改动，输出 Spec compliance 与 code quality；核验其身份与实现者不同。
- [ ] 主协调器在 SDD 验证和独立 Review 通过后，按 open-code-review Skill 对完整交付范围运行 OCR：覆盖全部未提交交付；若同时存在已提交交付，再覆盖原始 BASE..HEAD。保存 exit code、覆盖和失败文件，不能将 exit 0 视为自动通过。运行时机按[主入口执行裁决](../2026-10-18-orca-dag-orchestration.md#execution-ruling)。
- [ ] 有效 critical/high/medium finding 进入编号修复 DAG，由对应实现者修复、验证者验证、reviewer 复审；修复后对完整交付范围重跑 OCR，通过后才交付；提交另依已有授权；provider/凭据故障记录为阻塞。

- [ ] 按 [context.md 第 4 节](context.md) 验证 Brief、重复消息与恢复读取行为，报告实际读取量及不能测量的部分。

**验收:** 所有 A1–A9 的离线可验证部分及 F1–F6 行为轨迹有证据；Review 通过；交付时 OCR 覆盖完整且无有效阻塞问题。此 Task 不声称真实根 Issue 范围运行完成。

执行前读取 [共享约束](workflow.md) 中适用条款；上下文、消息和恢复使用 [读取规则](context.md)。
