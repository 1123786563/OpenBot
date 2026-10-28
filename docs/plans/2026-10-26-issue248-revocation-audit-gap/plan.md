# Issue #248 F1 修复方案 — 撤销审计失败导致网关禁用永久跳过

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使 `revokeForUser` 在撤销提交后、审计写失败时仍然执行网关 Key 禁用，并让幂等重试可以补偿漏发的禁用。

**Architecture:** 当前顺序是「提交 → 审计写（fail-closed，抛错中止）→ 网关 seam」，审计写抛错时 seam 永不执行，且重试走进幂等分支（返回空 retired ids）永久短路。修复把网关 seam 前移到审计写之前——远端禁用是对外副作用，其失败由 seam 自身记录（`gateway.key_revocation_deactivation_failed`），不依赖 `model_access.revoked` 那一行是否写得进去；同时让幂等分支返回该 grant 名下的 revoked key ids，使重试能补齐仍在网关生效的旧 key。审计写保持 fail-closed 语义不变（失败仍抛错，调用方仍看到 500）。

**Tech Stack:** TypeScript / Bun / Drizzle ORM / PostgreSQL；测试经 e2e 统一入口（ADR 0008）的 driven 套件。

**Spec:** Issue #248（Bifrost 05.7）——「旧 credentialVersion 立即失效并**在网关侧禁用**」「已发生的消费仍从原预留结算」；父 Spec #5 AC08。审计裁决与复现证据：`.archive/runs/2026-10-26-closed-issue-daily-run5/reviews/issue-248-controller-ruling.md`、`verification/issue-248/evidence/probe-audit-failure.ts`。

## Global Constraints

- 目标基线：`origin/main` = `9ee7500c0fda16cc4cb3815aa0c3404639d2cd50`（修复在其后代上）。
- Write scope（越界即停并上报）：`server/src/bot-services/access-grants.ts`（撤销与失效逻辑）、`server/tests/key-revocation.test.ts`（对应测试）。**不改** `server/src/gateway/*`、迁移、接口签名。
- 本地撤销的**同步性不可削弱**：grant/key 行翻 `revoked` 必须在同一事务内提交；网关可达与否都不影响准入拒绝（AC3）。
- 网关 seam **total、never throwing**（既定契约，不得改为抛错）。
- `model_access.revoked` 审计保持 fail-closed（写失败仍抛错）；不得改成吞错。
- 正式测试入口只走 e2e：`E2E_BUN_ONLY='server/tests part 8' bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`；`bun test <file>` 仅作诊断。
- 凭据只从容器 env 读取，不写入仓库或归档；日志中 DSN 口令段替换 `***`。
- 无提交/推送授权：产出未提交检查点。

## Review Focus

1. **审计写与 seam 的相对顺序**——若有人把 seam 放回审计写之后，F1 原样复发：撤销已提交而远端 key 仍在生效，且无任何审计行。
2. **幂等重试的补偿语义**——第二次 `revokeForUser` 必须能看到该 grant 的 revoked key ids；若仍返回 `[]`，补漏路径不存在。
3. **首次按下时的 double-disable**——seam 前移后，首次成功路径不得对同一 key 调两次禁用。
4. **审计失败时的事务外状态**——`revokeForUser` 抛错时 grant/key 行已提交（这是刻意的，本地撤销先于审计），调用方 500 但状态正确；不得为此回滚。
5. **`revokeAllForUser` 的补偿可达性**——它只选 `status='active'` 的 grant，所以对已 revoked 的 grant 必须靠单票重试补偿，不得假设 revoke-all 能兜底。

---

### Task 1: 网关禁用前移到审计写之前 + 幂等重试可补偿

**Files:**
- Modify: `server/src/bot-services/access-grants.ts:489-525`（`revokeForUser` 提交后的两段）与 `:435-440`（幂等分支返回值）
- Test: `server/tests/key-revocation.test.ts`（新增 2 个用例）

