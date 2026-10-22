import "./preload";
/*
 * The runner comes straight from bun:test — the same door the sibling personal-credits-ui
 * suite uses, and the one the ticket's prescribed verification command names (`bun test
 * app/tests/async-jobs-ui.test.tsx`). The happy-dom registration below is the bun:test
 * shape; the e2e-compat runner cannot collect app suites in this worktree (its node
 * target lacks the runtime the preload needs), so the file pins the runner that executes.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import i18n from "@/lib/i18n";
import { settleReactWork } from "./settle-react-work";

/*
 * Bifrost 17.8 (#332): the person's own async jobs page.
 *
 * What the page owes — per the ticket's acceptance criteria — is exactly what this file
 * pins:
 *
 * - the five row states render with their status word, their reason sentence and their
 *   amounts (AC1/AC3): queued and pending-settlement carry the money lanes' own reason
 *   codes through 08.7's vocabulary table, and every row shows the cap, the settled
 *   charge and the amount awaiting settlement;
 * - the page never sends an account identifier of any kind (AC4's 他人任务不可见 half —
 *   the server scopes the answer to the session, so the client must not even ask);
 * - a job submitted under a key that has since expired still renders on its owner's page
 *   with its ORIGINAL attribution (AC2): the row carries the frozen owner the server's
 *   read answered, never the key's live state.
 *
 * The network is a stub serving the 17.8 server contract (`AsyncJobUsage`, see
 * server/src/billing/async-jobs-view.ts); the read's ownership rules themselves are pinned
 * server-side in server/tests/async-jobs-view.test.ts.
 */

const { AsyncJobsView } = await import("@/components/billing/async-jobs-view");

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

/*
 * The personal context's scope (MT097): the jobs read goes through the scoped seam, so the
 * harness hands it the no-selection scope a person without a company selection holds — the
 * read still hits the same /api/billing path the stub answers.
 */
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

/** One job row as the 17.8 server contract builds it. */
type JobFixture = {
  jobId: string;
  providerJobId: string | null;
  model: { provider: string; model: string; capability: string };
  createdAt: string;
  dispatchedAt: string | null;
  status:
    | "queued"
    | "running"
    | "pending-settlement"
    | "settled"
    | "refused"
    | "cancelled";
  statusReason: string | null;
  attribution: { grantId: string; payerKind: string; payerId: string };
  maximumCents: number;
  settledCents: number;
  pendingCents: number;
};

function job(
  jobId: string,
  overrides: Partial<JobFixture> = {},
): JobFixture {
  return {
    jobId,
    providerJobId: `prov-${jobId}`,
    model: { provider: "openai", model: `sora-${jobId}`, capability: "video" },
    createdAt: "2026-10-22T10:00:00.000Z",
    dispatchedAt: "2026-10-22T10:00:01.000Z",
    status: "running",
    statusReason: null,
    attribution: {
      grantId: "grant-expired-since",
      payerKind: "personal",
      payerId: "ui-test-user",
    },
    maximumCents: 6_001,
    settledCents: 0,
    pendingCents: 6_001,
    ...overrides,
  };
}

/** Every URL the page asked for, for the no-account-identifier assertion. */
let requestedUrls: string[] = [];

function installFetchStub(jobs: JobFixture[]) {
  requestedUrls = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
  ): Promise<Response> => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.startsWith("/api/billing/credits/async-jobs")) {
      return new Response(JSON.stringify({ jobs }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // The jobs page asks for its one path; anything else has no business being asked.
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function renderView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AsyncJobsView scope={PERSONAL_SCOPE} />
    </QueryClientProvider>,
  );
}

test("五种行状态渲染：状态词、待结算原因与金额", async () => {
  installFetchStub([
    job("aj-queued", {
      status: "queued",
      providerJobId: null,
      dispatchedAt: null,
      statusReason: "async_dispatch_answer_lost",
    }),
    job("aj-running"),
    job("aj-pending", {
      status: "pending-settlement",
      statusReason: "async_cancel_result_unknown",
    }),
    job("aj-settled", {
      status: "settled",
      settledCents: 2_500,
      pendingCents: 0,
    }),
    job("aj-cancelled", {
      status: "cancelled",
      pendingCents: 0,
      statusReason: null,
    }),
  ]);
  const view = renderView();

  const rows = await view.findAllByTestId("async-job-row");
  expect(rows).toHaveLength(5);

  const byStatus = new Map(
    rows.map((row) => [row.dataset.status, row]),
  );

  // The status words — the code table's own vocabulary, in the reader's language.
  expect(byStatus.get("queued")?.querySelector('[data-testid="async-job-status"]')?.textContent).toBe("排队中");
  expect(byStatus.get("running")?.querySelector('[data-testid="async-job-status"]')?.textContent).toBe("运行中");
  expect(byStatus.get("pending-settlement")?.querySelector('[data-testid="async-job-status"]')?.textContent).toBe("待结算");
  expect(byStatus.get("settled")?.querySelector('[data-testid="async-job-status"]')?.textContent).toBe("已结算");
  expect(byStatus.get("cancelled")?.querySelector('[data-testid="async-job-status"]')?.textContent).toBe("已取消");

  // 待结算任务显示可理解原因: the waiting states carry 08.7's sentences for the money
  // lanes' own codes — the raw code never renders.
  const reasons = view.getAllByTestId("async-job-reason");
  expect(reasons).toHaveLength(2);
  expect(reasons[0].textContent).toContain("回执丢失");
  expect(reasons[1].textContent).toContain("取消请求未收到供应商答复");
  expect(view.queryByText("async_dispatch_answer_lost")).toBeNull();
  expect(view.queryByText("async_cancel_result_unknown")).toBeNull();

  // The amounts: the cap on every row, the settled charge on the settled one — the
  // ledger's ×100 integers scaled once at render.
  const settledRow = byStatus.get("settled");
  expect(settledRow?.textContent).toContain("60.01");
  expect(settledRow?.textContent).toContain("25");
});

test("页面请求不携带任何账户标识参数", async () => {
  installFetchStub([job("aj-one")]);
  const view = renderView();
  await view.findAllByTestId("async-job-row");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const identity =
    /userid|externalcustomerid|payerid|accountid|companyid|tenantid/i;
  const offenders = requestedUrls.filter((url) => identity.test(url));
  expect(offenders, JSON.stringify(offenders)).toEqual([]);
  // And the page asked for its own jobs by path alone — no account naming anywhere.
  expect(
    requestedUrls.some((url) =>
      url.startsWith("/api/billing/credits/async-jobs"),
    ),
  ).toBe(true);
});

test("Key 到期后任务仍显示原归属账户", async () => {
  // The grant this job was submitted under has since expired; the server's read still
  // answers the row with the FROZEN attribution (17.1/17.2's creation-time copy), and the
  // page renders it unchanged — amounts, status and owner.
  installFetchStub([
    job("aj-expired-key", {
      attribution: {
        grantId: "grant-expired-since",
        payerKind: "personal",
        payerId: "ui-test-user",
      },
    }),
  ]);
  const view = renderView();
  const rows = await view.findAllByTestId("async-job-row");
  expect(rows).toHaveLength(1);
  expect(rows[0].dataset.attribution).toBe("ui-test-user");
  expect(rows[0].dataset.status).toBe("running");
  expect(rows[0].textContent).toContain("60.01");
});

test("无任务时用文字说明空态，失败时显示错误", async () => {
  installFetchStub([]);
  const view = renderView();
  await view.findByText("还没有异步任务。");

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "nope" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const failed = renderView();
  await failed.findByText("异步任务加载失败。");
});
