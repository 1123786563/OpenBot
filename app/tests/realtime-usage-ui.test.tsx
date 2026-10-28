import "./preload";
/*
 * The runner comes straight from bun:test — the same door the sibling personal-credits-ui
 * suite uses, and the one the ticket's prescribed verification command names (`bun test
 * app/tests/realtime-usage-ui.test.tsx`). The module-level stubs and the happy-dom
 * registration below are the bun:test shapes; the e2e-compat runner cannot collect app
 * suites in this worktree, so the file pins the runner that actually executes.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
  test,
} from "../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type * as React from "react";
import type { ReactNode } from "react";
import { cloneElement, createContext, useContext } from "react";
import i18n from "@/lib/i18n";
import { settleReactWork } from "./settle-react-work";

/* The close affordance is threaded through context rather than props, the way the real Dialog's
 * Close button asks the root to close — the same mock billing-credits-ui.test.tsx installs,
 * because mock.module is registry-level and OUTLIVES THIS FILE. */
const CloseContext = createContext<() => void>(() => {});

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
  const Dialog = ({
    children,
    onOpenChange,
  }: {
    children?: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    const close = useContext(CloseContext);
    return (
      <div data-testid="dialog-root">
        {children}
        <button
          type="button"
          onClick={() => (onOpenChange ? onOpenChange(false) : close())}
        >
          close
        </button>
      </div>
    );
  };
  const DialogContent = ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => (
    <div className={className} data-testid="dialog-content">
      {children}
    </div>
  );
  const DialogClose = ({
    render,
  }: {
    render?: React.ReactElement<Record<string, unknown>>;
  }) => (render ? cloneElement(render, { "data-dialog-close": "true" }) : null);
  return {
    Dialog,
    DialogTrigger: DialogTriggerMock,
    DialogContent,
    DialogBody: pass,
    DialogClose,
    DialogHeader: pass,
    DialogFooter: pass,
    DialogTitle: pass,
    DialogDescription: pass,
  };
});

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

/* The personal context's scope (MT097), the same shape the sibling personal-credits-ui
 * harness hands the view: the reads hit the /api/billing paths the stubs answer. */
const scopedCachePrefixMod = await import(
  "@/lib/enterprise/tenant/scoped-cache"
);
const PERSONAL_SCOPE = {
  status: "open" as const,
  userId: "ui-test-user",
  selection: null,
  generation: 1,
  prefix: scopedCachePrefixMod.scopedCachePrefix("ui-test-user", null),
  key: "ui-test-user:personal",
};

/*
 * Bifrost 15.8 (#321): the realtime session rows on the 套餐与积分 page.
 *
 * What this file pins, per the ticket's AC3/AC4:
 *
 * - the reader sees each of their realtime sessions' consumption and the amount awaiting
 *   settlement, formatted as credits from the server's ×100 integers;
 * - an abnormal session says WHY as a sentence mapped from the doors' own closed codes
 *   (15.5's stop, 15.6's close) — the raw stable code never reaches the DOM, and a code the
 *   mapping does not know reads as the fallback sentence, not as itself;
 * - the rows rendered are exactly the sessions the server's answer carries — the payload is
 *   the person's own (the account is resolved server-side), so nothing here filters and
 *   nothing fabricates: a payload of three renders three, a payload of none renders the
 *   empty sentence;
 * - a realtime surface the deployment does not answer hides the section rather than dressing
 *   an error up as an empty list.
 */

type SessionFixture = {
  sessionId: string;
  provider: string;
  model: string;
  startedAt: string;
  state: "open" | "closed";
  stopped: boolean;
  closed: boolean;
  abnormal: {
    kind: "stopped" | "closed";
    reason: string;
    at: string;
  } | null;
  units: { settled: number; holding: number; unknown: number; refused: number };
  consumedCents: number;
  pendingCents: number;
};

const HEALTHY: SessionFixture = {
  sessionId: "rs-ui-healthy",
  provider: "openai",
  model: "gpt-realtime",
  startedAt: "2026-10-22T08:00:00.000Z",
  state: "open",
  stopped: false,
  closed: false,
  abnormal: null,
  units: { settled: 1, holding: 1, unknown: 0, refused: 0 },
  consumedCents: 1_234,
  pendingCents: 10_000,
};

const STOPPED: SessionFixture = {
  sessionId: "rs-ui-stopped",
  provider: "openai",
  model: "gpt-realtime",
  startedAt: "2026-10-22T07:30:00.000Z",
  state: "open",
  stopped: true,
  closed: false,
  abnormal: {
    kind: "stopped",
    reason: "insufficient_credits",
    at: "2026-10-22T07:31:00.000Z",
  },
  units: { settled: 0, holding: 0, unknown: 0, refused: 1 },
  consumedCents: 0,
  pendingCents: 0,
};

/** A closed session whose reason code the mapping does not know — the fallback's case. */
const CLOSED_UNMAPPED: SessionFixture = {
  sessionId: "rs-ui-closed-future",
  provider: "openai",
  model: "gpt-realtime",
  startedAt: "2026-10-22T06:00:00.000Z",
  state: "closed",
  stopped: false,
  closed: true,
  abnormal: {
    kind: "closed",
    reason: "a_future_code",
    at: "2026-10-22T06:05:00.000Z",
  },
  units: { settled: 0, holding: 0, unknown: 1, refused: 0 },
  consumedCents: 0,
  pendingCents: 5_000,
};

