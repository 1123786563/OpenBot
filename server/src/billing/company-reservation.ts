// server/src/billing/company-reservation.ts
// MT070（Issue #113）：公司调用归属与同一余额的原子预扣（公司工作台预扣 seam）。
//
// 职责：公司工作台的每次被计费执行，在同一个公司余额上原子预扣，并把
// 公司/团队/使用人/Bot 授权/稳定调用标识固定到这次预扣上（票面 AC3）。
// 设计裁决见 checkpoints/MT070/design.md，要点：
//
//   - 付款账户由服务端固定（票注）：输入形状没有客户字段；调用方塞入
//     externalCustomerId/customer/payer 键一律 PAYER_ACCOUNT_FIXED 拒绝。
//     预扣客户 = resolveCompanyCustomer(tenantId) 的唯一映射（MT069 交付），
//     没有映射 CUSTOMER_MAPPING_REQUIRED（与 MT069 同码同语义），映射没有
//     活跃公司账户 COMPANY_ACCOUNT_REQUIRED——公司调用只可能落在公司自己的
//     付款账户上（AC2 的结构性根基：不存在「指定别家客户」的输入通道）。
//   - 原子性（AC1）：预扣完全委托既有 credits-writer.reserveCredits——
//     customer 行 FOR UPDATE 串行化同一账户的全部预扣/结算，多团队并发
//     消费共享余额时总额不超余额；本模块零复制、零分叉该路径。
//   - 上界与幂等键语义不变（AC4）：writer 的返回形状/冲突语义原样透传；
//     稳定调用标识（call_key）是事实标识不是第二幂等键——同公司同 call_key
//     的第二次预扣（哪怕换幂等键）拒绝（CALL_KEY_CONFLICT），(tenant_id,
//     call_key) 唯一索引是预检竞态的 DB 兜底；输了竞态的一方对刚建的预扣
//     立即全额退持（releaseReservation，台账零动），不留幻影持有限额。
//   - 归属行（AC3）：billing_call_attributions 预扣 1:1；在预扣事务提交后
//     幂等写入（ON CONFLICT DO NOTHING）。重放同幂等键：同归属 → 同一结果
//     （含崩溃窗口自愈：预扣已提交而归属缺失时，重放补写）；归属漂移 →
//     CALL_ATTRIBUTION_CONFLICT（原预扣不动，AC4 的重试不改归属）。
//   - 伪造归属在结构上不可能：复合外键同时证明 workspace 属该公司、
//     principal 是该公司成员（schema 层）；服务层预检把它们翻译成类型化
//     哨兵（CALL_MEMBER_REQUIRED / CALL_WORKSPACE_MISMATCH）并保证拒绝路径
//     零写入。
//
// 错误纪律：计费 seam 哨兵码（`CODE: message`），与 credits-writer /
// payer-accounts 一致；金额与过期校验留在 writer（语义不变），归属字段
// 非空校验在本模块。

import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { billingCallAttributions } from "../db/schema/call-attributions";
import { creditReservations } from "../db/schema/credit-reservations";
import {
  enterpriseMemberships,
  enterpriseWorkspaces,
} from "../db/schema/enterprise-tenancy";
import type { CreditWriter } from "./credits-writer";
import { createPayerAccountService } from "./payer-accounts";

/** 一次公司调用预扣的归属事实（按存储行回答）。 */
export interface CallAttribution {
  readonly reservationId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly botRef: string;
  readonly callKey: string;
  readonly createdAt: Date;
}

/** 公司用量的团队/主体汇总（held=活动预扣上限，charged=已结算入账）。 */
export interface CompanyUsageSummary {
  readonly byTeam: ReadonlyArray<{
    readonly workspaceId: string;
    readonly heldUnits: number;
    readonly chargedUnits: number;
  }>;
  readonly byUser: ReadonlyArray<{
    readonly principalId: string;
    readonly heldUnits: number;
    readonly chargedUnits: number;
  }>;
}

