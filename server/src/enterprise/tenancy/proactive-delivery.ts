// server/src/enterprise/tenancy/proactive-delivery.ts
// MT045（Issue #88）：主动建议与外部调用前后的事务边界。
//
// 票面语义（Issue #88 正文）：
//   AC1 主动建议只投递给归属范围内的授权接收者；正文不含无权内容。
//   AC2 外部调用前后是独立事务；不在等待外部 API 时持有数据库授权锁。
//   AC3 外部调用失败后重试安全（幂等），不产生重复投递或重复扣费。
//   AC4 撤销接收者权限后不再投递，且已投递内容不可被无权者读取。
//
// 结构（纯新增服务面 + 0177 expand-only 列，与 MT044/#87 同款纪律）：
//
//   1. 归属（resolveSetting）：proactive_settings 的 (tenant_id, workspace_id)
//      是创建时一次写入的持久映射（store.create 的 server-supplied 入参，
//      body 不可影响）。解析复用 #87 的通道分工：directory 通道现读
//      owner→principal→membership→tenant 的存活事实（app.user_id 臂），
//      operator 通道现读 workspace∈tenant。两列全空 = 旧个人设置（行为
//      不变，本服务返回 personal 让调用方走个人路径）；一空一有或映射
//      腐化 = unresolvable——不投递，不落任何业务范围。
//   2. 投递（deliver，AC1–AC3 的核心）：三段式，两段短事务夹一段零事务的
//      外部调用：
//        判定段（data 通道事务）：受信 PlatformScope（assertTrustedScope）
//        → read committed + lock/statement timeout + set_config('app.*',…,true)
//        事务本地 → advisory 共享锁（键序与 MT016/credential-lease 一致）→
//        两级成员重验（公司 active 且 epoch === scope.memberEpoch；团队行
//        active）→ 设置行与受信 scope 三比（tenant/workspace 逐字相等）。
//        任一不成立 → canonical RESOURCE_NOT_FOUND，零认领零投递（跨公司/
//        跨团队/撤权/不存在对外不可区分——错误不泄露存在性）。事务提交，
//        锁全部释放。
//        认领段（平台连接单语句）：读取该设置未投递的建议行。dedupeKey
//        是建议 id 的纯函数（suggestion:<id>）——同一建议永远同一键。
//        发送段（零数据库事务）：逐条调用注入的 transport.send。发送中
//        不存在任何打开的事务（结构上：本函数在两段之间不持有任何连接
//        上的事务；AC2 的测试在 transport 阻塞时探测 pg_locks/
//        pg_stat_activity 证明）。transport 契约按 dedupeKey 幂等（装配
//        侧是 delivery outbox 的 onConflictDoNothing offer，见 index.ts
//        的 deliveryNotifications）；崩溃在发送与落账之间时重试重发同一
//        键，由 transport 幂等吸收——不产生重复投递，也不产生重复扣费
//        （费用点在 transport 侧按键记账）。
//        落账段（平台连接单语句）：UPDATE … SET delivered_at = now()
//        WHERE id IN (…) AND delivered_at IS NULL——幂等，重复落账无
//        副作用、无错误。
//   3. 读取（readDelivered，AC4 后半）：已投递建议的读取入口。先过判定
//      段同一道门（data 通道成员重验 + 三比），再读平台侧行；任何不匹
//      配 → canonical not-found。撤权（挂起递增 epoch / 团队行翻 status）
//      在下一次判定立即生效。
//
// 事务边界说明（AC2 的结构面）：本域不新增任何「事务回调内含网络拨号」
// 的路径；判定段事务在 transport 被调用前已提交（await 完毕），落账段在
// transport 全部返回后才开启。职责/触发域的既有模式（单语句原子认领 +
// outbox 状态机在事务外发送，responsibilities/store.ts、delivery/router.ts）
// 在此逐字沿用。
//
// 边界（诚实披露）：
//   - 本票不接生产装配（index.ts）与 HTTP 路由：服务面供接线票装配（与
//     #87/#90 同例）；测试以真实通道 + 真实 store 组装。
//   - 个人路径零改动：engine.deliver 的 owner 语义原样；本服务只服务企业
//     归属的设置（personal 结局显式交还调用方）。
//   - 正文内容：投递文本只由建议行自身字段（title/detail/sourceApp/
//     sourceLink）组成——与 engine.deliver 同一组合式；不嵌入任何其他
//     范围的数据（AC1 的「正文不含无权内容」）。生成侧的读取面仍由
//     proactive/restriction.ts 的只读门约束（既有套件在案）。

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  proactiveSettings,
  proactiveSuggestions,
} from "../../db/schema/proactive";
import type { PlatformScope } from "../contracts";
import {
  assertDataDatabase,
  assertDirectoryDatabase,
  assertOperatorDatabase,
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
} from "./connections";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 归属解析：持久映射 + 现读权威行（#87 resolveTrigger 同款通道分工）
// ---------------------------------------------------------------------------

