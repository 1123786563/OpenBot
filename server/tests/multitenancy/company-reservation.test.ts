// server/tests/multitenancy/company-reservation.test.ts
// MT070（Issue #113）：公司调用归属与同一余额的原子预扣。
//
// 票面四条验收全部在真实 PostgreSQL 上钉死（专用测试库，缺 env 显式 skip、
// skipped 不计通过）：
//   AC1 并发预扣证明总额不超余额——真实并行连接对同一公司余额同时预扣；
//   AC2 公司 A 不能消费公司 B 余额（伪造付款方/伪造公司/伪造团队全拒、零写入）；
//   AC3 每次预扣记录公司/团队/使用人/Bot 授权/稳定调用标识；
//   AC4 预扣上界与幂等键语义不变（重复请求不重复预扣）。
// 既有 writer（credits-writer）是只读消费的权威路径：本套件任何用例都不修改它；
// 结算回归走 writer 原路径，证明公司预扣没有分叉扣费实现。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { eq, sql } from "drizzle-orm";
import { createCompanyReservationService } from "../../src/billing/company-reservation";
import { billingCustomers } from "../../src/db/schema/billing";
import { enterpriseTenants } from "../../src/db/schema/enterprise-tenancy";
import {
  type CompanyReservationFixture,
  createCompanyReservationFixture,
  probeCompanyReservationEnvironment,
} from "./support/company-reservation";

const ENV = probeCompanyReservationEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

let fixture: CompanyReservationFixture;
let service: ReturnType<typeof createCompanyReservationService>;

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createCompanyReservationFixture();
  service = createCompanyReservationService({
    database: fixture.db,
    writer: fixture.writer,
  });
});

afterAll(async () => {
  await fixture?.dispose();
});

/** 一次公司工作台被计费调用的输入（付款账户由服务端固定——输入里没有它）。 */
interface CompanyCallInput {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly botRef: string;
  readonly callKey: string;
  readonly idempotencyKey: string;
  readonly maximumCents: number;
  readonly expiresAt: Date;
}

/** 断言 promise 以计费 seam 哨兵码拒绝（`CODE: …` 形态，MT069 同款）。 */
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

describeDb(
  "MT070 AC3: every reservation records the company call attribution",
  () => {
    itDb(
      "records company, team, user, bot authorization, and the stable call key for every reservation",
      async () => {
        const { ids, caller } = fixture;
        await fixture.seedGrant("company-a", 1000, "ac3");
        const who = caller("a1-member");
        const input: CompanyCallInput = {
          tenantId: ids.companyA,
          workspaceId: ids.teamA1,
          principalId: who.principalId,
          botRef: "bot:mt070-alpha/virtual-key-77",
          callKey: "call:mt070-ac3-run-1",
          idempotencyKey: "mt070-ac3-idem-1",
          maximumCents: 300,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        };
        const before = await fixture.balanceOf("company-a");
        const result = await service.reserveForCompanyCall(input);
        if (!result.reserved)
          throw new Error("expected the hold to be admitted");
        expect(result.reservationId).toStartWith("cr-");

        const attribution = await service.attributionOf(result.reservationId);
        expect(attribution).not.toBeNull();
        expect(attribution?.reservationId).toBe(result.reservationId);
        expect(attribution?.tenantId).toBe(ids.companyA);
        expect(attribution?.workspaceId).toBe(ids.teamA1);
        expect(attribution?.principalId).toBe(who.principalId);
        expect(attribution?.botRef).toBe("bot:mt070-alpha/virtual-key-77");
        expect(attribution?.callKey).toBe("call:mt070-ac3-run-1");

        // 持有限额在 writer 的容量事实里可见（同一余额、同一口径，delta 断言）。
        expect(await fixture.balanceOf("company-a")).toBe(before - 300);
      },
    );

    itDb("summarizes held and charged usage by team and by user", async () => {
      const { ids, caller } = fixture;
      // 汇总专用公司 S：全新余额，不受其它用例的持有限额影响。
      await fixture.seedGrant("company-s", 1000, "a9-summary");
      const s1 = caller("s1-member");
      const s2 = caller("s2-member");
      const first = await service.reserveForCompanyCall({
        tenantId: ids.companyS,
        workspaceId: ids.teamS1,
        principalId: s1.principalId,
        botRef: "bot:mt070-sum-1",
        callKey: "call:mt070-sum-1",
        idempotencyKey: "mt070-sum-1-idem",
        maximumCents: 400,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });
      const second = await service.reserveForCompanyCall({
        tenantId: ids.companyS,
        workspaceId: ids.teamS2,
        principalId: s2.principalId,
        botRef: "bot:mt070-sum-2",
        callKey: "call:mt070-sum-2",
        idempotencyKey: "mt070-sum-2-idem",
        maximumCents: 250,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });
      if (!first.reserved || !second.reserved) throw new Error("unreachable");
      // 第一笔按实际费用结算（writer 原路径，12.34 credits = 1234 缩放单位的 1/100
      // 形状这里用整数 150），第二笔仍活动。
      const settled = await fixture.writer.settleReservation({
        reservationId: first.reservationId,
        actual: { numerator: 150n, denominator: 1n },
        title: "MT070 usage summary settle",
      });
      void settled;

      const summary = await service.usageSummary(ids.companyS);
      const byS1 = summary.byTeam.find((row) => row.workspaceId === ids.teamS1);
      const byS2 = summary.byTeam.find((row) => row.workspaceId === ids.teamS2);
      expect(byS1?.heldUnits).toBe(0); // 已结算：预扣转 charged
      expect(byS1?.chargedUnits).toBe(150);
      expect(byS2?.heldUnits).toBe(250);
      expect(byS2?.chargedUnits).toBe(0);
      const userS1 = summary.byUser.find(
        (row) => row.principalId === s1.principalId,
      );
      expect(userS1?.chargedUnits).toBe(150);
      const userS2 = summary.byUser.find(
        (row) => row.principalId === s2.principalId,
      );
      expect(userS2?.heldUnits).toBe(250);

      // 另一家公司的汇总不含 S 家的任何团队/主体（汇总按公司过滤，不跨公司泄漏）。
      const summaryA = await service.usageSummary(ids.companyA);
      expect(
        summaryA.byTeam.every(
          (row) =>
            row.workspaceId !== ids.teamS1 && row.workspaceId !== ids.teamS2,
        ),
      ).toBe(true);
      expect(
        summaryA.byUser.every((row) => row.principalId !== s1.principalId),
      ).toBe(true);
    });
  },
);

