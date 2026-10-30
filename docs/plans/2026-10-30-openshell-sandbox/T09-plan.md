# T09 computer 网络申请与管理员授权闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Project execution rules determine actual dispatch and authorization.

**Goal:** Bot 为自己的 computer 申请指定目的地址，部署管理员在 OpenBot 批准，批准后下发到该执行归属的沙箱，并在核到 OpenShell 的 Loaded 回执与最终有效规则后才报告已生效。

**Architecture:** OpenBot 仍是网络权限的唯一权威与变更入口（D5）。新增一张按完整执行归属绑定的 durable grant 表，复用现有 `network_policies` 的 organization/group 长期规则作为基线，由一个纯函数把二者合成 OpenShell 模式下的期望策略；下发经 T01/T02 的 OpenShell adapter，写入后必须读回 Loaded generation 与最终有效目的（含 provider 附加规则）才可标记 `active`。`server/src/computer/policy-network.ts` 的异步 `pushEgressPolicies` 与 `NO_NETWORK_POLICY` 保持旧模式语义不变，不作为 OpenShell 模式的生效证明。

**Tech Stack:** TypeScript/Bun、Hono、Drizzle/Postgres、`agent-computer/src/egress.ts` 的规则与 matcher、tester-army `e2e`（ADR 0008）、隔离 Kubernetes 集群上选定版本的 OpenShell/Agent Sandbox controller/CNI。

