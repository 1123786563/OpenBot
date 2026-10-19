// server/tests/multitenancy/payer-accounts.test.ts
// MT069（Issue #112）：公司计费 Customer 映射与公司/个人账户类型（expand-only）。
//
// 验收事实源（Issue #112 验收 1–4 + brief 追加"映射与账户操作留审计"，逐条对应 describe）：
//   (1) 公司与 Customer 的映射唯一且稳定；重复映射被拒绝。
//   (2) 账户类型是显式字段，不从字符串或用户身份猜测。
//   (3) 既有记录在迁移后行为不变（回归测试）；未知类型记录被隔离而不是默认归为某一类。
//   (4) 金额尺度、精度与既有约束保持不变。
//   (5) 映射与账户操作留审计（brief 验收 4）。
//
// 机制：三张新表（billing_customer_mappings / billing_credit_accounts /
// billing_account_audit）跟随 billing 域访问模型（owner 通道、无 RLS，与
// billing_customers/credit_grants/credit_ledger/credit_reservations 一致）；唯一性
// 与行形状约束在 DB 层，服务层给类型化哨兵码。expand-only：不改既有扣费路径——
// 回归组用真实 writer（createCreditWriter）在 MT069 迁移后的库上走
// grant→reserve→settle 全链路，并列断言四张既有计费表列清单不变。
//
// 环境契约：专用企业测试库，缺显式 env 整套显式 skip，绝不回退开发库、skipped
// 不计通过。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import { asc, eq, sql } from "drizzle-orm";
import { createCreditWriter } from "../../src/billing/credits-writer";
import { creditGrants, creditLedger } from "../../src/db/schema/credits";
import {
  createPayerAccountsFixture,
  type PayerAccountsFixture,
  probePayerAccountsEnvironment,
} from "./support/payer-accounts";

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  return probePayerAccountsEnvironment();
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

let fixture: PayerAccountsFixture;

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createPayerAccountsFixture();
});

afterAll(async () => {
  await fixture?.dispose();
});

/** 断言 promise 以计费 seam 哨兵码拒绝（`CODE: …` 形态）。 */
async function expectSentinelRejection(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(
      error instanceof Error && error.message.startsWith(`${code}: `),
    ).toBe(true);
    return;
  }
  throw new Error(`expected rejection with sentinel code ${code}, got resolve`);
}

describeDb("MT069 AC1: company↔customer mapping is unique and stable", () => {
  itDb("binds a company to a customer once and audits it", async () => {
    const { service, ids } = fixture!;
    const mapping = await service.bindCompanyCustomer({
      tenantId: ids.companyA,
      externalCustomerId: ids.customerA,
      actor: "mt069-test",
    });
    expect(mapping).toMatchObject({
      tenantId: ids.companyA,
      externalCustomerId: ids.customerA,
    });

    const audits = await service.listAccountAudit({ tenantId: ids.companyA });
    expect(
      audits.filter((entry) => entry.action === "customer_mapping.bound"),
    ).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "customer_mapping.bound",
      actor: "mt069-test",
      tenantId: ids.companyA,
      externalCustomerId: ids.customerA,
    });
  });

  itDb(
    "re-binding the exact same pair is idempotent and writes nothing",
    async () => {
      const { service, ids } = fixture!;
      const first = await service.bindCompanyCustomer({
        tenantId: ids.companyA,
        externalCustomerId: ids.customerA,
        actor: "mt069-test",
      });
      const retry = await service.bindCompanyCustomer({
        tenantId: ids.companyA,
        externalCustomerId: ids.customerA,
        actor: "mt069-test",
      });
      expect(retry).toEqual(first);

      const audits = await service.listAccountAudit({ tenantId: ids.companyA });
      expect(
        audits.filter((entry) => entry.action === "customer_mapping.bound"),
      ).toHaveLength(1);
    },
  );

  itDb("rejects a second customer for an already-bound company", async () => {
    const { service, ids } = fixture!;
    // 消息断言钉死预检语义（非竞态兑底路径）：预检消息含 "already bound"。
    try {
      await service.bindCompanyCustomer({
        tenantId: ids.companyA,
        externalCustomerId: ids.customerFree1,
        actor: "mt069-test",
      });
    } catch (error) {
      expect(
        error instanceof Error &&
          error.message.startsWith("CUSTOMER_MAPPING_CONFLICT: "),
      ).toBe(true);
      expect(
        error instanceof Error && error.message.includes("already bound"),
      ).toBe(true);
      return;
    }
    throw new Error("expected CUSTOMER_MAPPING_CONFLICT");
  });

  itDb("rejects a second company for an already-bound customer", async () => {
    const { service, ids } = fixture!;
    try {
      await service.bindCompanyCustomer({
        tenantId: ids.companyB,
        externalCustomerId: ids.customerA,
        actor: "mt069-test",
      });
    } catch (error) {
      expect(
        error instanceof Error &&
          error.message.startsWith("CUSTOMER_MAPPING_CONFLICT: "),
      ).toBe(true);
      expect(
        error instanceof Error && error.message.includes("already bound"),
      ).toBe(true);
      return;
    }
    throw new Error("expected CUSTOMER_MAPPING_CONFLICT");
  });

  itDb(
    "resolves the mapping, and unknown companies resolve to null",
    async () => {
      const { service, ids } = fixture!;
      const resolved = await service.resolveCompanyCustomer(ids.companyA);
      expect(resolved?.externalCustomerId).toBe(ids.customerA);
      expect(await service.resolveCompanyCustomer(ids.companyB)).toBeNull();
    },
  );
});

