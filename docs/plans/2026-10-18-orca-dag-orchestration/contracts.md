> 路径约定：下文代码、命令及产物路径相对仓库根目录；Markdown 链接相对本文。

## 附录 A：数据契约

T1 负责冻结 `contracts.schema.json`；所有消费者使用同一契约。字段与状态约定如下：

### A.1 任务、阶段与依赖

- Task：`id/source_issues/acceptance/depends_on/owner_role/validator_role/owned_files/interfaces/verification/status`，另含 `kind/resources/priority/estimated_seconds`。
- 业务状态：`pending/ready/running/implemented/validating/reviewing/integrating/verified/blocked/failed/unverifiable/revalidation_required`；不能从 worker_done 直接跳到 verified。阶段节点另用 `pending/ready/running/succeeded/failed/blocked/unverifiable`，两种状态不得混用。
- Dependency：`from/to/condition`；condition 为 `artifact_ready/validation_passed/review_passed/integration_validated/business_verified`，附证据引用。业务任务依赖只使用 business_verified；内部阶段使用[B.1](protocols.md) 的条件表。
- StageAttempt：`task_id/attempt_id/stage/stage_attempt_id/orca_task_id/dispatch_id/outcome`；attempt_id 标识业务产物轮次，stage_attempt_id 标识一次阶段执行，集成阶段不要求 Orca Task/Dispatch。

### A.2 资源与执行权

- Resource：`scope(workspace|repo|host)/scope_id/key/mode(shared|exclusive)/units`；容量为正整数；未知写范围按仓库独占处理。verification 中每条检查必须声明 resources，确实无共享资源时显式使用空数组。
- ResourceReservation：`reservation_id/run_id/holder_id/resources/registry_revision/token/status`；holder_id 为阶段尝试或集成 ID，status 为 reserved/active/released/unverifiable。
- Claim：`repo/source_issue/run_id/purposes(implementation|review_sync)/holders/token/epoch/status`；holders 记录 Task/Attempt 或 outbox ID，同仓库跨 Run 共享声明注册表。纯同步持有者不需要伪造 Task/Attempt。

### A.3 证据、恢复与范围迁移

- Evidence：`task_id/attempt_id/checkpoint_hash/base_commit/prerequisite_checkpoints/tested_tree_hash/requirements_hash/scope_revision/commands/results/review_status/integrated_checkpoint/validity`；validity 为 current/stale，历史记录不覆盖。
- RecoveryDecision：`decision_id/task_id/failed_stage_attempt_id/kind(retry_stage|repair|revalidate|blocked)/reason/evidence_refs/repair_round/resume_stage/invalidated_evidence_ids`；同一失败事件只能产生一个生效裁决。
- ScopeCarryForward：`task_id/attempt_id/stage_attempt_id/from_revision/to_revision/requirements_hash/prerequisite_checkpoints/ownership_hash/evidence_refs/status`；status 为 eligible/accepted/rejected，保留原始结果及迁移证据。

### A.4 集成事务与验证

- IntegrationIntent：`integration_id/task_id/attempt_id/checkpoint_hash/target_workspace/pre_tree_hash/post_tree_hash/file_manifest/verification_plan_hash/reservation_ids/status`；状态为 prepared/applied/validated/blocked。
- IntegrationVerificationPlan：`target_workspace/target_tree_hash/integrated_checkpoints/checks/resources/verification_plan_hash`；checks 包含命令、预期结果及资源声明。

### A.5 事件、投影与 Issue 同步

- Event：`event_id/run_id/task_id/attempt_id/stage_attempt_id/type/payload/recorded_at`；Delivery ID 与 Dispatch ID 保留原值，无阶段的事件允许 stage_attempt_id 为空。
- RuntimeState：任务、资源预留、权威阶段尝试、恢复裁决、范围承接记录、待对账启动、已处理消息、待 ack Delivery、求解进度及 Issue 标签同步 outbox 的投影。
- IssueReviewSync：`repo/issue_number/run_id/scope_revision/requirements_hash/checkpoint_hash/evidence_refs/desired_ready/generation/status/comment_id/idempotency_key/sync_claim_token/claim_epoch/last_error`；status 为 pending/synced/failed/unverifiable，独立于业务 Task 状态；尚未领取声明时 token/epoch 为空，此时不能写 GitHub。

<a id="a6"></a>

### A.6 调度决策

- ScheduleDecision：`selected/deferred/objective/algorithm/exact/diagnostics/input_hash/search_status/search_checkpoint/explored_nodes`；search_status 为 searching/exact/budget_exhausted/cancelled，非 exact 结果的 selected 只能用于诊断，不得派发。

所有模块对外接受/返回符合该 schema 的 JSON 对象；不依赖隐式全局工作区。外部进程使用 argv 数组而非 shell 拼接。
