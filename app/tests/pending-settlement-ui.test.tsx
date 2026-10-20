import "./preload";
/*
 * The runner is bun:test behind the repo's compat door (tests/support/bun-test-compat — the
 * same import the sibling bun-driven app suites use), because the ticket's prescribed
 * verification command is `bun test app/tests/pending-settlement-ui.test.tsx` and this file
 * is registered in docs/verification/e2e-bun-suites.json as a Bun-executed suite (ADR 0008:
 * the driven layer). The happy-dom registration below is the bun:test shape.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import i18n from "@/lib/i18n";
import { PersonalBalanceCard } from "@/components/billing/personal-balance-card";
import type { PersonalCreditBalance } from "@/lib/billing/credits";

/*
 * Bifrost 08.7 (#282): the person's own pending-settlement block, on the 套餐与积分 page's
 * balance card.
 *
 * What the page owes — per the ticket's acceptance criteria — is exactly what this file pins:
 *
 * - a pending item is shown WITH its reason, in the reader's language: the server's stable
 *   reason code maps to a sentence a person can act on, and the raw code itself never
 *   reaches the DOM (AC01);
 * - the display leaks nothing: an unrecognized or internal-looking reason string renders as
 *   the honest generic sentence, never as the raw text — no stack, no provider internals,
 *   no other account's anything (AC02);
 * - the pending quota and the spendable balance are separate figures, and every number on
 *   the card is the server's own answer, unchanged (AC03);
 * - an account with nothing pending shows NO pending block at all — not "待结算 0", not a
 *   list of settled history under a pending label (AC04).
 *
 * The card is rendered directly against the 06.12 wire contract
 * (`PersonalCreditBalance.pendingSettlement`, see app/src/lib/billing/credits.ts): the
 * component owns exactly the mapping and gating this ticket adds, so the suite needs no
 * network stub — the fixture IS the server's answer.
 */

beforeAll(async () => {
  GlobalRegistrator.register();
  await i18n.changeLanguage("zh-CN");
});
afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await i18n.changeLanguage("en");
  GlobalRegistrator.unregister();
});

/** One reservation row as the 06.12 wire carries it. */
function reservation(
  overrides: Partial<
    PersonalCreditBalance["pendingSettlement"]["reservations"][number]
  >,
): PersonalCreditBalance["pendingSettlement"]["reservations"][number] {
  return {
    id: "cr-fixture",
    status: "unknown",
    maximum: 10,
    charged: null,
    released: null,
    provider: "prov-a",
    model: "model-a",
    capability: "chat",
    botId: "bot-a",
    botName: "测试 Bot A",
    unknownReason: "dispatch_result_unknown",
    releaseReason: null,
    createdAt: "2026-10-17T09:00:00.000Z",
    expiresAt: "2026-10-17T09:15:00.000Z",
    terminalAt: null,
    ...overrides,
  };
}

/** The balance fixture builder: the parts this block reads, the rest at honest zeros. */
function balanceOf(
  pendingSettlement: Partial<PersonalCreditBalance["pendingSettlement"]>,
): PersonalCreditBalance {
  return {
    accountType: "personal",
    available: 12.5,
    consumed: 3.2,
    expired: 0,
    held: 1,
    grants: [],
    pendingSettlement: {
      enabled: true,
      available: 0,
      consumed: 0,
      expired: 0,
      reserved: 0,
      unknown: 0,
      reservations: [],
      ...pendingSettlement,
    },
  };
}

test("有待结算项时：额度与分别的可用余额来自同一服务端答案，原因以用户语言展示", async () => {
  const view = render(
    <PersonalBalanceCard
      balance={balanceOf({
        available: 30,
        reserved: 20,
        unknown: 10,
        reservations: [
          reservation({
            id: "cr-unknown-1",
            unknownReason: "dispatch_result_unknown",
          }),
          reservation({
            id: "cr-reserved-1",
            status: "reserved",
            maximum: 20,
            unknownReason: null,
          }),
        ],
      })}
    />,
  );

  await view.findByTestId("personal-balance");

  // AC03: the pending quota and the spendable balance are separate figures, both the
  // server's own — 12.5 spendable (the stat grid), 30 pending split 20 reserved + 10 unknown.
  const cardText = view.getByTestId("personal-balance").textContent ?? "";
  expect(cardText).toContain("12.5");
  const pending = view.getByTestId("pending-settlement").textContent ?? "";
  expect(pending).toContain("30");
  expect(pending).toContain("20");
  expect(pending).toContain("10");

  // AC01: the unknown hold's reason is a sentence, in the reader's language — and the raw
  // stable code the server stores is nowhere in the DOM.
  const rows = view.getAllByTestId("reservation-row");
  const unknownRow = rows.find(
    (row) => row.getAttribute("data-status") === "unknown",
  );
  expect(unknownRow).toBeDefined();
  expect(unknownRow?.textContent).toContain("结果尚未确认");
  expect(unknownRow?.textContent).not.toContain("dispatch_result_unknown");
  // The block also says how a pending item gets resolved (the ticket's 预计处理方式).
  expect(cardText).toContain("平台将向模型服务核实");
});