**Interfaces:**
- Consumes: `dependencies.revokeGatewayKeys?: GatewayGrantKeyRevocator`（`(input: { grantId: string; gatewayVirtualKeyIds: string[] }) => Promise<void>`，total/never-throwing）；`recordAuditEvent(store, event)`；事务返回的 `outcome.retiredGatewayVirtualKeyIds`。
- Produces: 无新增导出。`revokeForUser` 返回类型不变 `{ grant: AccessGrant; revoked: boolean }`——幂等分支的 `retiredGatewayVirtualKeyIds` 只在内部用于补漏，**不**新增公开字段。

- [ ] **Step 1: 写两个失败测试**

在 `server/tests/key-revocation.test.ts` 末尾（现有 6 个 test 之后）追加。第一个测试直接钉 F1 的复现路径：

```ts
test("a revocation whose audit write fails still asks the gateway to disable every retired key", async () => {
  // F1 (run5 audit): the audit row is fail-closed, but it sits AFTER the commit. If the
  // only way to reach the gateway seam is through that write, a transient audit failure
  // leaves the remote key alive with nothing recording it. The seam must run regardless.
  const userId = `${prefix}-auditfail`;
  const { grant, botId } = await confirmedGrant(userId, "auditfail");
  await activeKeyVersion(grant, botId, 1);

  const seamCalls: string[][] = [];
  const failingAuditStore = {
    insert: async (event: { eventType: string }) => {
      if (event.eventType === "model_access.revoked") {
        throw new Error("audit_events insert failed");
      }
      return auditStore.insert(event as never);
    },
  } as unknown as typeof auditStore;
  const svc = createAccessGrantService({
    database,
    botServices: botStore,
    auditStore: failingAuditStore,
    revokeGatewayKeys: async ({ gatewayVirtualKeyIds }) => {
      seamCalls.push([...gatewayVirtualKeyIds]);
    },
  });

  await expect(svc.revokeForUser(grant.grantId, userId)).rejects.toThrow(
    "audit_events insert failed",
  );

  // The commit stands (the person's answer is true), the trail refused to name it,
  // and the remote disable was still attempted exactly once for the retired key.
  const [row] = await database
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.grantId, grant.grantId));
  expect(row?.status).toBe("revoked");
  expect(seamCalls).toHaveLength(1);
  expect(seamCalls[0]).toHaveLength(1);
});

test("a retried revocation asks the gateway again for keys the grant already retired", async () => {
  // F1's complement: the caller's retry lands in the idempotent no-op, so that branch is
  // the only place a skipped disable can be made good.
  const userId = `${prefix}-retrycomp`;
  const { grant, botId } = await confirmedGrant(userId, "retrycomp");
  await activeKeyVersion(grant, botId, 1);

  const seamCalls: string[][] = [];
  let auditThrows = true;
  const flakyAuditStore = {
    insert: async (event: { eventType: string }) => {
      if (auditThrows && event.eventType === "model_access.revoked") {
        throw new Error("audit_events insert failed");
      }
      return auditStore.insert(event as never);
    },
  } as unknown as typeof auditStore;
  const svc = createAccessGrantService({
    database,
    botServices: botStore,
    auditStore: flakyAuditStore,
    revokeGatewayKeys: async ({ gatewayVirtualKeyIds }) => {
      seamCalls.push([...gatewayVirtualKeyIds]);
    },
  });

  await expect(svc.revokeForUser(grant.grantId, userId)).rejects.toThrow();
  const afterFirst = seamCalls.length;

  auditThrows = false;
  const retry = await svc.revokeForUser(grant.grantId, userId);
  // Still the idempotent answer — but the gateway is asked again for the retired keys,
  // so a disable lost to the first press is not lost forever.
  expect(retry.revoked).toBe(false);
  expect(seamCalls.length).toBe(afterFirst + 1);
  expect(seamCalls[seamCalls.length - 1]).toHaveLength(1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/wuyongjun/trea/OpenBot && TEST_DATABASE_URL=<55451 DSN> bun test server/tests/key-revocation.test.ts`
Expected: 新加的两个测试 FAIL —— 第一个 `expect(seamCalls).toHaveLength(1)` 实得 0；第二个 `expect(seamCalls.length).toBe(afterFirst + 1)` 实得 `afterFirst`。

