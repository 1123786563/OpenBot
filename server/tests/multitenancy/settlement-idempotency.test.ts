// server/tests/multitenancy/settlement-idempotency.test.ts
// MT071（Issue #114）：结算、释放、尾差与重试幂等在新归属下保持。
//
// 票面四条验收全部在真实 PostgreSQL 上钉死（专用测试库，缺 env 显式 skip、
// skipped 不计通过）：
//   AC1 重放同一结算事件不重复扣费或重复释放（幂等测试）；
//   AC2 尾差与金额精度和既有行为一致（归属预扣 × 个人直连对照）；
//   AC3 未知结果的预扣继续占用可用额度；超时、Key 过期、客户端取消都不是释放证据；
//   AC4 结算记录归属与付款账户一致，重试不改变账户。
// 修复轮（复审 F1 medium / F2 low）追加真并发用例：同一预扣上并发终态化
//   （settle×2 异 actual、settle+release×2）恰入账一次；同请求体并发重放得首果。
// 结算/释放/尾差的权威实现是已冻结的 credits-writer（MT070 交付只读消费）；
// 归属经 MT070 的 company-reservation seam 预扣。本套件零生产代码修改：
// 它证明带 billing_call_attributions 归属后，既有幂等与金额保证分毫未变。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import { eq } from "drizzle-orm";
import { createCompanyReservationService } from "../../src/billing/company-reservation";
import {
  CreditReservationConflictError,
  type CreditSettlementResult,
} from "../../src/billing/credits-writer";
import { createCreditUsageTarget } from "../../src/billing/usage-delivery";
import { UsageDeliveryError } from "../../src/billing/usage-delivery-error";
import {
  CONFIRMED_NO_COST_REASONS,
  isConfirmedNoCost,
} from "../../src/billing/usage-evidence";
import type { UsageOutboxRecord } from "../../src/billing/usage-outbox";
import {
  creditChargeRemainders,
  creditReservations,
} from "../../src/db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../../src/db/schema/credits";
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

/** 一次归属预扣的输入（付款账户由服务端固定——输入里没有它）。 */
async function holdForCompanyCall(input: {
  tenantId: string;
  workspaceId: string;
  principalId: string;
  botRef: string;
  callKey: string;
  idempotencyKey: string;
  maximumCents: number;
  expiresAt?: Date;
}): Promise<string> {
  const result = await service.reserveForCompanyCall({
    ...input,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000),
  });
  if (!result.reserved) {
    throw new Error(
      `expected the hold to be admitted (available ${result.availableCents})`,
    );
  }
  return result.reservationId;
}

async function reservationRow(
  reservationId: string,
): Promise<typeof creditReservations.$inferSelect> {
  const [row] = await fixture.db
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId))
    .limit(1);
  if (!row) throw new Error(`no reservation row ${reservationId}`);
  return row;
}

/** 结算事件的台账事实（writer 权威幂等键 `reservation:<id>`）。 */
async function ledgerOfReservation(
  reservationId: string,
): Promise<(typeof creditLedger.$inferSelect)[]> {
  return fixture.db
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.idempotencyKey, `reservation:${reservationId}`));
}

async function ledgerRowCountForCustomer(customer: string): Promise<number> {
  const rows = await fixture.db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, customer));
  return rows.length;
}

/**
 * 并发用例的前置钉死：该客户的累计尾差必须为中性（分子 0，或缺行）。
 * 文件序里 company-a/b/s 的尾差都被早前用例收敛到 {0,1}（整数入账后不欠账），
 * 绝对金额断言才不被跨用例尾差漂移干扰；若文件序变化导致不成立，这里会先红。
 */
async function expectNeutralCarriedRemainder(customer: string): Promise<void> {
  const [row] = await fixture.db
    .select()
    .from(creditChargeRemainders)
    .where(eq(creditChargeRemainders.externalCustomerId, customer))
    .limit(1);
  expect(row?.numerator ?? "0").toBe("0");
}

/** 断言 promise 以 writer 的 reservation_conflict 拒绝（结算/重试语义守卫）。 */
async function expectReservationConflict(
  promise: Promise<unknown>,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(
      error instanceof CreditReservationConflictError &&
        error.code === "reservation_conflict",
    ).toBe(true);
    return;
  }
  throw new Error("expected a reservation_conflict rejection, got resolve");
}