describeDb(
  "MT070 AC1: concurrent holds never overdraw the shared balance",
  () => {
    itDb(
      "concurrent teams never overdraw the shared company balance",
      async () => {
        const { ids, caller } = fixture;
        // 公司 C（团队 c1/c2）与公司 D（团队 d1）：全新余额，数字精确。
        await fixture.seedGrant("company-c", 1000, "ac1-c");
        await fixture.seedGrant("company-d", 1000, "ac1-d");
        const c1 = caller("c1-member");
        const c2 = caller("c2-member");
        const d1 = caller("d-member");

        // 公司 C：两队 10 个并发预扣 ×250（余额只够 4 笔）；公司 D 同时 4 笔 ×250。
        const attemptsC = Array.from({ length: 10 }, (_, i) => {
          const who = i % 2 === 0 ? c1 : c2;
          const team = i % 2 === 0 ? ids.teamC1 : ids.teamC2;
          return service
            .reserveForCompanyCall({
              tenantId: ids.companyC,
              workspaceId: team,
              principalId: who.principalId,
              botRef: `bot:mt070-concurrent-${i}`,
              callKey: `call:mt070-ac1-c-${i}`,
              idempotencyKey: `mt070-ac1-c-idem-${i}`,
              maximumCents: 250,
              expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            })
            .then((r) => ({ i, r, team, principalId: who.principalId }));
        });
        const attemptsD = Array.from({ length: 4 }, (_, i) =>
          service
            .reserveForCompanyCall({
              tenantId: ids.companyD,
              workspaceId: ids.teamD1,
              principalId: d1.principalId,
              botRef: `bot:mt070-concurrent-d-${i}`,
              callKey: `call:mt070-ac1-d-${i}`,
              idempotencyKey: `mt070-ac1-d-idem-${i}`,
              maximumCents: 250,
              expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            })
            .then((r) => ({ i, r })),
        );

        const [resultsC, resultsD] = await Promise.all([
          Promise.all(attemptsC),
          Promise.all(attemptsD),
        ]);

        // 公司 C：恰 4 笔成功、Σheld = 1000 = 余额（不超一笔）；6 笔拒绝且报 0。
        const admittedC = resultsC.filter((x) => x.r.reserved);
        const refusedC = resultsC.filter((x) => !x.r.reserved);
        expect(admittedC.length).toBe(4);
        expect(refusedC.length).toBe(6);
        const heldC = admittedC.reduce(
          (sum, x) => (x.r.reserved ? sum + 250 : sum),
          0,
        );
        expect(heldC).toBe(1000);
        for (const x of refusedC) {
          if (!x.r.reserved) expect(x.r.availableCents).toBe(0);
        }
        // 每笔成功预扣都有归属行（并发下归属不缺号、团队逐笔对得上）。
        for (const x of admittedC) {
          if (!x.r.reserved) throw new Error("unreachable");
          const attribution = await service.attributionOf(x.r.reservationId);
          expect(attribution?.tenantId).toBe(ids.companyC);
          expect(attribution?.workspaceId).toBe(x.team);
          expect(attribution?.principalId).toBe(x.principalId);
        }

        // 公司 D：同一瞬间、另一个余额——4 笔全部成功，C 的饱和不殃及 D。
        expect(resultsD.every((x) => x.r.reserved)).toBe(true);

        // 终态口径：汇总（A9 邻接）读出的 Σheld 与事实一致——C 家 1000、D 家 1000。
        const summaryC = await service.usageSummary(ids.companyC);
        expect(summaryC.byTeam.reduce((s, row) => s + row.heldUnits, 0)).toBe(
          1000,
        );
        expect(
          summaryC.byTeam.every(
            (row) =>
              row.workspaceId === ids.teamC1 || row.workspaceId === ids.teamC2,
          ),
        ).toBe(true);
        const summaryD = await service.usageSummary(ids.companyD);
        expect(summaryD.byTeam.reduce((s, row) => s + row.heldUnits, 0)).toBe(
          1000,
        );
      },
    );
  },
);

