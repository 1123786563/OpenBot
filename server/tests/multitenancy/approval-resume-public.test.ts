// server/tests/multitenancy/approval-resume-public.test.ts
// MOD13（Issue #633，根 #620）：「分离工具审批决定与 Run 等待恢复并保持单次
// 消费」的两个能力组——ToolAccess 的 approvals 组（src/approvals/public.ts，
// 经 plugins/public.ts 的 approvals 槽承载）与 RunLifecycle 的 WaitRef/claim
// 组（src/enterprise/runs/continuations.ts）——的委托等价、五条验收的现状钉
// 与迁移完整性源级钉。
//
// 事实源（Issue #633 验收 + MOD13 Brief §1.C，逐条对应 describe）：
//   C1 委托等价：两门面新增能力 vs 直调内件——decide/receiptOf/saveReceipt/
//      complete 对 ApprovalService/ApprovalStore，六个 RunContinuations 成员对
//      continuation-store/install；equivalenceOf 是 service.ts 既有纯函数的
//      同一引用（re-export 不是第二处定义）；toolAccess.approvals 恒等持有注入
//      组（toBe 同一对象）。
//   C2 验收①等价复用/重复批准同决定：equivalenceOf 的挥发键剥离与本质键敏
//      感；重复 decide 拒第二次、receiptOf 恒读回第一个决定；等价复用现状
//      （ALREADY_WAITING / DECLINED_BY_PERSON）由真 createApprovalService.gate
//      在等价双亲上跑出——门面承载的等价摘要正是该机制的公开面。
//   C3 验收②CAS 单驱动者：store 双亲忠实镜像 SQL CAS（revision 比对+token+
//      过期接管），门面 claimContinuation 与直调逐字同判；真编排器
//      （createMastraContinuationInstall→resumeMastraContinuation）下同一决定
//      重放收敛 already_applied、并发第二恢复者输在具名冲突上，drive 恰一次。
//   C4 验收③重启读 receipt 不重发：真 service.resume 完成一次执行后，重启
//      （新门面实例）receiptOf 读回原 receipt、saveReceipt 得 false（首写者
//      已胜）、continue 通道恰发一次；M05 侧 executed receipt 复用
//      （reused_receipt）零再驱动。
//   C5 验收④无幂等证据超时进 unknown：drive 在 started 后崩溃→receipt unknown；
//      过期接管后重放收敛 pending_unknown（failed_unknown 终态），drive 不再
//      第二次触达；recordOperationStarted 的 F1 栅栏给后来者 started:false。
//      started 前崩溃（无 receipt）→安全再驱动恰一次。
//   C6 验收⑤真实结果不填假成功：执行错误原样进 result.error；consumed 无
//      结果的重启答案是「outcome is unknown. It was not repeated.」而非成功；
//      拒绝答案 DECLINED_BY_PERSON 且零执行；M05 侧 declined/re_suspended 零
//      receipt 升级（declined 无 receipt、re_suspended 保持 unknown）——
//      resume-driver.ts 的排序纪律另以源级钉钉住（真实引擎行为归
//      mastra-continuations.test.ts 真库套件，见 C7）。
//   C7 存量对照：approvals/continuation 族两树对照与复跑见
//      reports/mod13-verification/（基线侧=干净树 @ dcbaf1405 首跑，实施侧=
//      同树复跑+独立复跑，命令与退出码全表=其 commands.md），不在本文件内。
//
// 运行层（ADR 0008）：import 自 e2e-compat——根 e2e 入口 Node target 原生收集
// （native 桶），不依赖 Bun 运行时、不触真实数据库：approvals 侧=真
// createApprovalService over 内存 store 双亲（approvals.test.ts 先例）；M05 侧=
// 真六门编排器+真 install over 内存 CAS 双亲（SQL 比对集的忠实镜像，只换
// 持久层）；drive=可编排假引擎（真 resume-driver 需 Mastra 引擎栈，其行为归
// 真库套件，此处以源级钉补）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import {
  createApprovalsAccess,
  equivalenceOf,
  type ApprovalsAccess,
} from "../../src/approvals/public";
import { createApprovalService } from "../../src/approvals/service";
import {
  approvalAction,
  type ApprovalAction,
  type ApprovalRecord,
  type ApprovalStore,
  ApprovalRefusedError,
} from "../../src/approvals/types";
import { createToolAccess } from "../../src/plugins/public";
import { createRunContinuations } from "../../src/enterprise/runs/continuations";
import {
  createMastraContinuationInstall,
  type MastraResumeDriver,
} from "../../src/mastra/approvals";
import {
  continuationOperationId,
  decisionIdOf,
  type MastraContinuationStore,
  MastraContinuationRefusal,
} from "../../src/mastra/continuation-store";
import type {
  ClaimedContinuation,
  ContinuationPayload,
  ExecutionBinding,
  ResumeDecision,
  ResumeRef,
} from "../../src/mastra/execution-contracts";
import type { PlatformScope } from "../../src/enterprise/contracts";
import { argsDigestFor } from "../../src/mastra/tools";

// ---------------------------------------------------------------------------
// 通用形状与双亲
// ---------------------------------------------------------------------------

const OWNER = "owner-1";
const BOT = "bot-1";
const TOOL_REF = "mcp/files/save";

/** AG-UI 可过闸的续跑快照（approvalAction 的最小合法 continuation）。 */
function continuationFixture(
  overrides: Partial<{
    toolCallId: string;
    runId: string;
    threadId: string;
  }> = {},
) {
  return {
    runId: "run-1",
    threadId: "thread-1",
    toolCallId: "call-1",
    toolName: "computer_save",
    args: { path: "report.txt" },
    messages: [],
    state: {},
    context: [],
    forwardedProps: {},
    ...overrides,
  };
}

function candidateFixture(
  overrides: Partial<{
    toolCallId: string;
    args: unknown;
    target: unknown;
    effect: string;
    toolRef: string;
  }> = {},
) {
  const continuation = continuationFixture({
    toolCallId: overrides.toolCallId ?? "call-1",
  });
  return {
    actorId: OWNER,
    botId: BOT,
    toolRef: TOOL_REF,
    effect: "write",
    scope: "files:report.txt",
    args: { path: "report.txt" },
    target: { ref: "e1", snapshotId: 7, name: "Submit" },
    continuation,
    ...overrides,
  };
}

/**
 * 内存 ApprovalStore：approvals.test.ts storeFixture 的同律镜像——open 的
 * (owner,runId,toolCallId) 收敛、decide 的单发守卫与 allow_always 规则写、
 * consume 的摘要+approved CAS、saveResult 的首写者胜。带调用计数，供委托等价
 * 证明门面不加读。
 */
