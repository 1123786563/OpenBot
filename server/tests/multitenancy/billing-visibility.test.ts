// server/tests/multitenancy/billing-visibility.test.ts
// MT073（Issue #116）：账务可见性——付款人订单、公司财务授权与团队用量视图。
//
// 票面四条验收全部在真实 PostgreSQL 上钉死（专用测试库，缺 env 显式 skip、
// skipped 不计通过）：
//   AC1 普通公司成员看不到其他人的订单与支付资料（即使共用公司余额）——
//       真实 PaymentStore 创建人过滤回归（读取面零修改）；
//   AC2 具备公司财务管理授权的主体可查看公司账务与团队用量；无此授权则不可
//       （授权是显式事实；tenant_admin 不自动获得；拒绝同形不泄露存在性）；
//   AC3 团队用量汇总与公司总额一致（账户侧独立口径对账），且不含个人直连消费；
//   AC4 旧按创建人限制的订单读取没有被放宽为全公司成员可读（回归：财务授权
//       存在且生效后创建人过滤依旧）。
// 既有交付（payer-accounts/credits-writer/company-reservation/payment store）
// 全部只读消费：本套件任何用例都不修改它们。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createCompanyFinanceVisibilityService } from "../../src/billing/company-finance-visibility";
import { createCompanyReservationService } from "../../src/billing/company-reservation";
import {
  type BillingVisibilityFixture,
  createBillingVisibilityFixture,
  probeBillingVisibilityEnvironment,
} from "./support/billing-visibility";

const ENV = probeBillingVisibilityEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