**Spec:** [Spec v1](../../specs/2026-10-30-openshell-sandbox.md) A06、A07 与 D5、D11、D12、D16、D18（D19 限定模式范围）；[ADR 0013](../../adr/0013-openshell-sandbox-substrate.md)、[ADR 0006](../../adr/0006-logical-private-bot-scoped-execution.md)；[ticket breakdown](ticket-breakdown.md#t09--computer-网络申请与管理员授权闭环) T09。正式票为 [GitHub Issue #743](https://github.com/1123786563/OpenBot/issues/743)，真实 Blocked by [#736](https://github.com/1123786563/OpenBot/issues/736)（T02）与 [#739](https://github.com/1123786563/OpenBot/issues/739)（T05）。

## Global Constraints

- 本计划与 Issue #743 都不是实施授权。实施前按 `.agents/rules/issue-delivery.md` rescan：回读 #743 正文/验收/标签、#736 与 #739 状态、Spec 批准版本（`approved_content_sha256`）、目标分支 SHA，并与本轮摄取记录比对。
- **Blocked by T02（#736）与 T05（#739）verified**，且二者产物实际进入本工作区。动手前先读它们的真实接口并据实改本计划的名字：T01/T02 的 OpenShell provider 与可信 scope resolver（`OpenShellScope`、`scopeFor(botId)`）、T05 的 durable intent/outcome 合同（本计划的 `operationId` 就是它铸的键，真实名字以 T05 为准）。前置未 verified 即 blocked，不以 mock 顶替。
- OpenShell 模式下**默认拒绝**。`NO_NETWORK_POLICY = { mode: "allow_all" }`（`server/src/computer/policy-network.ts:40`）与 `effectiveNetworkPolicy` 的 `from: "none"` 分支是旧部署语义，不得成为 OpenShell 模式在"无策略行"时的答案；管理员显式写入的 `allow_all` 行仍是管理员决定，予以保留（D11、D19）。
- 只有部署管理员可批准网络扩权（D18）。判定用 `requireAdmin`（`server/src/auth/guards.ts:125`），服务层再判一次 `role === "admin"`。`server/src/approvals/*` 的 owner-scoped `ApprovalStore.decide`、`allow_always` 规则与团队审批规则都**不含**网络扩权，不得复用为扩权路径，也不得把 grant 建成 `ApprovalRecord`。管理员级审批队列沿用 `server/src/plugins/shared-use-routes.ts` 的形状（admin gate + 单事务 claim + 409）。
- 授权必须绑定完整执行归属 `tenant/workspace/Bot/environment=computer/generation`（ADR 0006、D7、D22）。策略范围从 organization/group 扩到执行归属时不得改变旧模式行为：不修改 `networkInput`（`server/src/admin/routes.ts:74`）、`PUT /network`（:294）、`DELETE /network/:scopeKind`（:339）与 `network_policies` 表的既有语义。
- 临时申请必须含目的、范围、有效期（D11、D16）：`reason` 非空、`rules` 非空且逐条过 `parseEgressRules`、`kind: "temporary"` 必须有 `expiresAt`。`isAlwaysDenied` 覆盖的云 metadata/link-local 目的即使管理员批准也不得进入任何策略。
- 到期与撤销语义归 T11。本票只产出可被 T11 消费的 grant 记录（`id/scope/taskId/expiresAt/status/policyGeneration`）与生命周期钩子（`ended`、`endCause`、`endedAt` 字段与 `markApplied/markFailed/markUnknown` 的写入位置），不实现到期扫描、不断已有连接。
- **下发返回成功不等于生效。** 必须核 OpenShell 的 Loaded 回执（`loadedPolicyGeneration`）与最终有效规则（`finalEffectiveDestinations`，含 provider 附加规则），确认请求的目的确实在其中，才可把 grant 标为 `active` 并报告已生效（A06）。异步推送（`pushEgressPolicies` 的 `EgressPushReport`、`controls.ts:657` 的 30s 补推、LISTEN/NOTIFY）不是强撤销证明，也不是生效证明。
- 关键操作先记 T05 durable intent 再执行并记结果（D15、A07）；中央审计不可用时普通扩权批准拒绝执行，不留未记录的 grant 状态变更。
- OpenShell 能力未证实即 blocked：选定版本读不到 Loaded 回执或最终有效规则时，不得宣称 A06 通过，也不得以"策略写入 200"替代。
- 完整档（身份权限、租户/沙箱隔离、持久化写入与迁移）。需独立行为验收 + Spec/质量 Review + 适用 OCR，证据归 `.archive/runs/<run-key>/verification/`，runner 原始输出归 `.e2e/<run-key>/T09-task<k>-<attempt>/`。
- 测试入口按 ADR 0008：纯逻辑与路由套件用 `tests/support/e2e-compat`（e2e 原生收集）；经 `createDatabase`（`server/src/db/client.ts` 依赖 `import { SQL } from "bun"`）的真实库套件用 `tests/support/bun-test-compat`，并以 `node scripts/e2e-add-driven.mjs <file> <reason>` 登记，否则 `scripts/e2e-coverage-audit.mjs` 判为 gap。真实库只用 `TEST_DATABASE_URL`（`server/tests/support/database.ts`）。
- 新增/改动的用户与管理员可见文案（申请、审批、状态、拒绝句）遵守 `.agents/skills/openbot-copy/SKILL.md`：说发生了什么再说下一步，第二人称，Bot/admin/OpenBot 词汇，非 Admin 页面不出现 grant/scope/deployment 等内部词；同时补 `app/src/locales/en/admin.json` 与 `zh-CN`。新路由数据读写遵守 `.agents/skills/openbot-data-access/SKILL.md`，页面形状遵守 `.agents/skills/openbot-screen-layout/SKILL.md`。

## Review Focus

1. 普通动作审批者借 `server/src/approvals/*`（owner-scoped `decide`、`allow_always` 规则、团队规则）扩权：任何 approval 决定都不得产生 `active` grant，网络申请也不得成为 `ApprovalRecord`。Task 1 的 `approval_paths_cannot_widen_network_grants` 钉住。
2. 未批准目的因"无策略即放行"被打开：OpenShell 模式在无任何策略行时必须答 `deny_all`，旧模式必须仍是 `allow_all`。Task 1 的 `openshell_unconfigured_denies_and_legacy_keeps_allow_all` 钉住。
3. 策略写入成功但沙箱未加载即报告已生效：Loaded generation 缺失或滞后时 grant 必须是 `failed`、访问仍被拒、管理员看到未生效。Task 2 的 `grant_without_loaded_receipt_is_failed_and_access_stays_refused` 钉住。
4. 批准作用到同 Bot 的另一环境或另一 tenant/workspace：期望策略按完整 scope 合成，另一 scope 的 adapter 不得被调用。Task 2 的 `approval_does_not_cross_scope_or_environment` 钉住。
5. 并发批准/取代使已 decline 或已 superseded 的目的重新出现在最终有效规则；provider 附加规则悄悄放行：只有单事务 claim 到的那一条能 `active`，最终有效规则里不得含被拒目的，provider 附加规则必须在回执里可见（供 T11 判断）。Task 2 的 `concurrent_decisions_activate_one_grant`、`concurrent_grant_approvals_serialize_by_scope` 与 `final_effective_rules_exclude_refused_destinations_and_expose_provider_rules` 钉住。

---

## File map 与依赖合同

**本票拥有**

- Create `server/src/db/schema/network-grants.ts`：`networkGrants` 表（下文字段）。必须同时加进 `server/src/db/schema/index.ts` barrel 与 `server/drizzle.config.ts` 的 `schema` 数组——该数组注释明说漏列的文件对 `generate` 不可见，下次生成会当作表不存在。
- Create 迁移 `server/drizzle/0NNN_network_grants.sql` + `server/drizzle/meta/0NNN_snapshot.json` + journal 条目，由 `bun run --cwd server db:generate` 产出。`NNN` 与 `when` 取实施时 `server/drizzle/meta/_journal.json` 的真实末尾（当前为 `0236_package_dispatch`，`when: 1793344800002`）：`idx = max+1`、`when = 前一条 + 1`，绝不写未来时间戳（`server/tests/migration-journal.test.ts` 会钉）。
- Create `server/src/computer/network-grants.ts`：grant 类型、`NetworkGrantStore`、`openShellNetworkPolicy` 合成、`applyNetworkPolicyForScope`、`decideNetworkGrant`。`network_grants` 表的唯一写入者是本文件（架构规则：一项业务事实只有一个 Module 写入；M09 ExecutionEnvironment 拥有执行环境事实）。
- Modify `server/src/computer/routes.ts`：新增 `POST /:botId/network-requests`、`GET /:botId/network-requests`。落在既有 `/:botId/*` 的 `canUseBot` 守卫内，不进 `DEPLOYMENT_ROUTES`。
- Modify `server/src/computer/headless-tools.ts`：在 `createHeadlessComputerTools`（:44）新增 `computer_request_network` 工具，经 `HeadlessToolSuspension`（`toolkit/src/headless-tools.ts:40`）挂起未值守回合，形状照 `computer_request_sign_in`（:245）。
- Modify `server/src/admin/routes.ts`：新增 `GET /network/grants`（返回 `listRecent(100)`，让 pending/failed/pending_reconciliation/active 都可见）、`POST /network/grants/:id/decision`，挂在既有 `routes.use("*")` 的 `requireAdmin` 之后；沿用 `unavailable(context)` 的 503 分支。
- Modify `server/src/admin/controls.ts`：`Snapshot`（:74）增 `grants` 与 `substrate`；`loadSnapshot` 读 grant；`policyForBot`（:413）经 `openShellNetworkPolicy` 合成；`decideFromSnapshot` 的 navigate 网络分支（:210-225）在 OpenShell 模式改为交给 scope-aware 的异步判定，不在此按 `botId` 放宽；grant 写入后照 `settings-store.ts` 的做法在 `ENTERPRISE_TOPIC` 上 announce，复用 :631 的 `refresh()` → `pushNetworkPolicies()` 与 :657 的 30s 补推。
- Modify `server/src/computer/gateway.ts`：navigate 路径增加 scope-aware 网络准入（OpenShell 模式），拒绝句沿用 `NavigationRefusedError`（`server/src/computer/client.ts:130`）与现有 `${decision.reason} An administrator can add it.` 的形状，新增句遵守 openbot-copy。
- Create `server/src/computer/openshell-network-policy.ts`：实现下述 `OpenShellNetworkPolicyAdapter`，只包装 T01/T02 已验证的 OpenShell 管理 client，不把控制面凭据带出集成服务。
- Modify `server/src/audit.ts`：`auditEventTypes`（:53）增 `network_grant.requested`、`network_grant.approved`、`network_grant.declined`、`network_grant.superseded`、`network_grant.applied`、`network_grant.apply_failed`、`network_grant.apply_unknown`、`network_grant.refused`。`server/tests/audit.test.ts:57` 要求每个新事件名在 `server/src` 内（audit.ts 除外）逐字出现，否则该套件红。
- Modify `app/src/routes/_authed/admin/enterprise.tsx` 的 Network `PageSection`（:323-397）：新增待批请求列表。Create `app/src/lib/network-grants/queries.ts`、`mutations.ts`。Modify `app/src/locales/{en,zh-CN}/admin.json` 的 `enterprise.network.*`。Bot 侧可见入口落在 `app/src/components/computer/computer-view.tsx` 的拒绝提示处，不新开屏幕。
- Create `scripts/openshell-network-grant-acceptance.ts`、`tests/openshell/network-grant.e2e.test.ts`（T11/T12 引用的 `tests/openshell/` live harness 路径由本票建立）。新 live 套件必须加进 `scripts/lib/e2e-manifest.mjs` 的 `LIVE_SUITES`（:220）并在无 `OPENBOT_LIVE_OPENSHELL` 时自 skip，否则 `tests/**` glob 会把它当普通套件收集。
- Create/modify 测试：`server/tests/openshell-network-grant.test.ts`、`server/tests/openshell-network-approval.test.ts`（native，e2e-compat）；`server/tests/openshell-network-grant-store.integration.test.ts`（Bun-driven，需登记）；`app/tests/network-grant-requests.test.tsx`。

**消费上游（实施前先读真实实现，名字不符就改本计划）**

- T01/T02：`OpenShellScope = { tenantId; workspaceId; botId; environment: "computer" | "coding"; generation }`、`scopeFor(botId): Promise<OpenShellScope | null>`、`createOpenShellComputerProvider`、部署级 substrate 选择（`server/src/config.ts`，T01 计划写作 `OPENBOT_SANDBOX_SUBSTRATE=openshell`）。scope 只能由可信服务端路径解析，不得采信 `x-openbot-tenant-id` / `x-openbot-workspace-id` 客户端头（`shared/execution-scope.ts` 的三态合同：object 注入、null 拒绝、undefined 不管）。
- T05：durable intent/outcome 与紧急处置记录。本票的 `operationId` 即其操作键；重复 `operationId` 必须返回同一结果。
- 既有：`EgressPolicy`、`EgressRule`、`EgressMode`、`EGRESS_MODES`、`parseEgressRules`、`egressDecision`、`isAlwaysDenied`、`DEFAULT_EGRESS_DESTINATIONS`（`agent-computer/src/egress.ts:182/186/192/194/264/420/403/205`，经 `server/src/computer/policy-network.ts` 再导出）；`effectiveNetworkPolicy`（`policy-network.ts:42`）；`NetworkPolicyRow`（`server/src/admin/settings-store.ts:78`）；`Member`/`resolveCapability`（`server/src/admin/capabilities.ts:112/121`）；`recordAuditEvent`（`server/src/audit.ts:1240`）；`requireAdmin`（`server/src/auth/guards.ts:125`）。

**Produces（T10/T11 精确合同；T11 已假定可消费"durable grant ID、scope、expiry、task ID、status"与"loaded policy generation / final effective destinations"，命名按此对齐）**

```ts
export type NetworkGrantScope = {
  tenantId: string; workspaceId: string; botId: string;
  environment: "computer" | "coding";
};
export type NetworkGrantStatus =
  | "pending" | "approved" | "active"
  | "declined" | "superseded" | "failed"
  | "pending_reconciliation"
  | "ended";                       // T11 拥有转入 ended 的所有转移
export type NetworkGrant = {
  id: string;                      // T11 的 durable grant ID
  scope: NetworkGrantScope;
  kind: "temporary";               // D16：长期规则仍是 network_policies，由管理员单独配置
  direction: "egress";             // 本票只扩大出站目的；入站不在范围
  reason: string;                  // 目的，非空
  rules: EgressRule[];             // 范围；方向只有"扩大"
  fingerprint: string;             // 排序归一后 rules 的稳定哈希，用于去重/取代
  taskId: string | null;           // T11 的 task ID：responsibilityRuns.id / routineRuns.id / `thread:${threadId}`
  threadId: string | null; toolCallId: string | null;
  continuation: Record<string, unknown> | null;  // parseApprovalContinuation 形状，供挂起回合恢复
  requestedBy: string; requestedAt: Date;
  expiresAt: Date;                 // T11 的 expiry
  status: NetworkGrantStatus;
  decidedBy: string | null; decidedAt: Date | null;
  operationId: string | null;      // T05 durable 操作键
  policyGeneration: string | null; // 生效回执确认的那一代
  appliedAt: Date | null;
  endedAt: Date | null; endCause: "task_end" | "expired" | "admin" | null;  // T11 写
};

export type NetworkGrantStore = {
  fileRequest(input: {
    scope: NetworkGrantScope; reason: string;
    rules: EgressRule[]; taskId?: string | null; threadId?: string | null;
    toolCallId?: string | null; continuation?: Record<string, unknown> | null;
    requestedBy: string; expiresAt: Date;
  }): Promise<{ grant: NetworkGrant; created: boolean }>;
  listPending(): Promise<NetworkGrant[]>;
  listRecent(limit: number): Promise<NetworkGrant[]>;  // Admin 状态列表：pending/failed/unknown/active 都可见
  listForScope(scope: NetworkGrantScope, now: Date): Promise<NetworkGrant[]>;
  snapshot(now: Date): Promise<NetworkGrant[]>;   // approved + active，供企业 Snapshot
  claimDecision(input: { grantId: string; by: string; decision: "approve" | "decline" }): Promise<NetworkGrant>;
  markApplied(input: { grantId: string; policyGeneration: string; appliedAt: Date }): Promise<void>;
  markFailed(input: {
    grantId: string; policyGeneration: string | null; reason: string;
  }): Promise<void>;
  markUnknown(input: {
    grantId: string; policyGeneration: string | null; reason: string;
  }): Promise<void>;
  /**
   * Per-scope serialization for policy side effects. Use a dedicated Postgres
   * session advisory lock (or T05's actual equivalent), never a long database
   * transaction around adapter calls.
   */
  withNetworkPolicyOperation<T>(input: {
    scope: NetworkGrantScope; operationId: string;
    operation: () => Promise<T>;
  }): Promise<T>;
  // T11 在同一对象上追加 endTemporaryGrant / listDueTemporaryGrants，不新建第二张 grant 表。
};

/** 唯一放宽网络权限的地方。base 来自 effectiveNetworkPolicy。 */
export function openShellNetworkPolicy(input: {
  base: EgressPolicy & { from: string };
  grants: readonly NetworkGrant[];
  substrate: "legacy" | "openshell";
  now: Date;
}): EgressPolicy & { from: string };

export type OpenShellNetworkPolicyAdapter = {
  applyDesiredPolicy(input: {
    scope: OpenShellScope; desired: EgressPolicy; operationId: string;
  }): Promise<{ policyGeneration: string }>;
  /** OpenShell 报告为 Loaded 的那一代；null 表示什么都没加载。 */
  loadedPolicyGeneration(scope: OpenShellScope): Promise<string | null>;
  /** 沙箱声称在力的规则，含 provider 自己附加的。 */
  finalEffectiveDestinations(scope: OpenShellScope): Promise<{
    generation: string; mode: EgressMode;
    rules: EgressRule[]; providerAdded: EgressRule[];
  } | null>;
  // T11 追加 establishedConnectionOutcome(...)；本票不实现也不声称。
};

export type NetworkApplyOutcome =
  | { status: "effective"; policyGeneration: string }
  | { status: "not_loaded"; policyGeneration: string | null; reason: string }
  | { status: "unknown"; policyGeneration: string | null; reason: string };

export async function applyNetworkPolicyForScope(input: {
  scope: OpenShellScope; desired: EgressPolicy; operationId: string;
  adapter: OpenShellNetworkPolicyAdapter; deadlineMs?: number;
}): Promise<NetworkApplyOutcome>;

/** 管理员审批入口。role !== "admin" 直接拒绝（D18 的第二道）。 */
export async function decideNetworkGrant(input: {
  grantId: string; by: { id: string; role: "admin" | "user" };
  decision: "approve" | "decline"; operationId: string;
}): Promise<{ grant: NetworkGrant; outcome: NetworkApplyOutcome | null }>;
```

`network_grants` 表列与上述字段一一对应，外加：`(tenant_id, workspace_id, bot_id, environment, fingerprint) WHERE status = 'pending'` 的唯一部分索引（照 `shared_use_requests_pending_idx` 的做法，重复申请返回同一 id，不同申请把旧 pending 置 `superseded`）；`(tenant_id, workspace_id, bot_id, environment, status)` 索引；`expires_at WHERE status = 'active'` 索引（T11 的到期扫描用）；`status` 与 `end_cause` 的 check 约束。

---

### Task 1: durable grant 记录、申请入口与默认拒绝合成

**Files:**
- Create: `server/src/db/schema/network-grants.ts`、`server/src/computer/network-grants.ts`
- Modify: `server/src/db/schema/index.ts`、`server/drizzle.config.ts`、`server/drizzle/`（生成迁移与 journal）、`server/src/audit.ts`、`server/src/computer/routes.ts`、`server/src/computer/headless-tools.ts`
- Test: `server/tests/openshell-network-grant.test.ts`（native）、`server/tests/openshell-network-grant-store.integration.test.ts`（Bun-driven）

**Interfaces:**
- Consumes: `EgressRule`/`EgressPolicy`/`parseEgressRules`/`isAlwaysDenied`（`agent-computer/src/egress.ts`）、`effectiveNetworkPolicy`（`server/src/computer/policy-network.ts:42`）、T01 的 substrate 选择、`createComputerRoutes` 的既有 `canUseBot` 守卫与 `act` 辅助（`server/src/computer/routes.ts:935`）、`createHeadlessComputerTools`（`server/src/computer/headless-tools.ts:44`）、`recordAuditEvent`。
- Produces: `NetworkGrantScope`、`NetworkGrantStatus`、`NetworkGrant`、`NetworkGrantStore.fileRequest/listForScope/snapshot`、`openShellNetworkPolicy`（签名见上）。Task 2/3/4 与 T10/T11 全部按此命名。

- [ ] **Step 1: 写失败测试。** 在 `server/tests/openshell-network-grant.test.ts` 写四条纯逻辑用例：
  - `openshell_unconfigured_denies_and_legacy_keeps_allow_all`：`openShellNetworkPolicy({ base: { ...NO_NETWORK_POLICY, from: "none" }, grants: [], substrate: "openshell", now })` 得 `{ mode: "deny_all", rules: [] }`；同样输入 `substrate: "legacy"` 得 `{ mode: "allow_all", rules: [] }`；`base.from === "capability"`（`cloudNetwork` 关闭）时即使传入 `status: "active"` 的 grant 也仍是 `deny_all`。
  - `active_grants_widen_only_their_own_rules`：base 为 `allowlist_only` + 一条 domain 规则，一条 active grant 带 `{ type: "domain", value: "example.org" }` 与一条 `expiresAt` 已过的 active grant 带 `pypi.test`，结果 rules 含 `example.org`、不含 `pypi.test`，mode 不被 grant 改成 `allow_all`。
  - `always_denied_destinations_cannot_be_requested_or_granted`：`fileRequest` 的入参校验（导出为纯函数以便直接测）对 `169.254.169.254`、`100.100.100.200`、`::ffff:169.254.169.254`、空 `reason`、空 `rules`、缺 `expiresAt`、`direction !== "egress"`、`parseEgressRules` 判为非法的规则一律拒绝并给出可读理由；合法输入归一出稳定 `fingerprint`（规则顺序不同、大小写不同、尾点不同 → 同一 fingerprint）。
  - `approval_paths_cannot_widen_network_grants`：结构断言 + 行为断言两半。结构半照 `server/tests/connector-tokens-never-reach-computer.test.ts` 的读源码方式，断言 `server/src/approvals/` 下任何 `.ts` 都不出现 `network_grants`、`NetworkGrantStore`、`decideNetworkGrant`、`openShellNetworkPolicy`；行为半用一个带 `behaviour: "pre_approved"` 且 `toolRef: "computer_request_network"` 的 `ApprovalRule` 走 `decideAction`，断言结果不含任何 grant 状态变化，且 `computer_request_network` 不被 `allow_always` 变成常驻规则写入。
  在 `server/tests/openshell-network-grant-store.integration.test.ts` 写三条真实库用例（`describeDb = ENV.ok ? describe : describe.skip`，缺显式 `TEST_DATABASE_URL` 整套 skip，skipped 不计通过）：`an_identical_pending_request_is_not_filed_twice`（同 fingerprint 第二次返回同一 `id`、`created: false`）、`a_different_request_supersedes_the_pending_one`（旧行变 `superseded`，新行 `pending`）、`a_request_survives_a_restart_and_is_scope_bound`（新建 store 实例后 `listForScope` 仍读到，且 tenant/workspace/Bot/environment 任一不同的 scope 读不到）。
- [ ] **Step 2: 跑 RED。** `E2E_UNIT_OUTPUT=.e2e/<run-key>/T09-task1-red e2e run --config e2e.unit.config.ts server/tests/openshell-network-grant.test.ts`；再 `node scripts/e2e-add-driven.mjs server/tests/openshell-network-grant-store.integration.test.ts "reaches createDatabase, which imports SQL from bun"` 后 `E2E_UNIT_OUTPUT=.e2e/<run-key>/T09-task1-red-db E2E_BUN_ONLY=server/tests/openshell-network-grant-store.integration.test.ts e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`。期望：新增用例全部因 `openShellNetworkPolicy`/`NetworkGrantStore`/表不存在而失败；报告里实际收集数 = 新增用例数，无未解释 skip（数据库未配置时的整套 skip 必须在报告里写明原因）。
- [ ] **Step 3: 最小实现。** 写 `server/src/db/schema/network-grants.ts`（列与索引见 File map），加进 barrel 与 `drizzle.config.ts`，跑 `bun run --cwd server db:generate` 产出迁移并核 journal 的 `idx`/`when` 单调；写 `server/src/computer/network-grants.ts` 的 `fingerprintOf`、入参校验、`openShellNetworkPolicy`、`createNetworkGrantStore(database)` 的 `fileRequest/listForScope/snapshot`（`fileRequest` 用单事务 `for update` + 部分唯一索引，照 `shared-use-store.ts:519` 的 `fileRequest`）；在 `server/src/audit.ts` 增事件名并在写 grant 处逐字使用；在 `server/src/computer/routes.ts` 加 `POST /:botId/network-requests`（走 `act`，scope 由服务端可信路径解析，body 只带 `reason`/`rules`/`expiresAt`/`taskId`，绝不带 tenant/workspace）与 `GET /:botId/network-requests`；在 `server/src/computer/headless-tools.ts` 加 `computer_request_network`，成功后抛 `HeadlessToolSuspension(reason, { kind: "computer_network_grant", botId, requestId: grant.id })`。`openShellNetworkPolicy` 只读纯函数，不查库。
- [ ] **Step 4: 跑 GREEN。** 同 Step 2 两条命令，输出改 `T09-task1-green` / `T09-task1-green-db`。期望：全部新增用例收集并通过，实际用例数与 Step 2 一致；`node scripts/e2e-coverage-audit.mjs` 退出 0（新文件落进 native 与 driven 两个桶）；`bun run --cwd server typecheck` 通过；`server/tests/audit.test.ts`、`server/tests/schema.test.ts`、`server/tests/migration-journal.test.ts`、`server/tests/schema-drizzle-parity.test.ts` 仍绿。
- [ ] **Step 5: 提交。** 只 add 本 Task 授权文件（schema、迁移与 journal、`network-grants.ts`、`routes.ts`、`headless-tools.ts`、`audit.ts`、两个测试文件、barrel、`drizzle.config.ts`、driven manifest 与其分区产物），message 形如 `feat(computer): durable network grant requests with OpenShell default-deny composition`。不提交本计划文件以外的其他票产物，不推送。

### Task 2: 部署管理员审批、按 scope 下发与生效回执门禁

**Files:**
- Create: `server/src/computer/openshell-network-policy.ts`
- Modify: `server/src/admin/routes.ts`、`server/src/admin/controls.ts`、`server/src/computer/network-grants.ts`、`server/src/computer/gateway.ts`
- Test: `server/tests/openshell-network-approval.test.ts`（native，路由用 Hono + fake store/fake adapter，照 `server/tests/computer-policy-route.test.ts` 的装配方式）

**Interfaces:**
- Consumes: Task 1 的全部 Produces；T05 的 durable intent/outcome（`operationId`）；T02 的 `scopeFor(botId)` 与 provider；`requireAdmin`；`enterpriseControls()` 的 `Snapshot`/`refresh`/`pushNetworkPolicies`/`policyForBot`；`ENTERPRISE_TOPIC`。
- Produces: `NetworkGrantStore.listRecent/claimDecision/markApplied/markFailed/markUnknown/withNetworkPolicyOperation`、`OpenShellNetworkPolicyAdapter`（三方法，签名见上）、`NetworkApplyOutcome`、`applyNetworkPolicyForScope`、`decideNetworkGrant`。T10 用同一 store 与 adapter 换 `environment: "coding"`；T11 在同一 adapter 上追加连接处置方法，并消费 `policyGeneration` 与 `loadedPolicyGeneration`。

- [ ] **Step 1: 写失败测试。** 在 `server/tests/openshell-network-approval.test.ts` 写十条：
  - `non_admin_decision_is_refused_and_the_grant_stays_pending`：`role: "user"` 打 `POST /network/grants/:id/decision` 得 403 且 adapter 零调用；直接调 `decideNetworkGrant({ by: { role: "user" } })` 也被拒（两道门都在）。
  - `approval_does_not_cross_scope_or_environment`：同 Bot 在 workspace A 的 computer 有一条 active grant，断言 workspace B 的同 Bot、以及 workspace A 的同 Bot 的 `environment: "coding"`，其 `applyDesiredPolicy` 都没被调用、`openShellNetworkPolicy` 合成结果不含该目的。
  - `grant_without_loaded_receipt_is_failed_and_access_stays_refused`：fake adapter 的 `applyDesiredPolicy` 返回 `{ policyGeneration: "g2" }` 但 `loadedPolicyGeneration` 返回 `"g1"`（滞后）或 `null`；断言 `applyNetworkPolicyForScope` 得 `not_loaded`、grant 变 `failed`、`policyGeneration` 记为读回的那一代或 null、管理员响应里可见未生效，且 scope-aware 网络准入对该目的仍拒绝。
  - `effective_requires_the_destination_in_final_rules`：`loadedPolicyGeneration` 返回 `"g2"` 但 `finalEffectiveDestinations` 的 `mode`/`rules` 不覆盖所请求目的 → 仍不得 `effective`。
  - `final_effective_rules_exclude_refused_destinations_and_expose_provider_rules`：一条 declined 与一条 superseded 的目的不出现在下发给 adapter 的 `desired.rules`；`providerAdded` 非空时回执必须原样带回（供 T11 与 Task 4 判断），不得被当作 OpenBot 批准的规则写进 grant。
  - `concurrent_decisions_activate_one_grant`：两个并发 `decideNetworkGrant` 打同一 grantId，只有一个得到 `approved`，另一个拿到已决定错误（路由映 409，照 `SharedUseRequestDecidedError`）；`markApplied` 只被调用一次。
  - `concurrent_grant_approvals_serialize_by_scope`：同一 scope 的两条不同 grant 并发批准，per-scope 串行化后两条都在最终 desired policy 与最终有效规则里，adapter 的 `policyGeneration` 单调递增，后一次不得丢掉前一条目的。
  - `lost_adapter_reply_leaves_reconcilable_unknown_and_grants_no_access`：fake adapter 在 apply 后抛出连接丢失/超时，断言 grant 是 `pending_reconciliation` 而不是 `active`，T05 outcome 是 unknown 且带 `operationId`/`policyGeneration`（可为 null），`network_grant.apply_unknown` 可读回，目标目的访问仍被拒。
  - `audit_intent_and_receipt_are_reconcilable`：正常批准写 T05 intent（先于任何 adapter 调用）、`network_grant.approved`、成功后 `network_grant.applied`（payload 含 `operationId`、`policyGeneration`、`loadedGeneration`、`finalEffective` 摘要与完整 scope）；重复同一 `operationId` 不产生第二条 intent 也不二次下发。
  - `grant_approval_refuses_when_central_audit_is_unavailable`：T05 报中央审计不可用时，批准被拒、grant 仍 `pending`、adapter 零调用（D15：普通扩权不是紧急收紧，不享受"审计故障仍执行"）。
  另加一条旧模式回归：`legacy_network_routes_and_push_are_unchanged`——`PUT /network`、`DELETE /network/:scopeKind`、`network_policy.changed`/`network_policy.removed` 审计、`pushEgressPolicies` 的 `EgressPushReport` 形状与 `NO_NETWORK_POLICY` 的 `allow_all` 全部照旧。
- [ ] **Step 2: 跑 RED。** `E2E_UNIT_OUTPUT=.e2e/<run-key>/T09-task2-red e2e run --config e2e.unit.config.ts server/tests/openshell-network-approval.test.ts server/tests/computer-policy-route.test.ts server/tests/egress-policy-on-wake.test.ts server/tests/enterprise-controls.test.ts`。期望：新增十条 + 一条回归红（缺路由/缺 adapter 方法/缺合成/缺串行化），四个既有套件的原有用例仍绿；记录实际收集数。
- [ ] **Step 3: 最小实现。** 在 `server/src/computer/openshell-network-policy.ts` 按上方合同实现三个 adapter 方法；Task 4 的 spike 负责证明选定 OpenShell API 真能支撑它们，证不出来即 blocked。写 `applyNetworkPolicyForScope`：`applyDesiredPolicy` → 在 `deadlineMs`（默认 15_000）内轮询 `loadedPolicyGeneration` 直到等于本次 `policyGeneration` → 读 `finalEffectiveDestinations` 并按其 `mode` 与 `rules` 核对 `desired.rules` 都被覆盖 → 三者全满足才 `effective`；回执缺失或超时按可区分的方式落 `not_loaded`（明确读到旧代/空）或 `unknown`（读不到/连接丢失）。写 `decideNetworkGrant`：先判 `role === "admin"`，写 T05 intent，`claimDecision` 单事务 claim，approve 时按 grant 的完整 scope 解析 `OpenShellScope`（含 `generation`）、用 `openShellNetworkPolicy` 合成期望策略，再进 `withNetworkPolicyOperation`（per-scope 串行化；不得把 adapter 调用包进数据库事务）调 `applyNetworkPolicyForScope`，据结果 `markApplied`/`markFailed`/`markUnknown`，写 `network_grant.applied`/`apply_failed`/`apply_unknown`；decline 只写状态与审计，不下发。在 `server/src/admin/routes.ts` 加两条路由（沿用既有 admin gate 与 `unavailable`）。在 `server/src/admin/controls.ts` 把 grant 纳入 `Snapshot`、`policyForBot` 与 announce 路径，并让 `decideFromSnapshot` 的 navigate 网络分支在 OpenShell 模式不自行放宽（交 `server/src/computer/gateway.ts` 的 scope-aware 准入），legacy 分支逐字不动。
- [ ] **Step 4: 跑 GREEN。** 同 Step 2 命令，输出 `T09-task2-green`。期望：新增用例全绿、四个既有套件全绿、无未解释 skip；再跑 `E2E_UNIT_OUTPUT=.e2e/<run-key>/T09-task2-db E2E_BUN_ONLY=server/tests/enterprise-controls.integration.test.ts e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` 确认 `describe("network policy")`（:677）原有断言未回归；`bun run --cwd server typecheck`。
- [ ] **Step 5: 提交。** 只 add 本 Task 授权文件，message 形如 `feat(admin): deployment-admin network grant approval with loaded-policy receipt gate`。

### Task 3: 管理员审批界面与 Bot 侧可见路径

**Files:**
- Create: `app/src/lib/network-grants/queries.ts`、`app/src/lib/network-grants/mutations.ts`
- Modify: `app/src/routes/_authed/admin/enterprise.tsx`（Network `PageSection`，:323-397）、`app/src/locales/en/admin.json` 与 `zh-CN/admin.json`（`enterprise.network.*`）、`app/src/components/computer/computer-view.tsx`（拒绝时的可申请提示）
- Test: `app/tests/network-grant-requests.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `GET /api/admin/enterprise/network/grants` 与 `POST /api/admin/enterprise/network/grants/:id/decision`；`client`（`app/src/lib/client.ts`）；`PageShell`/`PageSection`/`PageRows`/`Item` 与 `SharedUseRequests`（`app/src/components/approvals/shared-use-requests.tsx`）的行形状；`app/src/lib/enterprise/queries.ts` 的 `NetworkPolicy`/`EnterpriseOverview`。
- Produces: `networkGrantKeys`（挂在 `["approvals", "network-grants"]` 下，与 `sharedUseKeys` 同族，让审批收件箱的刷新覆盖它）、`networkGrantRequestsQueryOptions(enabled: boolean)`、`decideNetworkGrantMutationOptions(queryClient)`。T10 在 coding 侧复用同一组 factory，只换 `environment`。

- [ ] **Step 1: 写失败测试。** 在 `app/tests/network-grant-requests.test.tsx` 写三条：`an_admin_sees_request_status_with_purpose_scope_and_expiry`（pending、failed、pending_reconciliation、active 各有一行，显示 Bot、目的、有效期、申请理由；只有 pending 行有 Approve/Decline，failed/unknown 行显示未生效）；`a_member_sees_no_approve_control`（非 admin 渲染不出 Approve/Decline，照 `SharedUseRequests` 的 `isAdmin` 分支）；`refusal_copy_names_the_destination_and_the_next_step`（computer 侧拒绝提示含被拒目的与"申请访问"入口，断言短句与关键词，不断言长解释文案——openbot-copy 的 "A test asserting long explanatory copy" 红旗）。
- [ ] **Step 2: 跑 RED。** `E2E_UNIT_OUTPUT=.e2e/<run-key>/T09-task3-red e2e run --config e2e.unit.config.ts app/tests/network-grant-requests.test.tsx`。期望：三条因组件与 query/mutation factory 不存在而失败。
- [ ] **Step 3: 最小实现。** 按 openbot-data-access 建 `queries.ts`/`mutations.ts`（`client` 是唯一 fetch，mutation 成功后 invalidate `networkGrantKeys` 与 `enterpriseKeys`）；按 openbot-screen-layout 在 Network `PageSection` 内用 `Item` 行 + `Separator` 列待批请求，不新造容器宽度或卡片；文案按 openbot-copy 写进两份 locale（英文与中文键一一对应，Admin 页可出现 grant/scope 等内部词，Bot 侧提示不得出现）；computer 侧在既有网络拒绝处加"申请访问"入口，指向 `POST /:botId/network-requests`。
- [ ] **Step 4: 跑 GREEN。** 同 Step 2 命令，输出 `T09-task3-green`，三条用例全绿且无 skip；`bun run --cwd app typecheck`。Task 4 的 live 验收负责证明页面入口与真实服务闭环。
- [ ] **Step 5: 提交。** 只 add 本 Task 授权文件，message 形如 `feat(app): admin network grant approvals and Bot-side request path`。

### Task 4: 选定版本上的真实集群验收

**Files:**
- Create: `scripts/openshell-network-grant-acceptance.ts`、`tests/openshell/network-grant.e2e.test.ts`
- Modify: `scripts/lib/e2e-manifest.mjs`（`LIVE_SUITES`）、`package.json`（新增 `test:live-openshell-network`，argv 照 `test:smoke`/`test:api` 的写法）
- 证据只写 `.archive/runs/<run-key>/verification/`，不写进本计划

`package.json` 的入口固定为 `test:live-openshell-network = "OPENBOT_LIVE_OPENSHELL=1 e2e run --config e2e.unit.config.ts tests/openshell/network-grant.e2e.test.ts"`；`E2E_UNIT_OUTPUT` 仍由每次验收显式提供，避免并发会话覆盖报告。

**Interfaces:**
- Consumes: Task 1–3 的全部产物；T01 固定的 OpenShell/controller/CNI/存储版本与集群装配；T02 的 scope-bound computer provider 与已鉴权 computer 路由；T05 的 intent/outcome 存储。
- Produces: T10/T11 复用的 live harness 路径 `tests/openshell/`，以及"选定版本能否读回 Loaded 回执与最终有效规则"的实测结论。T11 的 Task 3 直接在此文件旁加撤销用例。

- [ ] **Step 1: 本 Task 接线之前先做能力 spike，并核资源归属。** 在隔离集群上锁定并记录 OpenShell 发布版本与镜像 digest、Agent Sandbox controller/CRD 版本、CNI 及其 NetworkPolicy 执行情况、存储后端、宿主内核、集成服务 service account 的 RBAC 范围；逐项记录真实命令、输出、失败与官方文档来源（基线 [policies v0.1.6](https://docs.nvidia.com/openshell/v0.1.6/how-it-works/policies/manage-policies)：官方称策略加载会关闭旧连接，但**须核 Loaded 与最终有效策略，且 provider 附加规则可能继续授予访问**）。同时验明：能否从一个沙箱的 scope 读回 Loaded generation、能否读回最终有效目的列表、能否区分 provider 附加规则与 OpenBot 下发的规则。**任一项读不到即把 T09 标 blocked，不猜 endpoint 或资源字段，不以 `pushEgressPolicies` 的成功报告或 `PUT /egress-policy` 的 200 顶替生效证据。** 集群、namespace、测试 tenant/workspace/Bot 必须是本轮专用：脚本先验证集群身份与本轮资源 owner，列出将创建的每个资源，失败时不清理他人资源（`.agents/rules/testing.md`）。
- [ ] **Step 2: 写失败的 live 测试。** 在 `tests/openshell/network-grant.e2e.test.ts` 经 OpenBot 已鉴权入口（不得直连沙箱或裸 adapter）逐条断言六条，无 `OPENBOT_LIVE_OPENSHELL` 时整套自 skip 且 skip 原因写进报告：
  - 默认拒绝：新 scope 的 computer 对一个未申请目的发起导航，三层都拒——OpenBot 的 scope-aware 准入、沙箱内 egress 过滤、CNI 层实际不可达（用真实连接结果证明，不只断言 OpenBot 的拒绝句）。
  - 批准后仅目标 computer 可达：部署管理员批准后，目标 scope 与 generation 的 computer 实际取回该目的的内容；同 Bot 的另一 workspace、另一 Bot、同 Bot 的另一 computer generation 对同一目的仍不可达。coding 环境在本票只断言合同层不继承 grant，真实 coding 可达性归 T10，不把 T03 设为本票隐藏前置。
  - 越权审批被拒：Bot owner（普通动作审批者）经 `POST /api/approvals/:id/decision` 与 `allow_always` 规则处理后，目标 computer 仍不可达且 `network_grants` 无 `active` 行；非 admin 打管理员决策路由得 403。
  - 策略未加载/加载失败时拒绝并可见：注入一次加载失败（例如让 controller 拒绝该策略或使回执滞后一代），断言 API 不返回已生效、grant 落 `failed`、管理员界面显示未生效、目标 computer 仍不可达。
  - 审计意图与生效回执可核对：从 T05 的 intent/outcome 与 `network_grant.applied` 审计行读回 `operationId`、`policyGeneration`、Loaded generation 与最终有效目的，并与**直接从沙箱侧独立读到的**那一份逐项比对一致；同时记录 provider 附加规则的实际内容。
  - `169.254.169.254` 等 `isAlwaysDenied` 目的即使管理员批准也不可达。
- [ ] **Step 3: 跑 RED。** `OPENBOT_LIVE_OPENSHELL=1 E2E_UNIT_OUTPUT=.e2e/<run-key>/T09-task4-red e2e run --config e2e.unit.config.ts tests/openshell/network-grant.e2e.test.ts`。期望：尚未接通的行为以明确断言失败暴露，而不是以连接错误或超时形式假失败；记录实际收集数。
- [ ] **Step 4: 最小接线后跑 GREEN。** 只补 live 暴露出的真实缺口（版本绑定、回执读取、注入手段），不放宽已批准边界、不为通过测试关掉 Chromium 沙箱或 CNI 策略。`OPENBOT_LIVE_OPENSHELL=1 E2E_UNIT_OUTPUT=.e2e/<run-key>/T09-task4-green e2e run --config e2e.unit.config.ts tests/openshell/network-grant.e2e.test.ts`，并用 `bun run scripts/openshell-network-grant-acceptance.ts` 跑同一组注入以留下可读原始报告。要求：实际收集用例数与 Step 2 一致、无未解释 skip、每条注入的结论逐项可核。随后按 `testing.md` 的清理条款移除本轮创建的每个资源并 inspect 确认已移除（仅停止不够），只清本轮已核归属资源。
- [ ] **Step 5: 归档、审、提交。** 把版本/digest、命令与退出码、源树检查点（含子模块 SHA 与脏检查）、每个服务实际版本、用例/失败/跳过计数、注入项与原始报告、脱敏后的证据副本写入 `.archive/runs/<run-key>/verification/`（脱敏按 `artifacts.md`：不含凭据、连接串、完整环境）。跑受影响的 T01/T02 网络与 provider 套件、`server/tests/enterprise-controls.integration.test.ts`、server 与 app typecheck、聚焦 lint；按 `.agents/rules/review.md` 取得独立行为验收 + Spec/质量 Review + 适用 OCR（`--audience agent`，先 `ocr review --preview` 核范围）。只 add 本 Task 授权文件，message 形如 `test(openshell): live acceptance for computer network grant approval`。任何未解决的 medium 及以上 finding、任何未证实的 OpenShell 回执能力，都让 T09 保持未验证。

---

## Independent acceptance（验收标准）

**Issue #743 勾选项 → Task 与测试**

- [ ] 默认拒绝 → Task 1 `openshell_unconfigured_denies_and_legacy_keeps_allow_all`、`always_denied_destinations_cannot_be_requested_or_granted`；Task 2 `legacy_network_routes_and_push_are_unchanged`（证明默认拒绝没有靠改旧模式换来）；Task 4 live "默认拒绝"与 metadata 目的两条。
- [ ] 部署管理员批准后仅目标 computer 获授权 → Task 2 `approval_does_not_cross_scope_or_environment`、`effective_requires_the_destination_in_final_rules`；Task 4 live "批准后仅目标 computer 可达"（含跨 workspace、跨 Bot、跨 computer generation 三个反例；coding 环境的实机反例归 T10）。
- [ ] 普通动作审批者无权扩权 → Task 1 `approval_paths_cannot_widen_network_grants`；Task 2 `non_admin_decision_is_refused_and_the_grant_stays_pending`；Task 4 live "越权审批被拒"。
- [ ] 审计意图与生效回执可核对 → Task 2 `audit_intent_and_receipt_are_reconcilable`、`grant_approval_refuses_when_central_audit_is_unavailable`、`grant_without_loaded_receipt_is_failed_and_access_stays_refused`；Task 4 live "审计意图与生效回执可核对"（与沙箱侧独立读回的一份逐项比对）。

**A06（D5、D11–D12、D16、D18）本票覆盖的部分**

- 未授权地址拒绝：Task 1 + Task 4 live。
- 只有部署管理员可扩权：Task 2 两道门 + Task 4 live。
- 临时申请含目的、范围、有效期，且授权绑定完整执行归属：Task 1 入参校验与表约束 + Task 2 scope 合成。
- 核最终有效规则、含 provider 附加规则、不提前报告成功：Task 2 `final_effective_rules_exclude_refused_destinations_and_expose_provider_rules`、`grant_without_loaded_receipt_is_failed_and_access_stays_refused` + Task 4 live 注入。
- **不归本票**：临时授权先到期或先结束即撤销、现存长连接断开、并发撤销后不得重新开放——全部归 T11。本票只保证 T11 能消费 `id/scope/taskId/expiresAt/status/policyGeneration` 与 `loadedPolicyGeneration`/`finalEffectiveDestinations`，并保留 `ended`/`endCause`/`endedAt` 与 `expires_at` 索引。A06 的撤销半部在 T11 verified 之前不得声称通过。

**A07（D14–D15）本票覆盖的部分**

- 扩权这类普通关键操作先记 T05 intent 再执行并记结果；重复 `operationId` 只一次下发；中央审计不可用时批准被拒且不产生未记录的 grant 状态变更：Task 2 `audit_intent_and_receipt_are_reconcilable`、`grant_approval_refuses_when_central_audit_is_unavailable`。
- **不归本票**：审计故障下紧急停止与权限收紧仍执行并可恢复对账（T05/T11）、未知外部副作用不自动重放（D14，T15）。

**Blocked 门槛（命中即报 blocked，不降级验收、不放宽边界）**

- T02（#736）或 T05（#739）未在本工作区 verified，或其真实接口与本计划命名不符且无法在不改 Spec 的前提下映射 → 不开始实施。
- 选定 OpenShell/controller/CNI 版本读不到 Loaded 回执，或读不到最终有效目的列表，或无法区分 provider 附加规则 → **不得宣称 A06 通过**，T09 标 blocked；不得以 `pushEgressPolicies` 报告、`PUT /egress-policy` 的 200 或 adapter 写入成功替代。
- 拿不到隔离集群、无法固定版本/digest、或无法证明集群与测试 tenant/workspace/Bot 归本轮所有 → Task 4 不执行，A06/A07 保持未验证。
- Chromium 或 CNI 只能通过放宽已批准边界（关沙箱、关 NetworkPolicy、放 metadata）才跑通 → blocked，不是通过。
- 存在未解决的 critical/high/medium finding，或适用 OCR 未真实覆盖本轮代码范围 → 不交付。
