// server/src/enterprise/tenancy/revocation.ts
// MT007（Issue #50）：成员停用与撤权的级联生效与审计留痕。
//
// 本文件是下游各闭环 Ticket 的**单一撤权判定入口**（Issue #50 备注：
// 失效点清单是复用基础，下游不各自实现撤权判断），三件事：
//
//   1. 失效点清单（REVOCATION_CHECKPOINTS）：票面命名的六个失效点——
//      列表、详情读取、下载签发、事件订阅、任务敏感动作、凭据取用。
//      清单是封闭集合：未列名的检查点响亮拒绝（REVOCATION_CHECKPOINT_
//      UNKNOWN），杜绝下游用拼错的名字静默绕过。
//   2. 级联判定（createRevocationGuard）：受信 Scope → 在同一数据事务内
//      重验两级成员资格——公司停用（enterprise_memberships）→ SCOPE_
//      REVOKED（level=company，该公司范围内全部团队权限一次失效）；
//      团队停用（enterprise_workspace_memberships）→ WORKSPACE_REVOKED
//      （level=team，其他团队与其他公司不受影响）。判定**完全复用
//      MT005 的 scope-gate seam**（同一锁序、同一 set_config、同一事实
//      行），本文件不复制重验逻辑。恢复语义：每次调用都读实时行，
//      两个判定之间不保存任何结果——停用后的恢复立即重新放行，不存在
//      拒绝缓存（AC3）。基础设施故障原样上抛，绝不折叠成拒绝或放行。
//   3. 审计事件写入（recordRevocationAuditEvent）：每次停用/恢复/撤权
//      在同一管理事务内写一条 enterprise_security_events（AC4）：
//      操作者（actor_id=操作者 principal，details 双记 principal/user）、
//      对象（target_principal_id）、范围（tenant_id；团队事件带
//      workspace_id）、版本（epoch，变更后的成员关系版本）、时间
//      （created_at，库端 now()）。写入经受限 operator 角色与真实 RLS
//      （INSERT 策略钉 app.tenant_id + app.operation_id）。

import { sql } from "drizzle-orm";
import { enterpriseSecurityEvents } from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import type { DataDatabase, OperatorDatabase } from "./connections";
import { createWorkspaceGate } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 1. 失效点清单
// ---------------------------------------------------------------------------

/**
 * 票面命名的六个失效点（Issue #50 验收 1，逐点测试钉死）。下游业务
 * 闭环接入时把自己的入口映射到其中一个检查点，经 createRevocationGuard
 * 判定，不各自实现撤权判断。
 */
export const REVOCATION_CHECKPOINTS: readonly string[] = [
  "list",
  "detail.read",
  "download.issue",
  "events.subscribe",
  "task.sensitive",
  "credentials.access",
];

export type RevocationCheckpoint = (typeof REVOCATION_CHECKPOINTS)[number];

const CHECKPOINT_IDS: ReadonlySet<string> = new Set(REVOCATION_CHECKPOINTS);

/** 封闭集合：未列名的检查点响亮拒绝，绝不静默放行。 */
export function parseRevocationCheckpoint(
  value: unknown,
): RevocationCheckpoint {
  if (typeof value === "string" && CHECKPOINT_IDS.has(value)) {
    return value as RevocationCheckpoint;
  }
  throw new Error("REVOCATION_CHECKPOINT_UNKNOWN");
}

// ---------------------------------------------------------------------------
// 2. 级联判定入口
// ---------------------------------------------------------------------------

export type RevocationDecision =
  | { readonly outcome: "allow" }
  | {
      readonly outcome: "deny";
      readonly code: "SCOPE_REVOKED" | "WORKSPACE_REVOKED";
      /** company = 公司级级联（全部团队失效）；team = 单团队失效。 */
      readonly level: "company" | "team";
    };

const ALLOWED_DECISION: RevocationDecision = Object.freeze({
  outcome: "allow",
});

export interface RevocationGuard {
  /**
   * Decides one checkpoint for a trusted scope by revalidating both
   * membership levels inside a single data transaction. Never caches:
   * every call reads the live rows.
   */
  decide(
    scope: PlatformScope,
    checkpoint: RevocationCheckpoint,
  ): Promise<RevocationDecision>;
  /** Same judgment in throwing form: SCOPE_REVOKED / WORKSPACE_REVOKED. */
  assert(scope: PlatformScope, checkpoint: RevocationCheckpoint): Promise<void>;
}