describeDb("MT069 AC2: account type is an explicit field", () => {
  itDb(
    "registers a company account with the mapped customer, derived key, and audit",
    async () => {
      const { service, ids } = fixture!;
      const account = await service.registerCompanyAccount({
        tenantId: ids.companyA,
        actor: "mt069-test",
      });
      expect(account).toMatchObject({
        accountType: "company",
        status: "active",
        tenantId: ids.companyA,
        ownerUserId: null,
        externalCustomerId: ids.customerA,
        accountKey: `company:${ids.companyA}`,
      });

      const audits = await service.listAccountAudit({ tenantId: ids.companyA });
      expect(
        audits.filter((entry) => entry.action === "credit_account.registered"),
      ).toHaveLength(1);
    },
  );

  itDb(
    "refuses a company account without a mapping (the customer is never guessed)",
    async () => {
      const { service, ids } = fixture!;
      await expectSentinelRejection(
        service.registerCompanyAccount({
          tenantId: ids.companyB,
          actor: "mt069-test",
        }),
        "CUSTOMER_MAPPING_REQUIRED",
      );
    },
  );

  itDb(
    "re-registering the same company account is idempotent (stable identity)",
    async () => {
      const { service, ids } = fixture!;
      const first = await service.registerCompanyAccount({
        tenantId: ids.companyA,
        actor: "mt069-test",
      });
      const retry = await service.registerCompanyAccount({
        tenantId: ids.companyA,
        actor: "mt069-test",
      });
      expect(retry).toEqual(first);
    },
  );

  itDb(
    "registers a personal account with an explicit customer and owner",
    async () => {
      const { service, ids } = fixture!;
      const account = await service.registerPersonalAccount({
        userId: ids.user1,
        externalCustomerId: ids.customerFree1,
        actor: "mt069-test",
      });
      expect(account).toMatchObject({
        accountType: "personal",
        status: "active",
        ownerUserId: ids.user1,
        tenantId: null,
        externalCustomerId: ids.customerFree1,
        accountKey: `personal:${ids.user1}`,
      });
    },
  );

  itDb(
    "refuses a personal account on a company-mapped customer (fixed payer)",
    async () => {
      const { service, ids } = fixture!;
      await expectSentinelRejection(
        service.registerPersonalAccount({
          userId: ids.user2,
          externalCustomerId: ids.customerA,
          actor: "mt069-test",
        }),
        "CUSTOMER_COMPANY_MAPPED",
      );
    },
  );

  itDb(
    "holds one personal account per user (stable identity constraint)",
    async () => {
      const { service, ids } = fixture!;
      await expectSentinelRejection(
        service.registerPersonalAccount({
          userId: ids.user1,
          externalCustomerId: ids.customerFree2,
          actor: "mt069-test",
        }),
        "ACCOUNT_ALREADY_EXISTS",
      );
    },
  );

  itDb(
    "reads an account by customer; unknown customers read null",
    async () => {
      const { service, ids } = fixture!;
      expect(
        (await service.getAccountByCustomer(ids.customerA))?.accountType,
      ).toBe("company");
      expect(await service.getAccountByCustomer(ids.customerFree3)).toBeNull();
    },
  );
});

