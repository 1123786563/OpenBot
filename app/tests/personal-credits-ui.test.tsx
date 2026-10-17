import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type * as React from "react";
import type { ReactNode } from "react";
import { cloneElement, createContext, useContext } from "react";
import i18n from "@/lib/i18n";
import { settleReactWork } from "./settle-react-work";

/* The close affordance is threaded through context rather than props, the way the real Dialog's
 * Close button asks the root to close — see billing-credits-ui.test.tsx, whose mock this is. */
const CloseContext = createContext<() => void>(() => {});

/*
 * Bifrost 02.7 (#221): the person's own balance view on the 套餐与积分 page.
 *
 * What the page owes — per the ticket's acceptance criteria — is exactly what this file pins:
 *
 * - the signed-in reader sees their OWN available / consumed / expired credits, the in-progress
 *   holds, and the account type the server names (AC01);
 * - a failed credits read renders an error and a way back — never a zero balance dressed up as
 *   data (the field failure this page once had: `summary.data?.plan ?? 0` silently minted zeros
 *   when the server's contract shape changed);
 * - an account with no records says so in words, instead of showing a misleading bare 0;
 * - the page never sends an account identifier of any kind — the account is decided server-side
 *   from the session (02.6 answers 400 to any request that names one), so the client must not
 *   even ask.
 *
 * The network is a stub serving the 02.6 contract (`PersonalCreditBalance`, see
 * server/src/billing/types.ts), so the page is asserted against what a real server answers; the
 * route contracts themselves are pinned server-side in server/tests/personal-credits-read.test.ts.
 */

/* Base UI dialogs never mount under happy-dom (the portal rides browser transition APIs the DOM
 * shim does not implement), so the dialog shell is replaced with a SHAPE-COMPATIBLE passthrough —
 * the same mock billing-credits-ui.test.tsx installs, because mock.module is registry-level and
 * OUTLIVES THIS FILE: a simpler shell registered here would clobber the richer semantics later
 * files (dialog-heavy suites like bot-approval-rules) rely on — a closed dialog must mount
 * nothing, a trigger's child always renders, and DialogContent keeps a real close button.
 * Content renders inline instead of into a portal — the only part happy-dom cannot do. */
mock.module("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => children ?? null;
  const DialogTriggerMock = ({
    children,
    render,
  }: {
    children?: ReactNode;
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
    children?: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    const array = (Array.isArray(children) ? children : [children]).filter(
      Boolean,
    );
    const triggers = array.filter(isTrigger);
    const rest = array.filter((child) => !isTrigger(child));
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
  const DialogContent = ({ children }: { children?: ReactNode }) => {
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
    DialogTitle: ({ children }: { children?: ReactNode }) => (
      <h2>{children}</h2>
    ),
    DialogDescription: ({ children }: { children?: ReactNode }) => (
      <p>{children}</p>
    ),
    DialogClose: pass,
    DialogOverlay: pass,
    DialogPortal: pass,
    DialogTrigger: DialogTriggerMock,
  };
});

const { UsageCreditsView } = await import(
  "@/components/billing/usage-credits-view"
);
const { PersonalBalanceCard } = await import(
  "@/components/billing/personal-balance-card"
);

beforeAll(async () => {
  GlobalRegistrator.register();
  await i18n.changeLanguage("zh-CN");
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  await i18n.changeLanguage("en");
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;

/** The 02.6 wire contract, as the server builds it (PersonalCreditBalance). */
type BalanceFixture = {
  accountType: "personal";
  available: number;
  consumed: number;
  expired: number;
  held: number;
  grants: Array<{
    id: string;
    source: "plan" | "promo" | "signin";
    reason: string | null;
    total: number;
    used: number;
    remaining: number;
    grantedAt: string;
    expiresAt: string;
    status: "active" | "exhausted" | "expired";
    expiringSoon: boolean;
  }>;
  pendingSettlement: {
    enabled: false;
    available: 0;
    consumed: 0;
    expired: 0;
  };
};

const BALANCE: BalanceFixture = {
  accountType: "personal",
  available: 12.5,
  consumed: 3.2,
  expired: 0.75,
  held: 1,
  grants: [
    {
      id: "cg-live",
      source: "promo",
      reason: "活动奖励",
      total: 50,
      used: 5,
      remaining: 45,
      grantedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-31T00:00:00.000Z",
      status: "active",
      expiringSoon: false,
    },
    {
      id: "cg-spent",
      source: "signin",
      reason: null,
      total: 10,
      used: 10,
      remaining: 0,
      grantedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-30T00:00:00.000Z",
      status: "exhausted",
      expiringSoon: false,
    },
  ],
  pendingSettlement: { enabled: false, available: 0, consumed: 0, expired: 0 },
};

const EMPTY_BALANCE: BalanceFixture = {
  accountType: "personal",
  available: 0,
  consumed: 0,
  expired: 0,
  held: 0,
  grants: [],
  pendingSettlement: { enabled: false, available: 0, consumed: 0, expired: 0 },
};

/** Every URL the page asked for, for the no-account-identifier assertion. */
let requestedUrls: string[] = [];

type Stub = { status: number; body: unknown } | undefined;

function installFetchStub(overrides: {
  summary?: Stub;
  grants?: Stub;
  entitlements?: Stub;
}) {
  requestedUrls = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
  ): Promise<Response> => {
    const url = String(input);
    requestedUrls.push(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.startsWith("/api/billing/credits/summary")) {
      const o = overrides.summary;
      return o ? json(o.body, o.status) : json(BALANCE);
    }
    if (url.startsWith("/api/billing/credits/grants")) {
      const o = overrides.grants;
      if (o) return json(o.body, o.status);
      return json({ grants: BALANCE.grants });
    }
    if (url.startsWith("/api/billing/credits/consumption")) {
      return json({
        entries: [],
        pagination: {
          totalCount: 0,
          totalPages: 1,
          currentPage: 1,
          nextPage: null,
        },
      });
    }
    if (url.startsWith("/api/billing/entitlements")) {
      const o = overrides.entitlements;
      return o
        ? json(o.body, o.status)
        : json({
            active: false,
            planCode: "trial",
            codes: [],
            subscription: null,
          });
    }
    if (url.startsWith("/api/billing/catalog")) return json({});
    // The upgrade dialog stays closed here; anything else has no business being asked.
    return json({ error: "not stubbed" }, 404);
  }) as typeof fetch;
}

function renderView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <UsageCreditsView
        range="7d"
        page={1}
        onRangeChange={() => {}}
        onPage={() => {}}
      />
    </QueryClientProvider>,
  );
}

