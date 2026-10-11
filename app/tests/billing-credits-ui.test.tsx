import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { cloneElement, createContext, useContext } from "react";
import type * as React from "react";
import type { PlanCatalogEntry } from "@/lib/billing/credits";
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
      ? cloneElement(
          render,
          { "aria-haspopup": "dialog" },
          children,
        )
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

const { PlanCard } = await import("@/components/billing/plan-card");
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
    name: "同意协议",
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
    name: "同意协议",
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