/** 解析出的企业归属：公司 + 团队 + 发起主体（owner 用户在该公司派生）。 */
export interface ProactiveSettingAttributionFacts {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
}

export type ProactiveSettingResolution =
  | { readonly kind: "personal" }
  | {
      readonly kind: "enterprise";
      readonly attribution: ProactiveSettingAttributionFacts;
    }
  | { readonly kind: "unresolvable"; readonly code: string };

/** platform 通道读到的设置行（本服务消费的最小投影）。 */
export interface ProactiveSettingRow {
  readonly id: string;
  readonly ownerUserId: string;
  readonly agentId: string;
  readonly tenantId: string | null;
  readonly workspaceId: string | null;
}

/** execute() 结果归一：bun-sql 返回数组、node postgres 返回 {rows}。 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  return (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] })?.rows ?? [])
  ) as Record<string, unknown>[];
}

const READ_TX_SETUP = sql`set transaction isolation level read committed`;
const TIMEOUTS = [
  sql`set local lock_timeout = '2s'`,
  sql`set local statement_timeout = '5s'`,
] as const;

const ID_MAX = 200;

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > ID_MAX) {
    throw new Error(
      `PROACTIVE_ATTRIBUTION_INVALID: ${field} must be a non-empty string of at most ${ID_MAX} characters`,
    );
  }
  return value;
}

/**
 * 归属解析服务：只认持久映射列 + 权威企业行，载荷与队列消息从不参与。
 * 个人部署（无 enterprise 表的库）不装配本服务。
 */