test("个人余额页渲染账户类型、可用/已消费/已过期与待结算未启用", async () => {
  installFetchStub({});
  const view = renderView();

  await view.findByTestId("personal-balance");
  // The account is named: the server said "personal", the page says it in the reader's language.
  expect(view.getByTestId("account-type").textContent).toBe("个人账户");
  // The three balance figures the ticket names, plus the holds the gate lives by — all four from
  // the one server answer, formatted as credits.
  const card = view.getByTestId("personal-balance").textContent ?? "";
  expect(card).toContain("12.5");
  expect(card).toContain("3.2");
  expect(card).toContain("0.75");
  expect(card).toContain("1");
  // Pending settlement is group 06's lane: 未启用, spelled out — never a bare 0.
  const pending = view.getByTestId("pending-settlement").textContent ?? "";
  expect(pending).toContain("待结算");
  expect(pending).toContain("未启用");
  expect(pending).not.toMatch(/待结算[：:]\s*0/);
  // The grant rows render with their lives, and the rewards summary line is derived from the
  // balance (1 grant still spendable, the account's own available and held figures).
  expect(view.getByText("5/50积分")).toBeTruthy();
  expect(view.getByText("10/10积分")).toBeTruthy();
  expect(view.getByText("使用中")).toBeTruthy();
  expect(view.getByText("已用完")).toBeTruthy();
  expect(view.container.textContent).toContain(
    "1 个奖励，可用 12.5（进行中调用占用 1）",
  );
  expect(view.container.textContent).not.toContain("{{");
});

test("接口失败时显示错误提示，不渲染 0 余额", async () => {
  installFetchStub({
    summary: { status: 500, body: { error: "积分台账暂不可用" } },
  });
  const view = renderView();

  await view.findAllByRole("alert");
  expect(
    view
      .getAllByRole("alert")
      .some((node) => node.textContent?.includes("积分台账暂不可用")),
  ).toBe(true);
  // No balance card, therefore no balance figure: the failure is a sentence and a way back.
  expect(view.queryByTestId("personal-balance")).toBeNull();
  expect(view.queryByText("已消费")).toBeNull();
  expect(view.queryByText("进行中占用")).toBeNull();
  // Every section that needed the failed read offers the way back (subscription, balance,
  // rewards each render their own LoadError); at least one retry button must exist.
  expect(view.getAllByRole("button", { name: "重试" }).length).toBeGreaterThan(
    0,
  );
});

test("无发放记录时显示明确空态文案", async () => {
  installFetchStub({
    summary: { status: 200, body: EMPTY_BALANCE },
    grants: { status: 200, body: { grants: [] } },
  });
  const view = renderView();

  await view.findByTestId("personal-balance");
  // The grant block says "none" in words…
  expect(view.getByText("暂无奖励积分。")).toBeTruthy();
  // …and the card marks the all-zero ledger as "no records" instead of letting 0 impersonate data.
  expect(view.getByTestId("empty-ledger").textContent).toContain(
    "还没有积分记录",
  );
});

test("页面请求不携带任何账户标识参数", async () => {
  installFetchStub({});
  const view = renderView();
  await view.findByTestId("personal-balance");
  // Let the consumption window's request land too, then audit every URL the page asked for.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const identity =
    /userid|externalcustomerid|payerid|accountid|companyid|tenantid/i;
  const offenders = requestedUrls.filter((url) => identity.test(url));
  expect(offenders, JSON.stringify(offenders)).toEqual([]);
  // And the page did ask for its own balance by path alone — no account naming anywhere.
  expect(
    requestedUrls.some((url) => url.startsWith("/api/billing/credits/summary")),
  ).toBe(true);
});

test("billing 未启用时显示部署不可用空态", async () => {
  installFetchStub({ summary: { status: 404, body: { error: "nope" } } });
  const view = renderView();

  await view.findByText("此部署未启用计费");
  expect(view.queryByTestId("personal-balance")).toBeNull();
  expect(view.queryByText("已消费")).toBeNull();
});

test("PersonalBalanceCard 把待结算占位渲染为未启用而不是 0", () => {
  const view = render(<PersonalBalanceCard balance={EMPTY_BALANCE} />);
  expect(view.getByTestId("account-type").textContent).toBe("个人账户");
  const pending = view.getByTestId("pending-settlement").textContent ?? "";
  expect(pending).toContain("未启用");
  expect(pending).not.toMatch(/待结算[：:]\s*0/);
  // An all-zero ledger with no grants says so in words beside the (true) zeros.
  expect(view.getByTestId("empty-ledger").textContent).toContain(
    "还没有积分记录",
  );
});
