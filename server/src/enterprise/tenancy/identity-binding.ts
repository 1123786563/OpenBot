// server/src/enterprise/tenancy/identity-binding.ts
// MT026（Issue #69）：身份绑定的服务端持久意图与回调归属（票面验收 4：
// 身份绑定回调按服务端持久状态归属，不接受回调参数改写公司）。
//
// 机制：
//   - createIntent：服务端生成不透明 state（crypto.randomUUID，不是回调可
//     声明的值），把归属（公司 + 用户 + kind + 过期时间）在创建时持久化到
//     enterprise_identity_binding_intents（INSERT 策略 pin app.tenant_id）。
//   - resolveIntent：按 state 精确 pin（RLS 臂 app.identity_binding_state）
//     读**持久行**，公司归属只来自行。回调声称的公司 ≠ 持久公司 →
//     IDENTITY_BINDING_TENANT_MISMATCH（不消费、零改写——声称既不生效也
//     不烧掉 state）；成功解析一次性消费（consumed_at，UPDATE 只有 state
//     臂）；未知/已消费/过期分别响亮拒绝。
//
// 受限角色无法按公司枚举意图（SELECT 只有 state 臂——意图不被目录读取，
// 也不进入任何公司列表面）。

import { eq, sql } from "drizzle-orm";
import { enterpriseIdentityBindingIntents } from "../../db/schema/enterprise-sso-scim";
import { assertOperatorDatabase, type OperatorDatabase } from "./connections";

const DEFAULT_TTL_SECONDS = 600;
const MIN_TTL_SECONDS = 1;
const MAX_TTL_SECONDS = 86_400;

export type IdentityBindingKind = "sso" | "scim";

export interface IdentityBindingIntent {
  /** 不透明 state；回调携带它，但归属永远由服务端持久行决定。 */
  readonly state: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly kind: IdentityBindingKind;
  readonly expiresAt: Date;
}

export interface ResolvedIdentityBinding {
  readonly tenantId: string;
  readonly userId: string;
  readonly kind: IdentityBindingKind;
}

export interface IdentityBindingService {
  createIntent(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly kind: IdentityBindingKind;
    readonly ttlSeconds?: number;
  }): Promise<IdentityBindingIntent>;
  /**
   * Resolves a callback against the persisted intent. `claimedTenantId` is
   * what the callback *says* — when present it must equal the persisted
   * company, and it never decides the attribution.
   */
  resolveIntent(input: {
    readonly state: string;
    readonly claimedTenantId?: string;
  }): Promise<ResolvedIdentityBinding>;
}

function isPostgresErrorCode(error: unknown, sqlstate: string): boolean {
  // The Bun-native driver carries the SQLSTATE in `errno`, postgres.js in
  // `code`; match along the drizzle cause chain, bounded depth.
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof Error) {
      const shaped = current as { code?: string; errno?: string };
      if (shaped.code === sqlstate || shaped.errno === sqlstate) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function createIdentityBindingService(
  operator: OperatorDatabase,
): IdentityBindingService {
  assertOperatorDatabase(operator);

  return {
    async createIntent(input) {
      const tenantId = input?.tenantId;
      if (typeof tenantId !== "string" || !tenantId.trim()) {
        throw new Error(
          "IDENTITY_BINDING_INVALID: tenantId must be a non-empty string",
        );
      }
      const userId = input?.userId;
      if (typeof userId !== "string" || !userId.trim()) {
        throw new Error(
          "IDENTITY_BINDING_INVALID: userId must be a non-empty string",
        );
      }
      const kind = input?.kind;
      if (kind !== "sso" && kind !== "scim") {
        throw new Error(
          "IDENTITY_BINDING_INVALID: kind must be 'sso' or 'scim'",
        );
      }
      const ttlSeconds = input?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
      if (
        !Number.isSafeInteger(ttlSeconds) ||
        ttlSeconds < MIN_TTL_SECONDS ||
        ttlSeconds > MAX_TTL_SECONDS
      ) {
        throw new Error(
          `IDENTITY_BINDING_INVALID: ttlSeconds must be an integer of ${MIN_TTL_SECONDS}..${MAX_TTL_SECONDS}`,
        );
      }
      return operator.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        const state = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
        try {
          await tx.insert(enterpriseIdentityBindingIntents).values({
            id: state,
            tenantId,
            userId,
            kind,
            expiresAt,
          });
        } catch (error) {
          // FK violation: the user (or tenant) does not exist. Refuse loudly;
          // an intent is only created for a real global identity.
          if (isPostgresErrorCode(error, "23503")) {
            throw new Error(
              "IDENTITY_BINDING_INVALID: tenant or user does not exist",
            );
          }
          throw error;
        }
        return { state, tenantId, userId, kind, expiresAt };
      });
    },

    async resolveIntent(input) {
      const state = input?.state;
      if (typeof state !== "string" || !state.trim()) {
        throw new Error("IDENTITY_BINDING_STATE_UNKNOWN");
      }
      return operator.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.identity_binding_state', ${state}, true)`,
        );
        const [row] = await tx
          .select({
            tenantId: enterpriseIdentityBindingIntents.tenantId,
            userId: enterpriseIdentityBindingIntents.userId,
            kind: enterpriseIdentityBindingIntents.kind,
            expiresAt: enterpriseIdentityBindingIntents.expiresAt,
            consumedAt: enterpriseIdentityBindingIntents.consumedAt,
          })
          .from(enterpriseIdentityBindingIntents)
          .where(eq(enterpriseIdentityBindingIntents.id, state))
          .limit(1);
        if (!row) throw new Error("IDENTITY_BINDING_STATE_UNKNOWN");
        if (row.consumedAt) throw new Error("IDENTITY_BINDING_STATE_CONSUMED");
        if (row.expiresAt.getTime() <= Date.now()) {
          throw new Error("IDENTITY_BINDING_EXPIRED");
        }
        // The callback may *say* which company it thinks this is — it never
        // decides. A claim that contradicts the persisted attribution is a
        // loud refusal, and it does not consume the state (the honest
        // callback afterwards still resolves to the persisted company).
        const claimed = input.claimedTenantId;
        if (claimed !== undefined && claimed !== row.tenantId) {
          throw new Error("IDENTITY_BINDING_TENANT_MISMATCH");
        }
        const consumed = await tx
          .update(enterpriseIdentityBindingIntents)
          .set({ consumedAt: sql`now()` })
          .where(
            sql`${enterpriseIdentityBindingIntents.id} = ${state} and ${enterpriseIdentityBindingIntents.consumedAt} is null`,
          )
          .returning({ id: enterpriseIdentityBindingIntents.id });
        if (consumed.length !== 1) {
          throw new Error("IDENTITY_BINDING_STATE_CONSUMED");
        }
        return {
          tenantId: row.tenantId,
          userId: row.userId,
          kind: row.kind as IdentityBindingKind,
        };
      });
    },
  };
}
