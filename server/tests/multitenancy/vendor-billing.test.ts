// server/tests/multitenancy/vendor-billing.test.ts
// MT074（波次 16 补位）：供应商计费调用面 + 回调归属锁定。
//
// brief 票面四条验收全部在真实 PostgreSQL 上钉死（专用测试库，缺 env 显式 skip、
// skipped 不计通过）：
//   AC1 调用者身份在进入公司范围前确认；供应商只能收到其登记公司的必要计费字段
//       （身份门先于计费事实读取；载荷闭形 {externalId, name} 全部服务端派生）；
//   AC2 供应商回调只能作用于其登记公司的付款人与账单；跨公司回调拒绝（归属只从
//       唯一映射解析，claimed 只比对永不决定；锁定付款人事实是唯一披露）；
//   AC3 回调期间成员资格中断，处理按 MT028 的 fail-closed 规则（在途停用 →
//       拒绝零作用；恢复后重投递成功——不烧状态）；
//   AC4 调用与回调全程留审计（不含敏感明文）（每次尝试恰一行；detail 闭形非值
//       事实；canary 扫描；DB CHECK 反证）。
// 既有交付（payer-accounts）只读消费：本套件任何用例都不修改它们。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import { sql } from "drizzle-orm";
import { createVendorBillingService } from "../../src/billing/vendor-billing";
import { billingVendorInteractions } from "../../src/db/schema/vendor-billing";
import {
  createVendorBillingFixture,
  probeVendorBillingEnvironment,
  type VendorBillingFixture,
} from "./support/vendor-billing";

const ENV = probeVendorBillingEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

let fixture: VendorBillingFixture;
let vendor: ReturnType<typeof createVendorBillingService>;

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createVendorBillingFixture();
  vendor = createVendorBillingService({
    database: fixture.db,
    vendor: fixture.script.client,
  });
});

afterAll(async () => {
  await fixture?.dispose();
});

/** 断言 promise 以计费 seam 哨兵码拒绝（`CODE: …` 形态，MT069/MT070 同款）。 */
async function expectSentinelRejection(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(
      `expected sentinel rejection ${code}, but the call succeeded`,
    );
  } catch (error) {
    expect((error as Error).message).toStartWith(`${code}: `);
  }
}

/** 最近一条交互行（owner 通道读回，取 produced_at 最新的一行）。 */
async function latestInteraction(): Promise<
  typeof billingVendorInteractions.$inferSelect
> {
  const rows = await fixture.db
    .select()
    .from(billingVendorInteractions)
    .orderBy(sql`created_at desc`)
    .limit(1);
  return rows[0];
}

// ---------------------------------------------------------------------------
// AC1：调用面——身份门先于公司范围；供应商只收登记公司的必要计费字段
// ---------------------------------------------------------------------------