let fixture: BillingVisibilityFixture;
let finance: ReturnType<typeof createCompanyFinanceVisibilityService>;
let companyCalls: ReturnType<typeof createCompanyReservationService>;

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createBillingVisibilityFixture();
  finance = createCompanyFinanceVisibilityService({
    database: fixture.db,
    writer: fixture.writer,
  });
  companyCalls = createCompanyReservationService({
    database: fixture.db,
    writer: fixture.writer,
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

beforeAll(async () => {
  if (!ENV.ok) return;
  // 订单事实底座：同公司两成员各一笔已取消订单（释放部署唯一 pending 槽），
  // 另有一笔 mate 的 pending 单（AC1 的「别人的在途订单不可见」）。
  await fixture.seedOrder(fixture.caller("a1-member").userId, "a1-cancelled");
  await fixture.seedOrder(fixture.caller("a1-mate").userId, "mate-cancelled");
  // AC4 的管理员订单：必须在 mate-live 占住部署唯一 pending 槽**之前**种好
  // （insertOrder 的 pending 部分唯一索引是部署级单槽；冲突时返回赢家行）。
  await fixture.seedOrder(fixture.caller("a-admin").userId, "admin-order");
  await fixture.seedLiveOrder(fixture.caller("a1-mate").userId, "mate-live");
});

describeDb(
  "MT073 AC1: sharing a company balance does not open colleagues' orders",
  () => {
    itDb(
      "a company member cannot read a colleague's order even with a shared balance",
      async () => {
        const reader = fixture.caller("a1-member");
        const mate = fixture.caller("a1-mate");
        // 先确认事实存在：mate 自己读得到自己的订单。
        const own = await fixture.store.listOrdersInWindow({
          from: null,
          to: null,
          limit: 10,
          offset: 0,
          scope: { actorId: mate.userId },
        });
        expect(own).toHaveLength(2); // 一笔 canceled + 一笔 live
        const mateOrder = own[0];
        // 他人读 → null（不可见语义；连同 checkoutPayload 在内的支付资料不可达）。
        const invisible = await fixture.store.readOrder(mateOrder.id, {
          actorId: reader.userId,
        });
        expect(invisible).toBeNull();
        // 自己读自己 → 看得到（正向业务回归同过）。
        const readable = await fixture.store.readOrder(mateOrder.id, {
          actorId: mate.userId,
        });
        expect(readable?.id).toBe(mateOrder.id);
        expect(readable?.checkoutPayload).toBe(`mt073-qr-mate-live`);
      },
    );

    itDb(
      "the bill list and pager count carry only the caller's own orders",
      async () => {
        const reader = fixture.caller("a1-member");
        const mate = fixture.caller("a1-mate");
        const readerList = await fixture.store.listOrdersInWindow({
          from: null,
          to: null,
          limit: 10,
          offset: 0,
          scope: { actorId: reader.userId },
        });
        expect(readerList).toHaveLength(1);
        expect(readerList[0]?.createdBy).toBe(reader.userId);
        expect(
          await fixture.store.countOrdersInWindow({
            from: null,
            to: null,
            scope: { actorId: reader.userId },
          }),
        ).toBe(1);
        expect(
          await fixture.store.countOrdersInWindow({
            from: null,
            to: null,
            scope: { actorId: mate.userId },
          }),
        ).toBe(2);
        // 两个成员的列表不相交。
        const mateList = await fixture.store.listOrdersInWindow({
          from: null,
          to: null,
          limit: 10,
          offset: 0,
          scope: { actorId: mate.userId },
        });
        expect(mateList.every((row) => row.createdBy === mate.userId)).toBe(
          true,
        );
      },
    );

    itDb(
      "a colleague's live pending purchase is not the caller's latest live order",
      async () => {
        const reader = fixture.caller("a1-member");
        const mate = fixture.caller("a1-mate");
        const mateLive = await fixture.store.readLatestLiveOrder({
          actorId: mate.userId,
        });
        expect(mateLive?.status).toBe("pending");
        const readerLive = await fixture.store.readLatestLiveOrder({
          actorId: reader.userId,
        });
        expect(readerLive).toBeNull();
      },
    );
  },
);

describeDb(
  "MT073 AC2: company finance read is an explicit authorization",
  () => {
    itDb(
      "an explicit grant lets a company member read the company books and team usage",
      async () => {
        const reader = fixture.caller("a1-member");
        const admin = fixture.caller("a-admin");
        await finance.grantCompanyFinanceReader({
          tenantId: fixture.ids.companyA,
          principalId: reader.principalId,
          grantedBy: admin.principalId,
        });
        const books = await finance.companyBooks({
          tenantId: fixture.ids.companyA,
          principalId: reader.principalId,
        });
        expect(books.tenantId).toBe(fixture.ids.companyA);
        expect(books.customer?.externalCustomerId).toBe(fixture.ids.customerA);
        expect(books.account?.status).toBe("active");
        expect(books.balanceUnits).toBe(await fixture.balanceOf("company-a"));
        expect(books.authorization.principalId).toBe(reader.principalId);
        expect(books.authorization.grantedBy).toBe(admin.principalId);
      },
    );

    itDb(
      "a member without the grant, an admin without the grant, a non-member, and an unknown company are refused identically",
      async () => {
        const shapes: ReadonlyArray<readonly [string, Promise<unknown>]> = [
          [
            "member-without-grant",
            finance.companyBooks({
              tenantId: fixture.ids.companyA,
              principalId: fixture.caller("a2-member").principalId,
            }),
          ],
          [
            "tenant-admin-without-grant",
            finance.companyBooks({
              tenantId: fixture.ids.companyA,
              principalId: fixture.caller("a-admin").principalId,
            }),
          ],
          [
            "non-member",
            finance.companyBooks({
              tenantId: fixture.ids.companyA,
              principalId: fixture.caller("b-member").principalId,
            }),
          ],
          [
            "unknown-company",
            finance.companyBooks({
              tenantId: "mt073-no-such-company",
              principalId: fixture.caller("a1-member").principalId,
            }),
          ],
        ];
        const messages: string[] = [];
        // 四个形状同时起跑、同步挂接拒绝处理器（Promise.allSettled），再逐形状
        // 检查拒绝消息——顺序 await 急切创建的 promise 会让 bun 的未处理拒绝
        // 探测在 catch 挂接前触发，把本测试误标为失败（已实测）。
        const settled = await Promise.allSettled(
          shapes.map(([, promise]) => promise),
        );
        settled.forEach((outcome, index) => {
          const shape = shapes[index][0];
          if (outcome.status === "rejected") {
            messages.push((outcome.reason as Error).message);
            return;
          }
          throw new Error(
            `expected ${shape} to be refused, but the call succeeded`,
          );
        });
        // 同一哨兵、同一句子：拒绝形状不区分「无资格/非成员/公司不存在」，
        // 不泄露公司是否存在、是否有计费映射（spec A2 不可见语义）。
        expect(new Set(messages).size).toBe(1);
        expect(messages[0]).toStartWith("COMPANY_FINANCE_REQUIRED: ");
      },
    );

    itDb(
      "the grant is a company fact: the same principal's other company does not inherit it",
      async () => {
        const dual = fixture.caller("both-companies");
        const admin = fixture.caller("a-admin");
        await finance.grantCompanyFinanceReader({
          tenantId: fixture.ids.companyA,
          principalId: dual.principalId,
          grantedBy: admin.principalId,
        });
        // 在 A 有授权 → A 可读。
        const books = await finance.companyBooks({
          tenantId: fixture.ids.companyA,
          principalId: dual.principalId,
        });
        expect(books.customer?.externalCustomerId).toBe(fixture.ids.customerA);
        // 同一主体在 B 无授权 → 拒（授权不随人跨公司）。
        await expectSentinelRejection(
          finance.companyBooks({
            tenantId: fixture.ids.companyB,
            principalId: dual.principalId,
          }),
          "COMPANY_FINANCE_REQUIRED",
        );
      },
    );

    itDb(
      "revocation ends the authorization immediately and is idempotent",
      async () => {
        const reader = fixture.caller("a1-member");
        const tenantId = fixture.ids.companyA;
        expect(
          await finance.revokeCompanyFinanceReader({
            tenantId,
            principalId: reader.principalId,
          }),
        ).toEqual({ revoked: true });
        await expectSentinelRejection(
          finance.companyBooks({ tenantId, principalId: reader.principalId }),
          "COMPANY_FINANCE_REQUIRED",
        );
        expect(
          await finance.revokeCompanyFinanceReader({
            tenantId,
            principalId: reader.principalId,
          }),
        ).toEqual({ revoked: false });
        // 重新授权 = 新一行（管理动作可重放，trail 记录新的 grantedBy）。
        await finance.grantCompanyFinanceReader({
          tenantId,
          principalId: reader.principalId,
          grantedBy: fixture.caller("a2-member").principalId,
        });
        const readers = await finance.financeReadersOf(tenantId);
        const restored = readers.find(
          (row) => row.principalId === reader.principalId,
        );
        expect(restored?.grantedBy).toBe(
          fixture.caller("a2-member").principalId,
        );
        const books = await finance.companyBooks({
          tenantId,
          principalId: reader.principalId,
        });
        expect(books.authorization.grantedBy).toBe(
          fixture.caller("a2-member").principalId,
        );
      },
    );

    itDb(
      "suspending the grantee's membership closes the books even with the grant row intact",
      async () => {
        const reader = fixture.caller("a1-member");
        const tenantId = fixture.ids.companyA;
        // 授权行仍在（上例末尾重新授权过）；停用成员资格 → 立即失效（A5 邻接）。
        await fixture.setMembershipStatus(
          tenantId,
          reader.principalId,
          "suspended",
        );
        await expectSentinelRejection(
          finance.companyBooks({ tenantId, principalId: reader.principalId }),
          "COMPANY_FINANCE_REQUIRED",
        );
        await fixture.setMembershipStatus(
          tenantId,
          reader.principalId,
          "active",
        );
        const books = await finance.companyBooks({
          tenantId,
          principalId: reader.principalId,
        });
        expect(books.tenantId).toBe(tenantId);
      },
    );

    itDb(
      "a duplicate active grant is an explicit refusal, not a silent refresh",
      async () => {
        const reader = fixture.caller("a1-member");
        const admin = fixture.caller("a-admin");
        const tenantId = fixture.ids.companyA;
        const first = await finance.financeReadersOf(tenantId);
        const before = first.find(
          (row) => row.principalId === reader.principalId,
        );
        expect(before).toBeDefined();
        await expectSentinelRejection(
          finance.grantCompanyFinanceReader({
            tenantId,
            principalId: reader.principalId,
            grantedBy: admin.principalId,
          }),
          "FINANCE_GRANT_EXISTS",
        );
        const after = await finance.financeReadersOf(tenantId);
        const kept = after.find(
          (row) => row.principalId === reader.principalId,
        );
        // 原行原样：grantedBy/createdAt 未被第二次动作改写。
        expect(kept?.grantedBy).toBe(before?.grantedBy);
        expect(kept?.createdAt.getTime()).toBe(before?.createdAt.getTime());
        expect(after).toHaveLength(first.length);
      },
    );

    itDb(
      "a grant names two members of the same company: outsiders and suspended members are refused",
      async () => {
        const tenantId = fixture.ids.companyA;
        const outsider = fixture.caller("b-member");
        // grantee 不是本公司成员 → 拒（服务层预检；复合 FK 是 DB 兜底）。
        await expectSentinelRejection(
          finance.grantCompanyFinanceReader({
            tenantId,
            principalId: outsider.principalId,
            grantedBy: fixture.caller("a-admin").principalId,
          }),
          "FINANCE_GRANT_INVALID",
        );
        // grantedBy 不是本公司成员 → 拒（授权来自本公司成员）。
        await expectSentinelRejection(
          finance.grantCompanyFinanceReader({
            tenantId,
            principalId: fixture.caller("a2-member").principalId,
            grantedBy: outsider.principalId,
          }),
          "FINANCE_GRANT_INVALID",
        );
        // grantee 被停用 → 拒（显式授权只发给活跃成员）。
        const suspended = fixture.caller("a2-member");
        await fixture.setMembershipStatus(
          tenantId,
          suspended.principalId,
          "suspended",
        );
        await expectSentinelRejection(
          finance.grantCompanyFinanceReader({
            tenantId,
            principalId: suspended.principalId,
            grantedBy: fixture.caller("a-admin").principalId,
          }),
          "FINANCE_GRANT_INVALID",
        );
        await fixture.setMembershipStatus(
          tenantId,
          suspended.principalId,
          "active",
        );
      },
    );

    itDb("keeps restricted roles outside the finance grant table", async () => {
      for (const role of [
        "ob_ent_directory",
        "ob_ent_data",
        "ob_ent_operator",
        "ob_ent_identity_operator",
        "public",
      ]) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          const rows = await fixture.db.execute(
            sql`select has_table_privilege(${role}, 'billing_company_finance_grants', ${privilege}) as allowed`,
          );
          expect(rows[0]?.allowed).toBe(false);
        }
      }
    });
  },
);