describeDb("MT070 AC2: company A can never draw company B's balance", () => {
  itDb("rejects a payer named by the caller", async () => {
    const { ids } = fixture;
    await fixture.seedGrant("company-a", 500, "forge-payer-a");
    await fixture.seedGrant("company-b", 500, "forge-payer-b");
    const beforeA = await fixture.balanceOf("company-a");
    const beforeB = await fixture.balanceOf("company-b");
    const forged = {
      tenantId: ids.companyA,
      workspaceId: ids.teamA1,
      principalId: fixture.caller("a1-member").principalId,
      botRef: "bot:mt070-forge-payer",
      callKey: "call:mt070-forge-payer",
      idempotencyKey: "mt070-forge-payer-idem",
      maximumCents: 100,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      // 客户端塞进来的付款账户（B 家的客户键）：类型上不存在，运行时必须拒绝。
      externalCustomerId: ids.customerB,
    } as CompanyCallInput;
    await expectSentinelRejection(
      service.reserveForCompanyCall(forged),
      "PAYER_ACCOUNT_FIXED",
    );
    // 零写入：A、B 余额都分毫未动。
    expect(await fixture.balanceOf("company-a")).toBe(beforeA);
    expect(await fixture.balanceOf("company-b")).toBe(beforeB);
  });

  itDb(
    "a principal who is not a member of the claimed company cannot draw its balance",
    async () => {
      const { ids, caller } = fixture;
      await fixture.seedGrant("company-b", 400, "forge-company-b");
      const beforeB = await fixture.balanceOf("company-b");
      // 仅属 A 的成员声称公司 B + 团队丙（伪造公司标识）。
      const forger = caller("a1-member");
      await expectSentinelRejection(
        service.reserveForCompanyCall({
          tenantId: ids.companyB,
          workspaceId: ids.teamB1,
          principalId: forger.principalId,
          botRef: "bot:mt070-forge-company",
          callKey: "call:mt070-forge-company",
          idempotencyKey: "mt070-forge-company-idem",
          maximumCents: 400,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        }),
        "CALL_MEMBER_REQUIRED",
      );
      // B 的余额完整；B 的合法成员仍能足额预扣。
      expect(await fixture.balanceOf("company-b")).toBe(beforeB);
      const legit = await service.reserveForCompanyCall({
        tenantId: ids.companyB,
        workspaceId: ids.teamB1,
        principalId: caller("b1-member").principalId,
        botRef: "bot:mt070-legit-b",
        callKey: "call:mt070-legit-b",
        idempotencyKey: "mt070-legit-b-idem",
        maximumCents: 400,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });
      expect(legit.reserved).toBe(true);
    },
  );

  itDb(
    "a team from another company is refused under a valid membership",
    async () => {
      const { ids, caller } = fixture;
      await fixture.seedGrant("company-a", 300, "forge-team-a");
      const before = await fixture.balanceOf("company-a");
      // A 家双成员（甲乙都在 A）声称 workspace=团队丙（B 家团队）。
      const dual = caller("a1a2-member");
      await expectSentinelRejection(
        service.reserveForCompanyCall({
          tenantId: ids.companyA,
          workspaceId: ids.teamB1,
          principalId: dual.principalId,
          botRef: "bot:mt070-forge-team",
          callKey: "call:mt070-forge-team",
          idempotencyKey: "mt070-forge-team-idem",
          maximumCents: 300,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        }),
        "CALL_WORKSPACE_MISMATCH",
      );
      expect(await fixture.balanceOf("company-a")).toBe(before);

      // 反向同样拒：B 家成员声称 A 家团队甲。
      const b1 = caller("b1-member");
      await expectSentinelRejection(
        service.reserveForCompanyCall({
          tenantId: ids.companyA,
          workspaceId: ids.teamA1,
          principalId: b1.principalId,
          botRef: "bot:mt070-forge-team-rev",
          callKey: "call:mt070-forge-team-rev",
          idempotencyKey: "mt070-forge-team-rev-idem",
          maximumCents: 100,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        }),
        "CALL_MEMBER_REQUIRED",
      );
      expect(await fixture.balanceOf("company-a")).toBe(before);
    },
  );
});