test("原因码到文案的映射覆盖停留原因的全部闭集词汇，未命中走兜底不外泄", async () => {
  // Every code the server's writers can leave on a hold a person sees (06.8's mark, the
  // recovery scan's detections, the settlement failure codes, the confirmed-no-cost
  // releases) maps to its own sentence — the ticket's rule that the mapping follows the
  // server's code tables, so no reason ever degrades to an uninformative "未知错误".
  const codes = [
    "usage_missing",
    "stream_error",
    "cancelled",
    "dispatch_result_unknown",
    "hold_expired_without_result",
    "usage_invalid",
    "usage_over_bound",
    "usage_charge_failed",
    "provider_error",
    "bound_refused",
    "no_usage",
  ] as const;
  for (const code of codes) {
    const view = render(
      <PersonalBalanceCard
        balance={balanceOf({
          available: 10,
          unknown: 10,
          reservations: [reservation({ id: `cr-${code}`, unknownReason: code })],
        })}
      />,
    );
    const row = await view.findByTestId("reservation-row");
    expect(row.textContent, `the ${code} row carries a mapped sentence`).toContain(
      "原因：",
    );
    expect(row.textContent).not.toContain(code);
    cleanup();
  }
});

test("脱敏：未识别的内部原因串不渲染原文，兜底文案替代", async () => {
  // A reason string outside the closed vocabulary — shaped like an internal error a
  // future writer might leave — must never reach the DOM as-is. The fallback sentence
  // says what is true (the item is being reconciled) without the internals.
  const internalDetail =
    "connect ECONNREFUSED 10.0.0.5:5432 user=postgres password=hunter2";
  const view = render(
    <PersonalBalanceCard
      balance={balanceOf({
        available: 10,
        unknown: 10,
        reservations: [
          reservation({
            id: "cr-internal",
            unknownReason: internalDetail,
            botName: "他人 Bot",
          }),
        ],
      })}
    />,
  );

  const row = await view.findByTestId("reservation-row");
  expect(row.textContent).toContain("仍在核对中");
  expect(row.textContent).not.toContain(internalDetail);
  expect(row.textContent).not.toContain("ECONNREFUSED");
  expect(row.textContent).not.toContain("hunter2");
  expect(view.container.textContent).not.toContain(internalDetail);
});

test("无待结算项时不显示待结算区块（不出现误导性 0 或历史列表）", async () => {
  const view = render(
    <PersonalBalanceCard
      balance={balanceOf({
        available: 0,
        reserved: 0,
        unknown: 0,
        // Only settled history remains: nothing pending, so no pending block — not even
        // the reservation history under a pending label.
        reservations: [
          reservation({
            id: "cr-settled",
            status: "settled",
            maximum: 5,
            charged: 4.2,
            unknownReason: null,
          }),
        ],
      })}
    />,
  );

  await view.findByTestId("personal-balance");
  expect(view.queryByTestId("pending-settlement")).toBeNull();
  expect(view.queryByTestId("reservation-list")).toBeNull();
  // The spendable figures are still the server's own — hiding the block hides nothing else.
  const cardText = view.getByTestId("personal-balance").textContent ?? "";
  expect(cardText).toContain("12.5");
  expect(cardText).not.toContain("待结算");
});

test("未启用（pre-06.12 服务端）仍显示诚实的未启用标记", async () => {
  const view = render(
    <PersonalBalanceCard
      balance={balanceOf({ enabled: false })}
    />,
  );

  await view.findByTestId("personal-balance");
  expect(view.getByTestId("pending-settlement").textContent).toContain(
    "待结算：未启用",
  );
});
