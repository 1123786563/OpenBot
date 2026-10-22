// server/src/enterprise/tenancy/openmuse-voice-mobile-tenancy.ts
// MT066（Issue #109）：语音、听写与移动聚合接口只返回当前范围。
//
// 票面语义（brief + Issue #109）：
//   AC1 语音与听写会话只对本范围授权主体可见；用量记录归属（供 MT070
//      计费）——voice_session_scopes（可见性 + usage_seconds 冻结用量）与
//      dictation_usage_scopes（听写无会话根行，用量行即持久事实）两协会
//      面；一切不可见 = MT011 canonical RESOURCE_NOT_FOUND 逐字节同形。
//   AC2 移动聚合接口的每个子查询都受当前范围限制——readMobileAggregate
//      的每个子集合（语音会话/听写用量/推送设备）独立经协会门过滤；
//      逐子查询的跨范围反例由测试钉死。
//   AC3 推送设备绑定到具体用户与范围；解绑或撤权后停止推送——
//      bindPushDevice/unbindPushDevice + authorizePushDevice 判定门（sweep
//      发送前的消费面，下游接线票接线）；解绑（删协会行）或撤权（成员
//      事实失效）后 authorize = 拒绝。
//   AC4 切换范围后聚合结果立即变化，无跨范围缓存——每次读取都是新事务
//      新判定（结构上无缓存可漂移）；同一用户连读两个三元组得到两个
//      互斥快照。
//
// 结构（纯新增，消费 MT005/MT011 既有出口与既有 voice/delivery 权威面
// ——三张归属协会表是本模块的唯一新持久化对象）：
//
//   1. 语音会话归属（pinVoiceSessionScope/listVoiceSessions/
//      readVoiceSession）：pin 时从根行冻结 usage_seconds（AC1 用量半边，
//      MT070 的消费面）；列表/读取走协会门。
//   2. 听写用量归属（recordDictationUsage/listDictationUsage）：听写面无
//      会话根行（mt10 报告核实的结构性事实），本模块把用量行本身钉到
//      (用户, 三元组)——usage_key 幂等收敛；结算库
//      （createTranscriptionSettlementService 等）的接线归下游装配票，
//      本模块交付归属与用量事实（诚实边界）。
//   3. 推送设备绑定（bindPushDevice/unbindPushDevice/authorizePushDevice，
//      AC3）：绑定钉到 (用户, 三元组)；解绑 = 删协会行（根行不动——设备
//      注册事实归既有 delivery store）；authorize 是发送前判定门。
//   4. 移动聚合快照（readMobileAggregate，AC2/AC4）：语音会话/听写用量/
//      推送设备三子查询各自经协会门（MT066 自有三表——单一写者纪律）；
//      审阅动作/通知子查询归 MT064/MT065 服务，聚合的跨模块组合由下游
//      接线票装配（诚实披露）。
//
// 事务纪律与 MT060–MT065 完全一致：assertTrustedScope → read committed +
// lock/statement timeout → set_config('app.*', …, true) 事务本地 →
// advisory 锁（键序 tenant → principal → membership → workspace-membership；
// 读共享、写排他）→ 成员事实重验 → 判定或执行。
//
// 不可见语义：canonical { outcome: "deny", code: "RESOURCE_NOT_FOUND" }
// 冻结实例（MT011 唯一事实源，逐字节同形）。
//
// 边界（诚实披露）：
//   - 本票不接路由/装配：语音/听写/聚合 HTTP 面的接线归下游票；本模块
//     提供归属、用量与判定面（MT060/MT061 同例）。
//   - 语音会话本体的写入/摘要语义归既有 voice/sessions.ts；本模块只管
//     归属与用量。
//   - f89cce08 交付的语音/听写结算库无生产调用方的接线缺口不在本票
//     （mt10 附带发现 4）：本模块的用量行是结算的输入事实，不是结算。

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import {
  type DictationUsageScopeRow,
  dictationUsageScopes,
  type PushDeviceScopeRow,
  pushDeviceScopes,
  type VoiceSessionScopeRow,
  voiceSessionScopes,
} from "../../db/schema/openmuse-voice-mobile-tenancy";
import type { PlatformScope } from "../contracts";
import {
  assertDataDatabase,
  assertOperatorDatabase,
  type DataDatabase,
  type OperatorDatabase,
} from "./connections";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 视图与判定形状
// ---------------------------------------------------------------------------

