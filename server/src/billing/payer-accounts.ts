// server/src/billing/payer-accounts.ts
// MT069（Issue #112）：公司计费 Customer 映射与公司/个人账户类型（expand-only）。
//
// 职责：三张新表（billing_customer_mappings / billing_credit_accounts /
// billing_account_audit）的唯一写入面。设计裁决（见
// checkpoints/MT069/design.md）：
//
//   - 唯一且稳定的映射（验收 1）：公司↔Customer 两方向唯一在 DB 层
//     （tenant 主键 + customer 唯一索引）；服务预检冲突给出类型化
//     CUSTOMER_MAPPING_CONFLICT，完全相同的重复绑定幂等返回既有行（零写入、
//     零重复审计）。并发竞态兜底：唯一冲突（23505）映射到同一哨兵码——
//     绝不产生第二行。服务不暴露任何改绑/解除路径（稳定 = 写入一次）。
//   - 显式账户类型（验收 2）：注册入口按类型分开——公司账户的 Customer 从
//     唯一映射派生（无映射 → CUSTOMER_MAPPING_REQUIRED，调用方无法错配），
//     个人账户的 Customer 由调用方显式给出但绝不复用公司映射的 Customer
//     （CUSTOMER_COMPANY_MAPPED）。不存在从用户身份或字符串推断类型的路径。
//   - 未知类型隔离（验收 3）：quarantineUnknownAccount 是未知归属的唯一去处；
//     隔离行 type/key 必空（DB 行形状 CHECK 强制）、必留原因；已分类行再隔离
//     → ACCOUNT_ALREADY_CLASSIFIED；隔离行之上注册 → ACCOUNT_ALREADY_EXISTS
//     （分类晋升属 MT070+，本票绝不静默改类）。
//   - 审计（brief 验收 4）：bind/register/quarantine 每个成功写入操作一行
//     billing_account_audit；幂等重放不产生重复审计（不是新操作）。actor 由
//     受信调用方传入，服务只校验非空。
//
// 错误纪律：计费 seam 哨兵码（`CODE: message`），与 credits-writer /
// identity-binding 一致；金额与既有约束不在本模块触达范围（expand-only）。

import { randomBytes } from "node:crypto";
import { and, desc, eq, type SQL } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  billingAccountAudit,
  billingCreditAccounts,
  billingCustomerMappings,
} from "../db/schema/payer-accounts";

/** 计费账户 id：`bca-` + 16 hex（与 `cg-`/`po-` 同款随机宽度）。 */
function generateAccountId(): string {
  return `bca-${randomBytes(8).toString("hex")}`;
}

/** 审计行 id：`baa-` + 16 hex。 */
function generateAuditId(): string {
  return `baa-${randomBytes(8).toString("hex")}`;
}

export type PayerAccountAction =
  | "customer_mapping.bound"
  | "credit_account.registered"
  | "credit_account.quarantined";

/** 一条公司 ↔ Customer 映射，按存储行回答。 */
export interface CompanyCustomerMapping {
  readonly tenantId: string;
  readonly externalCustomerId: string;
  readonly createdAt: Date;
}

/** 一个积分账户（含隔离态），按存储行回答。 */
export interface CreditAccount {
  readonly id: string;
  readonly externalCustomerId: string;
  /** 'company' | 'personal'；隔离行为 null。 */
  readonly accountType: "company" | "personal" | null;
  /** 'active' | 'quarantined'。 */
  readonly status: "active" | "quarantined";
  readonly tenantId: string | null;
  readonly ownerUserId: string | null;
  readonly accountKey: string | null;
  readonly quarantineReason: string | null;
  readonly createdAt: Date;
}

/** 一条映射/账户操作审计。 */
export interface PayerAccountAuditEntry {
  readonly id: string;
  readonly action: PayerAccountAction;
  readonly actor: string;
  readonly tenantId: string | null;
  readonly externalCustomerId: string | null;
  readonly accountId: string | null;
  readonly detail: unknown;
  readonly occurredAt: Date;
}

/**
 * SQLSTATE 唯一/排他冲突探测。driver 可能把它放在 `code`（postgres.js）或
 * `errno`，沿 cause 链有限深度匹配（identity-binding 同款）。
 */
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

function invalid(what: string): Error {
  return new Error(`PAYER_ACCOUNT_INVALID: ${what}`);
}

function requireNonEmpty(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalid(`${what} must be a non-empty string`);
  }
  return value;
}