- [ ] **Step 3: 把网关 seam 移到审计写之前**

在 `server/src/bot-services/access-grants.ts` 的 `revokeForUser` 中，把当前位于 `:518-525` 的 `if (outcome.revoked && outcome.retiredGatewayVirtualKeyIds.length > 0 && dependencies.revokeGatewayKeys) { await dependencies.revokeGatewayKeys(...) }` 整段**上移**到 `recordAuditEvent` 那一段（`:496-517`）**之前**。同时把该段原有的解释性注释改写成说明新顺序的两句：远端禁用先于审计写，因为它是不能因审计表故障而丢失的对外副作用；seam 自身对每把失败 key 写 `gateway.key_revocation_deactivation_failed` 审计行。

- [ ] **Step 4: 让幂等分支返回已退役的 key ids**

把 `:435-440` 幂等分支的

```ts
        if (row.status === "revoked")
          return {
            grant: toGrant(row),
            revoked: false,
            retiredGatewayVirtualKeyIds: [],
          };
```

改为在**同一事务内**查询该 grant 名下已 revoked 的 key ids 并返回：

```ts
        if (row.status === "revoked") {
          // The answer is the idempotent no-op, but the caller's retry is also the only
          // recovery path for a disable the first press could not deliver: hand back what
          // this grant already retired so the seam can be asked again.
          const retired = await tx
            .select({ id: gatewayVirtualKeys.gatewayVirtualKeyId })
            .from(gatewayVirtualKeys)
            .where(
              and(
                eq(gatewayVirtualKeys.grantId, grantId),
                eq(gatewayVirtualKeys.status, "revoked"),
              ),
            );
          return {
            grant: toGrant(row),
            revoked: false,
            retiredGatewayVirtualKeyIds: retired.map((r) => r.id),
          };
        }
```

- [ ] **Step 5: 让 seam 调用条件同时覆盖幂等分支**

把 Step 3 移上来的 seam 调用条件从 `outcome.revoked && …` 改为只要 `outcome.retiredGatewayVirtualKeyIds.length > 0` 就调用（去掉 `outcome.revoked &&`）。保留下方的 `dependencies.revokeGatewayKeys` 存在性检查。

> 注意：现有测试「a repeated revocation neither re-disables remote keys nor rewrites history」断言第二次撤销**不**再调 seam。该断言与 F1 的补偿语义冲突——Step 6 更新它。

- [ ] **Step 6: 更新既有的幂等测试以匹配补偿语义**

把 `server/tests/key-revocation.test.ts` 中「a repeated revocation neither re-disables remote keys nor rewrites history」的 body 改为：第二次撤销 `revoked` 仍为 `false`、`model_access.revoked` 审计行仍恰好 1 条（**不重写历史**这一点不变），但**允许** seam 再次收到该 grant 已退役的 key id。测试名相应改为
`test("a repeated revocation rewrites no history and only re-asks the gateway for keys it already retired"`，并把 `expect(remoteDisableCalls.length).toBe(callsAfterFirst)` 改为 `expect(remoteDisableCalls.length).toBeGreaterThanOrEqual(callsAfterFirst)`，另加一条断言：第二次的调用只携带首次已退役的那一个 key id（不引入新 id）。

- [ ] **Step 7: 跑全量组测试确认通过**

Run:
```
cd /Users/wuyongjun/trea/OpenBot
E2E_UNIT_OUTPUT=<ev>/tmp/e2e-out E2E_BUN_ONLY='server/tests part 8' \
TEST_DATABASE_URL=<55451 DSN> \
bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```
Expected: exit 0；`key-revocation.test.ts` 由 6 用例增至 **8 用例全绿**；该组 0 失败。

- [ ] **Step 8: 类型检查与 lint**

Run: `bun run --filter server typecheck` → exit 0
Run: `bunx biome lint --error-on-warnings server/src/bot-services/access-grants.ts server/tests/key-revocation.test.ts` → exit 0

- [ ] **Step 9: 记录检查点（不提交）**

无提交授权：保存 `git diff` 全文与 `git status --short` 到修复证据目录，作为未提交检查点。**不**执行 `git add/commit`。