/**
 * The single revocation judgment entry. The guard wraps the MT005 workspace
 * gate: trust boundary, transaction shape, lock order and fact rows are the
 * gate's, so gate semantics and this checkpoint face cannot drift apart.
 */
export function createRevocationGuard(data: DataDatabase): RevocationGuard {
  const gate = createWorkspaceGate(data);
  const decide = async (
    scope: PlatformScope,
    checkpoint: RevocationCheckpoint,
  ): Promise<RevocationDecision> => {
    parseRevocationCheckpoint(checkpoint);
    // Trust boundary first — a forged scope must never reach the database.
    assertTrustedScope(scope);
    try {
      // A no-op operation: the gate's value is the revalidation + locks that
      // run before it; committing the empty transaction is the checkpoint.
      await gate.transaction(scope, async () => undefined);
      return ALLOWED_DECISION;
    } catch (error) {
      const code = error instanceof Error ? error.message : undefined;
      if (code === "SCOPE_REVOKED") {
        return Object.freeze({ outcome: "deny", code, level: "company" });
      }
      if (code === "WORKSPACE_REVOKED") {
        return Object.freeze({ outcome: "deny", code, level: "team" });
      }
      // Infrastructure faults are never folded into a verdict.
      throw error;
    }
  };
  return {
    decide,
    async assert(scope, checkpoint) {
      const decision = await decide(scope, checkpoint);
      if (decision.outcome === "deny") {
        throw new Error(decision.code);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 3. 审计事件写入
// ---------------------------------------------------------------------------

/** 每次停用/恢复/撤权写入的审计事件类型（封闭集合）。 */
export const REVOCATION_AUDIT_EVENT_TYPES: readonly string[] = [
  "company_member.suspended",
  "company_member.restored",
  "workspace_member.suspended",
  "workspace_member.restored",
  "workspace_member.removed",
];

export type RevocationAuditEventType =
  (typeof REVOCATION_AUDIT_EVENT_TYPES)[number];

const AUDIT_EVENT_TYPE_IDS: ReadonlySet<string> = new Set(
  REVOCATION_AUDIT_EVENT_TYPES,
);

export interface RevocationAuditEventInput {
  readonly eventType: RevocationAuditEventType;
  /** 范围：被管理的公司。 */
  readonly tenantId: string;
  /** 操作者（管理员）：principal 与登录用户双记（AC4 操作者）。 */
  readonly operatorPrincipalId: string;
  readonly operatorUserId: string;
  /** 对象：被停用/恢复/撤权的成员 principal（AC4 对象）。 */
  readonly targetPrincipalId: string;
  /** 团队级事件的团队范围；公司级事件省略。 */
  readonly workspaceId?: string;
  /** 版本：变更后的成员关系 epoch（AC4 版本）。 */
  readonly epoch: number;
}

/** The operator-role transaction an audit event is written through. */
type OperatorTransaction = Parameters<
  Parameters<OperatorDatabase["transaction"]>[0]
>[0];

/**
 * Writes one audit event inside the caller's operator transaction. The event
 * id doubles as the operation id: the security-events INSERT policy pins
 * `app.tenant_id` (set by the caller's transaction) and `app.operation_id`
 * (set here), so the write is RLS-checked against the administered company.
 * Returns the event id so actions can surface it and callers can read the
 * trail back through the restricted role.
 */
export async function recordRevocationAuditEvent(
  tx: OperatorTransaction,
  input: RevocationAuditEventInput,
): Promise<string> {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.eventType !== "string" ||
    !AUDIT_EVENT_TYPE_IDS.has(input.eventType) ||
    !String(input.tenantId ?? "").trim() ||
    !String(input.operatorPrincipalId ?? "").trim() ||
    !String(input.operatorUserId ?? "").trim() ||
    !String(input.targetPrincipalId ?? "").trim() ||
    !Number.isSafeInteger(input.epoch) ||
    input.epoch <= 0
  ) {
    throw new Error("REVOCATION_AUDIT_EVENT_INVALID");
  }
  const eventId = crypto.randomUUID();
  await tx.execute(
    sql`select set_config('app.operation_id', ${eventId}, true)`,
  );
  await tx.insert(enterpriseSecurityEvents).values({
    tenantId: input.tenantId,
    id: eventId,
    operationId: eventId,
    actorId: input.operatorPrincipalId,
    eventType: input.eventType,
    details: {
      operator_principal_id: input.operatorPrincipalId,
      operator_user_id: input.operatorUserId,
      target_principal_id: input.targetPrincipalId,
      workspace_id: input.workspaceId ?? null,
      epoch: input.epoch,
    },
  });
  return eventId;
}