function approvalStoreDouble() {
  const records = new Map<string, ApprovalRecord>();
  const rules: {
    ownerUserId: string;
    botId: string;
    toolRef: string;
    effect: string;
    scope: string;
    revokedAt: Date | null;
  }[] = [];
  const counts = {
    open: 0,
    get: 0,
    decide: 0,
    consume: 0,
    saveResult: 0,
    finish: 0,
  };
  const require = (owner: string, id: string) => {
    const row = records.get(id);
    if (!row || row.ownerUserId !== owner) {
      const missing = new Error("not found") as Error & { code?: string };
      missing.code = "APPROVAL_NOT_FOUND";
      throw missing;
    }
    return row;
  };
  const store: ApprovalStore = {
    enabled: async () => true,
    setEnabled: async () => undefined,
    open: async (action: ApprovalAction) => {
      counts.open += 1;
      const prior = [...records.values()].find(
        (row) =>
          row.ownerUserId === action.actorId &&
          row.action.runId === action.runId &&
          row.action.toolCallId === action.toolCallId,
      );
      if (prior) {
        if (prior.action.actionDigest !== action.actionDigest)
          throw new ApprovalRefusedError("The approved action has changed.");
        return structuredClone(prior);
      }
      const rule = rules.find(
        (rule) =>
          rule.ownerUserId === action.actorId &&
          rule.botId === action.botId &&
          rule.toolRef === action.toolRef &&
          rule.effect === action.effect &&
          rule.scope === action.scope &&
          !rule.revokedAt,
      );
      const row: ApprovalRecord = {
        id: `ap-${counts.open}`,
        ownerUserId: action.actorId,
        action: structuredClone(action),
        status: rule ? "approved" : "pending",
        decision: rule ? "allow_always" : null,
        result: null,
        createdAt: new Date(1000),
        decidedAt: rule ? new Date(1000) : null,
        consumedAt: null,
        completedAt: null,
      };
      records.set(row.id, row);
      return structuredClone(row);
    },
    get: async (owner, id) => {
      counts.get += 1;
      return structuredClone(require(owner, id));
    },
    list: async (owner) =>
      [...records.values()]
        .filter((row) => row.ownerUserId === owner)
        .map((row) => structuredClone(row)),
    decide: async (owner, id, decision) => {
      counts.decide += 1;
      const row = require(owner, id);
      if (row.status !== "pending")
        throw new ApprovalRefusedError("This request was already decided.");
      row.decision = decision;
      row.status = decision === "deny" ? "denied" : "approved";
      row.decidedAt = new Date(2000);
      if (decision === "allow_always")
        rules.push({
          ownerUserId: owner,
          botId: row.action.botId,
          toolRef: row.action.toolRef,
          effect: row.action.effect,
          scope: row.action.scope,
          revokedAt: null,
        });
      return structuredClone(row);
    },
    decideQuiet: async (owner, id, decision) => {
      const row = require(owner, id);
      if (row.status !== "pending")
        throw new ApprovalRefusedError("This request was already decided.");
      row.decision = decision;
      row.status = decision === "deny" ? "denied" : "approved";
      row.decidedAt = new Date(2000);
      return structuredClone(row);
    },
    consume: async (owner, id, digest) => {
      counts.consume += 1;
      const row = require(owner, id);
      if (row.action.actionDigest !== digest)
        throw new ApprovalRefusedError("The approved action has changed.");
      if (row.status !== "approved") return false;
      row.status = "consumed";
      row.consumedAt = new Date(3000);
      return true;
    },
    saveResult: async (owner, id, result) => {
      counts.saveResult += 1;
      const row = require(owner, id);
      if (row.result) return false;
      row.result = result;
      return true;
    },
    finish: async (owner, id) => {
      counts.finish += 1;
      const row = require(owner, id);
      row.status = "completed";
      row.completedAt = new Date(4000);
    },
    rules: async (owner) =>
      structuredClone(rules.filter((rule) => rule.ownerUserId === owner)),
    revoke: async (owner, id) => {
      const rule = rules.find(
        (rule) => rule.id === id && rule.ownerUserId === owner,
      );
      if (!rule) throw new Error("rule not found");
      rule.revokedAt = new Date();
    },
  };
  return { store, records, counts };
}

// ---------------------------------------------------------------------------
// M05 双亲：内存 continuation store（SQL CAS 的忠实镜像）+ 可编排 drive
// ---------------------------------------------------------------------------

function scopeFixture(actor = "actor-a"): PlatformScope {
  return {
    tenantId: `tenant-${actor}`,
    workspaceId: `workspace-${actor}`,
    principalId: `principal-${actor}`,
    actorId: `actor-${actor}`,
    memberEpoch: 1,
    aclEpoch: 1,
    entrypoint: "web",
  };
}

function bindingFixture(
  overrides: Partial<ExecutionBinding> = {},
): ExecutionBinding {
  return {
    scope: scopeFixture(),
    botId: "bot-a",
    runId: "run-a",
    attemptId: "attempt-a",
    generation: 1,
    executionKey: "exec-a",
    threadId: "thread-a",
    ...overrides,
  };
}

function payloadFixture(
  overrides: Partial<ContinuationPayload> = {},
): ContinuationPayload {
  return {
    schemaVersion: 1,
    engine: "mastra",
    packageFingerprint: "fp-unit-mod13",
    kind: "approval",
    toolCallId: "call_1",
    toolName: "mcp__files__save",
    argsDigest: argsDigestFor({ path: "report.txt" }),
    snapshotRef: "snap-1",
    ...overrides,
  };
}

const CLAIM_TTL_MS = 15 * 60_000;

/**
 * 内存 MastraContinuationStore：continuation-store.ts 的 SQL 语义逐方法镜像——
 * saveContinuation 的收敛写与 (run,toolCall) 身份守卫、claimInternal 的 CAS
 * （revision 比对 + token + 过期接管窗口）、finish/release 的 token+revision+
 * 状态守卫、receipt 的 unknown 标记与 executed 升级、F1 started:false 栅栏、
 * list 的 principal 收窄与 limit 夹逼。时钟可注入/可推进（过期接管用）。
 */