describeDb(
  "MT074 AC1: vendor calls disclose only the registered company",
  () => {
    itDb(
      "hands the vendor exactly the mapped customer key and the company name, and audits the call",
      async () => {
        const a = fixture.caller("a-member");
        const result = await vendor.provisionCompanyCustomer({
          tenantId: fixture.ids.companyA,
          principalId: a.principalId,
        });
        expect(result.outcome).toBe("applied");
        if (result.outcome !== "applied") return;
        // 必要计费字段：恰二字段，值全部服务端派生（映射键 + 公司名）。
        expect(result.customer).toEqual({
          externalId: fixture.ids.customerA,
          name: "MT074 company-a",
        });
        expect(fixture.vendorCalls()).toEqual([
          {
            externalId: fixture.ids.customerA,
            name: "MT074 company-a",
          },
        ]);
        const row = await latestInteraction();
        expect(row.direction).toBe("call");
        expect(row.outcome).toBe("applied");
        expect(row.tenantId).toBe(fixture.ids.companyA);
        expect(row.principalId).toBe(a.principalId);
        expect(row.externalCustomerId).toBe(fixture.ids.customerA);
        expect(row.operation).toBe("customer.provision");
        expect(row.denialCode).toBeNull();
        // detail 只含非值事实：字段名 + 供应商状态码（无客户键/公司名值）。
        expect(Object.keys(row.detail as object).sort()).toEqual([
          "fields",
          "vendorStatus",
        ]);
      },
    );

    itDb(
      "refuses a non-member before entering the company's billing scope (vendor never called)",
      async () => {
        fixture.script.forgetCalls();
        const before = await fixture.interactionCount();
        const b = fixture.caller("b-member");
        await expectSentinelRejection(
          vendor.provisionCompanyCustomer({
            tenantId: fixture.ids.companyA,
            principalId: b.principalId,
          }),
          "VENDOR_CALLER_REQUIRED",
        );
        expect(fixture.vendorCalls()).toEqual([]);
        const row = await latestInteraction();
        expect(row.outcome).toBe("refused");
        expect(row.denialCode).toBe("VENDOR_CALLER_REQUIRED");
        // 身份门先于映射/账户事实：拒绝行没有客户键（还没读到映射）。
        expect(row.externalCustomerId).toBeNull();
        expect(row.tenantId).toBe(fixture.ids.companyA);
        expect(await fixture.interactionCount()).toBe(before + 1);
      },
    );

    itDb(
      "refuses a suspended member and admits them again after recovery (fail-closed identity)",
      async () => {
        fixture.script.forgetCalls();
        const a = fixture.caller("a-mate");
        await fixture.setMembershipStatus(
          fixture.ids.companyA,
          a.principalId,
          "suspended",
        );
        await expectSentinelRejection(
          vendor.provisionCompanyCustomer({
            tenantId: fixture.ids.companyA,
            principalId: a.principalId,
          }),
          "VENDOR_CALLER_REQUIRED",
        );
        expect(fixture.vendorCalls()).toEqual([]);
        await fixture.setMembershipStatus(
          fixture.ids.companyA,
          a.principalId,
          "active",
        );
        const result = await vendor.provisionCompanyCustomer({
          tenantId: fixture.ids.companyA,
          principalId: a.principalId,
        });
        expect(result.outcome).toBe("applied");
      },
    );

    itDb(
      "the identity gate precedes the mapping gate (unmapped company still answers the identity code)",
      async () => {
        fixture.script.forgetCalls();
        // 公司 C 无映射：若映射门先跑，会得到 CUSTOMER_MAPPING_REQUIRED；
        // 身份门先跑则得到 VENDOR_CALLER_REQUIRED（非成员 c 公司外的 b-member）。
        const b = fixture.caller("b-member");
        await expectSentinelRejection(
          vendor.provisionCompanyCustomer({
            tenantId: fixture.ids.companyC,
            principalId: b.principalId,
          }),
          "VENDOR_CALLER_REQUIRED",
        );
        // 同公司的成员则走到映射门。
        const c = fixture.caller("c-member");
        await expectSentinelRejection(
          vendor.provisionCompanyCustomer({
            tenantId: fixture.ids.companyC,
            principalId: c.principalId,
          }),
          "CUSTOMER_MAPPING_REQUIRED",
        );
        expect(fixture.vendorCalls()).toEqual([]);
      },
    );

    itDb(
      "refuses a company whose mapped customer has no active company account",
      async () => {
        fixture.script.forgetCalls();
        const d = fixture.caller("d-member");
        await expectSentinelRejection(
          vendor.provisionCompanyCustomer({
            tenantId: fixture.ids.companyD,
            principalId: d.principalId,
          }),
          "COMPANY_ACCOUNT_REQUIRED",
        );
        expect(fixture.vendorCalls()).toEqual([]);
      },
    );

    itDb(
      "a quarantined account on the mapped customer is not a payer",
      async () => {
        fixture.script.forgetCalls();
        const e = fixture.caller("e-member");
        await expectSentinelRejection(
          vendor.provisionCompanyCustomer({
            tenantId: fixture.ids.companyE,
            principalId: e.principalId,
          }),
          "COMPANY_ACCOUNT_REQUIRED",
        );
        expect(fixture.vendorCalls()).toEqual([]);
      },
    );

    itDb(
      "smuggled payer or payload fields are refused before any IO (the account is fixed server-side)",
      async () => {
        fixture.script.forgetCalls();
        const before = await fixture.interactionCount();
        const a = fixture.caller("a-member");
        for (const smuggled of [
          { externalCustomerId: fixture.ids.customerB },
          { customer: fixture.ids.customerB },
          { payer: fixture.ids.customerB },
          { name: "forged" },
          { companyName: "forged" },
        ]) {
          await expectSentinelRejection(
            vendor.provisionCompanyCustomer({
              tenantId: fixture.ids.companyA,
              principalId: a.principalId,
              ...smuggled,
            }),
            "PAYER_ACCOUNT_FIXED",
          );
        }
        expect(fixture.vendorCalls()).toEqual([]);
        expect(await fixture.interactionCount()).toBe(before);
      },
    );

    itDb(
      "a vendor 4xx is a structured refusal with the status, audited, not an exception",
      async () => {
        fixture.script.forgetCalls();
        fixture.script.replyWith(422);
        const a = fixture.caller("a-member");
        const result = await vendor.provisionCompanyCustomer({
          tenantId: fixture.ids.companyA,
          principalId: a.principalId,
        });
        expect(result).toEqual({
          outcome: "refused",
          code: "VENDOR_REJECTED",
          vendorStatus: 422,
        });
        fixture.script.replyWith(200);
        const row = await latestInteraction();
        expect(row.outcome).toBe("refused");
        expect(row.denialCode).toBe("VENDOR_REJECTED");
        expect((row.detail as { vendorStatus?: number }).vendorStatus).toBe(
          422,
        );
      },
    );

    itDb("a vendor transport failure is unreachable and audited", async () => {
      fixture.script.forgetCalls();
      fixture.script.failWith(new Error("socket exploded"));
      const a = fixture.caller("a-member");
      const result = await vendor.provisionCompanyCustomer({
        tenantId: fixture.ids.companyA,
        principalId: a.principalId,
      });
      expect(result).toEqual({
        outcome: "refused",
        code: "VENDOR_UNREACHABLE",
      });
      fixture.script.replyWith(200);
      const row = await latestInteraction();
      expect(row.outcome).toBe("refused");
      expect(row.denialCode).toBe("VENDOR_UNREACHABLE");
    });
  },
);