/** 归属视图：一条语音会话的 (公司, 团队, 主体, 用户, 用量秒) 事实。 */
export interface VoiceSessionScopeView {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly usageSeconds: number;
  readonly createdAt: Date;
}

/** 归属视图：一条听写用量记录的事实。 */
export interface DictationUsageView {
  readonly id: string;
  readonly usageKey: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly audioSeconds: number;
  readonly outputTokens: number;
  readonly createdAt: Date;
}

/** 归属视图：一台推送设备的绑定事实。 */
export interface PushDeviceScopeView {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly createdAt: Date;
}

/** 语音会话根行投影（既有 VoiceSessionRecord 的最小子集）。 */
export interface ScopedVoiceSessionRecord {
  readonly id: string;
  readonly channelId: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly durationSeconds: number;
}

/** 推送设备根行投影。 */
export interface ScopedPushDeviceRecord {
  readonly id: string;
  readonly platform: string;
  readonly enabled: boolean;
}

/** 范围化列表条目：根行投影 + 归属事实。 */
export interface ScopedVoiceSession {
  readonly ownership: VoiceSessionScopeView;
  readonly session: ScopedVoiceSessionRecord;
}

/** 单对象读取判定：allow 携带归属与根行；一切不可见 = canonical not-found。 */
export type VoiceSessionReadOutcome =
  | {
      readonly outcome: "allow";
      readonly ownership: VoiceSessionScopeView;
      readonly session: ScopedVoiceSessionRecord;
    }
  | ResourceNotFoundVerdict;

/** 归属 pin 结果：首建 pinned / 幂等 existing；不可见 = canonical not-found。 */
export type VoiceScopePinResult<TView> =
  | { readonly status: "pinned"; readonly ownership: TView }
  | { readonly status: "existing"; readonly ownership: TView }
  | ResourceNotFoundVerdict;

/** 听写用量记录结果：首建 recorded / 幂等 existing（usage_key 收敛）。 */
export type DictationUsageRecordResult =
  | { readonly status: "recorded"; readonly usage: DictationUsageView }
  | { readonly status: "existing"; readonly usage: DictationUsageView };

/** 设备绑定结局：绑定/幂等 existing/解绑 unbound；不可见 = not-found。 */
export type PushDeviceBindOutcome =
  | { readonly status: "bound"; readonly ownership: PushDeviceScopeView }
  | { readonly status: "existing"; readonly ownership: PushDeviceScopeView }
  | { readonly status: "unbound" }
  | ResourceNotFoundVerdict;

/** 推送判定门：allow / canonical not-found（解绑或撤权后 = 拒绝）。 */
export type PushDeviceAuthorization =
  | {
      readonly outcome: "allow";
      readonly ownership: PushDeviceScopeView;
      readonly device: ScopedPushDeviceRecord;
    }
  | ResourceNotFoundVerdict;

/** AC2 移动聚合快照：每个子集合独立经协会门。 */
export interface ScopedMobileAggregate {
  readonly voiceSessions: readonly ScopedVoiceSession[];
  readonly dictationUsage: readonly DictationUsageView[];
  readonly pushDevices: readonly {
    readonly ownership: PushDeviceScopeView;
    readonly device: ScopedPushDeviceRecord;
  }[];
}

// ---------------------------------------------------------------------------
// 拒绝：哨兵码 + canonical not-found（绝不回显归属或输入值）
// ---------------------------------------------------------------------------

export const OPENMUSE_VOICE_MOBILE_SCOPE_INVALID =
  "OPENMUSE_VOICE_MOBILE_SCOPE_INVALID";
export const OPENMUSE_VOICE_MOBILE_SCOPE_MISMATCH =
  "OPENMUSE_VOICE_MOBILE_SCOPE_MISMATCH";
export const OPENMUSE_VOICE_MOBILE_METERS_INVALID =
  "OPENMUSE_VOICE_MOBILE_METERS_INVALID";
/** 创建响亮门（MT059/MT016/MT060 同字面量：缺有效成员事实时创建拒绝）。 */
export const OPENMUSE_VOICE_MOBILE_WORKSPACE_MEMBERSHIP_REQUIRED =
  "WORKSPACE_MEMBERSHIP_REQUIRED";

