# Opik 实施 Ledger

日期：2026-10-14。阶段：实施计划已写出，待用户审阅；尚未开始生产实现。

## 事实与授权

- 已批准 Spec：`docs/specs/2026-10-14-opik-integration-design.md`。
- Plan：`docs/plans/2026-10-14-opik-integration-plan.md`。
- DAG：`docs/plans/2026-10-14-opik-integration-dag.json`。
- Root requirement: approved local Spec, now published as https://github.com/1123786563/OpenBot/issues/4 (2026-10-15). Ten proposed vertical children await breakdown approval; no child issues or implementation started.
- 执行工作区：`/Users/wuyongjun/orca/workspaces/OpenBot/opik-integration`。
- 分支：`1123786563/opik-integration`；原始 BASE：`7bfc18f28152a3fb2a3fa014ae33a61025246f1b`。
- 当前 HEAD 仍等于 BASE；全部交付使用未提交检查点，未授权 commit/push/merge/release。
- 企业租户仍在设计：只保留授权、数据定位和评测资格三个接入位置；不实现 enterprise adapter/tenant表，不以workspace代替租户授权。
- Bifrost讨论仍未批准实施；当前积分门控与结算不因讨论中的设计变更。

## 工作区准备与复制证据

Orca创建独立工作区，setup skip 后手动 `bun install --frozen-lockfile`，exit 0。批准设计从主工作区显式复制，bytes与SHA256核对一致。主工作区CONTEXT与Bifrost讨论复制为只读证据快照，未将其他用户的测试/领域改动应用到该分支。

Manifest：`docs/plans/evidence/2026-10-14-opik/workspace.json`，包含两个工作区、BASE、批准Spec哈希、主工作区状态与文件哈希。不要把这些历史快照当成未来仍不变的来源；恢复先核对Git与当前事实源。

基线命令：

```sh
bun test server/tests/trace.test.ts server/tests/trace-middleware.test.ts server/tests/trace-outbound.test.ts server/tests/agent-profile-policy.test.ts server/tests/run-built-agent-cancellation.test.ts agent-langgraph/tests/stream.test.ts
```

结果：42 pass、0 fail、161 assertions，6 files。日志：`docs/plans/evidence/2026-10-14-opik/baseline-tests.log`。Bun实测1.4.2，根packageManager声明1.4.3；后续交付复核声明版本。此基线未使用生产数据库或实际Opik。

## 执行路由与检查点

| Task | Owner | Validator / Review | 状态 | 检查点 |
| --- | --- | --- | --- | --- |
| T01 | backend_implementer | backend_validator + reviewer | ready（未派发） | 无 |
| T02 | backend_implementer | backend_validator + reviewer | pending（未派发） | 无 |
| T03 | backend_implementer | backend_validator + reviewer | pending（未派发） | 无 |
| T04 | backend_implementer | backend_validator + reviewer | pending（未派发） | 无 |
| T05 | backend_implementer | backend_validator + reviewer | pending（未派发） | 无 |
| T06 | backend_implementer | backend_validator + reviewer | pending（未派发） | 无 |
| T07 | frontend_implementer | frontend_validator + reviewer | pending（未派发） | 无 |
| T08 | backend_implementer | backend_validator + reviewer | pending（未派发） | 无 |
| T09 | backend_implementer | backend_validator + reviewer | pending（未派发） | 无 |
| T10 | frontend_implementer | frontend_validator + reviewer | pending（未派发） | 无 |
| T11 | backend_implementer | backend_validator + reviewer | pending（未派发） | 无 |
| T12 | frontend_implementer | frontend_validator + reviewer | pending（未派发） | 无 |
| T13 | root_coordinator | backend_validator + frontend_validator + default:gpt-6-sol/high (read-only full-range reviewer) | pending（未派发） | 无 |

专业实现者使用运行时固定角色；主控派发后核对实际模型与推理等级。完整交付涉及跨进程身份、脱敏、预算与恢复，最终只读Review按仓库要求使用 default + 明确 gpt-6-sol/high，并传递reviewer约束；这不是改用default实现业务。模型名在派发时与实际allowlist再次核对。

每Task前后保存HEAD、staged/unstaged diff、授权范围untracked文件内容与hash，生成任务增量Package。各Task的报告、验收与Review必须绑定同一内容hash，变更后相关证据失效。reviewer只读；验证者不得修改业务或测试源。只有verified前置检查点已经集成到同一工作区才放行下游。

## Review / OCR / Ruling

- 计划自查：需求覆盖、DAG、文件所有权、接口及测试方式已检查；最终结果见 `docs/plans/evidence/2026-10-14-opik/plan-self-review.json`。
- 生产实现：not_started。
- 任务验证及独立代码Review：not_started。
- 完整OCR：not_started。实施后主控读取open-code-review Skill运行完整workspace审查；有提交则同时覆盖原BASE..HEAD。
- Ruling：无实际finding；不得把计划自查或基线测试当成代码Review/OCR通过。
- 契约前置：Task1需要真实Opik的版本、OTLP、ID映射、评测、授权入口和实际删除证据。当前没有这些运行证据；Task1ready不表示契约已验证。
- 环境：实施需任务专属Postgres/Opik实例及测试Intelligence配置；缺失时明确报告，不能运行应用数据库或全skip成功。

## 恢复与收尾

恢复先读本Ledger、批准Spec、Plan、DAG及Git，验证工作区与检查点，不重派verified任务。新增范围/有效OCR finding形成编号修复计划；普通已授权修复不重复问是否继续。永久证据、Ruling和所有Review/OCR结果保存后，才使用finishing-a-development-branch；当前工作区保留待审阅，不清理。

## 2026-10-15: to-spec / to-tickets publication

- The user explicitly selected `1123786563/OpenBot` for this task, overriding the earlier openmuse tracker default. Enabled the previously disabled Issues feature and created ready-for-agent.
- Published aggregate Spec https://github.com/1123786563/OpenBot/issues/4 with ready-for-agent/enhancement. Read back the complete body and verified exact equality; comments, formal sub-issues and native blocked-by snapshots are archived with it.
- Native relationship GET endpoints are available. At the recorded read there are zero formal children and zero parent blockers; drafted children are not published or implemented.
- Ten vertical ticket drafts cover all 38 stories and A1..A13, with no dependency cycles or redundant blocking edges. See ticket-proposal.json and separate ticket-drafts files.
- to-tickets requires user approval of granularity and blocking edges before child publication. Preserve parent body/state when publishing approved children; contains is separate from depends_on.
- Production implementation has not started. Reconcile the earlier 13-Task draft with approved ticket interfaces/ownership before implementation.