function continuationStoreDouble() {
  interface Row {
    continuationId: string;
    tenantId: string;
    workspaceId: string;
    principalId: string;
    actorId: string;
    botId: string;
    runId: string;
    attemptId: string;
    generation: number;
    executionKey: string;
    threadId: string | null;
    kind: ContinuationPayload["kind"];
    toolCallId: string;
    toolName: string;
    operationId: string;
    argsDigest: string;
    packageFingerprint: string;
    snapshotRef: string;
    status: "waiting" | "claimed" | "finished";
    revision: number;
    claimTokenHash: string | null;
    claimExpiresAt: Date | null;
    decisionId: string | null;
    outcome: string | null;
    updatedAt: Date;
  }
  const rows = new Map<string, Row>();
  const receipts = new Map<
    string,
    { receiptId: string; status: "unknown" | "executed" }
  >();
  let clock = new Date("2026-10-26T00:00:00Z");
  let tokenSeq = 0;
  const counts = {
    saveContinuation: 0,
    getContinuation: 0,
    listContinuations: 0,
    claimContinuation: 0,
    claimForReceiptEvidence: 0,
    finishContinuation: 0,
    releaseClaim: 0,
    findReceipt: 0,
    recordOperationStarted: 0,
    recordOperationExecuted: 0,
  };
  /** 每次终态写记录编排器传入的 outcome（pending_unknown=failed_unknown 断言用）。 */
  const outcomes: string[] = [];
  const sameIdentity = (row: Row, scope: PlatformScope) =>
    row.tenantId === scope.tenantId &&
    row.workspaceId === scope.workspaceId &&
    row.principalId === scope.principalId &&
    row.actorId === scope.actorId;
  const loadRow = (scope: PlatformScope, continuationId: string) =>
    [...rows.values()].find(
      (row) =>
        row.continuationId === continuationId && sameIdentity(row, scope),
    ) ?? null;
  const loadPendingRow = (
    scope: PlatformScope,
    runId: string,
    toolCallId: string,
  ) =>
    [...rows.values()].find(
      (row) =>
        row.runId === runId &&
        row.toolCallId === toolCallId &&
        row.status !== "finished" &&
        sameIdentity(row, scope),
    ) ?? null;
  /** recordOf 的镜像：重导出 binding 的 scope 身份字段为权威、epoch 为占位。 */
  const recordOf = (row: Row) => {
    const claimExpired =
      row.status === "claimed" &&
      row.claimExpiresAt !== null &&
      row.claimExpiresAt < clock;
    const payload: ContinuationPayload = {
      schemaVersion: 1,
      engine: "mastra",
      kind: row.kind,
      packageFingerprint: row.packageFingerprint,
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      argsDigest: row.argsDigest,
      snapshotRef: row.snapshotRef,
    };
    return {
      ref: { continuationId: row.continuationId, revision: row.revision },
      binding: {
        scope: {
          tenantId: row.tenantId,
          workspaceId: row.workspaceId,
          principalId: row.principalId,
          actorId: row.actorId,
          memberEpoch: 0,
          aclEpoch: 0,
          entrypoint: "web",
          reDerivedScope: true,
        },
        botId: row.botId,
        runId: row.runId,
        attemptId: row.attemptId,
        generation: row.generation,
        executionKey: row.executionKey,
        ...(row.threadId ? { threadId: row.threadId } : {}),
        reDerivedScope: true,
      } as ExecutionBinding,
      payload,
      operationId: row.operationId,
      status: row.status,
      decisionId: row.decisionId,
      outcome:
        (row.outcome as "resumed" | "declined" | "failed_unknown" | null) ??
        null,
      claimExpired,
    };
  };
  const conflict = () =>
    new MastraContinuationRefusal(
      "MASTRA_CONTINUATION_REVISION_CONFLICT",
      "MASTRA_CONTINUATION_REVISION_CONFLICT: another resumer holds the claim.",
    );
  /** claimInternal 的镜像：waiting 直取、claimed 仅过期可接管；token 唯一。 */
  const claimInternal = (row: Row, decisionId: string): ClaimedContinuation => {
    const record = recordOf(row);
    if (record.status === "claimed" && !record.claimExpired) throw conflict();
    const token = `claim-token-${row.continuationId}-${row.revision}-${tokenSeq++}`;
    row.status = "claimed";
    row.revision += 1;
    row.claimTokenHash = token; // 双亲存 token 本身：哈希不可逆性不是被测语义
    row.claimExpiresAt = new Date(clock.getTime() + CLAIM_TTL_MS);
    row.decisionId = decisionId;
    row.updatedAt = new Date(clock);
    return {
      ref: { continuationId: row.continuationId, revision: row.revision },
      binding: record.binding,
      payload: record.payload,
      claimToken: token,
    };
  };
  const decideFits = (decision: ResumeDecision, payload: ContinuationPayload) =>
    (payload.kind === "approval" &&
      (decision.kind === "approved" || decision.kind === "declined")) ||
    (payload.kind === "question" && decision.kind === "answered") ||
    (payload.kind === "frontend_tool" && decision.kind === "tool_result");
  const store: MastraContinuationStore = {
    saveContinuation: async (binding, payloadValue, expectedOperationId) => {
      counts.saveContinuation += 1;
      const payload = payloadValue;
      const operationId = continuationOperationId(
        binding.executionKey,
        payload.toolCallId,
        payload.argsDigest,
      );
      if (
        expectedOperationId !== undefined &&
        expectedOperationId !== operationId
      )
        throw new MastraContinuationRefusal(
          "MASTRA_CONTINUATION_OPERATION_ID_MISMATCH",
        );
      const existing = loadPendingRow(
        binding.scope,
        binding.runId,
        payload.toolCallId,
      );
      if (existing) {
        if (
          existing.argsDigest !== payload.argsDigest ||
          existing.kind !== payload.kind ||
          existing.toolName !== payload.toolName
        )
          throw conflict();
        return recordOf(existing).ref;
      }
      const id = `ct-${counts.saveContinuation}`;
      rows.set(id, {
        continuationId: id,
        tenantId: binding.scope.tenantId,
        workspaceId: binding.scope.workspaceId,
        principalId: binding.scope.principalId,
        actorId: binding.scope.actorId,
        botId: binding.botId,
        runId: binding.runId,
        attemptId: binding.attemptId,
        generation: binding.generation,
        executionKey: binding.executionKey,
        threadId: binding.threadId ?? null,
        kind: payload.kind,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        operationId,
        argsDigest: payload.argsDigest,
        packageFingerprint: payload.packageFingerprint,
        snapshotRef: payload.snapshotRef,
        status: "waiting",
        revision: 1,
        claimTokenHash: null,
        claimExpiresAt: null,
        decisionId: null,
        outcome: null,
        updatedAt: new Date(clock),
      });
      return recordOf(rows.get(id)!).ref;
    },
    getContinuation: async (scope, continuationId) => {
      counts.getContinuation += 1;
      const row = loadRow(scope, continuationId);
      return row ? recordOf(row) : null;
    },
    listContinuations: async (scope, filter) => {
      counts.listContinuations += 1;
      const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200);
      return [...rows.values()]
        .filter(
          (row) =>
            row.tenantId === scope.tenantId &&
            row.workspaceId === scope.workspaceId &&
            row.principalId === scope.principalId,
        )
        .filter((row) => !filter?.status || row.status === filter.status)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, limit)
        .map(recordOf);
    },
    claimContinuation: async (scope, ref, decision) => {
      counts.claimContinuation += 1;
      const row = loadRow(scope, ref.continuationId);
      if (!row)
        throw new MastraContinuationRefusal("MASTRA_CONTINUATION_NOT_FOUND");
      if (row.revision !== ref.revision) throw conflict();
      const record = recordOf(row);
      if (!decideFits(decision, record.payload))
        throw new MastraContinuationRefusal(
          "MASTRA_CONTINUATION_DECISION_INCOMPATIBLE",
        );
      if (record.status === "finished")
        throw new MastraContinuationRefusal(
          "MASTRA_CONTINUATION_ALREADY_FINISHED",
        );
      if (
        decision.kind === "approved" &&
        decision.argsDigest !== record.payload.argsDigest
      )
        throw new MastraContinuationRefusal(
          "MASTRA_CONTINUATION_ARGS_MISMATCH",
        );
      // idempotent re-apply 的对账键：真 decisionIdOf（导出的合同面），双亲零镜像零漂移。
      return claimInternal(row, decisionIdOf(decision));
    },
    claimForReceiptEvidence: async (scope, ref, decisionId) => {
      counts.claimForReceiptEvidence += 1;
      const row = loadRow(scope, ref.continuationId);
      if (!row)
        throw new MastraContinuationRefusal("MASTRA_CONTINUATION_NOT_FOUND");
      if (row.revision !== ref.revision) throw conflict();
      if (row.status === "finished")
        throw new MastraContinuationRefusal(
          "MASTRA_CONTINUATION_ALREADY_FINISHED",
        );
      return claimInternal(row, decisionId);
    },
    finishContinuation: async (claim, outcome) => {
      counts.finishContinuation += 1;
      outcomes.push(outcome);
      const row = rows.get(claim.ref.continuationId);
      const guardOk =
        row !== undefined &&
        row.status === "claimed" &&
        row.revision === claim.ref.revision &&
        row.claimTokenHash === claim.claimToken &&
        (row.claimExpiresAt === null || row.claimExpiresAt >= clock);
      if (!guardOk) {
        const record = row ? recordOf(row) : null;
        throw new MastraContinuationRefusal(
          record?.claimExpired
            ? "MASTRA_CONTINUATION_CLAIM_EXPIRED"
            : "MASTRA_CONTINUATION_REVISION_CONFLICT",
        );
      }
      row.status = "finished";
      row.outcome = outcome;
      row.claimTokenHash = null;
      row.claimExpiresAt = null;
      row.updatedAt = new Date(clock);
    },
    releaseClaim: async (claim) => {
      counts.releaseClaim += 1;
      const row = rows.get(claim.ref.continuationId);
      const guardOk =
        row !== undefined &&
        row.status === "claimed" &&
        row.revision === claim.ref.revision &&
        row.claimTokenHash === claim.claimToken;
      if (!guardOk) throw conflict();
      row.status = "waiting";
      row.revision += 1;
      row.claimTokenHash = null;
      row.claimExpiresAt = null;
      row.updatedAt = new Date(clock);
    },
    currentFingerprint: () => "fp-unit-mod13",
    findReceipt: async (_scope, operationId) => {
      counts.findReceipt += 1;
      return receipts.get(operationId) ?? null;
    },
    recordOperationStarted: async (_scope, operation) => {
      counts.recordOperationStarted += 1;
      const existing = receipts.get(operation.operationId);
      if (!existing) {
        receipts.set(operation.operationId, {
          receiptId: `rc-${counts.recordOperationStarted}`,
          status: "unknown",
        });
        return { started: true };
      }
      return { started: false, status: existing.status };
    },
    recordOperationExecuted: async (_scope, operationId) => {
      counts.recordOperationExecuted += 1;
      const receipt = receipts.get(operationId);
      if (receipt?.status !== "unknown") return null;
      receipt.status = "executed";
      return receipt.receiptId;
    },
  };
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  return { store, rows, receipts, counts, outcomes, advance };
}

