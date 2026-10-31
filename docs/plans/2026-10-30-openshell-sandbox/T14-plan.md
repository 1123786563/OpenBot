# T14 OpenShell Control-Plane Loss Containment and Safe Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Repository execution, issue, checkpoint, review, and authorization rules govern actual dispatch.

**Goal:** computer 与 coding OpenShell 沙箱在控制链路失联超过配置宽限期后，由任务进程不能禁用的独立运行约束阻止继续执行，并且恢复只在新归属、有效策略和重新授权全部核验后发生。

**Architecture:** 采用 `runtime-guard` PID 1 执行约束作为候选机制：guard 先于业务进程启动，业务进程是降权子进程；guard 通过独立的低权限 mTLS lease relay/watchdog 接收 OpenBot 执行租约服务直连送来的 Ed25519 签名短租约，租约链包含完整 scope、generation、policy generation、authorization version 和单调 sequence。任务可以攻击 relay 或让其崩溃，但那只会导致租约到期；guard 崩溃会使业务进程随 PID namespace 终止，guard 卡死由 relay watchdog 终止业务进程树。watchdog 心跳只证明组件存活，不用作运行授权。租约续期不经过 OpenShell/Kubernetes 控制链路；失联、分区或约束组件故障都不能延续执行。恢复不是 resume 旧授权，而是重新计算归属、最终有效策略和当前授权后签发新租约与新执行代际。

**Tech Stack:** TypeScript/Bun、Node child process/PID namespace、Ed25519/mTLS、PostgreSQL/Drizzle、Helm、OpenShell/controller/CNI 测试栈、tester-army `e2e`。