function failInvalid(rule: string): never {
  throw new Error(`${OPENMUSE_VOICE_MOBILE_SCOPE_INVALID}: ${rule}`);
}

// ---------------------------------------------------------------------------
// 输入校验（形状错误响亮拒绝；错误只含规则，不回显值）
// ---------------------------------------------------------------------------

const ID_MAX = 200;
const USAGE_KEY_MAX = 300;

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > ID_MAX) {
    failInvalid(
      `${field} must be a non-empty string of at most ${ID_MAX} characters`,
    );
  }
  return value;
}

function requireUsageKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > USAGE_KEY_MAX
  ) {
    failInvalid(
      `usageKey must be a non-empty string of at most ${USAGE_KEY_MAX} characters`,
    );
  }
  return value;
}

function requireMeter(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 1_000_000_000
  ) {
    throw new Error(
      `${OPENMUSE_VOICE_MOBILE_METERS_INVALID}: ${field} must be a non-negative integer`,
    );
  }
  return value;
}

/** 聚合/列表页大小：1..100。 */
const LIST_LIMIT_MAX = 100;

// ---------------------------------------------------------------------------
// 行缝：既有 voice/delivery 权威面的最小投影
// ---------------------------------------------------------------------------

/**
 * 既有权威面的最小投影。save/list/summarize 与设备注册/解注册语义全部
 * 归既有 voice/sessions.ts 与 delivery/store.ts 权威，本模块零复刻、只
 * 做范围门后的委托。
 */
export type OpenMuseVoiceMobileTenancyRows = {
  /** owner 的一条语音会话根行（不存在/外来 = null）。 */
  findOwnedSession(
    ownerUserId: string,
    sessionId: string,
  ): Promise<ScopedVoiceSessionRecord | null>;
  listSessionsByIds(
    ownerUserId: string,
    sessionIds: readonly string[],
  ): Promise<readonly ScopedVoiceSessionRecord[]>;
  /** owner 的一台推送设备根行（不存在/外来 = null）。 */
  findOwnedDevice(
    ownerUserId: string,
    deviceId: string,
  ): Promise<ScopedPushDeviceRecord | null>;
};

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface OpenMuseVoiceMobileTenancyService {
  /**
   * 语音会话归属固定（AC1）：pin 时从根行冻结 usage_seconds；外来会话 =
   * canonical not-found；同三元组幂等 existing；不同选择标识 MISMATCH 响
   * 亮拒绝。
   */
  pinVoiceSessionScope(
    scope: PlatformScope,
    input: { readonly sessionId: string },
  ): Promise<VoiceScopePinResult<VoiceSessionScopeView>>;

  /**
   * 范围化语音会话列表（AC1）：公司级撤销响亮拒绝（SCOPE_REVOKED）；
   * 团队级撤销 = 空页；只返回三元组下本人的会话。稳定序
   * (created_at DESC, session_id DESC)。
   */
  listVoiceSessions(
    scope: PlatformScope,
    page: { readonly limit: number },
  ): Promise<{ readonly sessions: readonly ScopedVoiceSession[] }>;

  /** 范围化读取（AC1）：不可见 = canonical not-found。 */
  readVoiceSession(
    scope: PlatformScope,
    sessionId: string,
  ): Promise<VoiceSessionReadOutcome>;

  /**
   * AC1 听写用量归属：写入钉到 (用户, 三元组) 的用量行（听写无会话根
   * 行，本行即持久事实）；usage_key 幂等收敛。
   */
  recordDictationUsage(
    scope: PlatformScope,
    input: {
      readonly usageKey: string;
      readonly audioSeconds: number;
      readonly outputTokens: number;
    },
  ): Promise<DictationUsageRecordResult>;

  /** 范围化听写用量列表（AC1/AC2 子查询；同三元组过滤）。 */
  listDictationUsage(
    scope: PlatformScope,
    page: { readonly limit: number },
  ): Promise<{ readonly usage: readonly DictationUsageView[] }>;

  /**
   * AC3 推送设备绑定：把设备钉到 (用户, 三元组)；外来设备 = canonical
   * not-found；同三元组幂等 existing；不同选择标识 MISMATCH 响亮拒绝。
   */
  bindPushDevice(
    scope: PlatformScope,
    input: { readonly deviceId: string },
  ): Promise<PushDeviceBindOutcome>;

  /**
   * AC3 解绑：删协会行（根行设备注册事实不动）；本范围不可见 = canonical
   * not-found（防御性同形）。
   */
  unbindPushDevice(
    scope: PlatformScope,
    input: { readonly deviceId: string },
  ): Promise<{ readonly status: "unbound" } | ResourceNotFoundVerdict>;

  /**
   * AC3 推送判定门：成员重验 + 绑定三元组；解绑或撤权后 = canonical
   * not-found（sweep 发送前的消费面）。
   */
  authorizePushDevice(
    scope: PlatformScope,
    input: { readonly deviceId: string },
  ): Promise<PushDeviceAuthorization>;

  /**
   * AC2/AC4 移动聚合快照：语音会话/听写用量/推送设备三子查询各自经协会
   * 门；每次调用新事务（结构无缓存）；切换三元组立即换集合。
   */
  readMobileAggregate(
    scope: PlatformScope,
    page?: { readonly limit?: number },
  ): Promise<ScopedMobileAggregate>;
}

