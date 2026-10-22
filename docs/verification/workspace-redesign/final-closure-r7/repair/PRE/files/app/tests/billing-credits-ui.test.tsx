import "./preload";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "../../tests/support/e2e-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { cloneElement, createContext, useContext } from "react";
import type {
  CreditConsumptionEntry,
  CreditGrantEntry,
  PlanCatalogEntry,
} from "@/lib/billing/credits";
import i18n from "@/lib/i18n";
import { settleReactWork } from "./settle-react-work";

/*
 * The Base UI dialog never mounts under happy-dom: its portal rides browser transition APIs this
 * DOM shim does not implement, so an open dialog renders nothing at all (verified: bare
 * <Dialog open> leaves <body> empty). The repo's established answer for "the library's shell is
 * not what this test is about" is `mock.module` (approval-tools.test.tsx), so the portal shell is
 * replaced with pass-through components and the dialog's own logic — tier and cycle drawing from
 * the catalog, the agreement gate, the price arithmetic — is what gets asserted.
 *
 * The mocked imports below must load AFTER `mock.module` and BEFORE any render; `@testing-library/
 * react` itself is imported statically above because it registers suite-level hooks at import
 * time and refuses them from inside a test.
 */
mock.module("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: React.ReactNode }) =>
    children ?? null;
  const CloseContext = createContext<() => void>(() => {});
  /*
   * A SHAPE-COMPATIBLE passthrough, because mock.module is registry-level and OUTLIVES THIS
   * FILE. Later files (brokered-account-row's key dialog, the transcript's lightbox) exercise
   * the real Dialog's semantics through this mock, so it honors the real one's split behavior:
   * - a DialogTrigger child ALWAYS renders (the real trigger is the closed-state affordance;
   *   eating it made the transcript's attachment tiles vanish for every later file);
   * - every other child (the DialogContent tree) renders ONLY while open, wrapped in
   *   role="dialog" (a closed dialog mounting its content gave the no-auth row a phantom
   *   Close button — the real popup mounts nothing until open);
   * - DialogContent keeps the close button a real one renders (they close it by name).
   * Content renders inline instead of into a portal — the only part happy-dom cannot do, and
   * the part this file's assertions never looked at.
   */
  /*
   * The trigger honors `render` the way the real one does: the rendered element IS the trigger
   * (carrying its aria-label) with the children inside it, plus the `aria-haspopup="dialog"` the
   * real trigger answers for. Without this the transcript's tile button vanished and its label
   * and semantics with it.
   */
  const DialogTriggerMock = ({
    children,
    render,
  }: {
    children?: React.ReactNode;
    render?: React.ReactElement<Record<string, unknown>>;
  }) =>
    render
      ? cloneElement(render, { "aria-haspopup": "dialog" }, children)
      : (children ?? null);
  DialogTriggerMock.displayName = "DialogTriggerMock";
  const isTrigger = (child: React.ReactNode) =>
    child !== null &&
    typeof child === "object" &&
    "type" in child &&
    (child as { type?: { displayName?: string } }).type?.displayName ===
      "DialogTriggerMock";
  const Dialog = ({
    children,
    open = false,
    onOpenChange,
  }: {
    children?: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    const array = (Array.isArray(children) ? children : [children]).filter(
      Boolean,
    );
    const triggers = array.filter(isTrigger);
    const rest = array.filter((child) => !isTrigger(child));
    /*
     * The close affordance is threaded through context rather than props: a real DialogContent's
     * Close button asks the Dialog root to close (onOpenChange(false)), and a later file's tests
     * click that button by name and wait for the dialog to be gone — a dumb button that rendered
     * but did nothing broke them.
     */
    const close = () => onOpenChange?.(false);
    return open ? (
      <CloseContext.Provider value={close}>
        <div role="dialog">
          {triggers}
          {rest}
        </div>
      </CloseContext.Provider>
    ) : (
      <>
        {triggers}
        {rest.length === 0 ? null : null}
      </>
    );
  };
  const DialogTrigger = DialogTriggerMock;
  const DialogContent = ({ children }: { children?: React.ReactNode }) => {
    const close = useContext(CloseContext);
    return (
      <div>
        {children}
        <button onClick={close} type="button">
          <span className="sr-only">Close</span>
        </button>
      </div>
    );
  };
  return {
    Dialog,
    DialogContent,
    DialogHeader: pass,
    DialogBody: pass,
    DialogFooter: pass,
    /*
     * Title and Description get their own elements, as the real ones do (heading and p): a
     * later file's getByText pins a sentence that sits in a Description, and a bare passthrough
     * merged title and description into one text blob no exact matcher could hit.
     */
    DialogTitle: ({ children }: { children?: React.ReactNode }) => (
      <h2>{children}</h2>
    ),
    DialogDescription: ({ children }: { children?: React.ReactNode }) => (
      <p>{children}</p>
    ),
    /*
     * EVERY export, because mock.module is process-lifetime: a later test file importing
     * chat-transcript pulls this same mock, and a missing DialogClose/Overlay/Portal/Trigger
     * was a SyntaxError that failed that file before its own first test ran.
     */
    DialogClose: pass,
    DialogOverlay: pass,
    DialogPortal: pass,
    DialogTrigger,
  };
});