describeDb(
  "MT070 AC4: ceiling and idempotency semantics stay unchanged",
  () => {
    itDb("refuses a hold above the ceiling and writes nothing", async () => {
      await fixture.seedGrant("company-a", 200, "ac4-ceiling");
      const before = await fixture.balanceOf("company-a");
      const refused = await service.reserveForCompanyCall({
        tenantId: fixture.ids.companyA,
        workspaceId: fixture.ids.teamA1,
        principalId: fixture.caller("a1-member").principalId,
        botRef: "bot:mt070-ceiling",
        callKey: "call:mt070-ceiling",
        idempotencyKey: "mt070-ceiling-idem",
        maximumCents: before + 200,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });
      // 上界拒绝原样透传 writer 形状：{reserved:false, availableCents}。
      expect(refused).toEqual({ reserved: false, availableCents: before });
      expect(await fixture.balanceOf("company-a")).toBe(before);
    });

    itDb(
      "replays the same idempotency key without double-reserving",
      async () => {
        const { ids } = fixture;
        await fixture.seedGrant("company-a", 600, "ac4-replay");
        const before = await fixture.balanceOf("company-a");
        const input: CompanyCallInput = {
          tenantId: ids.companyA,
          workspaceId: ids.teamA1,
          principalId: fixture.caller("a1-member").principalId,
          botRef: "bot:mt070-replay",
          callKey: "call:mt070-replay",
          idempotencyKey: "mt070-replay-idem",
          maximumCents: 250,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        };
        const first = await service.reserveForCompanyCall(input);
        const second = await service.reserveForCompanyCall(input);
        if (!first.reserved || !second.reserved)
          throw new Error("expected both admitted");
        expect(second.reservationId).toBe(first.reservationId);
        // 只咬一口余额、只有一行归属。
        expect(await fixture.balanceOf("company-a")).toBe(before - 250);
        const attribution = await service.attributionOf(first.reservationId);
        expect(attribution?.callKey).toBe("call:mt070-replay");
      },
    );

    itDb(
      "refuses an idempotency-key replay that changes the attribution",
      async () => {
        const { ids, caller } = fixture;
        await fixture.seedGrant("company-a", 600, "ac4-drift");
        const before = await fixture.balanceOf("company-a");
        const a2 = caller("a2-member");
        const first = await service.reserveForCompanyCall({
          tenantId: ids.companyA,
          workspaceId: ids.teamA1,
          principalId: caller("a1-member").principalId,
          botRef: "bot:mt070-drift",
          callKey: "call:mt070-drift",
          idempotencyKey: "mt070-drift-idem",
          maximumCents: 100,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        });
        if (!first.reserved) throw new Error("unreachable");
        // 同幂等键、换团队/使用人/Bot/调用标识：归属漂移被拒，原预扣与原归属不动。
        await expectSentinelRejection(
          service.reserveForCompanyCall({
            tenantId: ids.companyA,
            workspaceId: ids.teamA2,
            principalId: a2.principalId,
            botRef: "bot:mt070-drift-2",
            callKey: "call:mt070-drift-2",
            idempotencyKey: "mt070-drift-idem",
            maximumCents: 100,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          }),
          "CALL_ATTRIBUTION_CONFLICT",
        );
        expect(await fixture.balanceOf("company-a")).toBe(before - 100);
        expect(
          (await service.attributionOf(first.reservationId))?.workspaceId,
        ).toBe(ids.teamA1);
      },
    );

    itDb(
      "refuses a second reservation for an already-used stable call key",
      async () => {
        const { ids } = fixture;
        await fixture.seedGrant("company-a", 600, "ac4-callkey");
        const before = await fixture.balanceOf("company-a");
        await service.reserveForCompanyCall({
          tenantId: ids.companyA,
          workspaceId: ids.teamA1,
          principalId: fixture.caller("a1-member").principalId,
          botRef: "bot:mt070-callkey-dup",
          callKey: "call:mt070-callkey-dup",
          idempotencyKey: "mt070-callkey-dup-idem-1",
          maximumCents: 100,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        });
        // 同一稳定调用标识、换幂等键（重试实现 bug 的形状）：拒绝、零新预扣。
        await expectSentinelRejection(
          service.reserveForCompanyCall({
            tenantId: ids.companyA,
            workspaceId: ids.teamA1,
            principalId: fixture.caller("a1-member").principalId,
            botRef: "bot:mt070-callkey-dup",
            callKey: "call:mt070-callkey-dup",
            idempotencyKey: "mt070-callkey-dup-idem-2",
            maximumCents: 100,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          }),
          "CALL_KEY_CONFLICT",
        );
        expect(await fixture.balanceOf("company-a")).toBe(before - 100);
      },
    );

    itDb(
      "the call-key unique index backstops a concurrent duplicate call",
      async () => {
        const { ids } = fixture;
        await fixture.seedGrant("company-a", 600, "ac4-callkey-race");
        const before = await fixture.balanceOf("company-a");
        const base = {
          tenantId: ids.companyA,
          workspaceId: ids.teamA1,
          principalId: fixture.caller("a1-member").principalId,
          botRef: "bot:mt070-callkey-race",
          callKey: "call:mt070-callkey-race",
          maximumCents: 100,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        };
        const [firstSettled, secondSettled] = await Promise.allSettled([
          service.reserveForCompanyCall({
            ...base,
            idempotencyKey: "mt070-race-idem-1",
          }),
          service.reserveForCompanyCall({
            ...base,
            idempotencyKey: "mt070-race-idem-2",
          }),
        ]);
        // 恰一笔成功；另一笔要么预检拒绝、要么竞态兜底拒绝（唯一索引兜底）。
        const outcomes = [firstSettled, secondSettled];
        const admitted = outcomes.filter(
          (
            s,
          ): s is PromiseFulfilledResult<{
            reserved: true;
            reservationId: string;
          }> => s.status === "fulfilled" && s.value.reserved,
        );
        const rejected = outcomes.filter((s) => s.status === "rejected");
        expect(admitted.length).toBe(1);
        expect(rejected.length).toBe(1);
        if (admitted.length !== 1 || rejected.length !== 1) {
          throw new Error("unreachable");
        }
        // 败者的哨兵码：稳定调用标识冲突。
        const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
        expect(reason.message.startsWith("CALL_KEY_CONFLICT: ")).toBe(true);
        // 唯一的活动持有限额是赢家的那 100；输家若有瞬持已全额退持。
        expect(await fixture.balanceOf("company-a")).toBe(before - 100);
        expect(
          await service.attributionOf(admitted[0].value.reservationId),
        ).not.toBeNull();
      },
    );
  },
);