const READ_TX_SETUP = sql`set transaction isolation level read committed`;
const TIMEOUTS = [
  sql`set local lock_timeout = '2s'`,
  sql`set local statement_timeout = '5s'`,
] as const;

type DataTx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];
type OperatorTx = Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

export function createOpenMuseVoiceMobileTenancyService(deps: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly rows: OpenMuseVoiceMobileTenancyRows;
}): OpenMuseVoiceMobileTenancyService {
  assertDataDatabase(deps.data);
  assertOperatorDatabase(deps.operator);

  const { data, operator, rows } = deps;

  /** 事务开场（MT060–MT065 判定入口同一形状）。 */
  const beginContext = async (
    tx: DataTx | OperatorTx,
    scope: PlatformScope,
  ) => {
    await tx.execute(READ_TX_SETUP);
    for (const timeout of TIMEOUTS) await tx.execute(timeout);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
    );
    for (const key of [
      JSON.stringify(["enterprise", "tenant", scope.tenantId]),
      JSON.stringify(["enterprise", "principal", scope.principalId]),
      JSON.stringify([
        "enterprise",
        "membership",
        scope.tenantId,
        scope.principalId,
      ]),
      workspaceMembershipLockKey(
        scope.tenantId,
        scope.workspaceId,
        scope.principalId,
      ),
    ]) {
      await tx.execute(
        sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
      );
    }
  };

  /** 事务内成员事实重验（公司 active + epoch；团队 active）。 */
  const readMembershipFacts = async (tx: DataTx, scope: PlatformScope) => {
    const [company] = await tx
      .select({
        status: enterpriseMemberships.status,
        epoch: enterpriseMemberships.epoch,
      })
      .from(enterpriseMemberships)
      .where(
        and(
          eq(enterpriseMemberships.tenantId, scope.tenantId),
          eq(enterpriseMemberships.principalId, scope.principalId),
        ),
      )
      .limit(1);
    const [team] = await tx
      .select({ status: enterpriseWorkspaceMemberships.status })
      .from(enterpriseWorkspaceMemberships)
      .where(
        and(
          eq(enterpriseWorkspaceMemberships.tenantId, scope.tenantId),
          eq(enterpriseWorkspaceMemberships.workspaceId, scope.workspaceId),
          eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
        ),
      )
      .limit(1);
    return {
      companyActive:
        company?.status === "active" && company?.epoch === scope.memberEpoch,
      teamActive: team?.status === "active",
    };
  };

  /** 读事务内重验失败时各读面的折叠判定（列表响亮/对象不可见）。 */
  const readScopeFacts = async (scope: PlatformScope) =>
    data.transaction(async (tx) => {
      await beginContext(tx, scope);
      return readMembershipFacts(tx, scope);
    });

  return {
    async pinVoiceSessionScope(scope, input) {
      assertTrustedScope(scope);
      const sessionId = requireId(input.sessionId, "sessionId");
      // 外来会话（根行不存在/非本人）与不存在不可区分。
      const owned = await rows.findOwnedSession(scope.actorId, sessionId);
      if (!owned) return notFoundVerdict();
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          throw new Error(OPENMUSE_VOICE_MOBILE_WORKSPACE_MEMBERSHIP_REQUIRED);
        }
        const [inserted] = await tx
          .insert(voiceSessionScopes)
          .values({
            sessionId,
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            userId: scope.actorId,
            usageSeconds: owned.durationSeconds,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          return {
            status: "pinned" as const,
            ownership: voiceViewOf(inserted),
          };
        }
        const [existing] = await tx
          .select()
          .from(voiceSessionScopes)
          .where(eq(voiceSessionScopes.sessionId, sessionId))
          .limit(1);
        if (
          !existing ||
          existing.tenantId !== scope.tenantId ||
          existing.workspaceId !== scope.workspaceId ||
          existing.principalId !== scope.principalId ||
          existing.userId !== scope.actorId
        ) {
          throw new Error(
            `${OPENMUSE_VOICE_MOBILE_SCOPE_MISMATCH}: voice session is already owned by a different scope`,
          );
        }
        return {
          status: "existing" as const,
          ownership: voiceViewOf(existing),
        };
      });
    },

    async listVoiceSessions(scope, page) {
      assertTrustedScope(scope);
      const limit = requireLimit(page?.limit);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive) {
          throw new Error("SCOPE_REVOKED");
        }
        if (!facts.teamActive) {
          return { sessions: [] as ScopedVoiceSession[] };
        }
        const associationRows = await tx
          .select()
          .from(voiceSessionScopes)
          .where(
            and(
              eq(voiceSessionScopes.tenantId, scope.tenantId),
              eq(voiceSessionScopes.workspaceId, scope.workspaceId),
              eq(voiceSessionScopes.principalId, scope.principalId),
            ),
          )
          .orderBy(
            desc(voiceSessionScopes.createdAt),
            desc(voiceSessionScopes.sessionId),
          )
          .limit(limit);
        if (associationRows.length === 0) {
          return { sessions: [] as ScopedVoiceSession[] };
        }
        const sessionRows = await rows.listSessionsByIds(
          scope.actorId,
          associationRows.map((row) => row.sessionId),
        );
        const sessionById = new Map(sessionRows.map((s) => [s.id, s]));
        const sessions: ScopedVoiceSession[] = [];
        for (const row of associationRows) {
          const session = sessionById.get(row.sessionId);
          // 根行在两次读取之间被删：条目消失，不泄露存在性。
          if (!session) continue;
          sessions.push({ ownership: voiceViewOf(row), session });
        }
        return { sessions };
      });
    },

    async readVoiceSession(scope, sessionId) {
      assertTrustedScope(scope);
      const id = requireId(sessionId, "sessionId");
      const facts = await readScopeFacts(scope);
      if (!facts.companyActive || !facts.teamActive) {
        return notFoundVerdict();
      }
      const ownership = await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const [row] = await tx
          .select()
          .from(voiceSessionScopes)
          .where(eq(voiceSessionScopes.sessionId, id))
          .limit(1);
        if (
          !row ||
          row.tenantId !== scope.tenantId ||
          row.workspaceId !== scope.workspaceId ||
          row.principalId !== scope.principalId
        ) {
          return null;
        }
        return voiceViewOf(row);
      });
      if (!ownership) return notFoundVerdict();
      const session = await rows.findOwnedSession(ownership.userId, id);
      if (!session) return notFoundVerdict();
      return { outcome: "allow" as const, ownership, session };
    },

    async recordDictationUsage(scope, input) {
      assertTrustedScope(scope);
      const usageKey = requireUsageKey(input.usageKey);
      const audioSeconds = requireMeter(input.audioSeconds, "audioSeconds");
      const outputTokens = requireMeter(input.outputTokens, "outputTokens");
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          throw new Error(OPENMUSE_VOICE_MOBILE_WORKSPACE_MEMBERSHIP_REQUIRED);
        }
        const [inserted] = await tx
          .insert(dictationUsageScopes)
          .values({
            id: `dictation-usage-${randomUUID()}`,
            usageKey,
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            userId: scope.actorId,
            audioSeconds,
            outputTokens,
          })
          .onConflictDoNothing({ target: dictationUsageScopes.usageKey })
          .returning();
        if (inserted) {
          return {
            status: "recorded" as const,
            usage: usageViewOf(inserted),
          };
        }
        // usage_key 已占用：幂等收敛到既有行；异三元组占用 = MISMATCH 响亮
        // （同一请求键被另一范围记录过是接线错误，不是重放）。
        const [existing] = await tx
          .select()
          .from(dictationUsageScopes)
          .where(eq(dictationUsageScopes.usageKey, usageKey))
          .limit(1);
        if (
          !existing ||
          existing.tenantId !== scope.tenantId ||
          existing.workspaceId !== scope.workspaceId ||
          existing.principalId !== scope.principalId ||
          existing.userId !== scope.actorId
        ) {
          throw new Error(
            `${OPENMUSE_VOICE_MOBILE_SCOPE_MISMATCH}: usageKey is already owned by a different scope`,
          );
        }
        return { status: "existing" as const, usage: usageViewOf(existing) };
      });
    },

    async listDictationUsage(scope, page) {
      assertTrustedScope(scope);
      const limit = requireLimit(page?.limit);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive) {
          throw new Error("SCOPE_REVOKED");
        }
        if (!facts.teamActive) {
          return { usage: [] as DictationUsageView[] };
        }
        const usageRows = await tx
          .select()
          .from(dictationUsageScopes)
          .where(
            and(
              eq(dictationUsageScopes.tenantId, scope.tenantId),
              eq(dictationUsageScopes.workspaceId, scope.workspaceId),
              eq(dictationUsageScopes.principalId, scope.principalId),
            ),
          )
          .orderBy(
            desc(dictationUsageScopes.createdAt),
            desc(dictationUsageScopes.id),
          )
          .limit(limit);
        return { usage: usageRows.map(usageViewOf) };
      });
    },

    async bindPushDevice(scope, input) {
      assertTrustedScope(scope);
      const deviceId = requireId(input.deviceId, "deviceId");
      // 外来设备（根行不存在/非本人）与不存在不可区分。
      const owned = await rows.findOwnedDevice(scope.actorId, deviceId);
      if (!owned) return notFoundVerdict();
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          throw new Error(OPENMUSE_VOICE_MOBILE_WORKSPACE_MEMBERSHIP_REQUIRED);
        }
        const [inserted] = await tx
          .insert(pushDeviceScopes)
          .values({
            deviceId,
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            userId: scope.actorId,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          return {
            status: "bound" as const,
            ownership: deviceViewOf(inserted),
          };
        }
        const [existing] = await tx
          .select()
          .from(pushDeviceScopes)
          .where(eq(pushDeviceScopes.deviceId, deviceId))
          .limit(1);
        if (
          !existing ||
          existing.tenantId !== scope.tenantId ||
          existing.workspaceId !== scope.workspaceId ||
          existing.principalId !== scope.principalId ||
          existing.userId !== scope.actorId
        ) {
          throw new Error(
            `${OPENMUSE_VOICE_MOBILE_SCOPE_MISMATCH}: push device is already bound to a different scope`,
          );
        }
        return {
          status: "existing" as const,
          ownership: deviceViewOf(existing),
        };
      });
    },

    async unbindPushDevice(scope, input) {
      assertTrustedScope(scope);
      const deviceId = requireId(input.deviceId, "deviceId");
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          throw new Error(OPENMUSE_VOICE_MOBILE_WORKSPACE_MEMBERSHIP_REQUIRED);
        }
        const deleted = await tx
          .delete(pushDeviceScopes)
          .where(
            and(
              eq(pushDeviceScopes.deviceId, deviceId),
              eq(pushDeviceScopes.tenantId, scope.tenantId),
              eq(pushDeviceScopes.workspaceId, scope.workspaceId),
              eq(pushDeviceScopes.principalId, scope.principalId),
            ),
          )
          .returning();
        if (deleted.length === 0) return notFoundVerdict();
        return { status: "unbound" as const };
      });
    },

    async authorizePushDevice(scope, input) {
      assertTrustedScope(scope);
      const deviceId = requireId(input.deviceId, "deviceId");
      // 解绑或撤权后停止推送（AC3）：成员重验活查 + 绑定三元组比对。
      const facts = await readScopeFacts(scope);
      if (!facts.companyActive || !facts.teamActive) {
        return notFoundVerdict();
      }
      const ownership = await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const [row] = await tx
          .select()
          .from(pushDeviceScopes)
          .where(eq(pushDeviceScopes.deviceId, deviceId))
          .limit(1);
        if (
          !row ||
          row.tenantId !== scope.tenantId ||
          row.workspaceId !== scope.workspaceId ||
          row.principalId !== scope.principalId
        ) {
          return null;
        }
        return deviceViewOf(row);
      });
      if (!ownership) return notFoundVerdict();
      const device = await rows.findOwnedDevice(ownership.userId, deviceId);
      if (!device) return notFoundVerdict();
      return { outcome: "allow" as const, ownership, device };
    },

    async readMobileAggregate(scope, page) {
      assertTrustedScope(scope);
      const limit = requireLimit(page?.limit ?? LIST_LIMIT_MAX);
      // AC4：每次调用新事务新判定——两个三元组连读得到互斥快照，结构性
      // 无跨范围缓存。
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive) {
          throw new Error("SCOPE_REVOKED");
        }
        if (!facts.teamActive) {
          return {
            voiceSessions: [],
            dictationUsage: [],
            pushDevices: [],
          } satisfies ScopedMobileAggregate;
        }
        const [voiceRows, usageRows, deviceRows] = await Promise.all([
          tx
            .select()
            .from(voiceSessionScopes)
            .where(
              and(
                eq(voiceSessionScopes.tenantId, scope.tenantId),
                eq(voiceSessionScopes.workspaceId, scope.workspaceId),
                eq(voiceSessionScopes.principalId, scope.principalId),
              ),
            )
            .orderBy(desc(voiceSessionScopes.createdAt))
            .limit(limit),
          tx
            .select()
            .from(dictationUsageScopes)
            .where(
              and(
                eq(dictationUsageScopes.tenantId, scope.tenantId),
                eq(dictationUsageScopes.workspaceId, scope.workspaceId),
                eq(dictationUsageScopes.principalId, scope.principalId),
              ),
            )
            .orderBy(desc(dictationUsageScopes.createdAt))
            .limit(limit),
          tx
            .select()
            .from(pushDeviceScopes)
            .where(
              and(
                eq(pushDeviceScopes.tenantId, scope.tenantId),
                eq(pushDeviceScopes.workspaceId, scope.workspaceId),
                eq(pushDeviceScopes.principalId, scope.principalId),
              ),
            )
            .orderBy(desc(pushDeviceScopes.createdAt))
            .limit(limit),
        ]);
        const sessionRows = await rows.listSessionsByIds(
          scope.actorId,
          voiceRows.map((row) => row.sessionId),
        );
        const sessionById = new Map(sessionRows.map((s) => [s.id, s]));
        const voiceSessions: ScopedVoiceSession[] = [];
        for (const row of voiceRows) {
          const session = sessionById.get(row.sessionId);
          if (!session) continue;
          voiceSessions.push({ ownership: voiceViewOf(row), session });
        }
        const deviceIds = deviceRows.map((row) => row.deviceId);
        const ownedDevices: ScopedPushDeviceRecord[] = [];
        for (const deviceId of deviceIds) {
          const device = await rows.findOwnedDevice(scope.actorId, deviceId);
          if (device) ownedDevices.push(device);
        }
        const deviceById = new Map(ownedDevices.map((d) => [d.id, d]));
        return {
          voiceSessions,
          dictationUsage: usageRows.map(usageViewOf),
          pushDevices: deviceRows.flatMap((row) => {
            const device = deviceById.get(row.deviceId);
            return device ? [{ ownership: deviceViewOf(row), device }] : [];
          }),
        } satisfies ScopedMobileAggregate;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 形状映射与校验小件
// ---------------------------------------------------------------------------

function requireLimit(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > LIST_LIMIT_MAX
  ) {
    failInvalid(`limit must be an integer between 1 and ${LIST_LIMIT_MAX}`);
  }
  return value;
}

function voiceViewOf(row: VoiceSessionScopeRow): VoiceSessionScopeView {
  return {
    sessionId: row.sessionId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    userId: row.userId,
    usageSeconds: row.usageSeconds,
    createdAt: row.createdAt,
  };
}

function usageViewOf(row: DictationUsageScopeRow): DictationUsageView {
  return {
    id: row.id,
    usageKey: row.usageKey,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    userId: row.userId,
    audioSeconds: row.audioSeconds,
    outputTokens: row.outputTokens,
    createdAt: row.createdAt,
  };
}

function deviceViewOf(row: PushDeviceScopeRow): PushDeviceScopeView {
  return {
    deviceId: row.deviceId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    userId: row.userId,
    createdAt: row.createdAt,
  };
}