function accountRow(row: {
  id: string;
  externalCustomerId: string;
  accountType: string | null;
  status: string;
  tenantId: string | null;
  ownerUserId: string | null;
  accountKey: string | null;
  quarantineReason: string | null;
  createdAt: Date;
}): CreditAccount {
  return {
    id: row.id,
    externalCustomerId: row.externalCustomerId,
    accountType: row.accountType as CreditAccount["accountType"],
    status: row.status as CreditAccount["status"],
    tenantId: row.tenantId,
    ownerUserId: row.ownerUserId,
    accountKey: row.accountKey,
    quarantineReason: row.quarantineReason,
    createdAt: row.createdAt,
  };
}

export interface PayerAccountService {
  /**
   * 把一家公司绑定到唯一明确的计费 Customer。完全相同的重复绑定幂等返回既有
   * 行（稳定、零写入、零重复审计）；公司已绑其他 Customer 或 Customer 已被
   * 其他公司绑定 → CUSTOMER_MAPPING_CONFLICT。
   */
  bindCompanyCustomer(input: {
    readonly tenantId: string;
    readonly externalCustomerId: string;
    readonly actor: string;
  }): Promise<CompanyCustomerMapping>;

  /** 读取一家公司的映射；未绑定返回 null（只读，无审计）。 */
  resolveCompanyCustomer(
    tenantId: string,
  ): Promise<CompanyCustomerMapping | null>;

  /**
   * 注册公司积分账户：Customer 从唯一映射派生（唯一事实源），无映射 →
   * CUSTOMER_MAPPING_REQUIRED。同键重注册幂等返回既有行；该 Customer 已有
   * 其他账户行 → ACCOUNT_ALREADY_EXISTS。
   */
  registerCompanyAccount(input: {
    readonly tenantId: string;
    readonly actor: string;
  }): Promise<CreditAccount>;

  /**
   * 注册个人积分账户：Customer 由调用方显式给出，但公司映射的 Customer 永远
   * 不是个人付款方（CUSTOMER_COMPANY_MAPPED）；同一用户已有个人账户（或该
   * Customer 已有账户行）→ ACCOUNT_ALREADY_EXISTS。
   */
  registerPersonalAccount(input: {
    readonly userId: string;
    readonly externalCustomerId: string;
    readonly actor: string;
  }): Promise<CreditAccount>;

  /**
   * 未知归属记录的唯一去处：隔离（type/key 必空 + 必留原因），绝不默认归为
   * 某一类。已分类 → ACCOUNT_ALREADY_CLASSIFIED；已有隔离行幂等返回。
   */
  quarantineUnknownAccount(input: {
    readonly externalCustomerId: string;
    readonly reason: string;
    readonly actor: string;
  }): Promise<CreditAccount>;

  /** 按计费 Customer 读账户；没有返回 null。 */
  getAccountByCustomer(
    externalCustomerId: string,
  ): Promise<CreditAccount | null>;

  /** 审计读：按公司或按 Customer 过滤，新在前。 */
  listAccountAudit(scope: {
    readonly tenantId?: string;
    readonly externalCustomerId?: string;
  }): Promise<PayerAccountAuditEntry[]>;
}

