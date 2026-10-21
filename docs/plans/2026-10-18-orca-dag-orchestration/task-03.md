> 路径约定：下文代码、命令及产物路径相对仓库根目录；Markdown 链接相对本文。

# Task 3: 持久化 Ledger 与执行唯一性

**依赖与角色：** T1；backend_implementer → backend_validator → reviewer。

**共享约束：** [B.3–B.6](protocols.md)、[C.3–C.4](review-sync.md)。

**Files / owned_files:** `scripts/orca-dag/ledger.mjs`、`scripts/orca-dag/resources.mjs`、`scripts/orca-dag/claims.mjs`、`scripts/orca-dag-ledger.test.ts`、`scripts/orca-dag-resources.test.ts`。Ledger 负责 Run 事件；resources 负责共享资源事务；claims 负责 Issue 两种用途的声明。

**Interfaces:**

- **Consumes:** T1。
- **Produces:** `appendEvent(runDir, event): Promise<void>`、`replay(runDir): Promise<RuntimeState>`、`reserveAttempt(runDir, stageAttempt, expectedRevision, claimRequest, resourceReservations): Promise<AttemptReservation>`、`reconcileClaims(repoIdentity, runId): Promise<ClaimReconciliation>`、`releaseClaims(repoIdentity, runId, settlementEvidence): Promise<void>`；resources 导出 `readResourceSnapshot(hostIdentity): Promise<ResourceSnapshot>`、`reserveResources(hostIdentity, requests, expectedRevision): Promise<ResourceReservation[]>`、`releaseResources(hostIdentity, reservationIds, releaseEvidence): Promise<void>`、`reconcileResources(hostIdentity, runId): Promise<ResourceReconciliation>`、`transferIntegrationResources(hostIdentity, oldReservationIds, newRequests, recoveryDecision, expectedRevision): Promise<ResourceReservation[]>`（在单事务中转移故障工作区预留并领取新测试资源，失败则保留旧预留）。claims 导出 `acquireSyncClaim(repoIdentity, issueNumber, runId, outboxId): Promise<Claim>`、`transferClaims(repoIdentity, issues, fromRun, toRun, handoffEvidence): Promise<Claim[]>`。请求、快照和回执类型由 T1 schema 定义；Snapshot 含资源目录、占用和 registry_revision，requests 按 holder_id 分组；releaseEvidence 为退出/结算证据或未产生副作用的持久证明。

**实施要求:**

- events.jsonl 为事实日志，state.json 原子替换为可重建投影；单协调器进程锁、revision 比较、事件去重；记录启动意图再调用外部启动。
- 锁损坏或持有者不明不自动抢锁；机器重启后需核对活跃 Worker 再恢复。
- 实现[B.3](protocols.md) 的仓库级原子声明协议；reserveAttempt 返回持久化 claim token，启动前必须校验 token。
- 日志持久化遵循[B.5](protocols.md) 的 fsync 和异常尾行规则。

**测试断言:**

- [ ] 同任务两次 reserve 仅一次成功。
- [ ] 事件重复不重复扣资源。
- [ ] 半写尾行作为恢复异常显式报告。
- [ ] 旧 attempt 的完成事件不能覆盖新 attempt。
- [ ] 重新投影状态一致。
- [ ] 进程锁禁止两个协调器同时写入同一 Run。
- [ ] 不同 runDir 同时领取重叠 Issue 仅一个成功。
- [ ] 多 key 领取无部分成功。
- [ ] 领取后启动意图前崩溃可对账。
- [ ] 独立 clone/远程配置拒绝 start。

**专项验收：**

- [ ] F2/F4：用两个真实进程、不同 runDir 和不同 Issue 争用同一 host 独占资源，断言恰好一个预留成功；多资源事务失败不留下部分占用；Run 配置不能放大共享容量。
- [ ] F4：覆盖资源预留后、Issue 领取后和启动意图写入后的崩溃窗口；只有可证明无副作用的预留可释放，未知子进程占用不得按超时释放。
- [ ] F5：没有 task_id 的父 Issue 同步领取合法；implementation/review_sync 对其他 Run 互斥；pending outbox 阻止释放；移交后旧 epoch 被拒绝，在途请求未知时不能移交。
- [ ] F3：范围迁移与结果承接事件重放后状态一致，原始证据保持原版本且只生成一个有效承接记录。

执行前读取 [共享约束](workflow.md) 中适用条款；上下文、消息和恢复使用 [读取规则](context.md)。