const ms = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describeDb(
  "MT071 AC1: replaying a settlement event never double-charges or double-releases",
  () => {
    itDb(
      "replaying the same settlement returns the first result and keeps one ledger row",
      async () => {
        const { ids, caller } = fixture;
        await fixture.seedGrant("company-c", 1000, "ac1-settle");
        const reservationId = await holdForCompanyCall({
          tenantId: ids.companyC,
          workspaceId: ids.teamC1,
          principalId: caller("c1-member").principalId,
          botRef: "bot:mt071-alpha/virtual-key-1",
          callKey: `call:${ids.companyC}-settle-1`,
          idempotencyKey: `${ids.companyC}-idem-settle-1`,
          maximumCents: 500,
        });

        // actual = 1.5 units exactly: charged floors to 1, half a unit carried over.
        const settled = await fixture.writer.settleReservation({
          reservationId,
          actual: { numerator: 1500n, denominator: 1000n },
          title: "LLM token usage",
          requestId: "mt071-ac1-request-1",
        });
        expect(settled.chargedCents).toBe(1);
        expect(settled.appliedCents).toBe(1);
        expect(settled.releasedCents).toBe(499);
        expect(settled.remainder).toEqual({ numerator: 1n, denominator: 2n });

        const rowAfterFirst = await reservationRow(reservationId);
        const ledgerAfterFirst = await ledgerOfReservation(reservationId);
        expect(ledgerAfterFirst).toHaveLength(1);
        expect(ledgerAfterFirst[0].credits).toBe(1);
        expect(ledgerAfterFirst[0].applied).toBe(1);
        expect(ledgerAfterFirst[0].requestId).toBe("mt071-ac1-request-1");

        // 重放同一结算事件：首次结果逐字段复现，台账与预扣行不再变化。
        const replayed = await fixture.writer.settleReservation({
          reservationId,
          actual: { numerator: 1500n, denominator: 1000n },
          title: "LLM token usage",
          requestId: "mt071-ac1-request-1",
        });
        expect(replayed).toEqual(settled);
        expect(await ledgerOfReservation(reservationId)).toHaveLength(1);
        const rowAfterReplay = await reservationRow(reservationId);
        expect(rowAfterReplay.status).toBe("settled");
        expect(rowAfterReplay.charged).toBe(1);
        expect(rowAfterReplay.applied).toBe(1);
        expect(rowAfterReplay.released).toBe(499);
        expect(rowAfterReplay.terminalAt?.getTime()).toBe(
          rowAfterFirst.terminalAt?.getTime(),
        );
      },
    );

    itDb("replaying a release changes nothing the second time", async () => {
      const { ids, caller } = fixture;
      await fixture.seedGrant("company-c", 1000, "ac1-release");
      const balanceBefore = await fixture.balanceOf("company-c");
      const reservationId = await holdForCompanyCall({
        tenantId: ids.companyC,
        workspaceId: ids.teamC1,
        principalId: caller("c1-member").principalId,
        botRef: "bot:mt071-alpha/virtual-key-2",
        callKey: `call:${ids.companyC}-release-1`,
        idempotencyKey: `${ids.companyC}-idem-release-1`,
        maximumCents: 400,
      });
      expect(await fixture.balanceOf("company-c")).toBe(balanceBefore - 400);
      const ledgerBefore = await ledgerRowCountForCustomer(ids.customerC);

      const reason = "mt071: provider reported zero usage (confirmed no cost)";
      await fixture.writer.releaseReservation(reservationId, reason);
      expect(await fixture.balanceOf("company-c")).toBe(balanceBefore);
      const released = await reservationRow(reservationId);
      expect(released.status).toBe("released");
      expect(released.released).toBe(400);
      expect(released.releaseReason).toBe(reason);

      // 重放释放：首个终态站住——终态时间戳、金额、原因都不被第二次改写。
      await ms(15);
      await fixture.writer.releaseReservation(reservationId, reason);
      expect(await fixture.balanceOf("company-c")).toBe(balanceBefore);
      const afterReplay = await reservationRow(reservationId);
      expect(afterReplay.status).toBe("released");
      expect(afterReplay.released).toBe(400);
      expect(afterReplay.releaseReason).toBe(reason);
      expect(afterReplay.terminalAt?.getTime()).toBe(
        released.terminalAt?.getTime(),
      );
      // 释放从不写台账：台账行数与预扣前一致（不多出"释放凭证"）。
      expect(await ledgerRowCountForCustomer(ids.customerC)).toBe(ledgerBefore);
    });

    itDb(
      "the same usage event replayed through the credit settlement target settles once",
      async () => {
        const { ids, caller } = fixture;
        await fixture.seedGrant("company-d", 1000, "ac1-target");
        const reservationId = await holdForCompanyCall({
          tenantId: ids.companyD,
          workspaceId: ids.teamD1,
          principalId: caller("d-member").principalId,
          botRef: "bot:mt071-alpha/virtual-key-3",
          callKey: `call:${ids.companyD}-target-1`,
          idempotencyKey: `${ids.companyD}-idem-target-1`,
          maximumCents: 600,
        });

        // 真实结算事件消费面（usage-outbox → credits target）携带的持久化事实。
        const event: UsageOutboxRecord = {
          eventId: `${ids.companyD}-usage-event-1`,
          source: "llm",
          externalCustomerId: ids.customerD,
          transactionId: `${ids.companyD}-usage-event-1`,
          inputTokens: 100,
          outputTokens: 50,
          model: "mt071-model",
          client: "mt071-test",
          occurredAt: new Date(),
          reservationId,
          actualCostNumerator: "700",
          actualCostDenominator: "1000",
          runId: null,
          botId: null,
          ownerUserId: null,
          sessionId: null,
          status: null,
          lagoStatus: "pending",
          creditsStatus: "pending",
          lagoLastErrorCode: null,
          creditsLastErrorCode: null,
          lagoAttempts: 0,
          creditsAttempts: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const chargeCredits = createCreditUsageTarget(fixture.writer);
        await chargeCredits(event);

        const settled = await reservationRow(reservationId);
        expect(settled.status).toBe("settled");
        expect(settled.charged).toBe(0);
        expect(settled.released).toBe(600);
        expect(settled.remainderNumerator).toBe("7");
        expect(settled.remainderDenominator).toBe("10");
        const ledger = await ledgerOfReservation(reservationId);
        expect(ledger).toHaveLength(1);
        expect(ledger[0].externalCustomerId).toBe(ids.customerD);
        expect(ledger[0].title).toBe("LLM token usage");
        expect(ledger[0].requestId).toBe(event.eventId);

        // 重放同一事件：已结算的预扣按首次结果应答，台账不增、终态不改写。
        await chargeCredits(event);
        expect(await ledgerOfReservation(reservationId)).toHaveLength(1);
        const afterReplay = await reservationRow(reservationId);
        expect(afterReplay.charged).toBe(0);
        expect(afterReplay.released).toBe(600);
        expect(afterReplay.terminalAt?.getTime()).toBe(
          settled.terminalAt?.getTime(),
        );
      },
    );

    itDb(
      "settling a released hold is refused and writes nothing (failure injection)",
      async () => {
        const { ids, caller } = fixture;
        await fixture.seedGrant("company-d", 500, "ac1-refused");
        const ledgerBefore = await ledgerRowCountForCustomer(ids.customerD);
        const reservationId = await holdForCompanyCall({
          tenantId: ids.companyD,
          workspaceId: ids.teamD1,
          principalId: caller("d-member").principalId,
          botRef: "bot:mt071-alpha/virtual-key-4",
          callKey: `call:${ids.companyD}-refused-1`,
          idempotencyKey: `${ids.companyD}-idem-refused-1`,
          maximumCents: 200,
        });
        await fixture.writer.releaseReservation(
          reservationId,
          "mt071: bound_refused",
        );
        await expectReservationConflict(
          fixture.writer.settleReservation({
            reservationId,
            actual: { numerator: 1n, denominator: 1n },
            title: "LLM token usage",
          }),
        );
        expect(await ledgerOfReservation(reservationId)).toHaveLength(0);
        expect(await ledgerRowCountForCustomer(ids.customerD)).toBe(
          ledgerBefore,
        );
        const row = await reservationRow(reservationId);
        expect(row.status).toBe("released");
      },
    );

    itDb(
      "settling an unknown reservation is refused and writes nothing (failure injection)",
      async () => {
        const { ids } = fixture;
        await expectReservationConflict(
          fixture.writer.settleReservation({
            reservationId: "cr-mt071-no-such-reservation",
            actual: { numerator: 1n, denominator: 1n },
            title: "LLM token usage",
          }),
        );
        expect(
          await ledgerOfReservation("cr-mt071-no-such-reservation"),
        ).toHaveLength(0);
        // 该形状的拒绝必须连 missing-fact 的消费面都进不了（不可重试码集）。
        const missingTarget = createCreditUsageTarget(fixture.writer);
        const missing: UsageOutboxRecord = {
          eventId: `${ids.companyD}-usage-event-missing`,
          source: "llm",
          externalCustomerId: ids.customerD,
          transactionId: `${ids.companyD}-usage-event-missing`,
          inputTokens: 0,
          outputTokens: 0,
          model: "mt071-model",
          client: "mt071-test",
          occurredAt: new Date(),
          reservationId: null,
          actualCostNumerator: null,
          actualCostDenominator: null,
          runId: null,
          botId: null,
          ownerUserId: null,
          sessionId: null,
          status: "usage_missing",
          lagoStatus: "pending",
          creditsStatus: "pending",
          lagoLastErrorCode: null,
          creditsLastErrorCode: null,
          lagoAttempts: 0,
          creditsAttempts: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        try {
          await missingTarget(missing);
          throw new Error("expected missing_reservation failure");
        } catch (error) {
          expect(error instanceof UsageDeliveryError).toBe(true);
          expect((error as UsageDeliveryError).code).toBe(
            "missing_reservation",
          );
        }
      },
    );
  },
);

describeDb(
  "MT071 AC2: tail difference and precision match existing behavior (attributed vs plain comparison)",
  () => {
    itDb(
      "an attributed hold and a plain hold produce identical amount trajectories",
      async () => {
        const { ids, caller } = fixture;
        await fixture.seedGrant("company-a", 1000, "ac2-a");
        await fixture.seedGrant("personal", 1000, "ac2-p");

        // 三轮各 1/3 单位：尾差按客户累计 {1,3} → {2,3} → 整 1，两侧逐字段一致。
        const expectedTrajectory = [
          {
            chargedCents: 0,
            appliedCents: 0,
            releasedCents: 300,
            remainder: { numerator: 1n, denominator: 3n },
          },
          {
            chargedCents: 0,
            appliedCents: 0,
            releasedCents: 300,
            remainder: { numerator: 2n, denominator: 3n },
          },
          {
            chargedCents: 1,
            appliedCents: 1,
            releasedCents: 299,
            remainder: { numerator: 0n, denominator: 1n },
          },
        ];
        for (const [index, expected] of expectedTrajectory.entries()) {
          const round = index + 1;
          const companyId = await holdForCompanyCall({
            tenantId: ids.companyA,
            workspaceId: ids.teamA1,
            principalId: caller("a1-member").principalId,
            botRef: "bot:mt071-alpha/virtual-key-5",
            callKey: `call:${ids.companyA}-ac2-r${round}`,
            idempotencyKey: `${ids.companyA}-idem-ac2-r${round}`,
            maximumCents: 300,
          });
          const plain = await fixture.writer.reserveCredits({
            externalCustomerId: ids.personalCustomer,
            idempotencyKey: `${ids.personalCustomer}-idem-ac2-r${round}`,
            maximumCents: 300,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          });
          if (!plain.reserved) throw new Error("expected the plain hold");

          const companySettled = await fixture.writer.settleReservation({
            reservationId: companyId,
            actual: { numerator: 1n, denominator: 3n },
            title: "LLM token usage",
          });
          const plainSettled = await fixture.writer.settleReservation({
            reservationId: plain.reservationId,
            actual: { numerator: 1n, denominator: 3n },
            title: "LLM token usage",
          });
          // 绝对轨迹钉死（尾差逐轮累计、第三轮整 1 入账），且两侧逐字段一致。
          expect(companySettled).toEqual(expected);
          expect(plainSettled).toEqual(expected);

          const companyRow = await reservationRow(companyId);
          const plainRow = await reservationRow(plain.reservationId);
          expect(companyRow.remainderNumerator).toBe(
            plainRow.remainderNumerator,
          );
          expect(companyRow.remainderDenominator).toBe(
            plainRow.remainderDenominator,
          );
        }

        // 尾差轨迹的最简分数逐轮钉死（归属侧；对照侧上面 toEqual 已同果）。
        const [companyRemainder] = await fixture.db
          .select()
          .from(creditChargeRemainders)
          .where(eq(creditChargeRemainders.externalCustomerId, ids.customerA))
          .limit(1);
        expect(companyRemainder?.numerator).toBe("0");
        expect(companyRemainder?.denominator).toBe("1");
      },
    );

    itDb(
      "precision stays exact-rational under the largest denominators",
      async () => {
        const { ids } = fixture;
        await fixture.seedGrant("personal", 1000, "ac2-prec");
        const plain = await fixture.writer.reserveCredits({
          externalCustomerId: ids.personalCustomer,
          idempotencyKey: `${ids.personalCustomer}-idem-ac2-prec`,
          maximumCents: 1000,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        });
        if (!plain.reserved) throw new Error("expected the plain hold");
        // 10 亿级分母的精确有理数：不取浮点近似，余数原样最简存储。
        const settled = await fixture.writer.settleReservation({
          reservationId: plain.reservationId,
          actual: { numerator: 1n, denominator: 1000000003n },
          title: "LLM token usage",
        });
        expect(settled.chargedCents).toBe(0);
        expect(settled.appliedCents).toBe(0);
        expect(settled.releasedCents).toBe(1000);
        expect(settled.remainder).toEqual({
          numerator: 1n,
          denominator: 1000000003n,
        });
        const row = await reservationRow(plain.reservationId);
        expect(row.remainderNumerator).toBe("1");
        expect(row.remainderDenominator).toBe("1000000003");
      },
    );
  },
);

describeDb(
  "MT071 AC3: unknown outcome keeps the hold; timeout, key expiry and client cancel are not release evidence",
  () => {
    itDb(
      "an unsettled hold keeps occupying exactly its hold amount",
      async () => {
        const { ids, caller } = fixture;
        await fixture.seedGrant("company-a", 1000, "ac3-occ");
        const balanceBefore = await fixture.balanceOf("company-a");
        const reservationId = await holdForCompanyCall({
          tenantId: ids.companyA,
          workspaceId: ids.teamA1,
          principalId: caller("a1-member").principalId,
          botRef: "bot:mt071-alpha/virtual-key-6",
          callKey: `call:${ids.companyA}-occ-1`,
          idempotencyKey: `${ids.companyA}-idem-occ-1`,
          maximumCents: 300,
        });
        const row = await reservationRow(reservationId);
        expect(row.status).toBe("reserved");
        expect(await fixture.balanceOf("company-a")).toBe(balanceBefore - 300);

        // 只有显式确认无费用才释放；释放恰好归还一次持有限额。
        await fixture.writer.releaseReservation(
          reservationId,
          "mt071: confirmed no cost after provider_error",
        );
        expect(await fixture.balanceOf("company-a")).toBe(balanceBefore);
      },
    );

    itDb(
      "expiry is not release evidence: the hold survives its own clock and still owes",
      async () => {
        const { ids, caller } = fixture;
        await fixture.seedGrant("company-a", 1000, "ac3-exp");
        const reservationId = await holdForCompanyCall({
          tenantId: ids.companyA,
          workspaceId: ids.teamA1,
          principalId: caller("a1-member").principalId,
          botRef: "bot:mt071-alpha/virtual-key-7",
          callKey: `call:${ids.companyA}-exp-1`,
          idempotencyKey: `${ids.companyA}-idem-exp-1`,
          maximumCents: 250,
          expiresAt: new Date(Date.now() + 80),
        });
        await ms(250);

        // 超时/Key 过期不翻转状态：没有释放、没有台账、没有终态时间戳。
        const lapsed = await reservationRow(reservationId);
        expect(lapsed.status).toBe("reserved");
        expect(lapsed.terminalAt).toBeNull();
        expect(lapsed.releaseReason).toBeNull();
        expect(await ledgerOfReservation(reservationId)).toHaveLength(0);

        // Key 过期不免除既有消费责任：过期预扣仍可结算入账。
        const settled = await fixture.writer.settleReservation({
          reservationId,
          actual: { numerator: 1n, denominator: 1n },
          title: "LLM token usage",
        });
        expect(settled.chargedCents).toBe(1);
        expect(settled.appliedCents).toBe(1);
        expect(settled.releasedCents).toBe(249);
      },
    );

    itDb(
      "only confirmed no-cost reasons may release; cancel and timeout are unknown outcomes",
      async () => {
        // 唯一授权释放闸的词汇表（usage-evidence）：确认无费用 vs 未知结果。
        expect([...CONFIRMED_NO_COST_REASONS].sort()).toEqual([
          "bound_refused",
          "no_usage",
          "provider_error",
        ]);
        for (const confirmed of CONFIRMED_NO_COST_REASONS) {
          expect(isConfirmedNoCost(confirmed)).toBe(true);
        }
        for (const unknown of [
          "cancelled",
          "timeout",
          "usage_missing",
          "stream_error",
          "client_disconnected",
        ]) {
          expect(isConfirmedNoCost(unknown)).toBe(false);
        }
      },
    );
  },
);

describeDb(
  "MT071 AC4: settlement lands on the attributed payer account and a retry never re-routes it",
  () => {
    itDb(
      "the ledger row names the attributed company's account and retries cannot change it",
      async () => {
        const { ids, caller } = fixture;
        const grantId = await fixture.seedGrant("company-s", 1000, "ac4-s");
        const who = caller("s1-member");
        const reservationId = await holdForCompanyCall({
          tenantId: ids.companyS,
          workspaceId: ids.teamS1,
          principalId: who.principalId,
          botRef: "bot:mt071-alpha/virtual-key-8",
          callKey: `call:${ids.companyS}-ac4-1`,
          idempotencyKey: `${ids.companyS}-idem-ac4-1`,
          maximumCents: 400,
        });
        const attributionBefore = await service.attributionOf(reservationId);
        expect(attributionBefore).not.toBeNull();

        // actual = 5 units exactly.
        const settled = await fixture.writer.settleReservation({
          reservationId,
          actual: { numerator: 500n, denominator: 100n },
          title: "LLM token usage",
          requestId: "mt071-ac4-request-1",
        });
        expect(settled.chargedCents).toBe(5);
        expect(settled.appliedCents).toBe(5);
        expect(settled.releasedCents).toBe(395);

        // 结算记录归属与付款账户一致：台账行名归归属公司的映射 Customer。
        const ledger = await ledgerOfReservation(reservationId);
        expect(ledger).toHaveLength(1);
        expect(ledger[0].externalCustomerId).toBe(ids.customerS);
        expect(ledger[0].credits).toBe(5);
        expect(ledger[0].applied).toBe(5);
        expect(ledger[0].grantId).toBe(grantId);
        // 结算不改归属：五元组逐字段不变。
        expect(await service.attributionOf(reservationId)).toEqual(
          attributionBefore,
        );
        // A9 邻接：用量汇总按公司过滤，且只有该公司出现该笔 charged。
        const summary = await service.usageSummary(ids.companyS);
        const byUser = summary.byUser.find(
          (entry) => entry.principalId === who.principalId,
        );
        expect(byUser?.chargedUnits).toBe(5);
        expect(byUser?.heldUnits).toBe(0);
        const byTeam = summary.byTeam.find(
          (entry) => entry.workspaceId === ids.teamS1,
        );
        expect(byTeam?.chargedUnits).toBe(5);

        // 重试同 actual → 同果；换 actual → 拒绝；两者都不动台账与账户。
        const replayed = await fixture.writer.settleReservation({
          reservationId,
          actual: { numerator: 500n, denominator: 100n },
          title: "LLM token usage",
          requestId: "mt071-ac4-request-1",
        });
        expect(replayed).toEqual(settled);
        await expectReservationConflict(
          fixture.writer.settleReservation({
            reservationId,
            actual: { numerator: 7n, denominator: 10n },
            title: "LLM token usage",
          }),
        );
        expect(await ledgerOfReservation(reservationId)).toHaveLength(1);
        expect(ledger[0].externalCustomerId).toBe(ids.customerS);
        expect(await service.attributionOf(reservationId)).toEqual(
          attributionBefore,
        );
      },
    );

    itDb(
      "two companies settle side by side and neither charge lands on the other's account",
      async () => {
        const { ids, caller } = fixture;
        await fixture.seedGrant("company-a", 1000, "ac4-aa");
        await fixture.seedGrant("company-b", 777, "ac4-bb");
        const personalLedgerBefore = await ledgerRowCountForCustomer(
          ids.personalCustomer,
        );
        const reservationA = await holdForCompanyCall({
          tenantId: ids.companyA,
          workspaceId: ids.teamA1,
          principalId: caller("a1-member").principalId,
          botRef: "bot:mt071-alpha/virtual-key-9",
          callKey: `call:${ids.companyA}-ac4-side-a`,
          idempotencyKey: `${ids.companyA}-idem-ac4-side-a`,
          maximumCents: 400,
        });
        const reservationB = await holdForCompanyCall({
          tenantId: ids.companyB,
          workspaceId: ids.teamB1,
          principalId: caller("b1-member").principalId,
          botRef: "bot:mt071-alpha/virtual-key-10",
          callKey: `call:${ids.companyB}-ac4-side-b`,
          idempotencyKey: `${ids.companyB}-idem-ac4-side-b`,
          maximumCents: 300,
        });

        const settledA = await fixture.writer.settleReservation({
          reservationId: reservationA,
          actual: { numerator: 200n, denominator: 100n },
          title: "LLM token usage",
        });
        expect(settledA.chargedCents).toBe(2);
        const settledB = await fixture.writer.settleReservation({
          reservationId: reservationB,
          actual: { numerator: 100n, denominator: 100n },
          title: "LLM token usage",
        });
        expect(settledB.chargedCents).toBe(1);

        // 各自台账各一行、各名其主：A 的 2 单位绝不动 B 的账户，反之亦然。
        const ledgerA = await ledgerOfReservation(reservationA);
        expect(ledgerA).toHaveLength(1);
        expect(ledgerA[0].externalCustomerId).toBe(ids.customerA);
        expect(ledgerA[0].credits).toBe(2);
        const ledgerB = await ledgerOfReservation(reservationB);
        expect(ledgerB).toHaveLength(1);
        expect(ledgerB[0].externalCustomerId).toBe(ids.customerB);
        expect(ledgerB[0].credits).toBe(1);
        // 扣减落在各自公司自己的 grant 上（writer 最早过期优先；grant 只需属于本公司账户）。
        const grantOwnerOf = async (grantId: string | null) => {
          if (!grantId) return null;
          const [row] = await fixture.db
            .select({ customer: creditGrants.externalCustomerId })
            .from(creditGrants)
            .where(eq(creditGrants.id, grantId))
            .limit(1);
          return row?.customer ?? null;
        };
        expect(await grantOwnerOf(ledgerA[0].grantId)).toBe(ids.customerA);
        expect(await grantOwnerOf(ledgerB[0].grantId)).toBe(ids.customerB);

        // 归属行与对方余额都保持原状；个人账户零波及。
        expect((await service.attributionOf(reservationA))?.tenantId).toBe(
          ids.companyA,
        );
        expect((await service.attributionOf(reservationB))?.tenantId).toBe(
          ids.companyB,
        );
        expect(await fixture.balanceOf("company-b")).toBe(776);
        expect(await ledgerRowCountForCustomer(ids.personalCustomer)).toBe(
          personalLedgerBefore,
        );
      },
    );
  },
);

describeDb(
  "MT071 fix F1: concurrent terminalization of one reservation settles exactly once",
  () => {
    itDb(
      "two settles racing on one hold leave one ledger row, one terminal state",
      async () => {
        const { ids, caller } = fixture;
        await expectNeutralCarriedRemainder(ids.customerA);
        await fixture.seedGrant("company-a", 1000, "f1-race-settle");
        const before = await fixture.balanceOf("company-a");
        const reservationId = await holdForCompanyCall({
          tenantId: ids.companyA,
          workspaceId: ids.teamA1,
          principalId: caller("a1-member").principalId,
          botRef: "bot:mt071fx/virtual-key-1",
          callKey: `call:${ids.companyA}-f1-race-settle`,
          idempotencyKey: `${ids.companyA}-idem-f1-race-settle`,
          maximumCents: 500,
        });
        expect(await fixture.balanceOf("company-a")).toBe(before - 500);

        // 真并发：两个结算同时起飞、actual 不同（1.5 vs 2 单位）——恰一笔入账。
        const [firstRace, secondRace] = await Promise.allSettled([
          fixture.writer.settleReservation({
            reservationId,
            actual: { numerator: 1500n, denominator: 1000n },
            title: "LLM token usage",
            requestId: "mt071fx-f1-settle-a",
          }),
          fixture.writer.settleReservation({
            reservationId,
            actual: { numerator: 2000n, denominator: 1000n },
            title: "LLM token usage",
            requestId: "mt071fx-f1-settle-b",
          }),
        ]);
        const fulfilled = [firstRace, secondRace].filter(
          (
            outcome,
          ): outcome is PromiseFulfilledResult<CreditSettlementResult> =>
            outcome.status === "fulfilled",
        );
        const rejected = [firstRace, secondRace].find(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === "rejected",
        );
        // 恰一个成功；败者按 writer 的 reservation_conflict 形状拒绝，而非第二笔扣费。
        expect(fulfilled).toHaveLength(1);
        if (!rejected) throw new Error("expected exactly one loser");
        expect(rejected.reason instanceof CreditReservationConflictError).toBe(
          true,
        );
        expect((rejected.reason as CreditReservationConflictError).code).toBe(
          "reservation_conflict",
        );

        // 赢家的首果逐字段钉死（两种赢家形状都钉：1.5 → 1+欠 1/2；2 → 整 2）。
        const firstSideWon = firstRace.status === "fulfilled";
        expect(fulfilled[0].value).toEqual(
          firstSideWon
            ? {
                chargedCents: 1,
                appliedCents: 1,
                releasedCents: 499,
                remainder: { numerator: 1n, denominator: 2n },
              }
            : {
                chargedCents: 2,
                appliedCents: 2,
                releasedCents: 498,
                remainder: { numerator: 0n, denominator: 1n },
              },
        );

        // 台账恰好一行，金额与赢家一致（无重复记账）。
        const ledger = await ledgerOfReservation(reservationId);
        expect(ledger).toHaveLength(1);
        expect(ledger[0].credits).toBe(firstSideWon ? 1 : 2);
        expect(ledger[0].applied).toBe(firstSideWon ? 1 : 2);

        // 预扣行终态恰一次且与台账对得上。
        const row = await reservationRow(reservationId);
        expect(row.status).toBe("settled");
        expect(row.charged).toBe(firstSideWon ? 1 : 2);
        expect(row.applied).toBe(firstSideWon ? 1 : 2);
        expect(row.released).toBe(firstSideWon ? 499 : 498);
        expect(row.ledgerId).toBe(ledger[0].id);

        // 无二次扣减、无负余额：两种赢家形状下可用余额都恰回到 before−2
        //（1.5 单位 = 入账 1 + 欠账 1/2 占 1 单位容量；2 单位 = 入账 2 + 欠 0）。
        expect(await fixture.balanceOf("company-a")).toBe(before - 2);
      },
    );

    itDb(
      "a settle racing two releases terminalizes the hold exactly once",
      async () => {
        const { ids, caller } = fixture;
        await expectNeutralCarriedRemainder(ids.customerB);
        await fixture.seedGrant("company-b", 1000, "f1-race-release");
        const before = await fixture.balanceOf("company-b");
        const reservationId = await holdForCompanyCall({
          tenantId: ids.companyB,
          workspaceId: ids.teamB1,
          principalId: caller("b1-member").principalId,
          botRef: "bot:mt071fx/virtual-key-2",
          callKey: `call:${ids.companyB}-f1-race-release`,
          idempotencyKey: `${ids.companyB}-idem-f1-race-release`,
          maximumCents: 400,
        });

        // 真并发：一次结算对两次释放同时起飞，谁先终态化由锁序决定，两种形状都合法。
        const reason = "mt071fx: confirmed no cost (provider_error)";
        const [settled, releasedOne, releasedTwo] = await Promise.allSettled([
          fixture.writer.settleReservation({
            reservationId,
            actual: { numerator: 1000n, denominator: 1000n },
            title: "LLM token usage",
            requestId: "mt071fx-f1-race-settle",
          }),
          fixture.writer.releaseReservation(reservationId, reason),
          fixture.writer.releaseReservation(reservationId, reason),
        ]);
        // 释放从不抛错：输者看到终态即安静 no-op。
        expect(releasedOne.status).toBe("fulfilled");
        expect(releasedTwo.status).toBe("fulfilled");

        const row = await reservationRow(reservationId);
        const ledger = await ledgerOfReservation(reservationId);
        if (settled.status === "fulfilled") {
          // 结算赢：首果入账恰一次，台账恰一行，释放全为 no-op 不改写终态。
          expect(settled.value).toEqual({
            chargedCents: 1,
            appliedCents: 1,
            releasedCents: 399,
            remainder: { numerator: 0n, denominator: 1n },
          });
          expect(ledger).toHaveLength(1);
          expect(ledger[0].credits).toBe(1);
          expect(row.status).toBe("settled");
          expect(row.charged).toBe(1);
          expect(row.applied).toBe(1);
          expect(row.released).toBe(399);
          expect(row.ledgerId).toBe(ledger[0].id);
          expect(await fixture.balanceOf("company-b")).toBe(before - 1);
        } else {
          // 释放赢：结算按 released-守卫拒绝且零写入，余额全额归还、无负值。
          expect(settled.reason instanceof CreditReservationConflictError).toBe(
            true,
          );
          expect((settled.reason as CreditReservationConflictError).code).toBe(
            "reservation_conflict",
          );
          expect(ledger).toHaveLength(0);
          expect(row.status).toBe("released");
          expect(row.released).toBe(400);
          expect(row.applied).toBe(0);
          expect(row.releaseReason).toBe(reason);
          expect(await fixture.balanceOf("company-b")).toBe(before);
        }
      },
    );
  },
);

describeDb(
  "MT071 fix F2: a concurrent replay of the same settle body answers with the first result",
  () => {
    itDb(
      "the same settle request body fired twice concurrently returns the first result, not an error",
      async () => {
        const { ids, caller } = fixture;
        await expectNeutralCarriedRemainder(ids.customerS);
        await fixture.seedGrant("company-s", 1000, "f2-replay");
        const before = await fixture.balanceOf("company-s");
        const reservationId = await holdForCompanyCall({
          tenantId: ids.companyS,
          workspaceId: ids.teamS1,
          principalId: caller("s1-member").principalId,
          botRef: "bot:mt071fx/virtual-key-3",
          callKey: `call:${ids.companyS}-f2-replay`,
          idempotencyKey: `${ids.companyS}-idem-f2-replay`,
          maximumCents: 500,
        });
        expect(await fixture.balanceOf("company-s")).toBe(before - 500);

        // 同一请求体逐字段相同（含 requestId）并发重放两次。
        const replayBody = {
          reservationId,
          actual: { numerator: 1500n, denominator: 1000n },
          title: "LLM token usage",
          requestId: "mt071fx-f2-replay",
        };
        const [first, second] = await Promise.allSettled([
          fixture.writer.settleReservation(replayBody),
          fixture.writer.settleReservation(replayBody),
        ]);

        // 现行行为钉死：并发重放不抛错，两调用都拿首果（若现状抛错，此处即红、
        // 按复审口径应如实改钉现状形状——本轮实测现状即返回首果）。
        expect(first.status).toBe("fulfilled");
        expect(second.status).toBe("fulfilled");
        if (first.status !== "fulfilled" || second.status !== "fulfilled") {
          throw new Error("unreachable");
        }
        expect(first.value).toEqual({
          chargedCents: 1,
          appliedCents: 1,
          releasedCents: 499,
          remainder: { numerator: 1n, denominator: 2n },
        });
        // 败者拿到的是首果逐字段复现，而不是第二笔扣费。
        expect(second.value).toEqual(first.value);

        // 台账恰好一行、终态恰一次（无重复记账）。
        const ledger = await ledgerOfReservation(reservationId);
        expect(ledger).toHaveLength(1);
        expect(ledger[0].credits).toBe(1);
        expect(ledger[0].applied).toBe(1);
        const row = await reservationRow(reservationId);
        expect(row.status).toBe("settled");
        expect(row.charged).toBe(1);
        expect(row.applied).toBe(1);
        expect(row.released).toBe(499);
        expect(row.ledgerId).toBe(ledger[0].id);

        // 无二次扣减、无负余额：恰入账 1 单位 + 欠账 1/2 占 1 单位容量。
        expect(await fixture.balanceOf("company-s")).toBe(before - 2);
      },
    );
  },
);