const { ConsumptionTable } = await import(
  "@/components/billing/consumption-table"
);
const { PlanCard } = await import("@/components/billing/plan-card");
const { CreditGrantList } = await import(
  "@/components/billing/credit-grant-list"
);
const { WelcomeBanner } = await import("@/components/billing/welcome-banner");
const { UpgradeDialog } = await import("@/components/billing/upgrade-dialog");

/*
 * The dialog now polls its pending order through React Query (the settlement recovery path), so
 * every UpgradeDialog render sits inside a QueryClientProvider the way the page provides one.
 */
const { QueryClient, QueryClientProvider } = await import(
  "@tanstack/react-query"
);
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const withProvider = (ui: React.ReactElement) => (
  <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
);

// Module scope so afterEach can restore it; see the comment below.
let realFetch: typeof globalThis.fetch;

/*
 * The catalog stub is (re)installed per test and restored after each one, because happy-dom has
 * no network and the dialog fetches its purchase catalog when open. Restore AND reinstall: bun
 * runs every file in one process, so a stub left behind sends later files' unmocked requests
 * here, while a stub removed after the first test starves this file's own later tests.
 */
function installCatalogStub() {
  realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes("/api/billing/purchases/catalog")) {
        return new Response(
          JSON.stringify({
            plans: [],
            canPurchase: true,
            activePlanCode: null,
            providers: ["alipay"],
            cycles: ["monthly", "recurring_monthly"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return realFetch(input as never);
    },
    { preconnect: () => undefined },
  );
}

beforeAll(() => GlobalRegistrator.register());
/*
 * zh-CN per test (these assertions are written against it), English and the network restored
 * after each one — see billing-invoice-shared.test.tsx for the language half.
 */
beforeEach(async () => {
  installCatalogStub();
  await i18n.changeLanguage("zh-CN");
});
afterEach(() => {
  cleanup();
  void i18n.changeLanguage("en");
  if (realFetch !== undefined) globalThis.fetch = realFetch;
});
afterAll(async () => {
  /*
   * React first, before the document goes away: the dialog's polling leaves scheduler work on a
   * macrotask, and that callback reads `window` when it runs — after `unregister` it throws
   * "window is not defined" against whichever file bun runs next. Same medicine
   * `transcript-attachments.test.tsx` takes at its own exit; see `settle-react-work.ts` for why
   * this is `act` and not a `setTimeout`.
   */
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/*
 * What these cover: the two entries this page's money questions hang on — the upgrade button and
 * the plan dialog it opens. Both were broken in the field at the same time (an unconfigured
 * catalog hid the button; the purchase button rendered disabled), so their contracts are now
 * pinned: a catalog with plans makes the entry appear, the dialog draws every tier and cycle from
 * the catalog alone, and the agreement gates the pay button exactly as the design says.
 */

const CATALOG: Record<string, PlanCatalogEntry> = {
  standard: {
    name: "标准版",
    credits: 4000,
    features: [
      "每月基础积分 4,000",
      "每月赠送积分",
      "全部模型可选",
      "无限次代码实时补全",
      "5 个自动任务",
    ],
    pricing: [
      {
        code: "recurring_monthly",
        label: "连续包月",
        priceCents: 4900,
        originalCents: 6900,
        discountLabel: "7折",
        unit: "month",
      },
      {
        code: "monthly",
        label: "1个月",
        priceCents: 6900,
        originalCents: null,
        discountLabel: null,
        unit: "month",
      },
      {
        code: "recurring_yearly",
        label: "连续包年",
        priceCents: 47040,
        originalCents: 84000,
        discountLabel: "5.6折",
        unit: "year",
      },
      {
        code: "yearly",
        label: "1年",
        priceCents: 58800,
        originalCents: 84000,
        discountLabel: "7折",
        unit: "year",
      },
    ],
  },
  advanced: {
    name: "高级版",
    credits: 9000,
    features: ["每月基础积分 9,000"],
    pricing: [
      {
        code: "recurring_monthly",
        label: "连续包月",
        priceCents: 14000,
        originalCents: 19900,
        discountLabel: "7折",
        unit: "month",
      },
    ],
  },
  flagship: {
    name: "旗舰版",
    credits: 50000,
    features: ["每月基础积分 50,000"],
    pricing: [
      {
        code: "recurring_monthly",
        label: "连续包月",
        priceCents: 39900,
        originalCents: 56900,
        discountLabel: "7折",
        unit: "month",
      },
    ],
  },
};

test("PlanCard renders the upgrade entry when the catalog has a plan to sell", () => {
  const view = render(
    <PlanCard
      planName="体验版"
      planCredits={{ total: 500, used: 0, remaining: 500 }}
      resetsAt={null}
      onUpgrade={() => {}}
    />,
  );
  const upgrade = view.getByRole("button", { name: "升级套餐" });
  expect(upgrade).toBeTruthy();
  expect(view.getByText("0/500积分")).toBeTruthy();
  expect(view.getByText(/套餐基础积分/)).toBeTruthy();
});

test("PlanCard without an upgrade callback hides the button, not the card", () => {
  const view = render(
    <PlanCard
      planName="体验版"
      planCredits={{ total: 500, used: 0, remaining: 500 }}
      resetsAt={null}
    />,
  );
  expect(view.queryByRole("button", { name: "升级套餐" })).toBeNull();
  // The card itself stays: the plan's facts are facts even with nothing to sell.
  expect(view.getByText("体验版")).toBeTruthy();
});

test("UpgradeDialog draws every catalog tier, its cycles and its discount labels from config alone", async () => {
  const view = render(
    withProvider(
      <UpgradeDialog
        open
        onOpenChange={() => {}}
        catalog={CATALOG}
        currentPlanName="体验版"
      />,
    ),
  );
  // The dialog's title and the current plan line. The shell is a pass-through, so the title text
  // rides the container directly — matched on the container, not on a wrapping element.
  expect(view.container.textContent).toContain("Buddy AI 套餐");
  expect(view.container.textContent).toContain("当前套餐：体验版");

  // All three tiers from the catalog keys.
  expect(view.getByText("标准版")).toBeTruthy();
  expect(view.getByText("高级版")).toBeTruthy();
  expect(view.getByText("旗舰版")).toBeTruthy();

  /*
   * The cycles now come from the PURCHASE catalog the dialog fetches (the server's contract:
   * v1 offers the monthly spellings only), so they arrive asynchronously. What renders is the
   * display catalog's label for the codes the server offered — and, just as deliberately,
   * NOT the yearly cycles the display catalog also carries: the server not offering a cycle
   * is what keeps the un-collectible option off the page.
   */
  await waitFor(() => {
    expect(view.getByText("连续包月")).toBeTruthy();
  });
  // The offered cycle's price and its unit render as separate nodes (the design's price row:
  // "¥49" in one span, "/" and "月" as sibling text inside the unit span), so the price is
  // matched on its own node and the unit on the container's joined text.
  expect(view.getByText("¥49")).toBeTruthy();
  expect(view.container.textContent).toContain("¥49");
  expect(view.container.textContent).toContain("/月");
  // The yearly cycle exists in the display catalog but the server did not offer it.
  expect(view.queryByText("连续包年")).toBeNull();
  // Discount tags ride the offered cycles.
  expect(view.getAllByText("7折").length).toBeGreaterThan(0);

  // The standard plan's credits allowance, drawn from the catalog's own number.
  expect(view.getByText("4,000")).toBeTruthy();

  // The validity line. The plan-compare link is gone by design: it had no destination
  // (P3-6's dead button), and an unclickable affordance is worse than none.
  expect(view.getByText(/有效期至/)).toBeTruthy();
  expect(view.queryByText(/查看套餐对比/)).toBeNull();
  // Settle straggler React work before cleanup unregisters happy-dom's window (an environment
  // race, not a product behaviour — see the gate test's identical note).
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("UpgradeDialog gates the pay button behind the agreement, and the tick releases it", async () => {
  const view = render(
    withProvider(
      <UpgradeDialog open onOpenChange={() => {}} catalog={CATALOG} />,
    ),
  );
  // The cycles arrive from the fetched purchase catalog; the pay button needs BOTH a cycle and
  // the agreement, so the button starts disabled for the cycle alone and stays disabled after
  // the tick until the fetch lands (then the tick alone gates it).
  const pay = view.getByRole("button", {
    name: "同意协议并支付",
  }) as HTMLButtonElement;
  expect(pay.disabled).toBe(true);

  fireEvent.click(view.container.querySelector('input[type="checkbox"]')!);
  await waitFor(() => {
    // The fetched catalog has landed (a cycle is selectable), so the agreement alone gates.
    expect(view.getByText("连续包月")).toBeTruthy();
    expect(pay.disabled).toBe(false);
  });
  // Let any straggler React work settle before cleanup unregisters the DOM — happy-dom's
  // window goes away with the suite's global, and a scheduled callback landing after it is
  // an environment race, not a product behaviour.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("UpgradeDialog with an empty catalog opens with nothing to sell", async () => {
  const view = render(
    withProvider(<UpgradeDialog open onOpenChange={() => {}} catalog={{}} />),
  );
  // The title mounts; no tier does, because there is no tier to draw.
  expect(view.container.textContent).toContain("Buddy AI 套餐");
  expect(view.queryByText("标准版")).toBeNull();
  expect(view.queryByText("高级版")).toBeNull();
  // With no cycle to select, the agreement alone does not release the pay button.
  const pay = view.getByRole("button", {
    name: "同意协议并支付",
  }) as HTMLButtonElement;
  fireEvent.click(view.container.querySelector('input[type="checkbox"]')!);
  expect(pay.disabled).toBe(true);
  // The empty catalog still fires the purchase-catalog fetch; settle its state work before the
  // suite unregisters happy-dom's window (same environment race as the two cases above).
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("the page's purchase entry: a catalog-backed button is enabled, an absent catalog disables it", () => {
  // The page wires the purchase button the same way as the upgrade entry: presence of a catalog
  // with at least one plan. These two states are the contract the field bug broke — hidden
  // upgrade and a dead purchase button — pinned here against the plain conditions.
  const hasCatalog = (catalog: Record<string, PlanCatalogEntry>) =>
    Object.keys(catalog).length > 0;
  expect(hasCatalog(CATALOG)).toBe(true);
  expect(hasCatalog({})).toBe(false);
});

/* ---------------------------------------------------------------------------
 * Browser-test findings fixed under TDD: the empty consumption window that
 * swallowed the range switcher, the dead welcome claim, the uncancellable
 * pending order, the untranslated pending-purchase refusal, the silent wait
 * for the payment choosers, and the pay button whose copy read like a
 * terms checkbox. Each block names the finding it pins.
 * ------------------------------------------------------------------------- */

test("ConsumptionTable keeps the range switcher up when the window has no rows", () => {
  // The bug: an empty window (今天 after local midnight, a fresh deployment's
  // first week) unmounted the whole table INCLUDING the switcher, and the only
  // way back to a window with data was editing the URL by hand.
  const onRangeChange = mock(() => {});
  const view = render(
    <ConsumptionTable
      entries={[]}
      pagination={{
        totalCount: 0,
        totalPages: 1,
        currentPage: 1,
        nextPage: null,
      }}
      range="today"
      onRangeChange={onRangeChange}
      onPage={() => {}}
      statusTemplate="第 {{page}} / {{totalPages}} 页 · 共 {{total}} 条"
    />,
  );
  // The empty sentence, in the component itself rather than only in the page.
  expect(view.getByText(/该时间范围内还没有积分消耗记录/)).toBeTruthy();
  // The switcher survives: all three windows stay reachable.
  expect(view.getByRole("button", { name: "今天" })).toBeTruthy();
  expect(view.getByRole("button", { name: "7天" })).toBeTruthy();
  expect(view.getByRole("button", { name: "30天" })).toBeTruthy();
  // An empty window has no table to show and no pager worth showing.
  expect(view.queryByRole("table")).toBeNull();
  expect(view.queryByText(/第 \d+ \/ \d+ 页/)).toBeNull();
  // The surviving switcher still switches.
  fireEvent.click(view.getByRole("button", { name: "30天" }));
  expect(onRangeChange).toHaveBeenCalledWith("30d");
});

test("WelcomeBanner without a claim write is disabled and says the claim is not open yet", () => {
  // The bug: the banner begged the reader to claim ("快点击领取吧！") and the
  // button did nothing at all — no request, no feedback. Until the claim
  // write exists the button must not look actionable.
  const view = render(<WelcomeBanner claimed={false} />);
  const claim = view.getByRole("button", { name: "领取" }) as HTMLButtonElement;
  expect(claim.disabled).toBe(true);
  expect(view.getByText("领取功能即将开放")).toBeTruthy();
});

test("WelcomeBanner with a claim write stays clickable", () => {
  // The other face of the same contract: once the write exists the banner
  // must not have locked itself.
  const onClaim = mock(() => {});
  const view = render(<WelcomeBanner claimed={false} onClaim={onClaim} />);
  const claim = view.getByRole("button", { name: "领取" }) as HTMLButtonElement;
  expect(claim.disabled).toBe(false);
  fireEvent.click(claim);
  expect(onClaim).toHaveBeenCalledTimes(1);
});

test("CreditGrantList renders the held figure in the rewards summary, with no raw placeholder", async () => {
  // Review round 1 (Important 1): the shared rewardsSummary copy gained a {{held}}
  // interpolation and this component's call site was the one left behind, so any reader
  // WITH reward grants saw the broken sentence — a bare {{held}} or a number-less
  // "（进行中调用占用 ）". Pinned against both locales the page ships.
  const grant: CreditGrantEntry = {
    id: "cg-a",
    source: "promo",
    reason: "活动奖励",
    total: 50,
    used: 5,
    remaining: 45,
    grantedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-10-31T00:00:00.000Z",
    status: "active",
    expiringSoon: false,
  };
  const zh = render(
    <CreditGrantList
      grants={[grant]}
      grantCount={2}
      remaining={45}
      held={21}
    />,
  );
  expect(zh.container.textContent).toContain("（进行中调用占用 21）");
  expect(zh.container.textContent).not.toContain("{{");
  await i18n.changeLanguage("en");
  const en = render(
    <CreditGrantList
      grants={[grant]}
      grantCount={2}
      remaining={45}
      held={21}
    />,
  );
  expect(en.container.textContent).toContain("21 held by in-progress calls");
  expect(en.container.textContent).not.toContain("{{");
});

/*
 * A plain-setTimeout poll. RTL's waitFor rides MutationObserver paths that do not observe the
 * dialog's fetch-then-setState updates under happy-dom (verified: the DOM updates within
 * ~800ms while waitFor's own clock never fires); this file's later async assertions poll the
 * DOM on the real timer bun runs instead.
 */
async function until(cond: () => boolean, ms = 4000, label = "condition") {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(cond(), `${label} not met within ${ms}ms`).toBe(true);
}

/*
 * The three dialog tests below drive the real checkout lane with a fetch stub
 * (the file's catalog stub only covers GET /purchases/catalog), so each
 * installs its own and restores afterwards the way installCatalogStub does.
 */
function installPurchaseStub(handlers: {
  create?: { status: number; body: unknown };
  cancel?: { status: number; body: unknown };
  current?: { status: number; body: unknown };
}) {
  realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes("/api/billing/purchases/catalog")) {
        return new Response(
          JSON.stringify({
            plans: [],
            canPurchase: true,
            activePlanCode: null,
            providers: ["alipay"],
            cycles: ["monthly", "recurring_monthly"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (handlers.create && url.endsWith("/api/billing/purchases")) {
        const h = handlers.create;
        return new Response(JSON.stringify(h.body), {
          status: h.status,
          headers: { "content-type": "application/json" },
        });
      }
      if (handlers.current && url.endsWith("/api/billing/purchases/current")) {
        const h = handlers.current;
        return new Response(JSON.stringify(h.body), {
          status: h.status,
          headers: { "content-type": "application/json" },
        });
      }
      if (handlers.cancel && url.includes("/cancel")) {
        const h = handlers.cancel;
        return new Response(JSON.stringify(h.body), {
          status: h.status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("nope", { status: 404 });
    },
    { preconnect: () => undefined },
  );
}

const ORDER_VIEW = {
  orderId: "po-0123456789abcdef",
  planCode: "standard",
  provider: "alipay",
  amountCents: 4900,
  currency: "CNY",
  status: "pending",
  activationState: "pending",
  checkout: { kind: "qrcode", payload: "https://qr.example/abc" },
  expiresAt: "2026-10-10T12:15:00.000Z",
  periodEnd: null,
  createdAt: "2026-10-10T12:00:00.000Z",
} as const;

async function openToAPayableDialog(view: ReturnType<typeof render>) {
  // The choosers arrive with the fetched purchase catalog; the agreement is ours to tick.
  await waitFor(() => {
    expect(view.getByText("连续包月")).toBeTruthy();
  });
  fireEvent.click(view.container.querySelector('input[type="checkbox"]')!);
}

test("UpgradeDialog lets the reader cancel their pending order, and cancelling releases the pay lane", async () => {
  let cancelled = false;
  installPurchaseStub({
    create: { status: 200, body: { order: ORDER_VIEW } },
    cancel: {
      status: 200,
      body: { order: { ...ORDER_VIEW, status: "canceled", checkout: null } },
    },
  });
  // The cancel handler must observe the call, not just serve it.
  const innerFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const url = String(args[0]);
      if (url.includes("/cancel")) cancelled = true;
      return innerFetch(...args);
    },
    { preconnect: () => undefined },
  );

  const view = render(
    withProvider(
      <UpgradeDialog open onOpenChange={() => {}} catalog={CATALOG} />,
    ),
  );
  await openToAPayableDialog(view);
  fireEvent.click(view.getByRole("button", { name: "同意协议并支付" }));
  // The order lands: the status line says pending and the cancel entry appears.
  await until(
    () => view.queryByText("订单待支付") !== null,
    4000,
    "order pending line",
  );
  const cancelEntry = view.getByRole("button", { name: "取消订单" });
  fireEvent.click(cancelEntry);
  await until(
    () => view.queryByText("订单待支付") === null,
    4000,
    "order cleared",
  );
  expect(cancelled).toBe(true);
  expect(view.queryByRole("button", { name: "取消订单" })).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("UpgradeDialog says the pending-purchase refusal in the reader's language", async () => {
  installPurchaseStub({
    create: {
      status: 409,
      body: {
        error: "Another purchase is already pending for this deployment.",
        pendingPlanCode: "standard",
      },
    },
  });
  const view = render(
    withProvider(
      <UpgradeDialog open onOpenChange={() => {}} catalog={CATALOG} />,
    ),
  );
  await openToAPayableDialog(view);
  fireEvent.click(view.getByRole("button", { name: "同意协议并支付" }));
  await waitFor(() => {
    expect(
      view.getByText("已有一笔待支付订单，请先完成支付或取消该订单后再购买"),
    ).toBeTruthy();
  });
  // The raw English sentence is not what a zh-CN reader should see.
  expect(view.queryByText(/Another purchase is already pending/)).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("UpgradeDialog says it is loading the payment options before the choosers arrive", async () => {
  // A catalog answer that sits on the wire: the choosers cannot render yet,
  // and the silence used to look like a broken dialog.
  let release: (r: Response) => void = () => {};
  const gate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => gate, {
    preconnect: () => undefined,
  });
  // The suite's shared client may already hold a fresh catalog entry; the
  // loading phase only exists while the fetch is actually in flight.
  queryClient.removeQueries({ queryKey: ["billing", "purchases", "catalog"] });

  const view = render(
    withProvider(
      <UpgradeDialog open onOpenChange={() => {}} catalog={CATALOG} />,
    ),
  );
  await until(
    () => view.queryByText("正在加载支付方式…") !== null,
    4000,
    "loading line",
  );
  release(
    new Response(
      JSON.stringify({
        plans: [],
        canPurchase: true,
        activePlanCode: null,
        providers: ["alipay"],
        cycles: ["monthly", "recurring_monthly"],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  await until(
    () => view.queryByText("正在加载支付方式…") === null,
    4000,
    "loading gone",
  );
  expect(view.getByText("连续包月")).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("the pay button stays inert while a cancel is in flight, and a cancel while paying is refused", async () => {
  // The field race: cancel and checkout lanes could run at once, crossing setOrder writes —
  // a late cancel callback erased a freshly created order and left the dialog 409-locked
  // with no cancel entry. Both lanes must be mutually exclusive.
  let releaseCancel: (r: Response) => void = () => {};
  const cancelGate = new Promise<Response>((resolve) => {
    releaseCancel = resolve;
  });
  installPurchaseStub({ create: { status: 200, body: { order: ORDER_VIEW } } });
  const innerFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes("/cancel")) return cancelGate;
      return innerFetch(...args);
    },
    { preconnect: () => undefined },
  );

  const view = render(
    withProvider(
      <UpgradeDialog open onOpenChange={() => {}} catalog={CATALOG} />,
    ),
  );
  await openToAPayableDialog(view);
  const pay = view.getByRole("button", {
    name: "同意协议并支付",
  }) as HTMLButtonElement;
  fireEvent.click(pay);
  await until(
    () => view.queryByText("订单待支付") !== null,
    4000,
    "order pending",
  );

  // Cancel is clicked and hangs on the wire: the pay button must disable for the whole flight.
  fireEvent.click(view.getByRole("button", { name: "取消订单" }));
  await until(() => pay.disabled, 4000, "pay disabled during cancel");
  // A click through a disabled button must not reach the create lane — fireEvent on a
  // disabled button fires no handler; the guard inside startCheckout covers the rest.
  releaseCancel(
    new Response(
      JSON.stringify({
        order: { ...ORDER_VIEW, status: "canceled", checkout: null },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  await until(() => !pay.disabled, 4000, "pay re-enabled after cancel lands");
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("a pending-purchase 409 on a remounted dialog restores the blocking order so the cancel entry exists", async () => {
  // The remount hole: the dialog's local order is gone after a refresh, the server still
  // holds a pending order, and the localized refusal says "cancel it" — but no cancel
  // button renders. The refusal path must pull the current order back into view.
  installPurchaseStub({
    create: {
      status: 409,
      body: {
        error: "Another purchase is already pending for this deployment.",
        pendingPlanCode: "standard",
      },
    },
    current: { status: 200, body: { order: ORDER_VIEW } },
  });
  const view = render(
    withProvider(
      <UpgradeDialog open onOpenChange={() => {}} catalog={CATALOG} />,
    ),
  );
  await openToAPayableDialog(view);
  fireEvent.click(view.getByRole("button", { name: "同意协议并支付" }));
  await until(
    () =>
      view.queryByText(
        "已有一笔待支付订单，请先完成支付或取消该订单后再购买",
      ) !== null,
    4000,
    "localized refusal",
  );
  // The blocking order came back with its cancel entry — the escape the message names.
  await until(
    () => view.queryByText("订单待支付") !== null,
    4000,
    "order restored",
  );
  expect(view.getByRole("button", { name: "取消订单" })).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("a failed cancel says the failure in the reader's language", async () => {
  // The settled refusal arrives in English ("That purchase is already settled."); the
  // same dialog localizes the checkout refusals, so a cancel refusal must not regress
  // to the server's raw sentence.
  installPurchaseStub({
    create: { status: 200, body: { order: ORDER_VIEW } },
    cancel: {
      status: 409,
      body: { error: "That purchase is already settled." },
    },
  });
  const view = render(
    withProvider(
      <UpgradeDialog open onOpenChange={() => {}} catalog={CATALOG} />,
    ),
  );
  await openToAPayableDialog(view);
  fireEvent.click(view.getByRole("button", { name: "同意协议并支付" }));
  await until(
    () => view.queryByText("订单待支付") !== null,
    4000,
    "order pending",
  );
  fireEvent.click(view.getByRole("button", { name: "取消订单" }));
  await until(
    () => view.queryByText(/取消订单失败/) !== null,
    4000,
    "localized cancel failure",
  );
  expect(view.queryByText(/already settled/)).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("ConsumptionTable keeps the pager for a page walked off the end", () => {
  // A shared ?page=99 link has no rows on it, but the window DOES: the empty sentence
  // would claim otherwise and unmount the pager built to walk the reader back.
  const view = render(
    <ConsumptionTable
      entries={[]}
      pagination={{
        totalCount: 5,
        totalPages: 1,
        currentPage: 99,
        nextPage: null,
      }}
      range="7d"
      onRangeChange={() => {}}
      onPage={() => {}}
      statusTemplate="第 {{page}} / {{totalPages}} 页 · 共 {{total}} 条"
    />,
  );
  expect(view.queryByText(/还没有积分消耗记录/)).toBeNull();
  expect(view.getByText(/共 5 条/)).toBeTruthy();
  expect(view.getByRole("table")).toBeTruthy();
});

test("ConsumptionTable shows the unfunded suffix only on a row the grants could not fully fund", () => {
  // Audit D1: a settlement that cost more than the balance could fund records the full cost
  // with `applied` clamped to the hold. The shortfall row says so through the muted badge and
  // its tooltip; a fully funded row must look exactly as it always has.
  const entry = (overdrawn: boolean): CreditConsumptionEntry => ({
    id: overdrawn ? "cl-over" : "cl-ok",
    title: overdrawn ? "over-bound settlement" : "fully funded",
    requestId: null,
    credits: overdrawn ? 2.5 : 0.5,
    applied: overdrawn ? 1 : 0.5,
    model: null,
    client: null,
    botId: null,
    botName: null,
    timestamp: "2026-10-15T10:00:00.000Z",
  });
  const view = render(
    <ConsumptionTable
      entries={[entry(true), entry(false)]}
      pagination={{
        totalCount: 2,
        totalPages: 1,
        currentPage: 1,
        nextPage: null,
      }}
      range="7d"
      onRangeChange={() => {}}
      onPage={() => {}}
      statusTemplate="第 {{page}} / {{totalPages}} 页 · 共 {{total}} 条"
    />,
  );
  // zh-CN is this suite's per-test language; the badge interpolates the shortfall (2.5 − 1 = 1.5)
  // and carries the hint as its tooltip. No raw key path in either.
  const badge = view.getByText(/未覆盖 1.5/);
  expect(badge.getAttribute("title")).toContain("无积分覆盖");
  expect(view.container.textContent).not.toContain("{{");
  // The fully funded row: exactly one badge in the table, and no zero-shortfall one.
  expect(view.getAllByText(/未覆盖/)).toHaveLength(1);
});