export function createPayerAccountService(
  database: Database,
): PayerAccountService {
  /** 审计写入（调用方已校验输入；detail 原样存 jsonb）。 */
  async function audit(entry: {
    action: PayerAccountAction;
    actor: string;
    tenantId: string | null;
    externalCustomerId: string | null;
    accountId: string | null;
    detail?: unknown;
  }): Promise<void> {
    await database.insert(billingAccountAudit).values({
      id: generateAuditId(),
      action: entry.action,
      actor: entry.actor,
      tenantId: entry.tenantId,
      externalCustomerId: entry.externalCustomerId,
      accountId: entry.accountId,
      detail: entry.detail ?? null,
    });
  }

  return {
    async bindCompanyCustomer(input) {
      const tenantId = requireNonEmpty(input?.tenantId, "tenantId");
      const externalCustomerId = requireNonEmpty(
        input?.externalCustomerId,
        "externalCustomerId",
      );
      const actor = requireNonEmpty(input?.actor, "actor");

      const existing = await database
        .select()
        .from(billingCustomerMappings)
        .where(eq(billingCustomerMappings.tenantId, tenantId));
      const current = existing[0];
      if (current) {
        // 唯一且稳定：同对幂等返回，任何冲突组合响亮拒绝。
        if (current.externalCustomerId === externalCustomerId) {
          return {
            tenantId: current.tenantId,
            externalCustomerId: current.externalCustomerId,
            createdAt: current.createdAt,
          };
        }
        throw new Error(
          `CUSTOMER_MAPPING_CONFLICT: company ${tenantId} is already bound to customer ${current.externalCustomerId}`,
        );
      }
      const taken = await database
        .select({ tenantId: billingCustomerMappings.tenantId })
        .from(billingCustomerMappings)
        .where(
          eq(billingCustomerMappings.externalCustomerId, externalCustomerId),
        );
      if (taken[0]) {
        throw new Error(
          `CUSTOMER_MAPPING_CONFLICT: customer ${externalCustomerId} is already bound to company ${taken[0].tenantId}`,
        );
      }

      try {
        await database
          .insert(billingCustomerMappings)
          .values({ tenantId, externalCustomerId });
      } catch (error) {
        // 并发竞态兜底：两方向唯一索引是权威，23505 一律映射为冲突。
        if (isUniqueViolation(error)) {
          throw new Error(
            `CUSTOMER_MAPPING_CONFLICT: company ${tenantId} and customer ${externalCustomerId} lost a concurrent binding race`,
          );
        }
        throw error;
      }
      await audit({
        action: "customer_mapping.bound",
        actor,
        tenantId,
        externalCustomerId,
        accountId: null,
      });
      return { tenantId, externalCustomerId, createdAt: new Date() };
    },

    async resolveCompanyCustomer(tenantId) {
      requireNonEmpty(tenantId, "tenantId");
      const rows = await database
        .select()
        .from(billingCustomerMappings)
        .where(eq(billingCustomerMappings.tenantId, tenantId));
      const row = rows[0];
      return row
        ? {
            tenantId: row.tenantId,
            externalCustomerId: row.externalCustomerId,
            createdAt: row.createdAt,
          }
        : null;
    },

    async registerCompanyAccount(input) {
      const tenantId = requireNonEmpty(input?.tenantId, "tenantId");
      const actor = requireNonEmpty(input?.actor, "actor");

      // Customer 从唯一映射派生：映射是公司付款 Customer 的唯一事实源。
      const rows = await database
        .select()
        .from(billingCustomerMappings)
        .where(eq(billingCustomerMappings.tenantId, tenantId));
      const mapping = rows[0];
      if (!mapping) {
        throw new Error(
          `CUSTOMER_MAPPING_REQUIRED: company ${tenantId} has no billing customer mapping`,
        );
      }
      const existing = await database
        .select()
        .from(billingCreditAccounts)
        .where(
          eq(
            billingCreditAccounts.externalCustomerId,
            mapping.externalCustomerId,
          ),
        );
      const prior = existing[0];
      if (prior) {
        if (
          prior.status === "active" &&
          prior.accountType === "company" &&
          prior.tenantId === tenantId
        ) {
          return accountRow(prior); // 同键重注册：稳定标识下幂等。
        }
        throw new Error(
          `ACCOUNT_ALREADY_EXISTS: customer ${mapping.externalCustomerId} already has account ${prior.id} (${prior.status})`,
        );
      }

      const account: CreditAccount = {
        id: generateAccountId(),
        externalCustomerId: mapping.externalCustomerId,
        accountType: "company",
        status: "active",
        tenantId,
        ownerUserId: null,
        accountKey: `company:${tenantId}`,
        quarantineReason: null,
        createdAt: new Date(),
      };
      try {
        await database.insert(billingCreditAccounts).values({
          id: account.id,
          externalCustomerId: account.externalCustomerId,
          accountType: account.accountType,
          status: account.status,
          tenantId: account.tenantId,
          ownerUserId: null,
          accountKey: account.accountKey,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new Error(
            `ACCOUNT_ALREADY_EXISTS: customer ${account.externalCustomerId} already has an account`,
          );
        }
        throw error;
      }
      await audit({
        action: "credit_account.registered",
        actor,
        tenantId,
        externalCustomerId: account.externalCustomerId,
        accountId: account.id,
        detail: { accountType: "company" },
      });
      return account;
    },

    async registerPersonalAccount(input) {
      const userId = requireNonEmpty(input?.userId, "userId");
      const externalCustomerId = requireNonEmpty(
        input?.externalCustomerId,
        "externalCustomerId",
      );
      const actor = requireNonEmpty(input?.actor, "actor");

      // 公司映射的 Customer 永远不是个人付款方（付款账户固定，票面 A13 邻接）。
      const mapped = await database
        .select({ tenantId: billingCustomerMappings.tenantId })
        .from(billingCustomerMappings)
        .where(
          eq(billingCustomerMappings.externalCustomerId, externalCustomerId),
        );
      if (mapped[0]) {
        throw new Error(
          `CUSTOMER_COMPANY_MAPPED: customer ${externalCustomerId} is the billing customer of company ${mapped[0].tenantId}`,
        );
      }

      const byUser = await database
        .select()
        .from(billingCreditAccounts)
        .where(eq(billingCreditAccounts.accountKey, `personal:${userId}`));
      if (byUser[0]) {
        throw new Error(
          `ACCOUNT_ALREADY_EXISTS: user ${userId} already has account ${byUser[0].id}`,
        );
      }
      const byCustomer = await database
        .select()
        .from(billingCreditAccounts)
        .where(
          eq(billingCreditAccounts.externalCustomerId, externalCustomerId),
        );
      if (byCustomer[0]) {
        throw new Error(
          `ACCOUNT_ALREADY_EXISTS: customer ${externalCustomerId} already has account ${byCustomer[0].id}`,
        );
      }

      const account: CreditAccount = {
        id: generateAccountId(),
        externalCustomerId,
        accountType: "personal",
        status: "active",
        tenantId: null,
        ownerUserId: userId,
        accountKey: `personal:${userId}`,
        quarantineReason: null,
        createdAt: new Date(),
      };
      try {
        await database.insert(billingCreditAccounts).values({
          id: account.id,
          externalCustomerId: account.externalCustomerId,
          accountType: account.accountType,
          status: account.status,
          tenantId: null,
          ownerUserId: account.ownerUserId,
          accountKey: account.accountKey,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new Error(
            `ACCOUNT_ALREADY_EXISTS: stable identity for user ${userId} / customer ${externalCustomerId} lost a concurrent registration race`,
          );
        }
        throw error;
      }
      await audit({
        action: "credit_account.registered",
        actor,
        tenantId: null,
        externalCustomerId,
        accountId: account.id,
        detail: { accountType: "personal" },
      });
      return account;
    },

    async quarantineUnknownAccount(input) {
      const externalCustomerId = requireNonEmpty(
        input?.externalCustomerId,
        "externalCustomerId",
      );
      const reason = requireNonEmpty(input?.reason, "reason");
      const actor = requireNonEmpty(input?.actor, "actor");

      const rows = await database
        .select()
        .from(billingCreditAccounts)
        .where(
          eq(billingCreditAccounts.externalCustomerId, externalCustomerId),
        );
      const prior = rows[0];
      if (prior) {
        if (prior.status === "quarantined") {
          return accountRow(prior); // 同一未知记录的重复观察：幂等返回。
        }
        throw new Error(
          `ACCOUNT_ALREADY_CLASSIFIED: account ${prior.id} is ${prior.accountType}; quarantine only holds unknowns`,
        );
      }

      const account: CreditAccount = {
        id: generateAccountId(),
        externalCustomerId,
        accountType: null,
        status: "quarantined",
        tenantId: null,
        ownerUserId: null,
        accountKey: null,
        quarantineReason: reason,
        createdAt: new Date(),
      };
      try {
        await database.insert(billingCreditAccounts).values({
          id: account.id,
          externalCustomerId,
          accountType: null,
          status: "quarantined",
          tenantId: null,
          ownerUserId: null,
          accountKey: null,
          quarantineReason: reason,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new Error(
            `ACCOUNT_ALREADY_EXISTS: customer ${externalCustomerId} already has an account`,
          );
        }
        throw error;
      }
      await audit({
        action: "credit_account.quarantined",
        actor,
        tenantId: null,
        externalCustomerId,
        accountId: account.id,
        detail: { reason },
      });
      return account;
    },

    async getAccountByCustomer(externalCustomerId) {
      requireNonEmpty(externalCustomerId, "externalCustomerId");
      const rows = await database
        .select()
        .from(billingCreditAccounts)
        .where(
          eq(billingCreditAccounts.externalCustomerId, externalCustomerId),
        );
      return rows[0] ? accountRow(rows[0]) : null;
    },

    async listAccountAudit(scope) {
      const filters: SQL[] = [];
      if (scope?.tenantId !== undefined) {
        requireNonEmpty(scope.tenantId, "tenantId");
        filters.push(eq(billingAccountAudit.tenantId, scope.tenantId));
      }
      if (scope?.externalCustomerId !== undefined) {
        requireNonEmpty(scope.externalCustomerId, "externalCustomerId");
        filters.push(
          eq(billingAccountAudit.externalCustomerId, scope.externalCustomerId),
        );
      }
      const rows = await database
        .select()
        .from(billingAccountAudit)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(billingAccountAudit.occurredAt));
      return rows.map((row) => ({
        id: row.id,
        action: row.action as PayerAccountAction,
        actor: row.actor,
        tenantId: row.tenantId,
        externalCustomerId: row.externalCustomerId,
        accountId: row.accountId,
        detail: row.detail,
        occurredAt: row.occurredAt,
      }));
    },
  };
}
