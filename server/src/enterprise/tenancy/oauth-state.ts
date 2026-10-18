// server/src/enterprise/tenancy/oauth-state.ts
// MT028（Issue #71）：OAuth 回调按服务端持久 state 固定归属。
//
// 票面：发起 OAuth 时服务端保存发起公司、团队、用户与目标连接；回调只按
// 这份持久状态绑定结果，与回调时客户端选择无关；state 缺失、过期、重复
// 使用或跨范围复用时拒绝并记录安全事件；回调失败不产生半成品连接，重试
// 必须用新 state；回调响应与日志零 token 明文。
//
// 机制（MT026 身份绑定 intent 的连接凭据版，机制族一致）：
//
//   - initiate：受信 Scope（assertTrustedScope）→ 受限 operator 事务（pin
//     app.tenant_id）→ 服务端生成不透明 state 与 PKCE verifier → INSERT
//     pending 行（归属三元组 + purpose + target 全部来自受信 Scope 与调用
//     参数，客户端无法用自选 scope 发起）→ 返回 state 与 S256 challenge。
//   - consume：无会话回调的唯一归属入口。state 臂读持久行 → 五拒绝
//     （MISSING/EXPIRED/REPLAYED/CROSS_SCOPE/INITIATOR_INELIGIBLE）→ 归属
//     完全来自持久行：claimed 租户/团队/属主只参与比对、永不决定；跨范围
//     不匹配响亮拒绝且不消费（MT026 先例：声称既不生效也不烧掉 state——
//     诚实的后续回调仍解析到持久公司）；发起人存活重验（公司 + 团队成员
//     资格 active，A5）在消费前同一事务完成；一次性消费 = UPDATE 只认
//     `status='pending' 且 expires_at > now()` 的原子臂。每个 deny 都写
//     一条 oauth.state.rejected 安全事件（enterprise_security_events，与
//     MT007 撤权审计同一张表、同一条受限 operator RLS INSERT 策略）。
//   - fail：pending→failed / consumed→failed（闭集原因）；终态，consume
//     再遇 = REPLAYED——「重试必须新 state」由结构保证。
//
// 「回调失败无半成品连接」的实现面：本模块唯一的写面是 state 行与安全
// 事件——它不 import 任何凭据/连接存储（套件钉死此源面），连接落库属于
// 调用方在 allow 分支内的下游职责。deny 变体不携带任何可执行物。
//
// 明文面：verifier 只经 allow binding 离开本模块；安全事件 details 是闭形
// 非机密事实（code/purpose/target/state_present），绝不携带 state 值、
// verifier 或任何 token 材料。模块零 console、零 process.env；拒绝消息只
// 含代码，绝不回显任何值（与 MT014/MT015/MT027 同一纪律）。

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { enterpriseOAuthStates } from "../../db/schema/enterprise-oauth-state";
import {
  enterpriseMemberships,
  enterpriseSecurityEvents,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import { assertOperatorDatabase, type OperatorDatabase } from "./connections";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 词汇
// ---------------------------------------------------------------------------

/** 连接目的闭集：对齐 MT027 凭据 kind（连接凭据 / 站点登录）。 */
export type OAuthConnectionPurpose = "connection" | "site-login";

/**
 * 拒绝码（模块级事实；HTTP 层统一折叠为失败重定向，绝不区分给回调方——
 * 对无会话端点指出「走到了哪一步」就是给探测者递梯子）。
 */
export type OAuthStateRejectionCode =
  | "STATE_MISSING"
  | "STATE_EXPIRED"
  | "STATE_REPLAYED"
  | "STATE_CROSS_SCOPE"
  | "STATE_INITIATOR_INELIGIBLE";

/** 失败原因闭集（fail 的三个可达原因）。 */
export type OAuthStateFailureReason =
  | "vendor-refused"
  | "record-failed"
  | "abandoned";

/** 安全事件类型闭集（enterprise_security_events.event_type）。 */
export const OAUTH_STATE_REJECTED_EVENT_TYPE = "oauth.state.rejected";

/** 回调绑定结果：完全来自持久行，不含任何 claimed 值。 */
export interface OAuthStateBinding {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly purpose: OAuthConnectionPurpose;
  readonly target: string;
  /** 发起时生成的 PKCE verifier（只经此字段离开本模块）。 */
  readonly verifier: string;
}

export type OAuthStateConsumption =
  | { readonly outcome: "allow"; readonly binding: OAuthStateBinding }
  | {
      readonly outcome: "deny";
      readonly code: OAuthStateRejectionCode;
      /** 拒绝伴随的安全事件 id；无法归属时为 null（绝不臆造租户落行）。 */
      readonly securityEventId: string | null;
    };

const PURPOSES: readonly OAuthConnectionPurpose[] = [
  "connection",
  "site-login",
];
const FAILURE_REASONS: readonly OAuthStateFailureReason[] = [
  "vendor-refused",
  "record-failed",
  "abandoned",
];
const DEFAULT_TTL_SECONDS = 600;
const MIN_TTL_SECONDS = 1;
const MAX_TTL_SECONDS = 86_400;
const TARGET_MAX = 512;

// ---------------------------------------------------------------------------
// 输入校验：拒绝只含代码与字段路径，绝不回显任何值
// ---------------------------------------------------------------------------

function requireString(
  value: unknown,
  code: string,
  min: number,
  max: number,
): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new Error(code);
  }
  return value;
}

function rejectExtraKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new Error(`OAUTH_STATE_INVALID: unexpected field ${key}`);
    }
  }
}

/** PKCE verifier：服务端生成，unreserved 字符，远超 43 字符下限。 */
function createVerifier(): string {
  return randomBytes(48).toString("base64url");
}

/** S256 challenge：与 plugins/oauth.ts 的 challengeFor 同一算法。 */
export function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ---------------------------------------------------------------------------
// 服务（受限 operator 通道；通道形状由 assertOperatorDatabase 钉死）
// ---------------------------------------------------------------------------

/** operator 事务句柄（与 admin-separation/credential-ownership 同形）。 */
type OperatorTransaction = Parameters<
  Parameters<OperatorDatabase["transaction"]>[0]
>[0];

/**
 * 把一条 state 拒绝写进 enterprise_security_events——与撤权审计
 * （MT007）同一张表、同一条受限 operator 角色 RLS INSERT 策略
 * （app.tenant_id + app.operation_id pin）。调用方事务必须已 pin
 * app.tenant_id（持久行的公司）；本函数 pin app.operation_id。details 是
 * 闭形非机密事实：绝不携带 state 值、verifier 或 claimed 输入。
 * 写入失败原样上抛——拒绝不留痕绝不被折叠成成功。
 */
async function recordStateRejectionEvent(
  tx: OperatorTransaction,
  input: {
    readonly tenantId: string;
    readonly actorId: string;
    readonly code: OAuthStateRejectionCode;
    readonly purpose: string | null;
    readonly target: string | null;
    readonly statePresent: boolean;
  },
): Promise<string> {
  const eventId = randomUUID();
  await tx.execute(
    sql`select set_config('app.operation_id', ${eventId}, true)`,
  );
  await tx.insert(enterpriseSecurityEvents).values({
    tenantId: input.tenantId,
    id: eventId,
    operationId: eventId,
    actorId: input.actorId,
    eventType: OAUTH_STATE_REJECTED_EVENT_TYPE,
    details: {
      code: input.code,
      purpose: input.purpose,
      target: input.target,
      // 拒绝时持久行是否存在（MISSING=false，其余=true）——闭形事实，
      // 绝不携带 state 值本身。
      state_present: input.statePresent,
    },
  });
  return eventId;
}

export interface OAuthStateService {
  /**
   * 发起一次连接 OAuth：归属三元组与连接目的在发起时固定。只接受受信
   * Scope——客户端无法用自选公司/团队/属主发起流程。
   */
  initiate(
    scope: PlatformScope,
    input: {
      readonly purpose: OAuthConnectionPurpose;
      readonly target: string;
      readonly ttlSeconds?: number;
    },
  ): Promise<{
    readonly state: string;
    readonly codeChallenge: string;
    readonly expiresAt: Date;
  }>;

  /**
   * 无会话回调的唯一归属入口。归属完全来自持久行；claimed 值只参与比对
   * （不匹配 = CROSS_SCOPE，不消费）。`securityAttributionTenantId` 仅供
   * STATE_MISSING 的调用方在确有归属事实时显式供给；模块绝不臆造租户。
   */
  consume(
    state: string,
    options?: {
      readonly claimedTenantId?: string;
      readonly claimedWorkspaceId?: string;
      readonly claimedPrincipalId?: string;
      readonly securityAttributionTenantId?: string;
    },
  ): Promise<OAuthStateConsumption>;