describeDb(
  "MT073 AC3: team usage reconciles with the company total and excludes personal direct spend",
  () => {
    itDb(
      "team usage sums to the independently computed company total",
      async () => {
        const tenantId = fixture.ids.companyA;
        await fixture.seedGrant("company-a", 100_000, "ac3-balance");
        const a1 = fixture.caller("a1-member");
        const a2 = fixture.caller("a2-member");
        const first = await companyCalls.reserveForCompanyCall({
          tenantId,
          workspaceId: fixture.ids.teamA1,
          principalId: a1.principalId,
          botRef: "mt073-bot-a1",
          callKey: "mt073-ac3-call-1",
          idempotencyKey: "mt073-ac3-idem-1",
          maximumCents: 250,
          expiresAt: new Date(Date.now() + 3600_000),
        });
        expect(first.reserved).toBe(true);
        const second = await companyCalls.reserveForCompanyCall({
          tenantId,
          workspaceId: fixture.ids.teamA2,
          principalId: a2.principalId,
          botRef: "mt073-bot-a2",
          callKey: "mt073-ac3-call-2",
          idempotencyKey: "mt073-ac3-idem-2",
          maximumCents: 300,
          expiresAt: new Date(Date.now() + 3600_000),
        });
        expect(second.reserved).toBe(true);
        // 第一笔按实际费用 150 结算（释放 100）。
        await fixture.writer.settleReservation({
          reservationId: (first as { reservationId: string }).reservationId,
          actual: { numerator: 150n, denominator: 1n },
          title: "MT073 usage reconciliation settle",
        });

        const books = await finance.companyBooks({
          tenantId,
          principalId: a1.principalId,
        });
        // 归属侧投影：a1 队已结算（charged 150，held 0），a2 队在途（held 300）。
        const teamA1 = books.usage.byTeam.find(
          (row) => row.workspaceId === fixture.ids.teamA1,
        );
        const teamA2 = books.usage.byTeam.find(
          (row) => row.workspaceId === fixture.ids.teamA2,
        );
        expect(teamA1).toEqual({
          workspaceId: fixture.ids.teamA1,
          heldUnits: 0,
          chargedUnits: 150,
        });
        expect(teamA2).toEqual({
          workspaceId: fixture.ids.teamA2,
          heldUnits: 300,
          chargedUnits: 0,
        });
        // 公司总额是账户侧独立口径（按公司映射客户的预扣投影），不是归属侧求和：
        // 两者一致 = 归属覆盖不变量（公司账户每笔持有都有归属行）。
        expect(books.usage.companyTotal).toEqual({
          heldUnits: 300,
          chargedUnits: 150,
        });
        const teamSum = books.usage.byTeam.reduce(
          (acc, row) => ({
            heldUnits: acc.heldUnits + row.heldUnits,
            chargedUnits: acc.chargedUnits + row.chargedUnits,
          }),
          { heldUnits: 0, chargedUnits: 0 },
        );
        expect(teamSum).toEqual(books.usage.companyTotal);
        const userSum = books.usage.byUser.reduce(
          (acc, row) => ({
            heldUnits: acc.heldUnits + row.heldUnits,
            chargedUnits: acc.chargedUnits + row.chargedUnits,
          }),
          { heldUnits: 0, chargedUnits: 0 },
        );
        expect(userSum).toEqual(books.usage.companyTotal);
      },
    );

    itDb(
      "personal Bifrost direct spend never enters the company books",
      async () => {
        const tenantId = fixture.ids.companyA;
        const a1 = fixture.caller("a1-member");
        const before = await finance.companyBooks({
          tenantId,
          principalId: a1.principalId,
        });
        // 个人直连：个人账户上的 grant + 预扣（ADR 0002/0003 路径，无公司归属行）。
        await fixture.seedGrant("personal", 50_000, "ac3-personal");
        const personal = await fixture.writer.reserveCredits({
          externalCustomerId: fixture.ids.personalCustomer,
          idempotencyKey: "mt073-ac3-personal-call",
          maximumCents: 999,
          expiresAt: new Date(Date.now() + 3600_000),
        });
        expect(personal.reserved).toBe(true);

        const after = await finance.companyBooks({
          tenantId,
          principalId: a1.principalId,
        });
        // 公司账簿每一项分毫不动；账簿的客户仍是公司映射（不是个人客户）。
        expect(after.usage.companyTotal).toEqual(before.usage.companyTotal);
        expect(after.usage.byTeam).toEqual(before.usage.byTeam);
        expect(after.usage.byUser).toEqual(before.usage.byUser);
        expect(after.balanceUnits).toBe(before.balanceUnits);
        expect(after.customer?.externalCustomerId).toBe(fixture.ids.customerA);
        // 个人余额确实动过（预扣真实发生，只是不进公司账簿）。
        const personalBooks = await fixture.writer.availableBalance(
          fixture.ids.personalCustomer,
        );
        expect(personalBooks).toBe(50_000 - 999);
      },
    );

    itDb(
      "an authorized reader of a company without a billing mapping sees empty books",
      async () => {
        const cReader = fixture.caller("c-member");
        const tenantId = fixture.ids.companyC;
        await finance.grantCompanyFinanceReader({
          tenantId,
          principalId: cReader.principalId,
          grantedBy: cReader.principalId,
        });
        const books = await finance.companyBooks({
          tenantId,
          principalId: cReader.principalId,
        });
        expect(books.customer).toBeNull();
        expect(books.account).toBeNull();
        expect(books.balanceUnits).toBe(0);
        expect(books.usage.companyTotal).toEqual({
          heldUnits: 0,
          chargedUnits: 0,
        });
        expect(books.usage.byTeam).toEqual([]);
        expect(books.usage.byUser).toEqual([]);
      },
    );
  },
);