// ---------------------------------------------------------------------------
// 可编排 drive：真 resume-driver 排序纪律的替身（每调用一个模式）
// ---------------------------------------------------------------------------

type DriveMode =
  | "resumed"
  | "declined"
  | "re_suspended"
  | "crash-before-started"
  | "crash-after-started"
  | "crash-after-executed";

/**
 * 引擎 drive 替身：按调用序消费 `modes`，sink 使用镜像真 driver 的排序纪律
 * ——approved 先 started（外部副作用可能发生之前）再 executed；declined 永不
 * 触 sink；re_suspended 只 started 不 executed（receipt 永不升级）。崩溃模式
 * 在对应排序点抛出。sink 调用计数与「外部效果到达」计数分开记录。
 */
function driverDouble(modes: DriveMode[]) {
  let calls = 0;
  const sink = { started: 0, executed: 0 };
  const externalEffects = { reached: 0 };
  const decisions: string[] = [];
  const driver: MastraResumeDriver = {
    resume: async ({ decision, receiptSink }) => {
      decisions.push(decision.kind);
      const mode = modes[calls] ?? "resumed";
      calls += 1;
      if (mode === "crash-before-started")
        throw new Error("engine died before start");
      if (mode === "declined") return "declined";
      await receiptSink.started();
      if (mode === "crash-after-started")
        throw new Error("engine died after start");
      externalEffects.reached += 1;
      if (mode === "re_suspended")
        return { outcome: "re_suspended", finishReason: "suspended" };
      if (mode === "crash-after-executed") {
        await receiptSink.executed();
        throw new Error("engine died after executed");
      }
      await receiptSink.executed();
      return {
        outcome: "resumed",
        answer: `turn continued (${decision.kind})`,
      };
    },
  };
  return {
    driver,
    get calls() {
      return calls;
    },
    sink,
    externalEffects,
    decisions,
  };
}

/** M05 侧全套：双亲 store + 真编排器 install + 门面组。 */
function continuationStack(modes: DriveMode[]) {
  const ct = continuationStoreDouble();
  const engine = driverDouble(modes);
  const install = createMastraContinuationInstall({
    store: ct.store,
    toolGrantCurrent: async () => true,
    generationCurrent: async () => true,
    driver: engine.driver,
  });
  const facade = createRunContinuations({
    store: ct.store,
    resume: install.resume,
  });
  return { ct, engine, install, facade };
}

/** 停车一条 continuation 并返回其 ref（save 是引擎面，经内件直写——组不扩面）。 */
async function parkedRow(deps: {
  store: MastraContinuationStore;
  payload?: ContinuationPayload;
  binding?: ExecutionBinding;
}): Promise<ResumeRef> {
  return deps.store.saveContinuation(
    deps.binding ?? bindingFixture(),
    deps.payload ?? payloadFixture(),
  );
}

const approvedDecision = (
  approvalId: string,
  digest: string,
): ResumeDecision => ({
  kind: "approved",
  approvalId,
  argsDigest: digest,
});

// ---------------------------------------------------------------------------
// C1 委托等价：两门面新增能力 vs 直调内件
// ---------------------------------------------------------------------------