describeDb("MT070 account discipline and unchanged writer path", () => {
  itDb("refuses a company with no billing mapping", async () => {
    const { ids } = fixture;
    const unmapped = `${fixture.ids.companyA}-unmapped-sibling`;
    await fixture.db
      .insert(enterpriseTenants)
      .values({ id: unmapped, name: "MT070 Company Unmapped" });
    try {
      await expectSentinelRejection(
        service.reserveForCompanyCall({
          tenantId: unmapped,
          workspaceId: ids.teamA1,
          principalId: fixture.caller("a1-member").principalId,
          botRef: "bot:mt070-unmapped",
          callKey: "call:mt070-unmapped",
          idempotencyKey: "mt070-unmapped-idem",
          maximumCents: 100,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        }),
        "CUSTOMER_MAPPING_REQUIRED",
      );
    } finally {
      await fixture.db
        .delete(enterpriseTenants)
        .where(eq(enterpriseTenants.id, unmapped));
    }
  });

  itDb(
    "refuses a company whose mapped account is not an active company account",
    async () => {
      const { ids, payer } = fixture;
      // 映射在、公司账户从未注册：预扣无处可落 → COMPANY_ACCOUNT_REQUIRED。
      const companyE = `${fixture.ids.companyA}-unregistered-sibling`;
      await fixture.db
        .insert(enterpriseTenants)
        .values({ id: companyE, name: "MT070 Company E" });
      try {
        const customerE = `${companyE}-cust`;
        await fixture.db
          .insert(billingCustomers)
          .values({ externalId: customerE });
        await payer.bindCompanyCustomer({
          tenantId: companyE,
          externalCustomerId: customerE,
          actor: "mt070-test",
        });
        await expectSentinelRejection(
          service.reserveForCompanyCall({
            tenantId: companyE,
            workspaceId: ids.teamA1,
            principalId: fixture.caller("a1-member").principalId,
            botRef: "bot:mt070-e",
            callKey: "call:mt070-e",
            idempotencyKey: "mt070-e-idem",
            maximumCents: 100,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          }),
          "COMPANY_ACCOUNT_REQUIRED",
        );
      } finally {
        await fixture.db
          .delete(enterpriseTenants)
          .where(eq(enterpriseTenants.id, companyE));
      }
    },
  );

  itDb("never draws a personal account into a company call", async () => {
    const { ids } = fixture;
    await fixture.seedGrant("personal", 500, "ac13-personal");
    await fixture.seedGrant("company-a", 500, "ac13-company");
    const beforePersonal = await fixture.balanceOf("personal");
    const beforeCompany = await fixture.balanceOf("company-a");
    const result = await service.reserveForCompanyCall({
      tenantId: ids.companyA,
      workspaceId: ids.teamA1,
      principalId: fixture.caller("a1-member").principalId,
      botRef: "bot:mt070-personal-fence",
      callKey: "call:mt070-personal-fence",
      idempotencyKey: "mt070-personal-fence-idem",
      maximumCents: 200,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    expect(result.reserved).toBe(true);
    // 公司预扣只走公司账户：个人余额分毫不动。
    expect(await fixture.balanceOf("personal")).toBe(beforePersonal);
    expect(await fixture.balanceOf("company-a")).toBe(beforeCompany - 200);
  });

  itDb("a company hold settles through the unchanged writer path", async () => {
    const { ids } = fixture;
    await fixture.seedGrant("company-a", 800, "settle-path");
    const before = await fixture.balanceOf("company-a");
    const result = await service.reserveForCompanyCall({
      tenantId: ids.companyA,
      workspaceId: ids.teamA1,
      principalId: fixture.caller("a1-member").principalId,
      botRef: "bot:mt070-settle",
      callKey: "call:mt070-settle",
      idempotencyKey: "mt070-settle-idem",
      maximumCents: 500,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    if (!result.reserved) throw new Error("unreachable");
    const settled = await fixture.writer.settleReservation({
      reservationId: result.reservationId,
      actual: { numerator: 1234n, denominator: 1n },
      title: "MT070 unchanged writer path",
    });
    // ×100 整数纪律与既有语义：charged=1234、applied 以 hold 为上界、released 找零。
    expect(settled.chargedCents).toBe(1234);
    expect(settled.appliedCents).toBe(500);
    expect(settled.releasedCents).toBe(0);
    // 台账幂等键 = reservation:<id>（writer 原派生），重复结算返回同一结果。
    const replay = await fixture.writer.settleReservation({
      reservationId: result.reservationId,
      actual: { numerator: 1234n, denominator: 1n },
      title: "MT070 unchanged writer path",
    });
    expect(replay.chargedCents).toBe(1234);
    expect(await fixture.balanceOf("company-a")).toBe(before - 500);
  });

  itDb("keeps restricted roles outside the attribution table", async () => {
    for (const role of [
      "ob_ent_directory",
      "ob_ent_data",
      "ob_ent_operator",
      "ob_ent_identity_operator",
      "public",
    ]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const rows = await fixture.db.execute(
          sql`select has_table_privilege(${role}, 'billing_call_attributions', ${privilege}) as allowed`,
        );
        expect(rows[0]?.allowed).toBe(false);
      }
    }
  });
});