  /** 终态失败（vendor 拒绝 / 落库失败 / 放弃）；之后 consume 一律 REPLAYED。 */
  fail(
    state: string,
    input: { readonly reason: OAuthStateFailureReason },
  ): Promise<{ readonly failed: boolean }>;
}

export function createOAuthStateService(
  operator: OperatorDatabase,
): OAuthStateService {
  assertOperatorDatabase(operator);

  const denied = (
    code: OAuthStateRejectionCode,
    securityEventId: string | null,
  ): OAuthStateConsumption =>
    Object.freeze({ outcome: "deny", code, securityEventId });

  return {
    async initiate(scope, input) {
      assertTrustedScope(scope);
      rejectExtraKeys(input as unknown as Record<string, unknown>, [
        "purpose",
        "target",
        "ttlSeconds",
      ]);
      if (!PURPOSES.includes(input.purpose)) {
        throw new Error("OAUTH_STATE_INVALID: purpose");
      }
      const target = requireString(
        input.target,
        "OAUTH_STATE_INVALID: target",
        1,
        TARGET_MAX,
      );
      const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
      if (
        !Number.isSafeInteger(ttlSeconds) ||
        ttlSeconds < MIN_TTL_SECONDS ||
        ttlSeconds > MAX_TTL_SECONDS
      ) {
        throw new Error(
          `OAUTH_STATE_INVALID: ttlSeconds must be an integer of ${MIN_TTL_SECONDS}..${MAX_TTL_SECONDS}`,
        );
      }
      const verifier = createVerifier();
      const state = randomUUID();
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      await operator.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
        );
        await tx.insert(enterpriseOAuthStates).values({
          id: state,
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          principalId: scope.principalId,
          purpose: input.purpose,
          target,
          verifier,
          status: "pending",
          expiresAt,
        });
      });
      return { state, codeChallenge: codeChallengeFor(verifier), expiresAt };
    },

    async consume(state, options) {
      if (typeof state !== "string" || !state.trim()) {
        // 模块误用与回调缺失要能区分：空值是调用方 bug，响亮拒绝。
        throw new Error("OAUTH_STATE_INVALID: state");
      }
      const claimed = options ?? {};
      rejectExtraKeys(claimed as Record<string, unknown>, [
        "claimedTenantId",
        "claimedWorkspaceId",
        "claimedPrincipalId",
        "securityAttributionTenantId",
      ]);
      return operator.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        // state 臂：受限角色每次事务至多见到一行，无法按公司枚举流程。
        await tx.execute(
          sql`select set_config('app.oauth_state', ${state}, true)`,
        );
        const [row] = await tx
          .select({
            tenantId: enterpriseOAuthStates.tenantId,
            workspaceId: enterpriseOAuthStates.workspaceId,
            principalId: enterpriseOAuthStates.principalId,
            purpose: enterpriseOAuthStates.purpose,
            target: enterpriseOAuthStates.target,
            verifier: enterpriseOAuthStates.verifier,
            status: enterpriseOAuthStates.status,
            expiresAt: enterpriseOAuthStates.expiresAt,
          })
          .from(enterpriseOAuthStates)
          .where(eq(enterpriseOAuthStates.id, state))
          .limit(1);
        if (!row) {
          // 缺失：无归属公司。仅在调用方显式供给归属租户时落事件——模块
          // 绝不臆造租户（「不填虚假租户标识」）。
          const attribution = claimed.securityAttributionTenantId;
          let eventId: string | null = null;
          if (typeof attribution === "string" && attribution.trim()) {
            await tx.execute(
              sql`select set_config('app.tenant_id', ${attribution}, true)`,
            );
            eventId = await recordStateRejectionEvent(tx, {
              tenantId: attribution,
              actorId: "unknown",
              code: "STATE_MISSING",
              purpose: null,
              target: null,
              statePresent: false,
            });
          }
          return denied("STATE_MISSING", eventId);
        }
        // 归属公司已从持久行得知：pin 它（同一事务后续的成员重验与事件
        // 写入都在该公司的 RLS 上下文内）。
        await tx.execute(
          sql`select set_config('app.tenant_id', ${row.tenantId}, true)`,
        );
        if (row.status !== "pending") {
          const eventId = await recordStateRejectionEvent(tx, {
            tenantId: row.tenantId,
            actorId: row.principalId,
            code: "STATE_REPLAYED",
            purpose: row.purpose,
            target: row.target,
            statePresent: true,
          });
          return denied("STATE_REPLAYED", eventId);
        }
        if (row.expiresAt.getTime() <= Date.now()) {
          const eventId = await recordStateRejectionEvent(tx, {
            tenantId: row.tenantId,
            actorId: row.principalId,
            code: "STATE_EXPIRED",
            purpose: row.purpose,
            target: row.target,
            statePresent: true,
          });
          return denied("STATE_EXPIRED", eventId);
        }
        // claimed 只比对、永不决定（MT026 先例：声称既不生效也不烧掉
        // state——诚实的后续回调仍解析到持久归属）。
        const crossScope =
          (claimed.claimedTenantId !== undefined &&
            claimed.claimedTenantId !== row.tenantId) ||
          (claimed.claimedWorkspaceId !== undefined &&
            claimed.claimedWorkspaceId !== row.workspaceId) ||
          (claimed.claimedPrincipalId !== undefined &&
            claimed.claimedPrincipalId !== row.principalId);
        if (crossScope) {
          const eventId = await recordStateRejectionEvent(tx, {
            tenantId: row.tenantId,
            actorId: row.principalId,
            code: "STATE_CROSS_SCOPE",
            purpose: row.purpose,
            target: row.target,
            statePresent: true,
          });
          return denied("STATE_CROSS_SCOPE", eventId);
        }
        // 发起人存活重验（A5）：公司成员资格与团队成员资格必须在回调时
        // 仍 active——停用/撤权后的在途流程不得落成连接。
        const [liveness] = await tx
          .select({
            companyStatus: enterpriseMemberships.status,
            workspaceStatus: enterpriseWorkspaceMemberships.status,
          })
          .from(enterpriseMemberships)
          .leftJoin(
            enterpriseWorkspaceMemberships,
            and(
              eq(enterpriseWorkspaceMemberships.tenantId, row.tenantId),
              eq(enterpriseWorkspaceMemberships.workspaceId, row.workspaceId),
              eq(enterpriseWorkspaceMemberships.principalId, row.principalId),
            ),
          )
          .where(
            and(
              eq(enterpriseMemberships.tenantId, row.tenantId),
              eq(enterpriseMemberships.principalId, row.principalId),
            ),
          )
          .limit(1);
        if (
          liveness?.companyStatus !== "active" ||
          liveness.workspaceStatus !== "active"
        ) {
          const eventId = await recordStateRejectionEvent(tx, {
            tenantId: row.tenantId,
            actorId: row.principalId,
            code: "STATE_INITIATOR_INELIGIBLE",
            purpose: row.purpose,
            target: row.target,
            statePresent: true,
          });
          return denied("STATE_INITIATOR_INELIGIBLE", eventId);
        }
        // 一次性消费：原子臂只认 pending 且未过期——并发双消费恰一 allow。
        const consumed = await tx
          .update(enterpriseOAuthStates)
          .set({ status: "consumed", consumedAt: sql`now()` })
          .where(
            sql`${enterpriseOAuthStates.id} = ${state} and ${enterpriseOAuthStates.status} = 'pending' and ${enterpriseOAuthStates.expiresAt} > now()`,
          )
          .returning({ id: enterpriseOAuthStates.id });
        if (consumed.length !== 1) {
          const eventId = await recordStateRejectionEvent(tx, {
            tenantId: row.tenantId,
            actorId: row.principalId,
            code: "STATE_REPLAYED",
            purpose: row.purpose,
            target: row.target,
            statePresent: true,
          });
          return denied("STATE_REPLAYED", eventId);
        }
        return {
          outcome: "allow" as const,
          binding: Object.freeze({
            tenantId: row.tenantId,
            workspaceId: row.workspaceId,
            principalId: row.principalId,
            purpose: row.purpose as OAuthConnectionPurpose,
            target: row.target,
            verifier: row.verifier,
          }),
        };
      });
    },

    async fail(state, input) {
      if (typeof state !== "string" || !state.trim()) {
        throw new Error("OAUTH_STATE_INVALID: state");
      }
      if (!FAILURE_REASONS.includes(input?.reason)) {
        throw new Error("OAUTH_STATE_INVALID: reason");
      }
      return operator.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.oauth_state', ${state}, true)`,
        );
        const rows = await tx
          .update(enterpriseOAuthStates)
          .set({
            status: "failed",
            failedAt: sql`now()`,
            failedReason: input.reason,
          })
          .where(
            sql`${enterpriseOAuthStates.id} = ${state} and ${enterpriseOAuthStates.status} in ('pending', 'consumed')`,
          )
          .returning({ id: enterpriseOAuthStates.id });
        return { failed: rows.length === 1 };
      });
    },
  };
}