describe("MOD13 C1: 委托等价——门面成员与直调内件同输入同答", () => {
  test("M08 approvals 组：四个成员 vs service/store 直调，逐项同答且不添读", async () => {
    const double = approvalStoreDouble();
    const service = createApprovalService(double.store);
    const access = createApprovalsAccess({ service, store: double.store });
    const action = approvalAction(candidateFixture());
    const rowA = await double.store.open({ ...action });
    const rowB = await double.store.open({
      ...action,
      toolCallId: "call-b",
    } as never);

    const viaFacade = await access.decide(OWNER, rowA.id, "allow_once");
    const viaDirect = await service.decide(OWNER, rowB.id, "allow_once");
    expect({ status: viaFacade.status, decision: viaFacade.decision }).toEqual({
      status: viaDirect.status,
      decision: viaDirect.decision,
    });

    const getsBefore = double.counts.get;
    const readFacade = await access.receiptOf(OWNER, rowA.id);
    const readDirect = await double.store.get(OWNER, rowB.id);
    // 门面读一次、直调读一次：门面没有第三只手。
    expect(double.counts.get - getsBefore).toBe(2);
    expect({
      status: readFacade.status,
      decision: readFacade.decision,
    }).toEqual({
      status: readDirect.status,
      decision: readDirect.decision,
    });

    const rowC = await double.store.open({
      ...action,
      toolCallId: "call-c",
    } as never);
    const rowD = await double.store.open({
      ...action,
      toolCallId: "call-d",
    } as never);
    expect(
      await access.saveReceipt(OWNER, rowC.id, { content: "did it" }),
    ).toBe(
      await double.store.saveResult(OWNER, rowD.id, { content: "did it" }),
    );
    await access.complete(OWNER, rowC.id);
    await double.store.finish(OWNER, rowD.id);
    expect((await access.receiptOf(OWNER, rowC.id)).status).toBe(
      (await double.store.get(OWNER, rowD.id)).status,
    );
  });

  test("M08 equivalenceOf 是 service.ts 的同一引用（re-export，非第二处定义）", async () => {
    const serviceModule = await import("../../src/approvals/service");
    expect(equivalenceOf).toBe(serviceModule.equivalenceOf);
  });

  test("M08 toolAccess.approvals 恒等持有注入组——同一对象，零转发层", async () => {
    const double = approvalStoreDouble();
    const service = createApprovalService(double.store);
    const access: ApprovalsAccess = createApprovalsAccess({
      service,
      store: double.store,
    });
    const pluginStore = {
      listServers: async () => [],
      connectionsFor: async () => [],
      brokeredConnectionsFor: async () => [],
      sharedConnections: async () => [],
      listForAgent: async () => ({ tools: [], skills: [] }),
      callTool: async () => ({ text: "", isError: false }),
      // MOD16（#636）：Pick 扩面后本套件不驱动的四个成员，只满足合同。
      installSkill: async () => {},
      uninstallSkill: async () => {},
      skillOwner: async () => null,
      grant: async () => {},
    };
    const toolAccess = createToolAccess({
      store: pluginStore,
      approvals: access,
    });
    expect(toolAccess.approvals).toBe(access);
    const action = approvalAction(candidateFixture());
    const row = await double.store.open(action);
    const decided = await toolAccess.approvals!.decide(
      OWNER,
      row.id,
      "allow_once",
    );
    expect(decided.status).toBe("approved");
  });

  test("M05 RunContinuations 组：读/claim/resume vs continuation-store/install 直调同答", async () => {
    const { ct, install, facade } = continuationStack(["resumed", "resumed"]);
    const scope = scopeFixture();
    const refA = await parkedRow({ store: ct.store });
    await parkedRow({
      store: ct.store,
      binding: bindingFixture({ runId: "run-b", executionKey: "exec-b" }),
    });

    const viaFacade = await facade.waitingContinuations(scope);
    const viaDirect = await ct.store.listContinuations(scope);
    expect(viaFacade.length).toBe(2);
    expect(viaFacade.map((r) => r.ref.continuationId).sort()).toEqual(
      viaDirect.map((r) => r.ref.continuationId).sort(),
    );

    const getsBefore = ct.counts.getContinuation;
    expect(
      (await facade.continuationFor(scope, refA.continuationId))?.ref,
    ).toEqual(
      (await ct.store.getContinuation(scope, refA.continuationId))?.ref,
    );
    expect(ct.counts.getContinuation - getsBefore).toBe(2); // 门面一次+直调一次

    const claimA = await facade.claimContinuation(
      scope,
      refA,
      approvedDecision("ap-1", payloadFixture().argsDigest),
    );
    const refB = await parkedRow({
      store: ct.store,
      binding: bindingFixture({ runId: "run-c", executionKey: "exec-c" }),
    });
    const claimB = await ct.store.claimContinuation(
      scope,
      refB,
      approvedDecision("ap-1", payloadFixture().argsDigest),
    );
    expect(claimA.payload.kind).toBe("approval");
    expect(claimA.binding.runId).toBe("run-a");
    expect(claimB.payload.kind).toBe(claimA.payload.kind);
    expect(claimB.binding.runId).toBe("run-c");

    const refC = await parkedRow({
      store: ct.store,
      binding: bindingFixture({ runId: "run-d", executionKey: "exec-d" }),
    });
    const refE = await parkedRow({
      store: ct.store,
      binding: bindingFixture({ runId: "run-e", executionKey: "exec-e" }),
    });
    const resumedFacade = await facade.resumeContinuation({
      scope,
      ref: refC,
      decision: approvedDecision("ap-1", payloadFixture().argsDigest),
    });
    const resumedDirect = await install.resume({
      scope,
      ref: refE,
      decision: approvedDecision("ap-1", payloadFixture().argsDigest),
    });
    expect(resumedFacade).toEqual(resumedDirect);
  });
});

// ---------------------------------------------------------------------------
// C2 验收①：等价复用与重复批准同决定
// ---------------------------------------------------------------------------

describe("MOD13 C2 (验收①): 等价复用/重复批准返回同一决定", () => {
  test("equivalenceOf：同动作同摘要；挥发键剥离、本质键敏感", () => {
    const base = candidateFixture();
    expect(equivalenceOf(base)).toBe(equivalenceOf(candidateFixture()));
    expect(
      equivalenceOf(
        candidateFixture({
          args: {
            path: "report.txt",
            snapshotId: 99,
            ref: "e42",
            toolCallId: "call-zzz",
            signal: "sig",
          },
          target: { ref: "other-ref", snapshotId: 42, name: "Submit" },
        }),
      ),
    ).toBe(equivalenceOf(base));
    expect(
      equivalenceOf(candidateFixture({ args: { path: "other.txt" } })),
    ).not.toBe(equivalenceOf(base));
    expect(
      equivalenceOf(
        candidateFixture({
          target: { ref: "e1", snapshotId: 7, name: "Changed" },
        }),
      ),
    ).not.toBe(equivalenceOf(base));
    expect(
      equivalenceOf(candidateFixture({ toolRef: "mcp/files/delete" })),
    ).not.toBe(equivalenceOf(base));
    expect(equivalenceOf(candidateFixture({ effect: "read" }))).not.toBe(
      equivalenceOf(base),
    );
  });

  test("重复批准：第二次 decide 被拒，receiptOf 恒读回第一个决定", async () => {
    const double = approvalStoreDouble();
    const service = createApprovalService(double.store);
    const access = createApprovalsAccess({ service, store: double.store });
    const row = await double.store.open(approvalAction(candidateFixture()));

    const first = await access.decide(OWNER, row.id, "allow_once");
    expect(first.status).toBe("approved");
    expect(first.decision).toBe("allow_once");
    await expect(access.decide(OWNER, row.id, "deny")).rejects.toThrow(
      "already decided",
    );
    const reread = await access.receiptOf(OWNER, row.id);
    expect(reread.decision).toBe("allow_once");
    expect(reread.status).toBe("approved");
  });

  test("等价复用现状（真 service.gate）：等价挂起中→ALREADY_WAITING；拒绝后→DECLINED_BY_PERSON", async () => {
    const double = approvalStoreDouble();
    // 等价判定需要 policy 面（findEquivalent 是等价复用的读）——内存双亲。
    double.store.policy = {
      preferences: async () => ({
        enabled: true,
        autoReview: false,
        hostCommands: "ask",
      }),
      setPreferences: async () => {
        throw new Error("not used");
      },
      teamSettings: async () => ({
        enforceAutoReview: false,
        customRulesEnabled: true,
        hostCommandsCap: "allow",
      }),
      setTeamSettings: async () => {
        throw new Error("not used");
      },
      teamRules: async () => [],
      createRule: async () => {
        throw new Error("not used");
      },
      createTeamRule: async () => {
        throw new Error("not used");
      },
      updateRule: async () => {
        throw new Error("not used");
      },
      updateTeamRule: async () => {
        throw new Error("not used");
      },
      revokeTeamRule: async () => {
        throw new Error("not used");
      },
      findEquivalent: async ({
        ownerUserId,
        threadId,
        equivalence,
        excludeToolCallId,
      }) =>
        [...double.records.values()].find(
          (row) =>
            row.ownerUserId === ownerUserId &&
            row.action.threadId === threadId &&
            row.action.equivalence === equivalence &&
            row.action.toolCallId !== excludeToolCallId,
        ),
      withdrawPending: async () => [],
      recordDecision: async () => undefined,
    } as never;
    const service = createApprovalService(double.store);
    // 第一个动作：挂起等待（真 gate 走完等价评估与 open）。
    await expect(service.gate(candidateFixture())).rejects.toThrow();
    expect([...double.records.values()].length).toBe(1);
    // 等价的第二个动作（不同 toolCallId、同 args/target）：不重复开请求。
    await expect(
      service.gate(candidateFixture({ toolCallId: "call-2" })),
    ).rejects.toThrow("already waiting");
    // 第一个请求被拒后：等价动作在本轮对话内不再询问。
    const pending = [...double.records.values()][0];
    await double.store.decide(OWNER, pending.id, "deny");
    await expect(
      service.gate(candidateFixture({ toolCallId: "call-3" })),
    ).rejects.toThrow("declined this action");
  });
});

