# T10 Coding Sandbox Independent Network Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Repository authorization and review rules govern execution.

**Goal:** 同一 Bot 的编码沙箱可以独立申请、获批准并加载网络目的授权；computer 与 coding 授权互不复制，未授权依赖下载失败并给出可操作的申请路径。

**Architecture:** T09 的 OpenShell 网络授权服务仍是唯一 grant 权威和审批入口。T10 把它的作用域扩展到 `environment: "coding"`，从 T03 的编码沙箱生命周期取得完整 scope/generation，按环境合成默认拒绝策略，并把 Loaded 回执与最终有效规则作为生效证明。用户申请与失败提示走 OpenBot coding 服务和 T09 管理端，不创建第二张 grant 表、第二套审批权威或编码专用网络权威。

**Tech Stack:** TypeScript/Bun、Hono、React/TanStack Query、Postgres/Drizzle、OpenShell Kubernetes adapter、tester-army `e2e`、隔离 Kubernetes 集群。

**Spec:** [OpenShell Spec v1](../../specs/2026-10-30-openshell-sandbox.md) 的 [已批准决定](../../specs/2026-10-30-openshell-sandbox.md#已批准决定) D5、D7、D11、D12、D16、D18 与 [验收映射](../../specs/2026-10-30-openshell-sandbox.md#验收映射) A02、A06；[ADR 0013](../../adr/0013-openshell-sandbox-substrate.md)；[ADR 0006](../../adr/0006-logical-private-bot-scoped-execution.md)；[ticket breakdown](ticket-breakdown.md#t10--编码沙箱独立网络授权闭环)。正式 Issue 是 [#744](https://github.com/1123786563/OpenBot/issues/744)，真实 Blocked by [#737](https://github.com/1123786563/OpenBot/issues/737)（T03）、[#739](https://github.com/1123786563/OpenBot/issues/739)（T05）、[#743](https://github.com/1123786563/OpenBot/issues/743)（T09）。2026-10-30 只读回读时四个 Issue 均为 `open` + `ready-for-agent`，阻塞项未完成。

## Global Constraints

- 本计划、ticket 草案和 Issue 均不是实施授权。实施前必须 rescan #744、#737、#739、#743、批准 Spec/ADR、适用规则和目标 SHA；依赖未在当前树验证即保持 blocked。
- T03、T05、T09 必须先在当前工作区通过并进入本增量。执行时以 T09 实际代码为准核对 grant 申请、审批、下发、回执和 T05 意图/结果合同；本文件的期望名与实际名不同时改造 T10 适配层，不得另建平行实现。
- 复用 T09 已建立的唯一 grant 权威、grant 存储和管理员审批队列。T10 只增加 `environment: "coding"` 和编码侧消费能力；禁止新增第二张 grant 表、第二套审批权威、第二套 destination parser 或编码环境专属审计流。
- 授权和策略绑定完整执行归属：`tenantId + workspaceId + botId + environment + generation`（ADR 0006、D7、D22）。同一 Bot 的 computer 授权不得自动复制到 coding，反向亦然；新 generation 不继承旧 generation 的已批准访问。
- 只有部署管理员可批准编码网络扩权（D18）。`requireAdmin` 是现有部署 admin 判定；普通动作审批权、团队审批规则和 owner-scoped approval 均不包含此权力。
- OpenShell coding 默认 `allowlist_only`，仅含 T03 已验证的系统必需目的（模型路由、受控 OpenBot 内部服务和底座所需 DNS/控制路径）。不得把 `agent-computer` 的 `DEFAULT_EGRESS_DESTINATIONS` 或 package registry 默认放行进 coding 基线，不得无策略时回落为 `NO_NETWORK_POLICY.allow_all`。
- 目的地址沿用 T09 与 `agent-computer/src/egress.ts` 的 `EgressRule` 结构合同（`domain` 或 `cidr` + 可选端口），并保留 metadata、link-local、NAT64 等绝对拒绝语义。执行时若 T09 已提取共享类型，使用该实际类型。
- 未授权依赖下载必须失败，不得静默重试、降级到共享容器、放宽策略或把超时当作成功。用户可见路径必须说明失败和下一步，文案遵守 `../../../.agents/skills/openbot-copy/SKILL.md`；浏览器请求仍按 `openbot-data-access` 走 `client` 和 query/mutation 工厂。
- 策略生效必须同时取得当前 generation 的 OpenShell `Loaded` 回执和最终有效 destinations。异步 apply、desired document、HTTP 200 或旧 generation 回执都不是生效证明；provider 附加 allow 若扩大 coding 访问，必须判为未安全生效并阻止执行。
- 撤销、到期和强撤销语义归 T11。T10 产出 T11 可消费的编码 grant 记录、environment 维度策略生成，以及 loaded generation / final effective destinations / established-connection outcome 查询；不得在 T10 宣称强撤销完成。
- 只改变 OpenShell 模式。现有 `networkInput`、`PUT /network`、`DELETE /network/:scopeKind`、`NetworkPolicyRow`、共享编码容器和旧 computer provider 行为不变；`agent-sandbox/src/*` 的现有 shared 模式只能做无行为差异的类型/测试适配。
- 本票是完整档：独立行为验收、独立 Spec/质量 Review、适用 OCR、实际收集数和证据归档缺一不可。证据放 `.archive/runs/<run-key>/verification/`，runner 原始输出先放 `.e2e/<run-key>/.../` 再归档。

## Current Code Facts

- 当前编码环境仍是共享容器内的每 Bot OpenCode 子进程：`agent-sandbox/src/bot-runtimes.ts` 以工作目录隔离，`agent-sandbox/src/devserver.ts` 与 OpenCode 共享容器网络；`docker-compose.yml` 的 `openbot_sandbox` 网络明确仍可访问互联网。
- `agent-sandbox/src/opencode-config.ts` 禁用 `webfetch`，但 `bash: "allow"`，且运行时依赖安装依赖直接出站；`agent-sandbox/Dockerfile` 专门为运行时 `bun install` 配置缓存，Craft 的 `start-webapp.sh` 也会执行 `bun install`。当前不存在编码侧 egress policy 模块。
- computer 合同在 `agent-computer/src/egress.ts`：`EgressRule`、`parseEgressRules`、`egressDecision`、`isAlwaysDenied`、本地 filter 和 `PUT /egress-policy`。`server/src/computer/policy-network.ts` 目前 org/group 合成，`NO_NETWORK_POLICY` 为 `allow_all`，推送异步且只覆盖运行中的 computer；这是要被 T09/OpenShell 改造的参考合同，不是 T10 可直接复用的安全语义。
- 管理面现状：`server/src/admin/routes.ts` 的 `networkInput` 只接受 organization/group，`PUT /network` 和 `DELETE /network/:scopeKind` 后台调用 `controls.pushNetworkPolicies()`；`server/src/admin/settings-store.ts` 的 `NetworkPolicyRow` 与 `network_policies` 表也是旧范围。T10 不得重载它们。
- 编码入口现状：`server/src/codesandbox/routes.ts` 以 `requireUser + canUseBot` 暴露 runs/reset；`server/src/codesandbox/client.ts` 有 `baseUrl/token/botId/executionScope`；`server/src/assembly/runtime.ts` 当前构造旧客户端。T03 会替换为 OpenShell scope-aware lifecycle，T10 只在其后接入。

## Review Focus

1. computer 的已批准目的被 coding 沙箱继承，或 coding 批准泄漏回 computer；Task 1 的 `computer_and_coding_grants_do_not_cross_environments` 与 Task 4 live `computer_and_foreign_scopes_stay_denied` 钉住。
2. coding 进程经 OpenCode 子进程、devserver、webapp 或 preview 代理绕开出站约束；Task 3 的 `preview_and_devserver_remain_under_coding_policy` 与 Task 4 live `preview_and_devserver_cannot_bypass_policy` 钉住。
3. 依赖下载失败被静默重试、降级为共享容器或回落为 allow-all；Task 2 的 `dependency_failure_fails_once_and_offers_request_path` 与 Task 4 live `unauthorized_dependency_downloads_fail_with_request_path` 钉住。
4. 批准作用到同 Bot 的另一 workspace、环境或 generation；Task 1 的 `coding_grant_requires_exact_execution_scope_and_generation` 与 Task 4 live `admin_approval_reaches_only_the_coding_generation` 钉住。
5. coding 沙箱 stop/resume 后旧策略回执被当作新 generation 生效证明；Task 3 的 `coding_resume_blocks_until_new_generation_policy_is_loaded` 与 Task 4 live `coding_resume_revalidates_loaded_policy` 钉住。

## File Map and Dependency Contract

**T10 owned or modified files**

- Modify T09's actual grant owner and migration, expected `server/src/openshell/network-grants.ts` plus its Drizzle schema/migration. If verified T09 chose another owner/path, modify that owner and record the mapping here; creating a second repository or table is prohibited.
- Modify T09's actual environment policy composer and OpenShell policy port, expected `server/src/openshell/network-policy.ts` and `server/src/openshell/policy-adapter.ts`.
- Modify T03's actual coding lifecycle owner, expected `server/src/codesandbox/openshell-provider.ts`, so wake/resume returns and requires the current coding generation policy receipt.
- Modify `server/src/codesandbox/routes.ts`, `server/src/codesandbox/gateway.ts`, and only if the current transport still owns the payload `server/src/codesandbox/client.ts` / `types.ts` for the user request and structured dependency failure.
- Modify T09's actual browser data owners, expected `app/src/lib/openshell-network/queries.ts` and `mutations.ts`; add the shared request card (expected `app/src/components/craft/network-access-request.tsx`), wire it into `app/src/lib/copilot/code-tools.tsx`, and extend T03's Craft stream/tool-result surface plus the needed Craft/Admin locale files.
- Tests: create `server/tests/openshell-network-grants.test.ts`, `server/tests/codesandbox-network-request.test.ts`, `server/tests/openshell-coding-policy-adapter.test.ts`, `app/tests/codesandbox-network-request.test.tsx`, and the live case `tests/e2e/openshell-coding-network.e2e.ts` unless T03/T09 already established a live harness path.

**Consumes**

- From T03: full coding scope resolver, `ensureRunning(scope): Promise<{ url: string; generation: string }>` or its actual equivalent, plus the verified system destination set. The scope is resolved server-side; browser headers and body identity are never trusted.
- From T05: the actual durable intent/operation/outcome and emergency containment APIs. Approval request, decision, and policy apply are ordinary critical operations; central audit unavailable means no ordinary approval/apply, while tightening or stop follows T05 emergency semantics.
- From T09: `requestNetworkGrant`, admin decision, durable grant repository, destination validation, policy orchestration and Loaded receipt contract under their actual names. T10 requires the stored record to carry `environment`, full scope, generation, destination, `taskId?`, expiry and status.
- From computer's policy contract: the destination shape and parser semantics, including all always-denied addresses. T10 does not import the old org/group decision or `allow_all` fallback into OpenShell coding.

**Produces for T11**

```ts
export type OpenShellNetworkScope = {
  tenantId: string;
  workspaceId: string;
  botId: string;
  environment: "computer" | "coding";
  generation: string;
};

export type CodingNetworkGrantRecord = {
  id: string;
  scope: OpenShellNetworkScope;
  destination: EgressRule;
  taskId: string | null;
  expiresAt: string | null;
  status: "pending" | "approved" | "denied" | "ended";
  requestedBy: string;
  decidedBy: string | null;
  operationId: string;
};

export type OpenShellEffectivePolicyReceipt = {
  desiredGeneration: string;
  loadedGeneration: string | null;
  finalEffectiveDestinations: readonly EgressRule[];
  establishedConnectionOutcome: "none" | "present" | "unknown";
};

export type OpenShellEnvironmentPolicyPort = {
  applyPolicy(input: {
    scope: OpenShellNetworkScope;
    policy: EgressPolicy;
    operationId: string;
  }): Promise<
    | { status: "loaded"; receipt: OpenShellEffectivePolicyReceipt }
    | { status: "not_loaded"; receipt: OpenShellEffectivePolicyReceipt }
    | { status: "unknown"; receipt?: OpenShellEffectivePolicyReceipt }
  >;
  inspectPolicy(scope: OpenShellNetworkScope): Promise<OpenShellEffectivePolicyReceipt>;
};
```

`composeCodingNetworkPolicy` must derive `desiredGeneration` from the complete scope, baseline version, and sorted approved grant IDs. The final allowlist is only T03 system destinations plus approved coding grants for that exact generation; `inspectPolicy` is the proof T11 uses after removal.

---

### Task 1: Extend the single grant authority to coding scopes

**Files:**

- Modify: T09 actual grant owner/schema/migration, expected `server/src/openshell/network-grants.ts`.
- Modify: T09 actual policy composer, expected `server/src/openshell/network-policy.ts`.
- Modify: T03 coding scope resolver/lifecycle owner only where needed to pass the full scope.
- Test: `server/tests/openshell-network-grants.test.ts`.

**Interfaces:**

- Consumes T09's real request/decision/repository APIs and T05's intent contract.
- Produces `OpenShellNetworkScope` and `CodingNetworkGrantRecord` above. The same repository serves computer and coding; coding is distinguished by `environment` and exact scope/generation, never by a second table.
- Produces `composeCodingNetworkPolicy(input: { scope: OpenShellNetworkScope; systemDestinations: readonly EgressRule[]; grants: readonly CodingNetworkGrantRecord[] }): { policy: EgressPolicy; desiredGeneration: string }`.

- [ ] **Step 1: Write failing tests**
  - `coding_grant_requires_exact_execution_scope_and_generation`: deny another tenant, workspace, Bot, environment, or generation.
  - `computer_and_coding_grants_do_not_cross_environments`: an approved computer destination and approved coding destination each affect only their own composed policy.
  - `coding_policy_is_allowlist_only_system_destinations_by_default`: no grants yields only T03 system destinations; registries and Internet are absent.
  - `coding_grant_uses_one_durable_authority_and_t05_intent`: request and decision use T09/T05 fixtures, one durable status transition, and one operation ID; audit outage does not perform an ordinary approval.
  - `new_generation_does_not_inherit_approved_coding_grant`: resume to generation 2 leaves the old approval out unless a new scoped approval exists.
- [ ] **Step 2: Run RED**

```bash
E2E_UNIT_OUTPUT=.e2e/<run-key>/T10-task1-red e2e run --config e2e.unit.config.ts server/tests/openshell-network-grants.test.ts
```

  Expected: exactly the five named cases are collected and fail on missing coding scope/repository/policy behavior; zero tests are skipped.

- [ ] **Step 3: Implement the smallest scope extension**
  - Extend T09's existing grant keys, validation, indexes and status transitions to carry `environment` and `generation`; use a single transaction for request/decision and preserve T05 intent-before-effect.
  - Extend the existing composer to filter by exact full scope. Do not read `NetworkPolicyRow`, `NO_NETWORK_POLICY`, owner groups, or computer capability to widen coding.
- [ ] **Step 4: Run GREEN**

```bash
E2E_UNIT_OUTPUT=.e2e/<run-key>/T10-task1-green e2e run --config e2e.unit.config.ts server/tests/openshell-network-grants.test.ts
```

  Expected: five collected, five passed, zero skipped. Keep the report for the run archive.

- [ ] **Step 5: Commit only this task's authorized files** with a message identifying coding network grant scoping.

### Task 2: User request path and dependency-failure outcome

**Files:**

- Modify: `server/src/codesandbox/routes.ts`, `server/src/codesandbox/gateway.ts`, and `server/src/codesandbox/client.ts` / `types.ts` only if needed for the structured failure payload.
- Modify: T09 browser query/mutation owners, expected `app/src/lib/openshell-network/queries.ts` and `mutations.ts`; add `app/src/components/craft/network-access-request.tsx` and wire it through `app/src/lib/copilot/code-tools.tsx` plus T03's actual Craft stream/tool-result surface.
- Modify: `app/src/locales/en/craft.json`, `app/src/locales/zh-CN/craft.json`, and the corresponding Admin locale files only where T09's shared approval row needs the coding label.
- Tests: `server/tests/codesandbox-network-request.test.ts`, `app/tests/codesandbox-network-request.test.tsx`.

**Interfaces:**

- Consumes Task 1's coding grant repository and T09's admin decision surface. The browser never sends tenant/workspace/generation.
- Produces `POST /api/codesandbox/network-requests` with body `{ botId: string; destination: EgressRule; reason: string; taskId?: string; expiresAt: string; idempotencyKey: string }`, returning `{ requestId: string; status: "pending" }`. The route resolves execution server-side, validates destination and T09's expiry ceiling, and writes one idempotent pending request.
- Produces an optional structured field on a failed code run: `networkRefusal: { destination: string; requestId: string | null; action: "request_access" }`. It never changes a successful run and never converts refusal to success.
- Browser reads through the established query factory and writes through `requestCodingNetworkAccessMutationOptions`; no component calls `fetch`. `run_code` keeps a model-readable failure string, stores the structured refusal by tool call ID, and its render branch shows the request card; the T03 Craft stream surface uses the same card for its coding turn events.

- [ ] **Step 1: Write failing tests**
  - `coding_network_request_uses_server_resolved_scope_and_creates_one_pending_request`: same idempotency key and content returns one request; changed content conflicts, and `expiresAt` beyond T09's ceiling is rejected.
  - `caller_cannot_request_network_for_another_bot`: `canUseBot` refusal produces 403 and no grant row.
  - `dependency_failure_fails_once_and_offers_request_path`: a blocked `bun install` or `pip install` result fails once, triggers no second sandbox attempt, no allow-all fallback, and carries the request action.
  - `coding_network_failure_copy_is_short_and_actionable`: English and Chinese render “Couldn't download packages. Request access for this Bot.” or the reviewed locale equivalent, with a button that calls the mutation.
- [ ] **Step 2: Run RED**

```bash
E2E_UNIT_OUTPUT=.e2e/<run-key>/T10-task2-red e2e run --config e2e.unit.config.ts server/tests/codesandbox-network-request.test.ts app/tests/codesandbox-network-request.test.tsx
```

  Expected: four named cases collected and fail; no unexplained skip.

- [ ] **Step 3: Implement the smallest user-facing loop**
  - Add the coding route and structured outcome mapping. Recognized package-manager network failures may prefill a destination; unknown failures still show the request entry point and never guess a broad CIDR.
  - Reuse T09's request/approval UI contract and add only the coding environment label. Copy follows `openbot-copy`; Admin may say “coding environment”, while the non-Admin path says Bot/package/access, not grant/scope/deployment.
- [ ] **Step 4: Run GREEN**

```bash
E2E_UNIT_OUTPUT=.e2e/<run-key>/T10-task2-green e2e run --config e2e.unit.config.ts server/tests/codesandbox-network-request.test.ts app/tests/codesandbox-network-request.test.tsx
```

  Expected: four collected, four passed, zero skipped. Also run old-mode regression: `server/tests/codesandbox-routes.test.ts`, `server/tests/codesandbox-gateway.test.ts`, and the current agent-sandbox suites selected by `bun run test:agent-sandbox`.

- [ ] **Step 5: Commit this task's reviewed files.**

### Task 3: Generation-bound policy proof and T11 adapter queries

**Files:**

- Modify: T09's actual OpenShell policy adapter, expected `server/src/openshell/policy-adapter.ts`.
- Modify: T03 coding lifecycle owner, expected `server/src/codesandbox/openshell-provider.ts`.
- Test: `server/tests/openshell-coding-policy-adapter.test.ts`.

**Interfaces:**

- Consumes Task 1 composer, T03 `ensureRunning`, and T05 operation API.
- Produces `OpenShellEffectivePolicyReceipt` and `OpenShellEnvironmentPolicyPort` above. `loadedGeneration` comes from the actual OpenShell receipt, `finalEffectiveDestinations` from the final effective policy read-back, and `establishedConnectionOutcome` from the adapter's real connection inspection; `unknown` is never coerced to `none`.
- Produces a policy-ready gate on coding wake/resume: no coding action, OpenCode request, dependency install, devserver start, or preview upstream access is returned before the current generation has a matching Loaded receipt and safe final rules.

- [ ] **Step 1: Write failing tests**
  - `coding_policy_success_requires_loaded_generation_and_final_effective_rules`: stale/missing receipt means `not_loaded` or `unknown`, never approved/ready.
  - `provider_added_allow_cannot_widen_coding_policy`: final rules outside the system + approved coding set block execution and retain T05 uncertainty.
  - `coding_resume_blocks_until_new_generation_policy_is_loaded`: generation 2 cannot reuse generation 1 receipt and remains unavailable until apply is proven.
  - `coding_policy_exposes_established_connection_outcome_for_t11`: adapter returns `none`, `present`, and `unknown` distinctly from three fixture states.
  - `preview_and_devserver_remain_under_coding_policy`: policy is bound to the sandbox network identity before OpenCode, devserver, webapp or preview forwarding becomes reachable; no child-process proxy bypass is introduced.
- [ ] **Step 2: Run RED**

```bash
E2E_UNIT_OUTPUT=.e2e/<run-key>/T10-task3-red e2e run --config e2e.unit.config.ts server/tests/openshell-coding-policy-adapter.test.ts
```

  Expected: five named cases collected and fail for missing proof/generation behavior.

- [ ] **Step 3: Implement generation-serialized apply and read-back**
  - Serialize policy operations per full scope. Write T05 intent, apply through the actual OpenShell API, read back `Loaded` generation and final effective destinations, then write the result.
  - Safe `loaded` requires matching generation, all approved destinations present, no unauthorized extra allow destination, and always-denied addresses absent. Otherwise keep the sandbox blocked and the operation pending/uncertain.
- [ ] **Step 4: Run GREEN**

```bash
E2E_UNIT_OUTPUT=.e2e/<run-key>/T10-task3-green e2e run --config e2e.unit.config.ts server/tests/openshell-coding-policy-adapter.test.ts
```

  Expected: five collected, five passed, zero skipped. Run `bun run --cwd server typecheck` and `bun run --cwd app typecheck`.

- [ ] **Step 5: Commit this task's reviewed files.**

### Task 4: Isolated-cluster acceptance, review and OCR

**Files:**

- Create or extend the T03/T09 live harness case, final fallback `tests/e2e/openshell-coding-network.e2e.ts`.
- Add only isolated test fixtures for a controlled package registry and a second denied destination; no production fixture secrets.
- Archive evidence under `.archive/runs/<run-key>/verification/`; do not commit secrets or raw traces.

**Interfaces:**

- Consumes all Task 1-3 products through authenticated OpenBot routes and the actual selected OpenShell/controller/CNI stack. Direct OpenShell API calls are only adapter diagnostics, never the acceptance entry point.
- Produces final live evidence and the T11-facing receipt contract exercised on a real coding sandbox generation.

- [ ] **Step 1: Preflight dependencies and resources**
  - Rescan #744/#737/#739/#743 and verify T03/T05/T09 evidence binds the current source tree. Re-read T09's actual names and T03's actual live harness/cluster command; reconcile this plan without creating a second authority.
  - Verify the cluster is test-owned: current context, namespace labels/annotations, run-key owner, existing resources, controlled registry ownership, and teardown plan. Record source SHA, OpenShell release/image digest, Agent Sandbox controller/CRD version, CNI kind/version, service revisions, values digest, and fixture IDs.
- [ ] **Step 2: Write the failing live test**
  - `unauthorized_dependency_downloads_fail_with_request_path`: real `bun install` and `pip install` against the controlled registry fail before approval, and the UI exposes the request action.
  - `admin_approval_reaches_only_the_coding_generation`: deployment admin approval produces a matching Loaded generation and final effective destinations for only the target coding sandbox.
  - `computer_and_foreign_scopes_stay_denied`: same Bot computer, another coding generation, another Bot, and the same logical Bot in another workspace cannot reach the target.
  - `coding_resume_revalidates_loaded_policy`: stop/resume creates a new generation, blocks until the new receipt is loaded, and does not inherit the old grant.
  - `preview_and_devserver_cannot_bypass_policy`: a devserver/webapp process inside the coding sandbox can reach only the approved target; the denied target and computer profile/network remain unreachable.
  - `approval_and_result_audit_can_be_reconstructed`: T05/T09 audit and operation rows link request, admin decision, destination digest/count, desired/loaded generation, final effective result, dependency outcome, and actor; inject one provider-added allow and prove it cannot widen the approved result.
- [ ] **Step 3: Run RED**

```bash
OPENBOT_LIVE_API=1 OPENBOT_API_BASE_URL=<isolated-openbot-url> OPENBOT_APP_URL=<isolated-app-url> \
  e2e run --config e2e.config.ts --output .e2e/<run-key>/T10-task4-red \
  tests/e2e/openshell-coding-network.e2e.ts
```

  Expected: six named cases collected and fail on the missing live behavior; no environment limitation is skipped.

- [ ] **Step 4: Implement only the identified T10 gaps and run GREEN**
  - Fix the smallest product/adapter/test fixture gap, rerun the same file to `.e2e/<run-key>/T10-task4-green/`, and require six collected, six passed, zero skipped.
  - Capture policy receipts, final effective rules, package-manager exit/output tails, UI assertion, audit query results, version/resource manifest, injection outcomes, teardown receipts, report hash, and no-residue check in the archive.
  - Do not make the cluster shared, disable CNI enforcement, add a wildcard destination, or substitute a mock for the coding sandbox.
- [ ] **Step 5: Final verification, independent review, OCR and commit**
  - Run the T09/T03 focused suites under their actual paths, Task 1-3 suites, old-mode `server/tests/codesandbox-*.test.ts`, `bun run test:agent-sandbox`, server/app typecheck, and focused Biome lint over changed files.
  - Obtain independent behavior + Spec/quality review and applicable full OCR under `.agents/rules/review.md`. Any effective critical/high/medium finding, unproven dependency, missing receipt, or unexplained skip keeps #744 blocked.
  - Commit only the final authorized T10 increment after evidence and review pass.

## Independent Acceptance

| Requirement | Task and test evidence | Passing condition |
| --- | --- | --- |
| #744 授权仅作用于指定环境和执行归属 | Task 1 `coding_grant_requires_exact_execution_scope_and_generation`, `computer_and_coding_grants_do_not_cross_environments`; Task 4 `admin_approval_reaches_only_the_coding_generation`, `computer_and_foreign_scopes_stay_denied` | Exact tenant/workspace/Bot/coding/generation is authorized; computer, reverse direction, foreign scope and stale generation remain denied. |
| #744 未授权依赖下载失败并展示可申请路径 | Task 2 `dependency_failure_fails_once_and_offers_request_path`, `coding_network_failure_copy_is_short_and_actionable`; Task 4 `unauthorized_dependency_downloads_fail_with_request_path` | Real dependency command fails, no fallback/retry, and the user can submit a coding network request from OpenBot UI. |
| #744 管理员批准与结果审计可核对 | Task 1 `coding_grant_uses_one_durable_authority_and_t05_intent`; Task 4 `approval_and_result_audit_can_be_reconstructed` | Only deployment admin can approve; request, decision, Loaded receipt, final effective rules and result link to one operation/grant ID. |
| A02 隔离与归属 | Task 1 exact scope tests; Task 3 `coding_resume_blocks_until_new_generation_policy_is_loaded`, `preview_and_devserver_remain_under_coding_policy`; Task 4 cross-scope/preview tests | Cross-Bot、跨团队、跨环境、跨 generation 和管理访问被拒；策略未证明时 coding 不执行；工作负载无控制面凭据沿 T03/T09 证据复验。 |
| A06 网络授权（T10 部分） | Task 1 default-deny test; Task 3 receipt/final-rule tests; Task 4 all live cases | 未授权默认拒绝，仅部署 admin 扩权，生效以当前 generation Loaded + final effective destinations 为准。到期、任务结束和强撤销由 T11 基于 T10 Produces 合同完成。 |

**Blocked gates:** #737, #739 or #743 not verified in the current tree; T09's actual single-authority contract cannot be identified; T03 cannot expose the current coding generation/system destinations; selected OpenShell/controller/CNI cannot provide Loaded generation, final effective rules or connection inspection; isolated cluster ownership cannot be proven; UI copy/data-access review fails. Any gate remains blocked rather than being waived by mock or broad allow.