// ---------------------------------------------------------------------------
// AC2 + AC3：回调归属锁定——只作用于登记公司的付款人；跨公司拒绝；fail-closed
// ---------------------------------------------------------------------------

describeDb("MT074 AC2: callbacks lock onto the registered company only", () => {
  itDb(
    "an honest callback locks onto the registered company's payer and discloses exactly its facts",
    async () => {
      const a = fixture.caller("a-member");
      const locked = await vendor.applyVendorCallback({
        externalCustomerId: fixture.ids.customerA,
        operation: "customer.updated",
        actingPrincipalId: a.principalId,
      });
      expect(locked).toEqual({
        tenantId: fixture.ids.companyA,
        externalCustomerId: fixture.ids.customerA,
        account: {
          id: expect.any(String),
          accountType: "company",
          status: "active",
        },
      });
      const row = await latestInteraction();
      expect(row.direction).toBe("callback");
      expect(row.outcome).toBe("applied");
      expect(row.tenantId).toBe(fixture.ids.companyA);
      expect(row.operation).toBe("customer.updated");
    },
  );

  itDb(
    "a customer key that maps to no company is refused with zero company facts and an unattributed audit row",
    async () => {
      await expectSentinelRejection(
        vendor.applyVendorCallback({
          externalCustomerId: `mt074-never-mapped-${Date.now()}`,
          operation: "invoice.generated",
          actingPrincipalId: fixture.caller("a-member").principalId,
        }),
        "VENDOR_CALLBACK_UNMAPPED",
      );
      const row = await latestInteraction();
      expect(row.outcome).toBe("refused");
      expect(row.denialCode).toBe("VENDOR_CALLBACK_UNMAPPED");
      expect(row.tenantId).toBeNull();
    },
  );

  itDb("a personal customer key never unlocks a company callback", async () => {
    await expectSentinelRejection(
      vendor.applyVendorCallback({
        externalCustomerId: fixture.ids.personalCustomer,
        operation: "invoice.generated",
        actingPrincipalId: fixture.caller("a-member").principalId,
      }),
      "VENDOR_CALLBACK_UNMAPPED",
    );
    const row = await latestInteraction();
    expect(row.tenantId).toBeNull();
    expect(row.externalCustomerId).toBe(fixture.ids.personalCustomer);
  });

  itDb(
    "a callback claiming another company is refused as cross-company and the claim never enters the audit",
    async () => {
      const a = fixture.caller("a-member");
      await expectSentinelRejection(
        vendor.applyVendorCallback({
          externalCustomerId: fixture.ids.customerA,
          operation: "customer.updated",
          actingPrincipalId: a.principalId,
          claimedTenantId: fixture.ids.companyB,
        }),
        "VENDOR_CALLBACK_CROSS_COMPANY",
      );
      const row = await latestInteraction();
      expect(row.outcome).toBe("refused");
      expect(row.denialCode).toBe("VENDOR_CALLBACK_CROSS_COMPANY");
      // 归属是映射公司；claimed 值不进审计（MT028 deny 面纪律）。
      expect(row.tenantId).toBe(fixture.ids.companyA);
      expect(JSON.stringify(row.detail ?? {})).not.toContain(
        fixture.ids.companyB,
      );
    },
  );

  itDb(
    "a callback whose claim equals the mapping is admitted (claimed values compare, never decide)",
    async () => {
      const a = fixture.caller("a-member");
      const locked = await vendor.applyVendorCallback({
        externalCustomerId: fixture.ids.customerA,
        operation: "customer.updated",
        actingPrincipalId: a.principalId,
        claimedTenantId: fixture.ids.companyA,
      });
      expect(locked.tenantId).toBe(fixture.ids.companyA);
    },
  );

  itDb(
    "a mapped customer without an active company account refuses the callback",
    async () => {
      const d = fixture.caller("d-member");
      await expectSentinelRejection(
        vendor.applyVendorCallback({
          externalCustomerId: fixture.ids.customerD,
          operation: "invoice.generated",
          actingPrincipalId: d.principalId,
        }),
        "COMPANY_ACCOUNT_REQUIRED",
      );
    },
  );
});