// ---------------------------------------------------------------------------
// C3 验收②：CAS + generation 单驱动者
// ---------------------------------------------------------------------------

describe("MOD13 C3 (验收②): CAS 单驱动者——claim 互斥与决定幂等", () => {
  test("第二个恢复者输在具名 CAS 冲突上；drive 恰一次", async () => {
    const { ct, engine, facade } = continuationStack(["resumed"]);
    const scope = scopeFixture();
    const ref = await parkedRow({ store: ct.store });
    const decision = approvedDecision("ap-1", payloadFixture().argsDigest);

    const [winner, loser] = await Promise.allSettled([
      facade.resumeContinuation({ scope, ref, decision }),
      facade.resumeContinuation({ scope, ref, decision }),
    ]);
    const kinds = [winner, loser].map((s) => s.status);
    expect(kinds.filter((s) => s === "fulfilled").length).toBe(1);
    expect(kinds.filter((s) => s === "rejected").length).toBe(1);
    const rejected = [winner, loser].find(
      (settled) => settled.status === "rejected",
    );
    const loserReason = rejected?.reason as MastraContinuationRefusal;
    expect(loserReason instanceof MastraContinuationRefusal).toBe(true);
    expect(loserReason.code).toContain("REVISION_CONFLICT");
    expect(engine.calls).toBe(1);
  });

  test("陈旧 ref（旧 revision）claim 被拒——门面与直调同判", async () => {
    const { ct, facade } = continuationStack([]);
    const scope = scopeFixture();
    const ref = await parkedRow({ store: ct.store });
    await facade.claimContinuation(
      scope,
      ref,
      approvedDecision("ap-1", payloadFixture().argsDigest),
    );
    const staleRef: ResumeRef = {
      continuationId: ref.continuationId,
      revision: ref.revision - 1,
    };
    await expect(
      facade.claimContinuation(
        scope,
        staleRef,
        approvedDecision("ap-1", payloadFixture().argsDigest),
      ),
    ).rejects.toThrow("REVISION_CONFLICT");
    await expect(
      ct.store.claimContinuation(
        scope,
        staleRef,
        approvedDecision("ap-1", payloadFixture().argsDigest),
      ),
    ).rejects.toThrow("REVISION_CONFLICT");
  });

  test("同一决定重放收敛 already_applied——不再触 store/驱动", async () => {
    const { ct, engine, facade } = continuationStack(["resumed"]);
    const scope = scopeFixture();
    const ref = await parkedRow({ store: ct.store });
    const decision = approvedDecision("ap-1", payloadFixture().argsDigest);
    const first = await facade.resumeContinuation({ scope, ref, decision });
    expect(first).toEqual({
      kind: "resumed",
      answer: "turn continued (approved)",
    });

    const claimsBefore = ct.counts.claimContinuation;
    const replay = await facade.resumeContinuation({ scope, ref, decision });
    expect(replay).toEqual({ kind: "already_applied" });
    expect(ct.counts.claimContinuation).toBe(claimsBefore);
    expect(engine.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// C4 验收③：重启读 receipt 不重发外部副作用
// ---------------------------------------------------------------------------

describe("MOD13 C4 (验收③): 重启读原 receipt，不重发外部副作用", () => {
  test("M08：真 service.resume 完成一次后，新门面实例读回原 receipt、再写为 false、通道恰一次", async () => {
    const double = approvalStoreDouble();
    const service = createApprovalService(double.store);
    const access = createApprovalsAccess({ service, store: double.store });
    const row = await double.store.open(approvalAction(candidateFixture()));
    await access.decide(OWNER, row.id, "allow_once");

    const executed: unknown[] = [];
    const continued: { result: { content: string; error?: string } }[] = [];
    const dependencies = {
      validate: async (action: ApprovalAction) => action,
      execute: async (action: ApprovalAction) => {
        executed.push(action.toolRef);
        return "the file was saved";
      },
      continue: async (input: {
        result: { content: string; error?: string };
      }) => {
        continued.push({ result: input.result });
      },
    };
    await service.resume(OWNER, row.id, dependencies);
    expect(executed).toEqual([TOOL_REF]);
    expect(continued).toEqual([{ result: { content: "the file was saved" } }]);

    // 重启：新门面实例（同一持久事实）。
    const restarted = createApprovalsAccess({
      service,
      store: double.store,
    });
    const receipt = await restarted.receiptOf(OWNER, row.id);
    expect(receipt.status).toBe("completed");
    expect(receipt.result?.content).toBe("the file was saved");
    // 首写者已胜：重启者不得再写 receipt，也就不得再发通道。
    expect(
      await restarted.saveReceipt(OWNER, row.id, { content: "again" }),
    ).toBe(false);
    // 再 resume：completed 早退，执行与通道计数不变。
    await service.resume(OWNER, row.id, dependencies);
    expect(executed).toEqual([TOOL_REF]);
    expect(continued.length).toBe(1);
  });

  test("M05：executed receipt 复用（reused_receipt）——崩溃后重放零再驱动", async () => {
    const { ct, engine, facade } = continuationStack(["crash-after-executed"]);
    const scope = scopeFixture();
    const ref = await parkedRow({ store: ct.store });
    const decision = approvedDecision("ap-1", payloadFixture().argsDigest);
    // drive 在 executed 之后崩溃：外部效果已证明发生、行未终态。
    await expect(
      facade.resumeContinuation({ scope, ref, decision }),
    ).rejects.toThrow("engine died after executed");
    expect(engine.externalEffects.reached).toBe(1);
    ct.advance(CLAIM_TTL_MS + 1);
    const replay = await facade.resumeContinuation({ scope, ref, decision });
    expect(replay).toEqual({
      kind: "reused_receipt",
      receiptId: "rc-1",
    });
    expect(engine.calls).toBe(1);
    expect(engine.externalEffects.reached).toBe(1);
    expect(
      (await facade.continuationFor(scope, ref.continuationId))?.status,
    ).toBe("finished");
  });
});

// ---------------------------------------------------------------------------
// C5 验收④：无供应商幂等证据，超时进 unknown（现状钉）
// ---------------------------------------------------------------------------

describe("MOD13 C5 (验收④): unknown 超时现状——不承诺跨网络 exactly once", () => {
  test("started 后崩溃：接管重放收敛 pending_unknown（failed_unknown 终态），不再驱动", async () => {
    const { ct, engine, facade } = continuationStack(["crash-after-started"]);
    const scope = scopeFixture();
    const ref = await parkedRow({ store: ct.store });
    const decision = approvedDecision("ap-1", payloadFixture().argsDigest);
    await expect(
      facade.resumeContinuation({ scope, ref, decision }),
    ).rejects.toThrow("engine died after start");
    // started 已记录、executed 未到：receipt 是 unknown——效果是否发生不可证明。
    const record = (await facade.continuationFor(scope, ref.continuationId))!;
    expect(
      (await facade.receiptEvidence(scope, record.operationId))?.status,
    ).toBe("unknown");
    // 未过期时立即重放：claim 仍被持有，具名冲突。
    await expect(
      facade.resumeContinuation({ scope, ref, decision }),
    ).rejects.toThrow("REVISION_CONFLICT");
    ct.advance(CLAIM_TTL_MS + 1);
    const replay = await facade.resumeContinuation({ scope, ref, decision });
    expect(replay).toEqual({
      kind: "pending_unknown",
      continuationId: ref.continuationId,
    });
    expect(engine.calls).toBe(1); // 待处置不重驱动
    expect(ct.outcomes).toContain("failed_unknown");
    expect(await facade.receiptEvidence(scope, "op-x")).toBeNull(); // 无关 operationId 读作无证据
  });

  test("recordOperationStarted 的 F1 栅栏：已有 receipt 的后来者得 started:false", async () => {
    const { ct, facade } = continuationStack([]);
    const scope = scopeFixture();
    const ref = await parkedRow({ store: ct.store });
    const record = (await facade.continuationFor(scope, ref.continuationId))!;
    const first = await facade.recordOperationStarted(scope, {
      operationId: record.operationId,
      runId: record.binding.runId,
      toolCallId: record.payload.toolCallId,
      toolName: record.payload.toolName,
      argsDigest: record.payload.argsDigest,
    });
    expect(first).toEqual({ started: true });
    const second = await facade.recordOperationStarted(scope, {
      operationId: record.operationId,
      runId: record.binding.runId,
      toolCallId: record.payload.toolCallId,
      toolName: record.payload.toolName,
      argsDigest: record.payload.argsDigest,
    });
    expect(second).toEqual({ started: false, status: "unknown" });
    // 证据读回：unknown，直到 executed 升级。
    const evidence = await facade.receiptEvidence(scope, record.operationId);
    expect(evidence).toEqual({ receiptId: "rc-1", status: "unknown" });
    await ct.store.recordOperationExecuted(scope, record.operationId);
    expect(
      (await facade.receiptEvidence(scope, record.operationId))?.status,
    ).toBe("executed");
  });

  test("started 前崩溃（零证据）：接管后安全再驱动恰一次", async () => {
    const { ct, engine, facade } = continuationStack([
      "crash-before-started",
      "resumed",
    ]);
    const scope = scopeFixture();
    const ref = await parkedRow({ store: ct.store });
    const decision = approvedDecision("ap-1", payloadFixture().argsDigest);
    await expect(
      facade.resumeContinuation({ scope, ref, decision }),
    ).rejects.toThrow("engine died before start");
    ct.advance(CLAIM_TTL_MS + 1);
    const replay = await facade.resumeContinuation({ scope, ref, decision });
    expect(replay).toEqual({
      kind: "resumed",
      answer: "turn continued (approved)",
    });
    expect(engine.calls).toBe(2); // 两次进入驱动
    expect(engine.externalEffects.reached).toBe(1); // 外部效果恰一次
  });
});

// ---------------------------------------------------------------------------
// C6 验收⑤：真实结果，不填假成功
// ---------------------------------------------------------------------------

describe("MOD13 C6 (验收⑤): 真实结果——执行错误/未知/拒绝都不伪装成功", () => {
  test("M08：执行错误原样进 result.error；不填假成功", async () => {
    const double = approvalStoreDouble();
    const service = createApprovalService(double.store);
    const access = createApprovalsAccess({ service, store: double.store });
    const row = await double.store.open(approvalAction(candidateFixture()));
    await access.decide(OWNER, row.id, "allow_once");
    const continued: { content: string; error?: string }[] = [];
    await service.resume(OWNER, row.id, {
      validate: async (action) => action,
      execute: async () => {
        throw new Error("vendor exploded");
      },
      continue: async ({ result }) => {
        continued.push(result);
      },
    });
    expect(continued).toEqual([
      { content: "vendor exploded", error: "vendor exploded" },
    ]);
    const receipt = await access.receiptOf(OWNER, row.id);
    expect(receipt.result?.error).toBe("vendor exploded");
  });

  test("M08：consumed 无结果的重启答案是「outcome is unknown…not repeated」，不再执行", async () => {
    const double = approvalStoreDouble();
    const service = createApprovalService(double.store);
    const access = createApprovalsAccess({ service, store: double.store });
    const action = approvalAction(candidateFixture());
    const row = await double.store.open(action);
    await access.decide(OWNER, row.id, "allow_once");
    // 崩溃窗口：已消费（执行已开始）但结果未写。
    expect(await double.store.consume(OWNER, row.id, action.actionDigest)).toBe(
      true,
    );
    const executed: unknown[] = [];
    const continued: { content: string; error?: string }[] = [];
    await service.resume(OWNER, row.id, {
      validate: async (a) => a,
      execute: async (a) => {
        executed.push(a.toolRef);
        return "never happens";
      },
      continue: async ({ result }) => {
        continued.push(result);
      },
    });
    expect(executed).toEqual([]);
    expect(continued.length).toBe(1);
    expect(continued[0].content).toContain("outcome is unknown");
    expect(continued[0].content).toContain("not repeated");
    expect(continued[0].error).toContain("unknown");
  });

  test("M08：拒绝的答案是 DECLINED_BY_PERSON，零执行", async () => {
    const double = approvalStoreDouble();
    const service = createApprovalService(double.store);
    const access = createApprovalsAccess({ service, store: double.store });
    const row = await double.store.open(approvalAction(candidateFixture()));
    await access.decide(OWNER, row.id, "deny");
    const executed: unknown[] = [];
    const continued: { content: string; error?: string }[] = [];
    await service.resume(OWNER, row.id, {
      validate: async (a) => a,
      execute: async (a) => {
        executed.push(a.toolRef);
        return "never";
      },
      continue: async ({ result }) => {
        continued.push(result);
      },
    });
    expect(executed).toEqual([]);
    expect(continued[0].content).toContain("declined this action");
    expect(continued[0].error).toContain("declined this action");
  });

  test("M05：declined 终态无 receipt；re_suspended 保持 unknown 不升级", async () => {
    const declinedStack = continuationStack(["declined"]);
    const scopeD = scopeFixture();
    const refD = await parkedRow({ store: declinedStack.ct.store });
    const declined = await declinedStack.facade.resumeContinuation({
      scope: scopeD,
      ref: refD,
      decision: { kind: "declined", approvalId: "ap-1", reason: "no" },
    });
    expect(declined).toEqual({ kind: "declined" });
    expect(declinedStack.ct.receipts.size).toBe(0); // 拒绝从不记录 receipt
    expect(declinedStack.ct.outcomes).toEqual(["declined"]);

    const resusStack = continuationStack(["re_suspended"]);
    const scopeR = scopeFixture();
    const refR = await parkedRow({ store: resusStack.ct.store });
    const reSuspended = await resusStack.facade.resumeContinuation({
      scope: scopeR,
      ref: refR,
      decision: approvedDecision("ap-1", payloadFixture().argsDigest),
    });
    expect(reSuspended.kind).toBe("re_suspended");
    const row = (await resusStack.facade.continuationFor(
      scopeR,
      refR.continuationId,
    ))!;
    expect(row.status).toBe("waiting"); // 回到等待，不是终态
    const record = (await resusStack.facade.continuationFor(
      scopeR,
      refR.continuationId,
    ))!;
    expect(record.claimExpired).toBe(false);
    expect(
      (await resusStack.facade.receiptEvidence(scopeR, record.operationId))
        ?.status,
    ).toBe("unknown"); // 未升级——悬挂中的效果不证明完成
  });

  test("M05：re_suspended 后同决定重放按证据收敛 pending_unknown（不重驱动）", async () => {
    const { ct, engine, facade } = continuationStack(["re_suspended"]);
    const scope = scopeFixture();
    const ref = await parkedRow({ store: ct.store });
    const decision = approvedDecision("ap-1", payloadFixture().argsDigest);
    await facade.resumeContinuation({ scope, ref, decision });
    // 换新决定 id 重放（模拟接管者）：receipt 已是 unknown → 待处置。
    const replay = await facade.resumeContinuation({
      scope,
      ref,
      decision: approvedDecision("ap-2", payloadFixture().argsDigest),
    });
    expect(replay.kind).toBe("pending_unknown");
    expect(engine.calls).toBe(1);
    expect(ct.outcomes).toContain("failed_unknown");
  });
});

// ---------------------------------------------------------------------------
// 源级钉：冻结普查与唯一出口
// ---------------------------------------------------------------------------

/** Strips comments so pins read code, not prose. */
function codeOf(relative: string): string {
  const raw = readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf-8",
  );
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const specifiersOf = (relative: string) =>
  [
    ...new Set(
      [
        ...readFileSync(
          fileURLToPath(new URL(relative, import.meta.url)),
          "utf-8",
        ).matchAll(/from "([^"]+)"/g),
      ].map((match) => match[1]),
    ),
  ].sort();

describe("MOD13 源级钉: 能力组边界与迁移完整性", () => {
  test("approvals/public.ts 只 import 组内 service/types，且四成员恒等委托", () => {
    const file = "../../src/approvals/public.ts";
    expect(specifiersOf(file)).toEqual(["./service", "./types"]);
    const code = codeOf(file);
    for (const banned of [
      "console.",
      "getLogger",
      "recordAuditEvent",
      "auditStore",
      "logger",
    ]) {
      expect(code.includes(banned), `must not contain ${banned}`).toBe(false);
    }
    expect(code).toMatch(
      /decide: \(\.\.\.input\) => service\.decide\(\.\.\.input\)/,
    );
    expect(code).toMatch(
      /receiptOf: \(\.\.\.input\) => store\.get\(\.\.\.input\)/,
    );
    expect(code).toMatch(
      /saveReceipt: \(\.\.\.input\) => store\.saveResult\(\.\.\.input\)/,
    );
    expect(code).toMatch(
      /complete: \(\.\.\.input\) => store\.finish\(\.\.\.input\)/,
    );
    // 等价合同是唯一 re-export，不是第二处定义。
    expect(code).toContain('export { equivalenceOf } from "./service"');
  });

  test("runs/continuations.ts 只 import M05 组内三文件，六成员恒等委托、零持久化面", () => {
    const file = "../../src/enterprise/runs/continuations.ts";
    expect(specifiersOf(file)).toEqual([
      "../../mastra/approvals",
      "../../mastra/continuation-store",
      "../../mastra/execution-contracts",
    ]);
    const code = codeOf(file);
    for (const banned of [
      ".insert(",
      ".update(",
      ".delete(",
      ".transaction(",
      "console.",
      "getLogger",
    ]) {
      expect(code.includes(banned), `must not contain ${banned}`).toBe(false);
    }
    // 注释剥离后，面名单里没有引擎面（finish/release/saveSuspension 不扩面）。
    expect(code).not.toMatch(
      /finishContinuation|releaseClaim|saveSuspension|saveContinuation|recordOperationExecuted/,
    );
    expect(code).toMatch(
      /continuationFor: \(scope, continuationId\) =>\s*store\.getContinuation\(scope, continuationId\)/,
    );
    expect(code).toMatch(
      /claimContinuation: \(scope, ref, decision\) =>\s*store\.claimContinuation\(scope, ref, decision\)/,
    );
    expect(code).toMatch(/resumeContinuation: \(input\) => resume\(input\)/);
  });

  test("plugins/public.ts 承载 approvals 槽且 import 名单不变（MOD12 钉保持）", () => {
    const file = "../../src/plugins/public.ts";
    const code = codeOf(file);
    expect(code).toContain("readonly approvals?: TApprovals;");
    expect(code).toMatch(/const \{ store, approvals \} = deps;/);
    expect(code.includes("\n    approvals,\n  };")).toBe(true);
    expect(specifiersOf(file)).toEqual([
      "../credentials",
      "./selection",
      "./store",
      "./tools",
    ]);
  });

  test("runtime.ts 迁移面：决定/receipt 与恢复入口经两门面，直调内件清零", () => {
    const code = codeOf("../../src/assembly/runtime.ts");
    for (const pinned of [
      "approvalsAccess.receiptOf(",
      "approvalsAccess.saveReceipt(",
      "approvalsAccess.complete(",
      "runContinuations.waitingContinuations(scope)",
      "runContinuations.resumeContinuation({",
      "createApprovalsAccess({",
      "createRunContinuations({",
      "approvals: approvalsAccess,",
    ]) {
      expect(code.includes(pinned), `missing ${pinned}`).toBe(true);
    }
    for (const banned of [
      "approvalService.store.get(",
      "approvalService.store.saveResult(",
      "approvalService.store.finish(",
      "mastraContinuationStore.listContinuations(",
      "mastraContinuationInstall.resume({",
    ]) {
      expect(code.includes(banned), `leftover direct call ${banned}`).toBe(
        false,
      );
    }
    // MOD12 受管门 census 不变：.callTool( 在 runtime 仍恰一点。
    expect([...code.matchAll(/\.\s*callTool\s*\(/g)].length).toBe(1);
  });

  test("resume-driver.ts 排序纪律（真实引擎行为的源级钉）", () => {
    const code = codeOf("../../src/mastra/resume-driver.ts");
    // declined 分支在 receiptSink.started 之前返回——拒绝从不记录 receipt。
    expect(code.indexOf("declineToolCall")).toBeGreaterThanOrEqual(0);
    expect(code.indexOf("declineToolCall")).toBeLessThan(
      code.indexOf("await receiptSink.started();"),
    );
    // re_suspended 分支：先 saveSuspension 再返回，且该分支不 executed()。
    const suspendedFrom = code.indexOf('produced.finishReason === "suspended"');
    const suspendedTo = code.indexOf('return { outcome: "re_suspended"');
    expect(suspendedFrom).toBeGreaterThanOrEqual(0);
    expect(suspendedTo).toBeGreaterThan(suspendedFrom);
    const suspendedBranch = code.slice(suspendedFrom, suspendedTo);
    expect(suspendedBranch).toContain("saveSuspension(fact)");
    expect(suspendedBranch.includes(".executed()")).toBe(false);
  });
});
