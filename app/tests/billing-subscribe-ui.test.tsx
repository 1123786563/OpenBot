import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { CheckoutCard } from "@/components/billing/checkout-card";
import { PriceCard } from "@/components/billing/price-card";
import { ProviderSegmented } from "@/components/billing/provider-segmented";
import type { PurchaseOrderView } from "@/lib/billing/payments";
import i18n from "@/lib/i18n";

beforeAll(async () => {
  GlobalRegistrator.register();
  // The suite's detector resolves happy-dom's "en-US" to English; these assertions are written
  // against the zh-CN bundle, so pin the language before anything renders.
  await i18n.changeLanguage("zh-CN");
});
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

// `render`'s own view is the query handle, not `screen`: screen binds `document.body` at import
// time, before `GlobalRegistrator` has run — the harness every other component test here uses.
const entry = { planCode: "pro", amountCents: 19900, currency: "CNY" as const, periodMonths: 1 };

test("PriceCard toggles selection on click", () => {
  let selected = false;
  const view = render(
    <PriceCard
      entry={entry}
      selected={selected}
      onSelect={() => {
        selected = true;
        view.rerender(
          <PriceCard entry={entry} selected={selected} onSelect={() => {}} disabled={false} />,
        );
      }}
      disabled={false}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: /pro/ }));
  expect(view.getByRole("button", { name: /pro/ }).getAttribute("aria-pressed")).toBe("true");
});

test("CheckoutCard shows a destructive countdown under 20% remaining", () => {
  const createdAt = "2026-10-10T10:00:00Z";
  const expiresAt = "2026-10-10T10:15:00Z";
  const pending: PurchaseOrderView = {
    orderId: "o1", planCode: "pro", provider: "alipay", amountCents: 19900, currency: "CNY",
    status: "pending", activationState: "pending",
    checkout: { kind: "qrcode", payload: "https://qr.example/pay" },
    expiresAt, periodEnd: null, createdAt,
  };
  const { container } = render(
    <CheckoutCard view={pending} now={Date.parse("2026-10-10T10:14:30Z")}
      onCancel={() => {}} cancelPending={false} cancelError={null} onDismiss={() => {}} />,
  );
  const bar = container.querySelector('[role="progressbar"]');
  expect(bar).toBeTruthy();
  // 剩 30 秒 / 总 15 分钟 = ~3.3% < 20% → destructive
  expect(bar?.getAttribute("aria-valuenow")).toBe("3");
  expect(bar?.firstElementChild?.className).toContain("bg-destructive");
});

test("CheckoutCard shows the success state for a paid order", () => {
  const paid: PurchaseOrderView = {
    orderId: "o2", planCode: "pro", provider: "alipay", amountCents: 19900, currency: "CNY",
    status: "paid", activationState: "applied", checkout: null,
    expiresAt: "2026-10-10T10:15:00Z", periodEnd: null, createdAt: "2026-10-10T10:00:00Z",
  };
  const view = render(
    <CheckoutCard view={paid} now={Date.parse("2026-10-10T10:05:00Z")}
      onCancel={() => {}} cancelPending={false} cancelError={null} onDismiss={() => {}} />,
  );
  expect(view.getByText("已收到付款，套餐已生效。")).toBeTruthy();
});

test("ProviderSegmented renders one option per configured channel", () => {
  const view = render(
    <ProviderSegmented providers={["alipay", "wechat"]} value="alipay" onChange={() => {}} />,
  );
  // The segmented row speaks radio semantics (radiogroup + aria-checked), so the options are
  // queried as radios, not as the buttons they are written with.
  expect(view.getByRole("radio", { name: "支付宝" })).toBeTruthy();
  expect(view.getByRole("radio", { name: "微信支付" })).toBeTruthy();
});