**Spec:** [OpenShell Spec v1](../../specs/2026-10-30-openshell-sandbox.md) 的 [D4](../../specs/2026-10-30-openshell-sandbox.md#已批准决定)、[D25](../../specs/2026-10-30-openshell-sandbox.md#已批准决定) 与 [A02、A09](../../specs/2026-10-30-openshell-sandbox.md#验收映射)；[ADR 0013](../../adr/0013-openshell-sandbox-substrate.md)；[ticket breakdown T14](ticket-breakdown.md#t14--控制面失联后独立阻止执行并安全恢复)。

**Issue:** 正式 Issue [#748](https://github.com/1123786563/OpenBot/issues/748)（父 Issue [#734](https://github.com/1123786563/OpenBot/issues/734)，状态 `open`，标签 `ready-for-agent`），真实 Blocked by [#736](https://github.com/1123786563/OpenBot/issues/736)（T02）和 [#737](https://github.com/1123786563/OpenBot/issues/737)（T03）。Issue 与本计划都不是实施授权；实施前必须重新只读摄取三者正文、状态、评论关系和批准事实源。

## Global Constraints

- T02/T03 必须先在同一执行树通过真实验收，并以其实际文件、scope resolver、generation、生命周期和镜像合同为准；前置 Issue 未验证即保持 blocked，不用草案接口或 mock 冒充。
- 约束机制必须独立于失联的 OpenShell/Kubernetes 控制链路；`provider.stop()`、OpenShell API patch、正常网络下的远程 stop、Postgres `LISTEN/NOTIFY` 或 server 内部定时器都不能作为约束证明。
- 沙箱内普通心跳、任务进程可写的 lease 文件、可被 kill 的 sidecar 心跳不能单独证明约束成立。guard 必须是先启动的 PID 1、高于任务 UID、不暴露控制面凭据，任务进程不能 signal/ptrace 它、不能伪造或重放签名租约、不能通过重启或改时钟复活旧授权。
- `OPENBOT_OPENSHELL_LOST_LEASE_GRACE_MS` 可配置，含义是从最后一次成功租约续期到业务进程完全停止的最大时限。默认值只能在 Task 4 的选定版本实测中确定；60 秒只是初始测试候选，不是已验证 SLO，也不能被写成推断值。
- 租约 TTL 必须小于配置宽限期，并预留 guard 检查与进程树终止预算；配置解析拒绝 `leaseTtlMs + enforcementBudgetMs > graceMs`。到期动作是先 SIGTERM 后 SIGKILL 业务进程树，guard 留在隔离态，不允许只暂停计数或继续长连接。
- 恢复前必须重新核验完整归属、当前最终有效策略回执和当前授权；旧 lease、旧 policy receipt、旧 authorization version 和旧 generation 不能复活。恢复成功只签发新 lease/新 authorization version，不自动重放外部副作用。
- computer 与 coding 均覆盖；同 Bot 两环境、不同 Bot、不同 tenant/workspace、不同业务范围和不同 generation 不能共享或交叉复活授权。
- 不放宽默认拒绝、NetworkPolicy、进程隔离、文件隔离或最小 RBAC；工作负载不挂 Kubernetes/OpenShell token，不获得 guard 签名私钥或 mTLS 客户端凭据。
- 仅改变 OpenShell 模式。现有 `shared`、`docker`、既有 `sandbox` provider、`agent-sandbox/src/*` 共享模式和 chart 输出保持行为不变。
- 本票是完整档：独立行为验收、Spec/质量 Review、适用 OCR、实际收集数、版本/digest/资源归属和证据归档缺一不可；证据按 `.agents/rules/artifacts.md` 放 `.archive/runs/<run-key>/`。

## Current Code Facts

- `server/src/computer/sandbox.ts` 通过 Kubernetes API patch `Sandbox.spec.operatingMode` 实现 stop；控制面失联时该链路不可用，且这是远程 stop，不满足 D25 独立约束。`sessionOf` 只表示浏览器运行代际，不是执行授权。
- `server/src/computer/provider.ts` 的 `ComputerProvider` 只有 `locate/status/stop/reset/list/update/sessionOf`，没有约束状态或恢复核验出口；`server/src/computer/gateway.ts` 每次 action 经 `locate()` 后才发请求，`server/src/computer/stream-auth.ts` 也依赖 gateway `locate()`，因此 T14 必须在 `locate` 前挡住已过期执行。
- `server/src/computer/policy-listener.ts` 是 Postgres 控制链路；`server/src/computer/policy-network.ts` 异步推送策略且 `NO_NETWORK_POLICY` 为 `allow_all`，都不能证明 OpenShell 最终有效策略或控制面失联后的约束。
- 当前编码环境仍是共享容器：`agent-sandbox/src/proxy.ts` 做 token/Bot/scope 路由，`agent-sandbox/src/bot-runtimes.ts` 只按请求/流活动回收子进程，`agent-sandbox/src/upstream.ts` 没有执行租约。这些活动时钟是资源回收，不是失联安全边界。
- `charts/openbot/templates/computer/sandbox-rbac.yaml` 给 server namespace 内 Sandbox 管理权；T14 不新增 pods/exec、leases、secrets 或 cluster-scoped 权限。`sandbox-template.yaml` 与 `pod-template.yaml` 是 computer workload 形状来源，`networkpolicy.yaml` 是默认拒绝和入口通道来源，`server/serviceaccount.yaml` 只保留 T01 已验证的控制面身份并另挂外部 Secret 签名密钥。
- 在必核文件范围内 `rg "lease|heartbeat|expir|renew"` 未发现 sandbox 执行租约；现有 gateway lease 是人工接管控制权，其它 server lease 是后台任务锁，均不承担本票约束。

## Review Focus

1. **执行约束组件故障时业务仍执行**：guard 崩溃或卡死、lease relay 崩溃/被连接洪水源或状态查询不可达时，任务必须随 PID namespace/watchdog 终止或留在已验证隔离态；Task 2 `guard_failure_kills_descendants_without_remote_stop`、`hung_guard_is_detected_and_business_stops`、`lease_relay_crash_or_flood_causes_expiry` 与 Task 4 C5/C6 覆盖。
2. **任务杀掉 guard 或伪造/重放心跳**：降权任务不能 signal/ptrace PID 1、不能写租约状态、不能用旧 token 或自造 token 续期；Task 1 `replayed_or_forged_leases_are_rejected`、Task 2 `task_cannot_disable_or_exhaust_guard` 与 Task 4 C7 覆盖。
3. **guard 重启或时钟漂移重置宽限期**：重启后无新租约不得启动业务，墙钟回拨/前跳不能延长单调到期，旧 generation/token 不因进程重建复活；Task 2 `guard_restart_requires_a_new_signed_lease`、`clock_drift_cannot_extend_expiry` 与 Task 4 C8 覆盖。
4. **恢复沿用旧归属、旧策略或旧授权**：任一当前核验失败必须保持隔离，新授权不得从旧 lease 推导；Task 3 `old_authorization_cannot_revive_after_recovery`、`recovery_rejects_foreign_or_stale_scope` 与 Task 4 C9/C10 覆盖。
5. **网络分区只切断控制面而数据面继续执行**：issuer→relay 续期通道被分区、业务进程仍有本地 CPU/长连接活动时，必须在配置期限内完全停止且没有字节继续传输；Task 4 C3/C4 覆盖，Task 2 先钉住通道只允许 server mTLS 入站。

## File Map and Dependency Contract

**Independent constraint component**

- Create `shared/execution-guard-protocol.ts`：唯一 wire/纯状态机合同，包含 scope、claims、canonical encoding、Ed25519 验证结果、单调到期、sequence/recovery 判定；无 I/O、无时钟读取、无 secret。
- Create `runtime-guard/package.json`、`runtime-guard/tsconfig.json`、`runtime-guard/src/index.ts`、`runtime-guard/src/process-tree.ts`、`runtime-guard/src/lease-relay.ts`、`runtime-guard/tests/execution-guard.test.ts`：两个 OpenShell 镜像共用的 PID 1 guard、独立 relay/watchdog 与测试；只挂 public verifier key/client CA，不挂 Kubernetes/OpenShell token 或签名私钥。
- Modify T02/T03 实际镜像入口与 OpenShell workload 模板：computer 以 T02 实际 `agent-computer` 镜像入口为子进程，coding 以 T03 实际 OpenCode/预览沙箱入口为子进程；guard 先收初始签名租约，再 spawn 降权业务进程。
- Modify `charts/openbot/templates/computer/sandbox-template.yaml`、`charts/openbot/templates/computer/pod-template.yaml`、`charts/openbot/templates/openshell/coding-sandbox.yaml`、`charts/openbot/templates/networkpolicy.yaml`：注入 guard entrypoint、只读 key/CA、guard mTLS 入站端口和默认拒绝；不开放 Kubernetes API。
- `charts/openbot/templates/computer/sandbox-rbac.yaml` 不给 workload token、不新增权限；回归断言其 verbs 与主体不扩大。`charts/openbot/templates/server/serviceaccount.yaml` 行为不变，签名密钥来自 chart 显式引用的 existing Secret 并只挂给 server。

**Lease / expiry ownership**

- Create `server/src/db/schema/openshell-execution-leases.ts` 与 `server/drizzle/0238_openshell_execution_leases.sql`：唯一持久租约链事实，保存 exact scope、generation、key ID、lease ID、sequence、policy generation、authorization version、issued/expired/revoked 与恢复状态，不保存签名私钥。
- Create `server/src/openshell/execution-lease.ts`：唯一签发/续期/撤销协调者。数据库事务保证 sequence 单调与幂等；DB 或密钥不可用时拒绝新执行，不用内存状态替代。
- Modify `server/src/config.ts` 与 `charts/openbot/values.yaml`：OpenShell 专属 grace、lease TTL、enforcement budget、key ID、existing Secret、guard port 与 `defaultEvidenceRef`；legacy 配置不存在。

**Recovery verification and integration**

- Create `server/src/openshell/execution-recovery.ts`：唯一恢复裁决者，输入均由 server 从当前权威事实重算，不采信浏览器或沙箱头。
- Modify T02/T03 实际 provider，预期 `server/src/computer/openshell.ts` 与 `server/src/codesandbox/openshell.ts`；若实际路径不同，执行时在 Ledger 记录映射并改实际 owner。`locate`、computer action、stream、coding run/SSE/preview 前都必须收到有效约束状态，`status/list` 不唤醒。
- Modify `server/src/computer/gateway.ts`、`server/src/computer/stream-auth.ts`、T03 coding gateway/client/proxy 实际入口只接入查询结果，不各自实现第二套安全规则。
- Create `scripts/openshell-execution-constraint-acceptance.ts` 与 `tests/openshell/execution-constraint.e2e.test.ts`：隔离集群故障注入、默认值校准、版本/资源证据和清理。

**Consumes**

- T02：真实 `OpenShellScope`/scope resolver、computer provider、generation、加固镜像和已验证能力报告；现有 `ComputerProvider.locate/status/stop/reset/list`、`sessionOf()` 与 `ComputerGateway` 行为只作为兼容边界。
- T03：真实 coding scope resolver、`ensureRunning(scope): Promise<{ url: string; generation: string }>` 或执行时核实的等价签名、OpenCode/预览入口、SSE/WS 行为和默认拒绝系统策略回执。
- T01 chart/control plane 事实：OpenShell/controller/CNI/storage 版本与 digest、默认 NetworkPolicy、server SA 最小权限。
- 若 T09/T10/T05 已在同一树验证，恢复核验直接消费其 `OpenShellEnvironmentPolicyPort.inspectPolicy`、grant 权威与 durable intent/emergency 合同；若尚未存在，本票只要求 T02/T03 当前系统策略的 loaded generation/final hash，并在恢复检查中保留 T09/T10 后续替换为同一 proof 形状的适配点，不得引入 allow-all 或第二 grant 权威。

**Produces for T16**

```ts
export type OpenShellExecutionScope = {
  tenantId: string;
  workspaceId: string;
  botId: string;
  environment: "computer" | "coding";
  generation: string;
};

export type OpenShellConstraintStatus = {
  scope: OpenShellExecutionScope;
  state: "valid" | "expired_contained" | "component_failed_contained" | "unknown";
  lease: { id: string; sequence: number; expiresAt: string } | null;
  enforcementDeadline: string | null;
  lastContainmentAt: string | null;
  mechanism: "pid1-signed-lease-guard-v1";
};

export type OpenShellRecoveryVerification = {
  scope: OpenShellExecutionScope;
  status: "allowed" | "blocked";
  ownership: "verified" | "mismatch" | "unknown";
  effectivePolicy: "verified" | "mismatch" | "unknown";
  authorization: "reauthorized" | "revoked" | "unknown";
  oldLeaseAccepted: false;
  newLeaseId: string | null;
  authorizationVersion: string | null;
  reason: string | null;
};

export type OpenShellExecutionConstraintPort = {
  getConstraintStatus(scope: OpenShellExecutionScope): Promise<OpenShellConstraintStatus>;
  verifyRecovery(input: {
    scope: OpenShellExecutionScope;
    observedStatus: OpenShellConstraintStatus;
  }): Promise<OpenShellRecoveryVerification>;
};
```

`verifyRecovery` 必须在服务端读取当前归属 resolver、最终策略回执和当前授权后调用 guard 新链，不接受调用方提交的 policy/auth 结论。

---

### Task 1: Signed Lease Protocol and Durable Lease Chain

**Files:**

- Create: `shared/execution-guard-protocol.ts`
- Create: `server/src/db/schema/openshell-execution-leases.ts`
- Create: `server/drizzle/0238_openshell_execution_leases.sql`
- Create: `server/src/openshell/execution-lease.ts`
- Modify: `server/src/config.ts`
- Test: `server/tests/openshell-execution-lease.test.ts`

**Interfaces:**

- Consumes T02/T03 exact `OpenShellExecutionScope` and current policy/authorization version inputs.
- Produces `parseExecutionLeaseClaims(token: string): ExecutionLeaseClaims | null`, `verifyExecutionLease(token: string, trustedKeys: readonly ExecutionVerificationKey[], expectedScope: OpenShellExecutionScope, monotonicNowMs: number): ExecutionLeaseVerification`, and a pure `evaluateExecutionGuardState(state, monotonicNowMs)` function.
- Produces `createExecutionLeaseAuthority(options)` with `issue(input: IssueExecutionLeaseInput): Promise<SignedExecutionLease>`, `renew(input: { leaseId: string; scope: OpenShellExecutionScope; policyGeneration: string; authorizationVersion: string; now: Date }): Promise<SignedExecutionLease>`, and `revoke(input: { leaseId: string; reason: "expired" | "admin" | "recovery" | "policy" }): Promise<{ status: "revoked" | "already_revoked" }>`.
- Produces `SignedExecutionLease = { token: string; claims: { scope; keyId; leaseId; sequence; issuedAt; notAfter; policyGeneration; authorizationVersion; taskId: string | null } }` and refuses issuance when the durable row cannot be committed.

- [ ] **Step 1: Write failing tests**
  - `lease_requires_exact_scope_generation_policy_and_authorization`
  - `forged_signature_or_unknown_key_is_rejected`
  - `replayed_or_forged_leases_are_rejected`
  - `lease_ttl_fits_inside_the_configured_grace`
  - `renew_extends_only_the_current_durable_chain`
  - `revoked_or_expired_chain_cannot_be_renewed`
  - `policy_or_authorization_change_refuses_renewal`
  - `new_generation_does_not_inherit_a_lease`
  - `duplicate_issue_is_idempotent_under_concurrency`
  - `database_failure_issues_no_token`
  - `token_payload_does_not_expose_private_key_or_secret`
  - `restart_scanner_finds_due_leases_without_reviving_them`
- [ ] **Step 2: RED**

```bash
E2E_UNIT_OUTPUT=.e2e/<run-key>/T14-task1-red e2e run --config e2e.unit.config.ts server/tests/openshell-execution-lease.test.ts
```

Expected: 12 collected, 12 failed, 0 skipped because the protocol/authority/schema are absent.

- [ ] **Step 3: GREEN**
  - Implement canonical CBOR/JSON encoding, Ed25519 detached signature, bounded wall-clock skew, monotonic expiry, exact-scope checks, and durable sequence transitions.
  - Store the minimum claims/hash needed to audit and reject replay; the private key remains only in the configured Secret and is never logged.
  - Add the restart-safe due scanner; a due lease is containment work, never a network-access continuation.

```bash
E2E_UNIT_OUTPUT=.e2e/<run-key>/T14-task1-green e2e run --config e2e.unit.config.ts server/tests/openshell-execution-lease.test.ts
```

Expected: 12 collected, 12 passed, 0 skipped. Run migration inspection against isolated `TEST_DATABASE_URL`, `cd server && bun run typecheck`, and `cd shared && bun run typecheck`; record outputs in the run archive.

- [ ] **Step 4: Commit** only this task's files with `feat: add OpenShell execution lease authority`.

### Task 2: PID 1 Guard, Both Workloads, Chart, and RBAC

**Files:**

- Create: `runtime-guard/package.json`
- Create: `runtime-guard/tsconfig.json`
- Create: `runtime-guard/src/index.ts`
- Create: `runtime-guard/src/process-tree.ts`
- Create: `runtime-guard/src/lease-relay.ts`
- Modify: T02/T03 actual image entrypoints and workload templates
- Modify: `charts/openbot/templates/computer/sandbox-template.yaml`
- Modify: `charts/openbot/templates/computer/pod-template.yaml`
- Modify: `charts/openbot/templates/openshell/coding-sandbox.yaml`
- Modify: `charts/openbot/templates/networkpolicy.yaml`
- Modify: `charts/openbot/values.yaml`
- Test: `runtime-guard/tests/execution-guard.test.ts`
- Test: `server/tests/openshell-execution-guard-integration.test.ts`
- Test: `server/tests/openshell-execution-chart.test.ts`

**Interfaces:**

- Consumes Task 1 protocol and authority.
- Produces `startExecutionGuard(config: { scope; verifierKeys; caPem; listenPort; leaseTtlMs; enforcementBudgetMs; child: { command: readonly string[]; uid: number; gid: number; env: Record<string, string> } }): Promise<{ status(): Promise<OpenShellConstraintStatus>; stop(): Promise<void> }>`.
- Produces `startLeaseRelay(config: { serverTls: { certPem: string; keyPem: string; clientCaPem: string }; listenPort: number; maxConnections: number; handshakeTimeoutMs: number; deliver(token: string): Promise<boolean>; watchdog: { guardPid: number; workloadRootPid: number; healthTimeoutMs: number; terminateWorkload(): Promise<void> } }): Promise<{ stop(): Promise<void> }>`; relay crash or flood never resets the guard's monotonic deadline, and a missing guard health beat only triggers containment.
- Produces `terminateProcessTree(input: { rootPid: number; graceMs: number }): Promise<{ terminated: boolean; remainingPids: readonly number[] }>`; unknown descendants or surviving sockets are failures.
- T02/T03 providers produce `renewExecutionLease(scope, leaseId): Promise<OpenShellConstraintStatus>` and `getConstraintStatus(scope): Promise<OpenShellConstraintStatus>`; `status/list` are read-only and never wake or spawn.

- [ ] **Step 1: Write failing guard tests**
  - `guard_does_not_spawn_workload_before_a_valid_lease`
  - `valid_lease_spawns_only_the_configured_child`
  - `renewal_extends_only_the_monotonic_deadline`
  - `expiry_terminates_process_tree_and_closes_child_sockets`
  - `replayed_or_forged_lease_cannot_extend_execution`
  - `task_cannot_disable_or_exhaust_guard`
  - `lease_relay_crash_or_flood_causes_expiry`
  - `guard_failure_kills_descendants_without_remote_stop`
  - `hung_guard_is_detected_and_business_stops`
  - `guard_restart_requires_a_new_signed_lease`
  - `clock_drift_cannot_extend_expiry`
  - `wrong_environment_or_generation_is_rejected`
- [ ] **Step 2: Write failing integration/chart tests**
  - `computer_and_coding_both_start_under_guard`
  - `computer_actions_and_stream_check_constraint_before_locate`
  - `coding_runs_sse_and_preview_check_constraint_before_spawn`
  - `constraint_status_does_not_wake_stopped_sandboxes`
  - `recovery_gate_blocks_until_guard_reports_containment`
  - `workload_has_no_control_plane_credentials_or_signing_key`
  - `guard_ingress_allows_only_server_mtls`
  - `legacy_providers_and_chart_output_are_unchanged`
  - `sandbox_rbac_adds_no_guard_or_pod_permissions`
  - `openshell_config_requires_guard_key_and_evidence_ref`
  - `computer_and_coding_get_separate_guard_configuration`
  - `rendered_pids_uids_and_capabilities_are_fail_closed`
  - `guard_port_is_not_exposed_to_public_ingress`
  - `chart_defaults_are_empty_until_measured`
- [ ] **Step 3: RED**

```bash
E2E_UNIT_OUTPUT=.e2e/<run-key>/T14-task2-red e2e run --config e2e.unit.config.ts runtime-guard/tests/execution-guard.test.ts server/tests/openshell-execution-guard-integration.test.ts server/tests/openshell-execution-chart.test.ts
```

Expected: 26 collected, 26 failed, 0 skipped for missing guard/relay/watchdog/integration/chart behavior.

- [ ] **Step 4: GREEN**
  - Start guard as PID 1 and start the isolated mTLS relay before spawning; verify the first lease, then spawn computer/coding as a lower-UID child in its own process group/PID namespace. Relay crash, handshake failure, connection exhaustion, or task-originated flood may only shorten execution, never extend it.
  - On expiry, terminate the entire business process tree within the enforcement budget and remain in `expired_contained`; on guard crash, rely on PID namespace collapse, and on a hung guard, let the relay watchdog terminate only the workload tree. Neither path uses a remote stop.
  - Mount verifier public keys and CA read-only; guard ingress is only server mTLS. Do not put the Kubernetes SA token, OpenShell credential, signing key, or client certificate into the workload.
  - Keep old modes byte-for-byte or behavior-equivalent in rendered snapshots; no production default is set before Task 4.

```bash
E2E_UNIT_OUTPUT=.e2e/<run-key>/T14-task2-green e2e run --config e2e.unit.config.ts runtime-guard/tests/execution-guard.test.ts server/tests/openshell-execution-guard-integration.test.ts server/tests/openshell-execution-chart.test.ts
```

Expected: 26 collected, 26 passed, 0 skipped. Also run `cd runtime-guard && bun run typecheck`, `cd server && bun run typecheck`, `helm lint charts/openbot`, and OpenShell/legacy `helm template` comparisons.

- [ ] **Step 5: Commit** only this task's files with `feat: contain OpenShell execution with a PID 1 guard`.

### Task 3: Recovery Re-Verification and Execution Gates

**Files:**

- Create: `server/src/openshell/execution-recovery.ts`
- Modify: T02/T03 actual providers, expected `server/src/computer/openshell.ts` and `server/src/codesandbox/openshell.ts`
- Modify: `server/src/computer/gateway.ts`
- Modify: `server/src/computer/stream-auth.ts`
- Modify: `server/src/codesandbox/gateway.ts`
- Modify: `server/src/codesandbox/client.ts`
- Modify: T03's OpenShell ingress extraction from `agent-sandbox/src/proxy.ts`; the legacy shared-proxy behavior remains unchanged
- Test: `server/tests/openshell-execution-recovery.test.ts`

**Interfaces:**

- Consumes Task 2 `OpenShellConstraintStatus`, T02/T03 scope resolvers, T01/T03 loaded-policy proof, and the current authorization owner.
- Produces exactly the T16 `OpenShellExecutionConstraintPort` above.
- Produces `computeAuthorizationVersion(input: { scope; ownerProof: OwnerProof; taskAuthorization: CurrentTaskAuthorization; policyGeneration: string }): string`; the value is a canonical SHA-256, changes on any relevant input, and is never supplied by the browser or task.

- [ ] **Step 1: Write failing tests**
  - `recovery_rejects_foreign_or_stale_scope`
  - `recovery_requires_current_loaded_policy_generation`
  - `provider_added_allow_or_stale_receipt_blocks_recovery`
  - `revoked_task_authorization_blocks_recovery`
  - `old_authorization_cannot_revive_after_recovery`
  - `old_lease_is_rejected_and_new_lease_gets_new_sequence`
  - `unknown_constraint_or_policy_state_blocks_execution`
  - `recovered_computer_actions_require_the_new_lease`
  - `recovered_coding_sse_and_preview_require_the_new_lease`
  - `normal_network_remote_stop_is_not_used_for_recovery`
- [ ] **Step 2: RED**

```bash
E2E_UNIT_OUTPUT=.e2e/<run-key>/T14-task3-red e2e run --config e2e.unit.config.ts server/tests/openshell-execution-recovery.test.ts
```

Expected: 10 collected, 10 failed, 0 skipped because the recovery gate is absent.

- [ ] **Step 3: GREEN**
  - Re-resolve full ownership, inspect the final effective policy for that exact environment/generation, and re-read current task authorization in one server-side decision.
  - `allowed` requires all three proofs plus a newly signed lease; every mismatch/unknown branch is `blocked` and does not issue or send a token.
  - Gate computer `locate`/actions/stream and coding run/SSE/preview on a currently valid constraint. Recovery never auto-runs an interrupted external side effect.

```bash
E2E_UNIT_OUTPUT=.e2e/<run-key>/T14-task3-green e2e run --config e2e.unit.config.ts server/tests/openshell-execution-recovery.test.ts
```

Expected: 10 collected, 10 passed, 0 skipped. Run the existing `computer-session-guard.test.ts`, `computer-session-guard-replicas.integration.test.ts`, `egress-policy-on-wake.test.ts`, and T03 coding proxy suites; every collected result and any environment blocker is archived.

- [ ] **Step 4: Commit** only this task's files with `feat: require fresh authorization to recover OpenShell execution`.

### Task 4: Fault-Injection Acceptance and Measured Default

**Files:**

- Create: `scripts/openshell-execution-constraint-acceptance.ts`
- Create: `tests/openshell/execution-constraint.e2e.test.ts`
- Modify: `charts/openbot/values.yaml`
- Modify: `charts/openbot/README.md`

**Interfaces:**

- Consumes Tasks 1–3 through authenticated OpenBot computer and coding entries in the T01 selected cluster; adapter-only calls, mocks, static chart checks, and normal remote stop do not count.
- Produces machine-readable evidence containing source tree/SHA/dirty state, OpenShell/controller/CNI/storage/kernel/image versions and digests, Helm/config identity, namespace owner labels, scope/generation, fault window, monotonic stop time, process/socket proof, no-remote-stop proof, recovery decisions, measured default formula, cleanup receipts, and evidence hashes.

- [ ] **Step 1: Write the failing live matrix**
  - C1 `computer_control_plane_outage_stops_within_grace`
  - C2 `coding_control_plane_outage_stops_within_grace`
  - C3 `computer_renewal_partition_stops_while_data_plane_runs`
  - C4 `coding_renewal_partition_stops_while_data_plane_runs`
  - C5 `computer_guard_and_relay_failures_fail_closed_without_remote_stop`
  - C6 `coding_guard_and_relay_failures_fail_closed_without_remote_stop`
  - C7 `task_kill_forge_replay_and_disable_attempts_fail`
  - C8 `guard_restart_and_clock_drift_do_not_reset_grace`
  - C9 `recovery_rejects_old_authorization_and_policy`
  - C10 `recovery_allows_only_fresh_owner_policy_authorization`
  - C11 `two_environments_and_legacy_mode_remain_separated`
  - C12 `measured_default_has_current_evidence_and_cleanup_is_complete`
- [ ] **Step 2: RED**

```bash
E2E_UNIT_OUTPUT=.e2e/<run-key>/T14-task4-red e2e run --config e2e.unit.config.ts tests/openshell/execution-constraint.e2e.test.ts
```

Expected in an available isolated cluster: 12 collected, 12 failed, 0 skipped before calibration/final chart values. If cluster ownership or a dependency is unavailable, record the keyed environment blocker; do not replace it with a mock.

- [ ] **Step 3: Inject faults and calibrate the default**
  - Use the 60-second value only as the initial candidate. Measure P999 healthy renewal round trip, guard verification/check jitter, maximum process-tree termination and socket-close time, key verification time, and bounded clock skew across both environments.
  - Set `defaultLostLeaseMs` to the measured upper bound plus explicit safety margin, record the formula and raw evidence digest, and ensure `leaseTtlMs + enforcementBudgetMs <= defaultLostLeaseMs`. A value unable to stop both environments within that bound fails even if tests otherwise pass.
  - For C1/C2 stop the OpenShell controller and OpenBot control/lease issuer. For C3/C4 apply a rule that drops only issuer→relay traffic while a CPU loop and an established socket remain active. For C5/C6 separately crash guard, hang guard until the watchdog fires, and kill/flood relay. In all cases assert no remote `provider.stop()` request, no surviving PID/CPU time, and zero further bytes on old sockets.
- [ ] **Step 4: GREEN**

```bash
E2E_UNIT_OUTPUT=.e2e/<run-key>/T14-task4-green e2e run --config e2e.unit.config.ts tests/openshell/execution-constraint.e2e.test.ts
```

Expected: 12 collected, 12 passed, 0 skipped. Re-run Tasks 1–3 suites, `cd server && bun run typecheck`, `cd shared && bun run typecheck`, `cd runtime-guard && bun run typecheck`, `helm lint charts/openbot`, and OpenShell/legacy render comparisons; reconcile every report count and skip.

- [ ] **Step 5: Independent acceptance, Review, and OCR**
  - A fresh reviewer verifies #748, A02, and A09 against code and live evidence, then performs independent Spec/quality Review and applicable full-scope OCR under `.archive/runs/<run-key>/reviews/` and `/ocr/`.
  - Any valid medium-or-higher finding, missed fault injection, task-disabling primitive, execution after deadline, unknown policy/auth recovery, unmeasured default, missing digest/owner evidence, or unexplained skip keeps #748 blocked.
- [ ] **Step 6: Commit** only this task's files with `test: prove OpenShell loss containment and recovery`.

## Independent Acceptance Mapping

| Gate | Evidence |
| --- | --- |
| #748 控制面停机、网络分区、执行约束组件故障均注入验证 | Task 4 C1–C6 runs each fault for both environment types in the selected isolated cluster; Task 2 unit/integration proves the mechanism but cannot substitute for live evidence. |
| #748 期限内停止执行且不能由沙箱任务进程禁用 | Task 1 token replay/forgery cases, Task 2 PID 1/process-tree/UID tests, and Task 4 C7–C8 prove monotonic expiry, failed disable attempts, restart containment, and no CPU/socket progress after the measured deadline. |
| #748 恢复后旧授权不能直接复活 | Task 3 re-verification and Task 4 C9–C10 require current owner, loaded final policy, and reauthorization; old lease, receipt, and authorization version remain rejected. |
| A02 隔离与归属 | Task 2/3 exact tenant/workspace/Bot/environment/generation tests plus Task 4 C11 prove no cross-environment or cross-scope revival and no control-plane/signing credentials in workloads. |
| A02 策略或隔离失效不执行 | Task 3 blocks stale/provider-widened/unknown policy; Task 4 confirms the blocked path emits no new lease and does not weaken default deny. |
| A09 失联约束 | Task 2's PID 1 signed-lease guard and Task 4 C1–C8 prove independence from OpenShell/Kubernetes control, normal remote stop, and task-controllable heartbeats. |
| A09 安全恢复 | Task 3 and Task 4 C9–C10 prove recovery is a fresh server-side decision, with no automatic replay of interrupted side effects. |

Blocked gates: #736/#737 not verified in the current tree, T02/T03 actual interface mismatch, isolated cluster/database unavailable, selected version digest unverifiable, guard cannot prove process-tree termination, task can disable/fake the constraint, default not measured, missing independent Review/OCR, or any unexplained live skip. Do not close/relabel #748 or perform GitHub writes without separate authorization.

## Self-Review

1. **Spec coverage:** D4/A02 的 fail-closed 与归属/凭据边界、D25/A09 的独立约束、可配置宽限、期限停止和安全恢复均映射到 Tasks 1–4；#748 三条验收逐项对应 live cases。
2. **Step scan:** 每个 Task 均先写具名失败测试、给出精确 e2e 命令/收集数/GREEN 标准，再实施和提交；默认值只由实测公式产生，无未决占位。
3. **Type consistency:** `OpenShellExecutionScope`、`OpenShellConstraintStatus`、`OpenShellRecoveryVerification` 和 `OpenShellExecutionConstraintPort` 在 Tasks 2–3 与 T16 合同一致；lease claims/sequence/version 名称贯穿任务。
4. **Review Focus:** 五类失败模式均有 deterministic test 和 live fault case，特别是 guard 故障、任务禁用、时钟/重启、旧授权恢复与 issuer→relay 分区下的数据面执行。
5. **Proportion:** 计划固定接口、文件责任、安全不变量、测试矩阵和证据门槛；实现细节留给任务执行者，未转写完整程序。