export type CompanyReservationInput = {
  /** 发起调用的公司（受信服务端事实；付款账户随之固定）。 */
  readonly tenantId: string;
  /** 承载调用的团队（必须属于该公司）。 */
  readonly workspaceId: string;
  /** 使用人（必须是该公司的有效成员）。 */
  readonly principalId: string;
  /** 本次调用的 Bot/授权标识。 */
  readonly botRef: string;
  /** 稳定调用标识：公司内唯一，重复请求不重复预扣的事实闸。 */
  readonly callKey: string;
  /** 预扣幂等键（语义与 credits-writer 完全一致）。 */
  readonly idempotencyKey: string;
  /** 预扣上界（×100 缩放整数；语义与 credits-writer 完全一致）。 */
  readonly maximumCents: number;
  readonly expiresAt: Date;
};

export interface CompanyReservationService {
  /**
   * 在调用方公司的唯一付款账户上原子预扣 `maximumCents`。成功时把本次调用的
   * 归属固定到预扣上；拒绝（上界不足/伪造标识/重复调用标识）零写入。
   * 重放同幂等键同归属返回原预扣；归属漂移拒绝。
   */
  reserveForCompanyCall(
    input: CompanyReservationInput,
  ): Promise<
    | { reserved: true; reservationId: string }
    | { reserved: false; availableCents: number }
  >;

  /** 读一条预扣的归属；没有返回 null。 */
  attributionOf(reservationId: string): Promise<CallAttribution | null>;

  /** 公司用量的团队/主体汇总（A9 邻接：用量可按团队/用户汇总）。 */
  usageSummary(tenantId: string): Promise<CompanyUsageSummary>;
}