describeDb(
  "MT073 AC4: the creator-scoped order read is not widened (regression)",
  () => {
    itDb(
      "finance authorization does not widen the order read: the grant holder still sees only their own orders",
      async () => {
        const reader = fixture.caller("a1-member");
        const mate = fixture.caller("a1-mate");
        const tenantId = fixture.ids.companyA;
        // 确认 reader 此刻持有效财务授权（AC2 组已建立；此处显式核对）。
        const readers = await finance.financeReadersOf(tenantId);
        expect(
          readers.some((row) => row.principalId === reader.principalId),
        ).toBe(true);
        // mate 的订单（含在途单）对持授权的 reader 依旧不可见。
        const mateOrders = await fixture.store.listOrdersInWindow({
          from: null,
          to: null,
          limit: 10,
          offset: 0,
          scope: { actorId: mate.userId },
        });
        expect(mateOrders.length).toBe(2);
        for (const order of mateOrders) {
          expect(
            await fixture.store.readOrder(order.id, { actorId: reader.userId }),
          ).toBeNull();
        }
        const readerList = await fixture.store.listOrdersInWindow({
          from: null,
          to: null,
          limit: 10,
          offset: 0,
          scope: { actorId: reader.userId },
        });
        expect(readerList).toHaveLength(1);
        expect(readerList[0]?.createdBy).toBe(reader.userId);
        expect(
          await fixture.store.countOrdersInWindow({
            from: null,
            to: null,
            scope: { actorId: reader.userId },
          }),
        ).toBe(1);
        expect(
          await fixture.store.readLatestLiveOrder({ actorId: reader.userId }),
        ).toBeNull();
      },
    );

    itDb(
      "the store surface has no company-wide read: even the tenant admin's scope filters by creator",
      async () => {
        const admin = fixture.caller("a-admin");
        const mate = fixture.caller("a1-mate");
        // 公司管理员（tenant_admin）同样按创建人过滤：不存在「全公司可读」的
        // 订单读取面（C3：旧 created_by 限制不被共用余额或管理角色替换）。
        // adminSeeded 由 beforeAll 预种（pending 单槽约束，见其注释）。
        const adminList = await fixture.store.listOrdersInWindow({
          from: null,
          to: null,
          limit: 10,
          offset: 0,
          scope: { actorId: admin.userId },
        });
        expect(adminList).toHaveLength(1);
        expect(adminList[0]?.createdBy).toBe(admin.userId);
        const adminOwn = adminList[0];
        const mateOrders = await fixture.store.listOrdersInWindow({
          from: null,
          to: null,
          limit: 10,
          offset: 0,
          scope: { actorId: mate.userId },
        });
        expect(mateOrders.length).toBe(2);
        for (const order of mateOrders) {
          expect(
            await fixture.store.readOrder(order.id, { actorId: admin.userId }),
          ).toBeNull();
        }
        expect(adminOwn.status).toBe("canceled");
      },
    );
  },
);