describeDb(
  "MT074 AC3: membership interruption during a callback fails closed",
  () => {
    itDb(
      "a suspended acting member refuses the callback now and the same callback succeeds after recovery",
      async () => {
        const a = fixture.caller("a-member");
        await fixture.setMembershipStatus(
          fixture.ids.companyA,
          a.principalId,
          "suspended",
        );
        await expectSentinelRejection(
          vendor.applyVendorCallback({
            externalCustomerId: fixture.ids.customerA,
            operation: "invoice.settled",
            actingPrincipalId: a.principalId,
          }),
          "VENDOR_CALLBACK_MEMBER_INELIGIBLE",
        );
        const refused = await latestInteraction();
        expect(refused.denialCode).toBe("VENDOR_CALLBACK_MEMBER_INELIGIBLE");
        // fail-closed 不烧状态：恢复成员资格后同一回调重投递成功（MT028 D2 同款）。
        await fixture.setMembershipStatus(
          fixture.ids.companyA,
          a.principalId,
          "active",
        );
        const locked = await vendor.applyVendorCallback({
          externalCustomerId: fixture.ids.customerA,
          operation: "invoice.settled",
          actingPrincipalId: a.principalId,
        });
        expect(locked.tenantId).toBe(fixture.ids.companyA);
      },
    );

    itDb(
      "an acting member of a different company is ineligible for the mapped company's callback",
      async () => {
        const b = fixture.caller("b-member");
        await expectSentinelRejection(
          vendor.applyVendorCallback({
            externalCustomerId: fixture.ids.customerA,
            operation: "invoice.settled",
            actingPrincipalId: b.principalId,
          }),
          "VENDOR_CALLBACK_MEMBER_INELIGIBLE",
        );
      },
    );

    itDb(
      "a removed member's refused callback is still audited (the trail holds no membership FK)",
      async () => {
        const a = fixture.caller("a-mate");
        await fixture.deleteMembership(fixture.ids.companyA, a.principalId);
        await expectSentinelRejection(
          vendor.applyVendorCallback({
            externalCustomerId: fixture.ids.customerA,
            operation: "invoice.settled",
            actingPrincipalId: a.principalId,
          }),
          "VENDOR_CALLBACK_MEMBER_INELIGIBLE",
        );
        const row = await latestInteraction();
        expect(row.outcome).toBe("refused");
        expect(row.tenantId).toBe(fixture.ids.companyA);
        expect(row.principalId).toBe(a.principalId);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// AC4：审计全程留痕（不含敏感明文）+ 存储形状 CHECK + 结构隔离
// ---------------------------------------------------------------------------

describeDb(
  "MT074 AC4: every attempt leaves one audited, value-free trail",
  () => {
    itDb(
      "applied and refused attempts each leave exactly one row with value-free details",
      async () => {
        const before = await fixture.interactionCount();
        const a = fixture.caller("a-member");
        // 一次 applied 调用 + 一次 refused 调用 + 一次 applied 回调 = 恰三行。
        await vendor.provisionCompanyCustomer({
          tenantId: fixture.ids.companyA,
          principalId: a.principalId,
        });
        await expectSentinelRejection(
          vendor.provisionCompanyCustomer({
            tenantId: fixture.ids.companyB,
            principalId: a.principalId,
          }),
          "VENDOR_CALLER_REQUIRED",
        );
        await vendor.applyVendorCallback({
          externalCustomerId: fixture.ids.customerA,
          operation: "customer.updated",
          actingPrincipalId: a.principalId,
        });
        expect(await fixture.interactionCount()).toBe(before + 3);
        // 全表 detail 序列化的 canary 扫描：客户键/公司名值零命中。
        const rows = await fixture.db.select().from(billingVendorInteractions);
        for (const row of rows) {
          const serialized = JSON.stringify(row.detail ?? {});
          expect(serialized).not.toContain(fixture.ids.customerA);
          expect(serialized).not.toContain(fixture.ids.customerB);
          expect(serialized).not.toContain("MT074 company-a");
          expect(serialized).not.toContain("MT074 company-b");
          for (const forbidden of [
            "envelope",
            "plaintext",
            "secret",
            "password",
            "token",
            "apiKey",
          ]) {
            expect(Object.keys((row.detail as object) ?? {})).not.toContain(
              forbidden,
            );
          }
        }
      },
    );

    itDb(
      "listInteractions filters by company, customer key, and direction, newest first",
      async () => {
        const a = fixture.caller("a-member");
        const b = fixture.caller("b-member");
        await vendor.provisionCompanyCustomer({
          tenantId: fixture.ids.companyA,
          principalId: a.principalId,
        });
        await vendor.provisionCompanyCustomer({
          tenantId: fixture.ids.companyB,
          principalId: b.principalId,
        });
        await vendor.applyVendorCallback({
          externalCustomerId: fixture.ids.customerA,
          operation: "customer.updated",
          actingPrincipalId: a.principalId,
        });
        const byTenant = await vendor.listInteractions({
          tenantId: fixture.ids.companyA,
        });
        expect(byTenant.length).toBeGreaterThan(0);
        for (const row of byTenant) {
          expect(row.tenantId).toBe(fixture.ids.companyA);
        }
        for (let i = 1; i < byTenant.length; i += 1) {
          expect(byTenant[i - 1].createdAt >= byTenant[i].createdAt).toBe(true);
        }
        const byCustomer = await vendor.listInteractions({
          externalCustomerId: fixture.ids.customerB,
        });
        expect(byCustomer.length).toBeGreaterThan(0);
        for (const row of byCustomer) {
          expect(row.externalCustomerId).toBe(fixture.ids.customerB);
        }
        const callbacks = await vendor.listInteractions({
          direction: "callback",
        });
        expect(callbacks.length).toBeGreaterThan(0);
        for (const row of callbacks) {
          expect(row.direction).toBe("callback");
        }
      },
    );

    itDb(
      "the storage layer enforces the trail shape (outcome/denial pair, direction, detail keys)",
      async () => {
        const base = {
          id: `bvi-probe-${Date.now()}`,
          direction: "call",
          operation: "probe",
          outcome: "applied",
        };
        // applied + denial_code → 拒绝。
        expect(
          fixture.db
            .insert(billingVendorInteractions)
            .values({ ...base, denialCode: "SHOULD_NOT_EXIST" })
            .then(() => "inserted")
            .catch(() => "refused"),
        ).resolves.toBe("refused");
        // refused 无拒绝码 → 拒绝。
        expect(
          fixture.db
            .insert(billingVendorInteractions)
            .values({ ...base, outcome: "refused", denialCode: null })
            .then(() => "inserted")
            .catch(() => "refused"),
        ).resolves.toBe("refused");
        // direction 闭集外 → 拒绝。
        expect(
          fixture.db
            .insert(billingVendorInteractions)
            .values({ ...base, direction: "chat" })
            .then(() => "inserted")
            .catch(() => "refused"),
        ).resolves.toBe("refused");
        // detail 秘密载体键 → 拒绝。
        expect(
          fixture.db
            .insert(billingVendorInteractions)
            .values({ ...base, detail: { token: "leak" } })
            .then(() => "inserted")
            .catch(() => "refused"),
        ).resolves.toBe("refused");
      },
    );

    itDb(
      "restricted roles hold zero table privileges on the interaction trail (structural isolation)",
      async () => {
        for (const role of [
          "ob_ent_data",
          "ob_ent_operator",
          "ob_ent_directory",
          "ob_ent_identity_operator",
        ]) {
          for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
            const rows = await fixture.db.execute(
              sql`select has_table_privilege(${role}, 'billing_vendor_interactions', ${privilege}) as allowed`,
            );
            expect(rows[0]?.allowed).toBe(false);
          }
        }
      },
    );
  },
);