const BALANCE = {
  accountType: "personal",
  /*
   * BP07 (#375) made the account-level capability part of the balance answer the card reads
   * off directly — non-optional on the wire (PersonalCreditBalance.account), the same shape
   * the sibling personal-credits-ui fixture carries. This fixture's sessions belong to an
   * ordinary active account; the quarantined rendering has its own case below.
   */
  account: { status: "active", quarantineReason: null },
  available: 0,
  consumed: 0,
  expired: 0,
  held: 0,
  grants: [],
  pendingSettlement: {
    enabled: true,
    available: 0,
    consumed: 0,
    expired: 0,
    reserved: 0,
    unknown: 0,
    reservations: [],
  },
};

function installFetchStub(
  realtime: { status: number; body: unknown },
  balance: unknown = BALANCE,
) {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = (async (
    input: string | URL | Request,
  ): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("/api/billing/credits/summary")) return json(balance);
    if (url.startsWith("/api/billing/credits/grants"))
      return json({ grants: [] });
    if (url.startsWith("/api/billing/credits/consumption"))
      return json({
        entries: [],
        pagination: {
          totalCount: 0,
          totalPages: 1,
          currentPage: 1,
          nextPage: null,
        },
      });
    if (url.startsWith("/api/billing/credits/realtime-sessions"))
      return json(realtime.body, realtime.status);
    if (url.startsWith("/api/billing/entitlements"))
      return json({
        active: false,
        planCode: "trial",
        codes: [],
        subscription: null,
      });
    if (url.startsWith("/api/billing/catalog")) return json({});
    return json({ error: "not stubbed" }, 404);
  }) as typeof fetch;
}

const { UsageCreditsView } = await import(
  "@/components/billing/usage-credits-view"
);

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
        scope={PERSONAL_SCOPE}
      />
    </QueryClientProvider>,
  );
}

test("实时会话行渲染消费、待结算与异常原因，原始代码不进 DOM", async () => {
  installFetchStub({
    status: 200,
    body: { sessions: [HEALTHY, STOPPED, CLOSED_UNMAPPED] },
  });
  const view = renderView();

  const rows = await view.findAllByTestId("realtime-session-row");
  expect(rows).toHaveLength(3);

  // The healthy session: its consumption and the amount awaiting settlement, formatted as
  // credits from the server's ×100 integers (12.34 and 100).
  const healthy = rows.find(
    (row) =>
      row.getAttribute("data-session-state") === "open" &&
      row.textContent?.includes("12.34"),
  );
  expect(healthy).toBeDefined();
  expect(healthy?.textContent).toContain("100");

  // The stopped session says why in the reader's words — the door's closed code mapped to
  // its sentence, and the raw code itself never reaches the DOM.
  const statuses = view
    .getAllByTestId("realtime-session-status")
    .map((node) => node.textContent ?? "");
  expect(statuses).toContain("已停止——账户余额耗尽");
  expect(document.body.textContent).not.toContain("insufficient_credits");

  // The unmapped closed reason reads as the fallback sentence — honest without diagnosing —
  // and the unknown code never reaches the DOM either.
  expect(statuses).toContain("该会话正在对账，完成后会更新。");
  expect(document.body.textContent).not.toContain("a_future_code");
});

test("空载荷渲染空句，不伪造行", async () => {
  installFetchStub({ status: 200, body: { sessions: [] } });
  const view = renderView();
  expect(await view.findByText("暂无实时会话。")).toBeTruthy();
  expect(view.queryAllByTestId("realtime-session-row")).toHaveLength(0);
});

test("实时面不可用时整节隐藏，不把错误装扮成空列表", async () => {
  installFetchStub({
    status: 503,
    body: { error: "Realtime usage is unavailable." },
  });
  const view = renderView();
  await view.findByText("个人积分账户");
  // The realtime section is absent — no title, no empty sentence, no error dressed as data.
  expect(view.queryByText("实时会话")).toBeNull();
  expect(view.queryByText("暂无实时会话。")).toBeNull();
});

/*
 * BP07 (#375): a quarantined account's capabilities are unavailable, said as the fixed
 * sentence — the row's raw quarantine reason is the operator's diagnosis and never reaches
 * the reader's page (the card's own redaction). The sibling personal-credits-ui suite pins
 * this on the card component directly; this case carries it through the page's own summary
 * read, the door these stubs answer.
 */
test("隔离账户的能力徽标是固定句，原始隔离原因不进 DOM", async () => {
  installFetchStub(
    { status: 200, body: { sessions: [] } },
    {
      ...BALANCE,
      account: {
        status: "quarantined",
        quarantineReason: "legacy key with unknown attribution",
      },
    },
  );
  const view = renderView();

  const badge = await view.findByTestId("account-capability");
  expect(badge.textContent).toContain("能力暂不可用");
  // innerHTML, not textContent: the raw reason must also be absent from the attribute
  // channel (title/data-*/aria-label serializations), which textContent cannot see.
  expect(document.body.innerHTML).not.toContain(
    "legacy key with unknown attribution",
  );
});
