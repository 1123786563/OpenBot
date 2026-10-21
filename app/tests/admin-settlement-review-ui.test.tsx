import "./preload";
import { afterAll, afterEach, beforeAll, expect, test } from "../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import i18n from "@/lib/i18n";
import { settleReactWork } from "./settle-react-work";

/*
 * Bifrost #283 (08.8): the administrator's settlement-anomaly review card. What this file
 * pins — before any styling question — is the ticket's shape for the PAGE half:
 *
 * - the card reads the ticket's contract route GET /api/admin/billing/recovery-items and
 *   renders what the server answered: the account, the ceiling (scaled units ÷100), the
 *   dwell, the failure count, the stable reason code, and the evidence 08.5 recorded;
 * - THE VIEW HAS NO WRITE SURFACE: no button, no form, no mutation — there is nothing to
 *   click that could settle, release or nudge a hold, because the disposal is 08.9's
 *   separately authorized command, never a button on the review page;
 * - the request the card makes is a bare GET (no method, no body): a read is the only
 *   verb this surface owns;
 * - empty and failure states render the server's own sentences, never a silent reset.
 */

const { BillingRecoveryReviewCard } = await import(
  "@/components/admin/billing-recovery-review-card"
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

type CapturedRequest = { url: string; method: string | undefined; body: unknown };

function installFetchStub(responder: () => Response) {
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push({
      url: String(input),
      method: init?.method,
      body: init?.body,
    });
    return responder();
  }) as typeof fetch;
  return requests;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BillingRecoveryReviewCard />
    </QueryClientProvider>,
  );
}

const oneItem = {
  generatedAt: "2026-10-20T08:00:00.000Z",
  items: [
    {
      itemId: "cri-abc123",
      attemptId: "bfat-def456",
      reservationId: "cr-789",
      accountRef: "openbot-personal-user-jia",
      payerKind: "personal",
      payerId: "user-jia",
      provider: "openai",
      model: "gpt-4o",
      maximumCredits: 500,
      failureCount: 2,
      lastReason: "dispatch_result_unknown",
      state: "pending",
      detectedAt: "2026-10-20T05:00:00.000Z",
      dwellSeconds: 3 * 3600 + 5 * 60,
      evidence: [
        {
          conclusion: "still_unknown",
          source: "fake-provider-log",
          summary: "provider log lookup: no rows",
          usageInput: null,
          usageOutput: null,
          queriedAt: "2026-10-20T07:00:00.000Z",
        },
        {
          conclusion: "settled_evidence",
          source: "fake-provider-log",
          summary: "job j-9 completed on second look",
          usageInput: 900,
          usageOutput: 210,
          queriedAt: "2026-10-20T07:30:00.000Z",
        },
      ],
    },
  ],
};

test("渲染归属账户、金额上限、停留时长、失败次数、原因与证据", async () => {
  installFetchStub(() => json(oneItem));
  const view = renderCard();

  const list = await view.findByTestId("recovery-review-list");
  expect(list.textContent).toContain("openbot-personal-user-jia");
  // 500 scaled units → 5.00 credits, the ledger's own arithmetic.
  expect(list.textContent).toContain("5.00");
  expect(list.textContent).toContain("3h 5m");
  expect(list.textContent).toContain("dispatch_result_unknown");
  const evidence = await view.findAllByTestId("recovery-review-evidence");
  expect(evidence).toHaveLength(2);
  expect(list.textContent).toContain("provider log lookup: no rows");
  expect(list.textContent).toContain("900/210");
});

test("严格只读：卡片只发一个裸 GET，页面没有任何按钮或写控件", async () => {
  const requests = installFetchStub(() => json(oneItem));
  const view = renderCard();

  await view.findByTestId("recovery-review-list");
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]?.url).toBe("/api/admin/billing/recovery-items");
  // A bare GET: no method, no body — a read is the only verb this surface owns.
  expect(requests[0]?.method).toBeUndefined();
  expect(requests[0]?.body).toBeUndefined();
  // And nothing to click: no button anywhere on the card (the footer says why).
  expect(view.queryByRole("button")).toBeNull();
  expect(view.getByTestId("recovery-review-list").textContent).toContain(
    "严格只读",
  );
});

test("空队列渲染空态，失败渲染服务器的句子而不是静默重置", async () => {
  installFetchStub(() => json({ generatedAt: "2026-10-20T08:00:00Z", items: [] }));
  const empty = renderCard();
  expect(await empty.findByTestId("recovery-review-empty")).toBeTruthy();
  cleanup();

  installFetchStub(() => json({ error: "no" }, 503));
  const failed = renderCard();
  const alert = await failed.findByRole("alert");
  expect(alert.textContent).toContain("异常结算核查数据加载失败");
});