/** SQLSTATE 唯一/排他冲突探测（payer-accounts 同款，cause 链有限深度）。 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof Error) {
      const shaped = current as { code?: string; errno?: string };
      if (shaped.code === "23505" || shaped.errno === "23505") return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function requireNonEmpty(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `CALL_ATTRIBUTION_INVALID: ${what} must be a non-empty string`,
    );
  }
  return value;
}

function attributionOfRow(
  row: typeof billingCallAttributions.$inferSelect,
): CallAttribution {
  return {
    reservationId: row.reservationId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    botRef: row.botRef,
    callKey: row.callKey,
    createdAt: row.createdAt,
  };
}

export function createCompanyReservationService({
  database,
  writer,
}: {
  database: Database;
  writer: CreditWriter;
}): CompanyReservationService {
  const payer = createPayerAccountService(database);

  /** 归属输入与已存行逐字段一致性（AC4：重试不改归属）。 */
  function attributionMatches(
    row: CallAttribution,
    input: CompanyReservationInput,
  ): boolean {
    return (
      row.tenantId === input.tenantId &&
      row.workspaceId === input.workspaceId &&
      row.principalId === input.principalId &&
      row.botRef === input.botRef &&
      row.callKey === input.callKey
    );
  }

  return {
    async reserveForCompanyCall(rawInput) {
      // 客户端指定的付款账户在这里死掉（票注）：输入类型上不存在这些键，
      // 运行时守卫让伪造请求响亮失败，而不是被静默剥掉。
      const smuggled = Object.keys(rawInput ?? {}).find((key) =>
        ["externalCustomerId", "customer", "payer"].includes(key),
      );
      if (smuggled !== undefined) {
        throw new Error(
          `PAYER_ACCOUNT_FIXED: the paying account is fixed server-side from the company's billing mapping (${smuggled} is not an input)`,
        );
      }
      const input = rawInput;
      requireNonEmpty(input?.tenantId, "tenantId");
      requireNonEmpty(input?.workspaceId, "workspaceId");
      requireNonEmpty(input?.principalId, "principalId");
      requireNonEmpty(input?.botRef, "botRef");
      requireNonEmpty(input?.callKey, "callKey");
      requireNonEmpty(input?.idempotencyKey, "idempotencyKey");

      // 付款账户：公司 ↔ Customer 唯一映射（MT069 交付）→ 活跃公司账户。
      const mapping = await payer.resolveCompanyCustomer(input.tenantId);
      if (!mapping) {
        throw new Error(
          `CUSTOMER_MAPPING_REQUIRED: company ${input.tenantId} has no billing customer mapping`,
        );
      }
      const account = await payer.getAccountByCustomer(
        mapping.externalCustomerId,
      );
      if (
        account?.status !== "active" ||
        account.accountType !== "company" ||
        account.tenantId !== input.tenantId
      ) {
        throw new Error(
          `COMPANY_ACCOUNT_REQUIRED: company ${input.tenantId} has no active company credit account on customer ${mapping.externalCustomerId}`,
        );
      }

      // 使用人必须是该公司的有效成员（伪造公司归属的预检；复合外键是 DB 兜底）。
      const [membership] = await database
        .select({ status: enterpriseMemberships.status })
        .from(enterpriseMemberships)
        .where(
          and(
            eq(enterpriseMemberships.tenantId, input.tenantId),
            eq(enterpriseMemberships.principalId, input.principalId),
          ),
        )
        .limit(1);
      if (membership?.status !== "active") {
        throw new Error(
          `CALL_MEMBER_REQUIRED: principal ${input.principalId} is not an active member of company ${input.tenantId}`,
        );
      }

      // 团队必须属于该公司（伪造团队归属的预检；复合外键是 DB 兜底）。
      const [workspace] = await database
        .select({ id: enterpriseWorkspaces.id })
        .from(enterpriseWorkspaces)
        .where(
          and(
            eq(enterpriseWorkspaces.tenantId, input.tenantId),
            eq(enterpriseWorkspaces.id, input.workspaceId),
          ),
        )
        .limit(1);
      if (!workspace) {
        throw new Error(
          `CALL_WORKSPACE_MISMATCH: workspace ${input.workspaceId} does not belong to company ${input.tenantId}`,
        );
      }

      // 稳定调用标识预检：同公司同 call_key 已有预扣 → 拒绝（零新预扣）。
      // 例外：已有行就是同一幂等键的那次预扣（重试重放）——放行，让 writer 的
      // 幂等语义接管（归属漂移由归属行比对拒绝）。
      const [existingCall] = await database
        .select({
          reservationId: billingCallAttributions.reservationId,
          idempotencyKey: creditReservations.idempotencyKey,
        })
        .from(billingCallAttributions)
        .innerJoin(
          creditReservations,
          eq(creditReservations.id, billingCallAttributions.reservationId),
        )
        .where(
          and(
            eq(billingCallAttributions.tenantId, input.tenantId),
            eq(billingCallAttributions.callKey, input.callKey),
          ),
        )
        .limit(1);
      if (
        existingCall &&
        existingCall.idempotencyKey !== input.idempotencyKey
      ) {
        throw new Error(
          `CALL_KEY_CONFLICT: call key ${input.callKey} already has reservation ${existingCall.reservationId} in company ${input.tenantId}`,
        );
      }

      // 原子预扣：完全委托既有 writer（customer 锁 + 上界 + 幂等键语义原样）。
      const hold = await writer.reserveCredits({
        externalCustomerId: mapping.externalCustomerId,
        idempotencyKey: input.idempotencyKey,
        maximumCents: input.maximumCents,
        expiresAt: input.expiresAt,
      });
      if (!hold.reserved) {
        return hold; // 上界拒绝：writer 已零写入，形状原样透传。
      }

      // 归属行：预扣 1:1，幂等写入。重放（同键）时这里自然落到已存行上。
      try {
        await database
          .insert(billingCallAttributions)
          .values({
            reservationId: hold.reservationId,
            tenantId: input.tenantId,
            workspaceId: input.workspaceId,
            principalId: input.principalId,
            botRef: input.botRef,
            callKey: input.callKey,
          })
          .onConflictDoNothing({
            target: billingCallAttributions.reservationId,
          });
      } catch (error) {
        // 并发同 call_key 竞态兜底：(tenant_id, call_key) 唯一索引是权威。
        // 输了竞态的一方刚建的预扣立即全额退持——不留幻影持有限额。
        if (isUniqueViolation(error)) {
          await writer.releaseReservation(
            hold.reservationId,
            "mt070: lost the stable call key race",
          );
          throw new Error(
            `CALL_KEY_CONFLICT: call key ${input.callKey} already has a reservation in company ${input.tenantId}`,
          );
        }
        throw error;
      }

      const [row] = await database
        .select()
        .from(billingCallAttributions)
        .where(eq(billingCallAttributions.reservationId, hold.reservationId))
        .limit(1);
      if (!row) {
        // ON CONFLICT DO NOTHING 吞掉了写入却没有已存行——结构上不可能
        // （插入要么成功要么撞唯一索引），宁可响亮失败也不静默丢单。
        throw new Error(
          `CALL_ATTRIBUTION_INVALID: attribution row for reservation ${hold.reservationId} vanished`,
        );
      }
      const attribution = attributionOfRow(row);
      if (!attributionMatches(attribution, input)) {
        // 同幂等键、不同归属：AC4 的重试不能改写归属（原预扣原归属不动）。
        throw new Error(
          `CALL_ATTRIBUTION_CONFLICT: the reservation for idempotency key ${input.idempotencyKey} belongs to another call attribution`,
        );
      }
      return { reserved: true as const, reservationId: hold.reservationId };
    },

    async attributionOf(reservationId) {
      requireNonEmpty(reservationId, "reservationId");
      const [row] = await database
        .select()
        .from(billingCallAttributions)
        .where(eq(billingCallAttributions.reservationId, reservationId))
        .limit(1);
      return row ? attributionOfRow(row) : null;
    },

    async usageSummary(tenantId) {
      requireNonEmpty(tenantId, "tenantId");
      // sum() over an integer column is bigint in Postgres; it rides back as text and is
      // widened here, so a long-lived tenant past 2^31-1 scaled units is a number instead
      // of an "integer out of range" throw.
      const heldUnits = sql<string>`coalesce(sum(case when ${creditReservations.status} = 'reserved' then ${creditReservations.maximum} else 0 end), 0)::bigint`;
      const chargedUnits = sql<string>`coalesce(sum(case when ${creditReservations.status} = 'settled' then coalesce(${creditReservations.charged}, 0) else 0 end), 0)::bigint`;
      const byTeam = await database
        .select({
          workspaceId: billingCallAttributions.workspaceId,
          heldUnits,
          chargedUnits,
        })
        .from(billingCallAttributions)
        .innerJoin(
          creditReservations,
          eq(creditReservations.id, billingCallAttributions.reservationId),
        )
        .where(eq(billingCallAttributions.tenantId, tenantId))
        .groupBy(billingCallAttributions.workspaceId);
      const byUser = await database
        .select({
          principalId: billingCallAttributions.principalId,
          heldUnits,
          chargedUnits,
        })
        .from(billingCallAttributions)
        .innerJoin(
          creditReservations,
          eq(creditReservations.id, billingCallAttributions.reservationId),
        )
        .where(eq(billingCallAttributions.tenantId, tenantId))
        .groupBy(billingCallAttributions.principalId);
      const widen = <T extends { heldUnits: string; chargedUnits: string }>(
        rows: readonly T[],
      ) =>
        rows.map((row) => ({
          ...row,
          heldUnits: Number(row.heldUnits),
          chargedUnits: Number(row.chargedUnits),
        }));
      return { byTeam: widen(byTeam), byUser: widen(byUser) };
    },
  };
}