export function createProactiveAttributionService(deps: {
  /** directory 受限通道：user→principal→membership→tenant 事实（app.user_id 臂）。 */
  readonly directory: DirectoryDatabase;
  /** operator 受限通道：workspace∈tenant 事实（app.tenant_id 臂）。 */
  readonly operator: OperatorDatabase;
}) {
  assertDirectoryDatabase(deps.directory);
  assertOperatorDatabase(deps.operator);
  const { directory, operator } = deps;

  return {
    async resolveSetting(
      setting: ProactiveSettingRow,
    ): Promise<ProactiveSettingResolution> {
      const ownerUserId = requireId(setting.ownerUserId, "ownerUserId");
      if (setting.tenantId === null && setting.workspaceId === null)
        return { kind: "personal" };
      if (setting.tenantId === null || setting.workspaceId === null)
        return { kind: "unresolvable", code: "PROACTIVE_MAPPING_INCOMPLETE" };
      const tenant = requireId(setting.tenantId, "tenantId");
      const workspace = requireId(setting.workspaceId, "workspaceId");

      const identity: { code: string } | { principalId: string } =
        await directory.transaction(async (tx) => {
          await tx.execute(READ_TX_SETUP);
          for (const timeout of TIMEOUTS) await tx.execute(timeout);
          await tx.execute(
            sql`select set_config('app.user_id', ${ownerUserId}, true)`,
          );
          const principals = rowsOf(
            await tx.execute(sql`
              select p.id, p.status
              from enterprise_principals p
              where p.user_id = ${ownerUserId}
              limit 1
            `),
          );
          if (principals.length === 0)
            return { code: "PROACTIVE_PRINCIPAL_UNRESOLVED" };
          const principalId = String(principals[0].id);
          if (String(principals[0].status) !== "active")
            return { code: "PROACTIVE_PRINCIPAL_UNRESOLVED" };
          const memberships = rowsOf(
            await tx.execute(sql`
              select m.status
              from enterprise_memberships m
              where m.tenant_id = ${tenant} and m.principal_id = ${principalId}
              limit 1
            `),
          );
          if (
            memberships.length === 0 ||
            String(memberships[0].status) !== "active"
          )
            return { code: "PROACTIVE_PRINCIPAL_UNRESOLVED" };
          const tenants = rowsOf(
            await tx.execute(sql`
              select t.status
              from enterprise_tenants t
              where t.id = ${tenant}
              limit 1
            `),
          );
          if (tenants.length === 0 || String(tenants[0].status) !== "active")
            return { code: "PROACTIVE_TENANT_UNRESOLVED" };
          return { principalId };
        });
      if ("code" in identity)
        return { kind: "unresolvable", code: identity.code };

      const workspaceLive = await operator.transaction(async (tx) => {
        await tx.execute(READ_TX_SETUP);
        for (const timeout of TIMEOUTS) await tx.execute(timeout);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenant}, true)`,
        );
        const rows = rowsOf(
          await tx.execute(sql`
            select 1
            from enterprise_workspaces w
            where w.tenant_id = ${tenant} and w.id = ${workspace}
            limit 1
          `),
        );
        return rows.length === 1;
      });
      if (!workspaceLive)
        return { kind: "unresolvable", code: "PROACTIVE_WORKSPACE_UNRESOLVED" };

      return {
        kind: "enterprise",
        attribution: {
          tenantId: tenant,
          workspaceId: workspace,
          principalId: identity.principalId,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 投递与读取服务（AC1–AC4）
// ---------------------------------------------------------------------------

/** 一条待投递建议的认领：发送段消费的最小事实。 */
export interface ProactiveDeliveryClaim {
  readonly suggestionId: string;
  /** 同一建议永远同一键：重试由 transport 幂等吸收（AC3）。 */
  readonly dedupeKey: string;
  readonly settingId: string;
  readonly runId: string;
  readonly botId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  /** 只由建议行自身字段组成的正文（AC1：不含无权内容）。 */
  readonly text: string;
}

/** 外部调用 seam（AC2/AC3）：装配侧是 delivery outbox 的 offer（按键幂等）。 */
export interface ProactiveDeliveryTransport {
  send(claim: ProactiveDeliveryClaim): Promise<unknown>;
}

export interface ProactiveAuditEvent {
  readonly action:
    | "proactive.delivery"
    | "proactive.delivery_read"
    | "proactive.attribution";
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly botId: string | null;
  readonly principalId: string;
  readonly outcome: "allowed" | "denied" | "unresolvable";
  readonly count?: number;
  readonly reason?: string;
}

export interface ProactiveAuditSink {
  record(event: ProactiveAuditEvent): Promise<void> | void;
}

export type ProactiveDeliverOutcome =
  | {
      readonly outcome: "delivered";
      readonly claims: readonly ProactiveDeliveryClaim[];
    }
  | { readonly outcome: "personal" }
  | { readonly outcome: "unresolvable"; readonly code: string }
  | ResourceNotFoundVerdict;

export type ProactiveReadOutcome =
  | {
      readonly outcome: "allow";
      readonly suggestion: {
        readonly id: string;
        readonly title: string;
        readonly detail: string;
        readonly sourceApp: string | null;
        readonly sourceLink: string | null;
        readonly deliveredAt: Date;
      };
    }
  | ResourceNotFoundVerdict;

export function createEnterpriseProactiveDelivery(deps: {
  /** 平台连接：proactive 表所在域（无 RLS，与 #87 的 quarantine 同位）。 */
  readonly platform: Database;
  /** 受限 data 通道：成员重验与三比（真实 RLS）。 */
  readonly data: DataDatabase;
  /** 归属解析（createProactiveAttributionService 的产物）。 */
  readonly attribution: ReturnType<typeof createProactiveAttributionService>;
  /** 外部调用 seam：发送段逐条调用，契约按 dedupeKey 幂等。 */
  readonly transport: ProactiveDeliveryTransport;
  /** 审计 sink：投递与读取的判定结果落行（内部事实，不回显值）。 */
  readonly audit: ProactiveAuditSink;
}) {
  assertDataDatabase(deps.data);
  const { platform, data, attribution, transport, audit } = deps;

  /**
   * 判定段（data 通道事务，AC1/AC4 的门）：受信 scope → 两级成员重验 →
   * 设置行归属三比。返回 true = 可以认领/读取。事务结束锁全部释放——
   * 外部调用发生在此函数返回之后（AC2）。
   */
  async function authorizeDeliveryScope(
    scope: PlatformScope,
    setting: ProactiveSettingRow,
  ): Promise<boolean> {
    assertTrustedScope(scope);
    return data.transaction(async (tx) => {
      await tx.execute(READ_TX_SETUP);
      for (const timeout of TIMEOUTS) await tx.execute(timeout);
      await tx.execute(
        sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
      );
      // 锁序：tenant → principal → membership → workspace-membership
      // （与 MT016/credential-lease/job-control 同一键序与键形）。
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
      // 公司级重验：撤权（挂起）递增 epoch，已签发 scope 立即失效（fail-closed）。
      const company = rowsOf(
        await tx.execute(sql`
          select m.status, m.epoch
          from enterprise_memberships m
          where m.tenant_id = ${scope.tenantId} and m.principal_id = ${scope.principalId}
          limit 1
        `),
      );
      if (
        company.length === 0 ||
        String(company[0].status) !== "active" ||
        Number(company[0].epoch) !== scope.memberEpoch
      )
        return false;
      // 团队级重验：行存在且 active（移除删行、挂起翻 status，都落在这里）。
      const team = rowsOf(
        await tx.execute(sql`
          select w.status
          from enterprise_workspace_memberships w
          where w.tenant_id = ${scope.tenantId} and w.workspace_id = ${scope.workspaceId} and w.principal_id = ${scope.principalId}
          limit 1
        `),
      );
      if (team.length === 0 || String(team[0].status) !== "active")
        return false;
      // 三比：设置行的持久归属必须与受信 scope 逐字相等（AC1 的归属范围）。
      return (
        setting.tenantId === scope.tenantId &&
        setting.workspaceId === scope.workspaceId
      );
    });
  }

  /** 正文组合式：与 engine.deliver 同款，只由建议行自身字段组成。 */
  function composeText(suggestion: {
    title: string;
    detail: string;
    sourceApp: string | null;
    sourceLink: string | null;
  }): string {
    return [
      `Suggested next step: ${suggestion.title}`,
      suggestion.detail,
      suggestion.sourceApp ? `From ${suggestion.sourceApp}` : "",
      // 头注契约的第四个字段：跳转链接随正文送达，投影不落正文=链接丢失。
      suggestion.sourceLink ?? "",
    ]
      .filter((part) => part !== "")
      .join("\n");
  }

  return {
    /**
     * AC1–AC3 的投递入口。三段式：判定段（短事务）→ 发送段（零事务）→
     * 落账段（单语句幂等 UPDATE）。personal/unresolvable 是显式结局，
     * 不投递、不落账。
     */
    async deliver(
      scope: PlatformScope,
      input: { readonly settingId: string; readonly runId?: string },
    ): Promise<ProactiveDeliverOutcome> {
      const settingId = requireId(input.settingId, "settingId");
      const [row] = await platform
        .select({
          id: proactiveSettings.id,
          ownerUserId: proactiveSettings.ownerUserId,
          agentId: proactiveSettings.agentId,
          tenantId: proactiveSettings.tenantId,
          workspaceId: proactiveSettings.workspaceId,
        })
        .from(proactiveSettings)
        .where(eq(proactiveSettings.id, settingId))
        .limit(1);
      if (!row) return notFoundVerdict();
      const resolution = await attribution.resolveSetting(row);
      if (resolution.kind === "personal") return { outcome: "personal" };
      if (resolution.kind === "unresolvable") {
        await audit.record({
          action: "proactive.attribution",
          tenantId: row.tenantId ?? "",
          workspaceId: row.workspaceId ?? "",
          botId: null,
          principalId: scope.principalId,
          outcome: "unresolvable",
          reason: resolution.code,
        });
        return { outcome: "unresolvable", code: resolution.code };
      }

      // 判定段：事务在此 await 内开与关；返回后没有任何锁被持有（AC2）。
      const authorized = await authorizeDeliveryScope(scope, row);
      if (!authorized) {
        await audit.record({
          action: "proactive.delivery",
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          botId: null,
          principalId: scope.principalId,
          outcome: "denied",
          reason: "not-found",
        });
        return notFoundVerdict();
      }

      // 认领段：平台连接单语句（不是事务的一部分——语句即原子）。
      const undelivered = await platform
        .select({
          id: proactiveSuggestions.id,
          runId: proactiveSuggestions.runId,
          title: proactiveSuggestions.title,
          detail: proactiveSuggestions.detail,
          sourceApp: proactiveSuggestions.sourceApp,
          sourceLink: proactiveSuggestions.sourceLink,
        })
        .from(proactiveSuggestions)
        .where(
          and(
            eq(proactiveSuggestions.settingId, settingId),
            isNull(proactiveSuggestions.deliveredAt),
            ...(input.runId !== undefined
              ? [eq(proactiveSuggestions.runId, input.runId)]
              : []),
          ),
        )
        .orderBy(proactiveSuggestions.createdAt)
        .limit(50);

      const claims: ProactiveDeliveryClaim[] = undelivered.map(
        (suggestion) => ({
          suggestionId: suggestion.id,
          dedupeKey: `suggestion:${suggestion.id}`,
          settingId,
          runId: suggestion.runId,
          botId: row.agentId,
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          text: composeText(suggestion),
        }),
      );

      // 发送段：零数据库事务。transport 阻塞多久都不会持有任何授权锁；
      // 失败上抛由调用方重试——重试重算出相同 dedupeKey，幂等在 transport。
      for (const claim of claims) {
        await transport.send(claim);
      }

      // 落账段：单语句幂等 UPDATE——崩溃在发送与落账之间的重试最多重发
      // 同键，不会重复落账（AC3）。
      if (claims.length > 0) {
        await platform
          .update(proactiveSuggestions)
          .set({ deliveredAt: new Date() })
          .where(
            and(
              inArray(
                proactiveSuggestions.id,
                claims.map((claim) => claim.suggestionId),
              ),
              isNull(proactiveSuggestions.deliveredAt),
            ),
          );
      }

      await audit.record({
        action: "proactive.delivery",
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId: row.agentId,
        principalId: scope.principalId,
        outcome: "allowed",
        count: claims.length,
      });
      return { outcome: "delivered", claims };
    },

    /**
     * AC4 后半的读取入口：已投递建议只对通过判定段的主体可见；撤权、
     * 跨团队、跨公司与不存在共用 canonical not-found。
     */
    async readDelivered(
      scope: PlatformScope,
      suggestionId: string,
    ): Promise<ProactiveReadOutcome> {
      const id = requireId(suggestionId, "suggestionId");
      const [suggestion] = await platform
        .select({
          id: proactiveSuggestions.id,
          settingId: proactiveSuggestions.settingId,
          title: proactiveSuggestions.title,
          detail: proactiveSuggestions.detail,
          sourceApp: proactiveSuggestions.sourceApp,
          sourceLink: proactiveSuggestions.sourceLink,
          deliveredAt: proactiveSuggestions.deliveredAt,
        })
        .from(proactiveSuggestions)
        .where(eq(proactiveSuggestions.id, id))
        .limit(1);
      if (!suggestion || suggestion.deliveredAt === null) {
        return notFoundVerdict();
      }
      const [setting] = await platform
        .select({
          id: proactiveSettings.id,
          ownerUserId: proactiveSettings.ownerUserId,
          agentId: proactiveSettings.agentId,
          tenantId: proactiveSettings.tenantId,
          workspaceId: proactiveSettings.workspaceId,
        })
        .from(proactiveSettings)
        .where(eq(proactiveSettings.id, suggestion.settingId))
        .limit(1);
      if (!setting) return notFoundVerdict();

      const authorized = await authorizeDeliveryScope(scope, setting);
      if (!authorized) {
        await audit.record({
          action: "proactive.delivery_read",
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          botId: null,
          principalId: scope.principalId,
          outcome: "denied",
          reason: "not-found",
        });
        return notFoundVerdict();
      }
      await audit.record({
        action: "proactive.delivery_read",
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId: setting.agentId,
        principalId: scope.principalId,
        outcome: "allowed",
      });
      return {
        outcome: "allow",
        suggestion: {
          id: suggestion.id,
          title: suggestion.title,
          detail: suggestion.detail,
          sourceApp: suggestion.sourceApp,
          sourceLink: suggestion.sourceLink,
          deliveredAt: suggestion.deliveredAt,
        },
      };
    },
  };
}

export type EnterpriseProactiveDelivery = ReturnType<
  typeof createEnterpriseProactiveDelivery
>;