describeDb("MT069 AC3: unknown-type records quarantine, never default", () => {
  itDb(
    "quarantines an unknown customer with no type, no key, and a reason",
    async () => {
      const { service, ids } = fixture!;
      const quarantined = await service.quarantineUnknownAccount({
        externalCustomerId: ids.customerFree2,
        reason: "legacy row with no provable attribution",
        actor: "mt069-test",
      });
      expect(quarantined).toMatchObject({
        accountType: null,
        status: "quarantined",
        accountKey: null,
        tenantId: null,
        ownerUserId: null,
        externalCustomerId: ids.customerFree2,
        quarantineReason: "legacy row with no provable attribution",
      });

      const audits = await service.listAccountAudit({
        externalCustomerId: ids.customerFree2,
      });
      expect(
        audits.filter((entry) => entry.action === "credit_account.quarantined"),
      ).toHaveLength(1);
    },
  );

  itDb("re-quarantining the same customer is idempotent", async () => {
    const { service, ids } = fixture!;
    const first = await service.getAccountByCustomer(ids.customerFree2);
    const retry = await service.quarantineUnknownAccount({
      externalCustomerId: ids.customerFree2,
      reason: "second observation",
      actor: "mt069-test",
    });
    expect(retry.id).toBe(first?.id);
  });

  itDb("refuses to quarantine an already-classified account", async () => {
    const { service, ids } = fixture!;
    await expectSentinelRejection(
      service.quarantineUnknownAccount({
        externalCustomerId: ids.customerA,
        reason: "should not happen",
        actor: "mt069-test",
      }),
      "ACCOUNT_ALREADY_CLASSIFIED",
    );
  });

  itDb(
    "never silently classifies over a quarantined row (promotion is MT070+)",
    async () => {
      const { service, ids } = fixture!;
      await expectSentinelRejection(
        service.registerPersonalAccount({
          userId: ids.user2,
          externalCustomerId: ids.customerFree2,
          actor: "mt069-test",
        }),
        "ACCOUNT_ALREADY_EXISTS",
      );
    },
  );
});

describeDb(
  "MT069 structural isolation: restricted roles have zero grants",
  () => {
    itDb(
      "ob_ent_directory/data/operator hold no table privileges on the three new tables",
      async () => {
        const { db } = fixture!;
        const tables = [
          "billing_customer_mappings",
          "billing_credit_accounts",
          "billing_account_audit",
        ];
        for (const table of tables) {
          const rows = await db.execute(
            sql`select grantee, privilege_type from information_schema.role_table_grants
            where table_name = ${table}
              and grantee in ('ob_ent_directory', 'ob_ent_data', 'ob_ent_operator')`,
          );
          expect(rows).toEqual([]);
          // PUBLIC 也必须无授权（REVOKE 纪律）：任何非创建者授权都算失败。
          const publicRows = await db.execute(
            sql`select grantee, privilege_type from information_schema.role_table_grants
            where table_name = ${table} and grantee = 'PUBLIC'`,
          );
          expect(publicRows).toEqual([]);
        }
      },
    );
  },
);

describeDb("MT069 AC4 regression: existing billing model untouched", () => {
  itDb(
    "keeps the column inventory of the four existing billing tables unchanged",
    async () => {
      const { db } = fixture!;
      const expected: Record<string, string[]> = {
        billing_customers: ["external_id", "last_synced_at", "name"],
        credit_grants: [
          "created_at",
          "expires_at",
          "external_customer_id",
          "granted_at",
          "id",
          "idempotency_key",
          "reason",
          "source",
          "status",
          "total",
          "used",
        ],
        credit_ledger: [
          "applied",
          "client",
          "created_at",
          "credits",
          "external_customer_id",
          "grant_id",
          "id",
          "idempotency_key",
          "model",
          "request_id",
          "title",
        ],
        // 修复波次 fix-mt（#112 MT069 测试适配）：AC4 原始语义是「既有计费表
        // 不因 MT069 而变」。MT069 之后主链迁移合法地为 credit_reservations
        // 加了 7 列（非 MT069 所为），期望清单同步为当前真实 schema：
        // provider/model/capability/snapshot_version/rate_version 来自
        // 0140_reservation_locked_basis（锁价基准，对应 0128/0129/0133 建立
        // 的 rate/model/snapshot 目录域），unknown_at/unknown_reason 来自
        // 0141_credit_reservation_unknown_state。其余三表仍钉死原清单。
        credit_reservations: [
          "actual_denominator",
          "actual_numerator",
          "applied",
          "capability",
          "charged",
          "created_at",
          "expires_at",
          "external_customer_id",
          "id",
          "idempotency_key",
          "ledger_id",
          "maximum",
          "model",
          "provider",
          "rate_version",
          "release_reason",
          "released",
          "remainder_denominator",
          "remainder_numerator",
          "snapshot_version",
          "status",
          "terminal_at",
          "unknown_at",
          "unknown_reason",
        ],
      };
      for (const [table, columns] of Object.entries(expected)) {
        const rows = await db.execute(
          sql`select column_name from information_schema.columns
            where table_schema = 'public' and table_name = ${table}
            order by column_name`,
        );
        expect(rows.map((row) => row.column_name)).toEqual(columns);
      }
    },
  );

  itDb(
    "runs the real grant→reserve→settle path unchanged on the migrated database",
    async () => {
      const { db, ids } = fixture!;
      const writer = createCreditWriter(db);
      const customer = ids.customerFree3;

      const grant = await writer.grantCredits({
        externalCustomerId: customer,
        source: "plan",
        totalCents: 5_000, // 50.00 credits, ×100
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        reason: "MT069 regression allowance",
        idempotencyKey: "mt069-regression-grant",
      });
      expect(grant.inserted).toBe(true);
      expect(grant.grant.total).toBe(5_000);
      expect(grant.grant.used).toBe(0);

      expect(await writer.availableBalance(customer)).toBe(5_000);

      const hold = await writer.reserveCredits({
        externalCustomerId: customer,
        idempotencyKey: "mt069-regression-hold",
        maximumCents: 3_000,
        expiresAt: new Date("2099-01-02T00:00:00Z"),
      });
      expect(hold).toEqual({
        reserved: true,
        reservationId: expect.any(String),
      });
      if (!hold.reserved) throw new Error("unreachable");

      const settled = await writer.settleReservation({
        reservationId: hold.reservationId,
        actual: { numerator: 1234n, denominator: 1n }, // 12.34 credits
        title: "MT069 regression call",
        requestId: "req-mt069",
        model: "test-model",
        client: "web",
      });
      expect(settled.chargedCents).toBe(1_234);
      expect(settled.appliedCents).toBe(1_234);
      expect(await writer.availableBalance(customer)).toBe(5_000 - 1_234);

      // 台账真实落行，×100 整数纪律原样。结算行的幂等键是 writer 派生的
      // `reservation:<id>`（预扣键只标识预扣本身），按客户 + 金额检索。
      const ledgerRows = await db
        .select()
        .from(creditLedger)
        .where(eq(creditLedger.externalCustomerId, customer))
        .orderBy(asc(creditLedger.createdAt));
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0].credits).toBe(1_234);
      expect(ledgerRows[0].applied).toBe(1_234);
      expect(ledgerRows[0].idempotencyKey).toBe(
        `reservation:${hold.reservationId}`,
      );
    },
  );

  itDb(
    "still enforces the scaled-integer ceiling (used never passes total)",
    async () => {
      const { db } = fixture!;
      const grant = await db
        .select({ id: creditGrants.id })
        .from(creditGrants)
        .where(eq(creditGrants.idempotencyKey, "mt069-regression-grant"));
      expect(grant).toHaveLength(1);
      // 既有约束原样：used 越过 total 的 UPDATE 必须被 CHECK 拒绝。
      let ceilingViolated = false;
      try {
        await db.execute(
          sql`update credit_grants set used = total + 1 where id = ${grant[0].id}`,
        );
      } catch {
        ceilingViolated = true;
      }
      expect(ceilingViolated).toBe(true);
    },
  );
});

describeDb("MT069 input discipline", () => {
  itDb(
    "rejects blank tenant/customer/user/reason/actor inputs loudly",
    async () => {
      const { service, ids } = fixture!;
      await expectSentinelRejection(
        service.bindCompanyCustomer({
          tenantId: " ",
          externalCustomerId: ids.customerFree3,
          actor: "mt069-test",
        }),
        "PAYER_ACCOUNT_INVALID",
      );
      await expectSentinelRejection(
        service.bindCompanyCustomer({
          tenantId: ids.companyB,
          externalCustomerId: "",
          actor: "mt069-test",
        }),
        "PAYER_ACCOUNT_INVALID",
      );
      await expectSentinelRejection(
        service.registerPersonalAccount({
          userId: "",
          externalCustomerId: ids.customerFree3,
          actor: "mt069-test",
        }),
        "PAYER_ACCOUNT_INVALID",
      );
      await expectSentinelRejection(
        service.quarantineUnknownAccount({
          externalCustomerId: ids.customerFree3,
          reason: " ",
          actor: "mt069-test",
        }),
        "PAYER_ACCOUNT_INVALID",
      );
      await expectSentinelRejection(
        service.registerCompanyAccount({
          tenantId: ids.companyB,
          actor: "",
        }),
        "PAYER_ACCOUNT_INVALID",
      );
    },
  );
});

describeDb("MT069 audit trail is readable per company and per customer", () => {
  itDb("lists audit entries newest-first scoped to a customer", async () => {
    const { service, ids } = fixture!;
    const audits = await service.listAccountAudit({
      externalCustomerId: ids.customerA,
    });
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits.map((entry) => entry.action)).toEqual([
      "credit_account.registered",
      "customer_mapping.bound",
    ]);
    // 隔离 Customer 的审计不串台。
    const otherAudits = await service.listAccountAudit({
      externalCustomerId: ids.customerFree2,
    });
    expect(
      otherAudits.every(
        (entry) => entry.action === "credit_account.quarantined",
      ),
    ).toBe(true);
  });
});
