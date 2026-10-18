import "./preload";
import { afterAll, afterEach, beforeAll, expect, mock, test } from "../../tests/support/e2e-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import i18n from "@/lib/i18n";
import { settleReactWork } from "./settle-react-work";

/* The dialogs this page does not use are mocked at the registry level the way every billing
 * suites does — a no-op shell so the module graph stays honest without Base UI's portals. */
mock.module("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    Dialog: pass,
    DialogContent: pass,
    DialogHeader: pass,
    DialogBody: pass,
    DialogFooter: pass,
    DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children?: ReactNode }) => (
      <p>{children}</p>
    ),
    DialogClose: pass,
    DialogOverlay: pass,
    DialogPortal: pass,
    DialogTrigger: pass,
  };
});

const { AdminCreditGrantCard } = await import(
  "@/components/billing/admin-credit-grant"
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

/*
 * Bifrost 02.8 (#222): the administrator's grant entry. What it owes the ticket — before any
 * styling question — is exactly what this file pins:
 *
 * - the form sends the ticket's contract: 目标用户 + 额度 + 过期时间 + 原因, credits converted to
 *   the ledger's scaled units (×100), an idempotency key minted per form session;
 * - the request NEVER carries an account key (externalCustomerId or any account-identity field):
 *   the account is the server's resolution of the chosen user (02.4), so the client must not
 *   even be able to ask;
 * - a success renders what the server answered — entered or replayed, the grant id and the
 *   account it resolved to;
 * - a failure renders the server's own sentence, not a silent reset;
 * - retrying the SAME form session reuses the same idempotency key (that is what makes the
 *   double-click safe), and a fresh mount mints a new one (that is what keeps two intentional
 *   grants two grants).
 */

type CapturedRequest = { url: string; body: Record<string, unknown> };

function installFetchStub(responder: (body: Record<string, unknown>) => Response) {
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    } catch {
      body = {};
    }
    requests.push({ url, body });
    return responder(body);
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
      <AdminCreditGrantCard />
    </QueryClientProvider>,
  );
}

async function fillAndSubmit(view: ReturnType<typeof renderCard>) {
  const user = userEvent.setup({ document });
  await user.type(view.getByTestId("grant-user-id"), "user-abc-123");
  await user.type(view.getByTestId("grant-credits"), "10");
  await user.type(view.getByTestId("grant-expires-at"), "2026-12-01T08:00");
  await user.type(view.getByTestId("grant-reason"), "新用户活动");
  await user.click(view.getByTestId("grant-submit"));
}

test("表单渲染目标用户、额度、过期时间、原因与来源（默认活动奖励）", () => {
  installFetchStub(() => json({}));
  const view = renderCard();

  expect(view.getByTestId("grant-user-id")).toBeTruthy();
  expect(view.getByTestId("grant-credits")).toBeTruthy();
  expect(view.getByTestId("grant-expires-at")).toBeTruthy();
  expect(view.getByTestId("grant-reason")).toBeTruthy();
  const source = view.getByTestId("grant-source") as HTMLSelectElement;
  expect(source.value).toBe("promo");
  expect(view.getByTestId("grant-submit").textContent).toContain("发放");
  // No result and no failure before anything was sent.
  expect(view.queryByTestId("grant-result")).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
});

test("提交体只含目标用户与额度等字段：积分×100、ISO 过期时间、幂等键，绝无账户键", async () => {
  const requests = installFetchStub(() =>
    json({ inserted: true, grant: { id: "cg-1", total: 1000 } }),
  );
  const view = renderCard();
  await fillAndSubmit(view);

  await waitFor(() => expect(view.getByTestId("grant-result")).toBeTruthy());
  expect(requests).toHaveLength(1);
  const { url, body } = requests[0];
  expect(url).toBe("/api/admin/billing/credits/personal-grants");
  expect(body.userId).toBe("user-abc-123");
  expect(body.source).toBe("promo");
  // 10 credits → 1000 scaled units, the ledger's own arithmetic.
  expect(body.totalCents).toBe(1000);
  expect(body.reason).toBe("新用户活动");
  const iso = body.expiresAt as string;
  expect(typeof iso).toBe("string");
  expect(new Date(iso).toISOString()).toBe(iso);
  expect(typeof body.idempotencyKey).toBe("string");
  expect((body.idempotencyKey as string).length).toBeGreaterThanOrEqual(8);

  // THE refusal the whole ticket turns on: no account identity anywhere in the body, in any
  // casing — the account is the server's resolution, not a client field.
  const identity = /externalcustomerid|payerid|accountid/i;
  for (const key of Object.keys(body)) {
    expect(identity.test(key)).toBe(false);
  }
});

test("成功渲染已入账结果：发放 id 与解析出的账户", async () => {
  installFetchStub(() =>
    json({
      inserted: true,
      grant: { id: "cg-abc123", total: 1000, used: 0 },
      account: {
        id: "pa-1",
        kind: "personal",
        payerId: "user-abc-123",
        externalCustomerId: "openbot-personal-user-abc-123",
      },
    }),
  );
  const view = renderCard();
  await fillAndSubmit(view);

  const result = await view.findByTestId("grant-result");
  expect(result.textContent).toContain("已入账");
  expect(result.textContent).toContain("cg-abc123");
  expect(result.textContent).toContain("10");
  expect(result.textContent).toContain("openbot-personal-user-abc-123");
});

test("重复提交应答 replay 时明确说明未重复入账", async () => {
  installFetchStub(() =>
    json({
      inserted: false,
      grant: { id: "cg-abc123", total: 1000, used: 0 },
      account: {
        id: "pa-1",
        kind: "personal",
        payerId: "user-abc-123",
        externalCustomerId: "openbot-personal-user-abc-123",
      },
    }),
  );
  const view = renderCard();
  await fillAndSubmit(view);

  const result = await view.findByTestId("grant-result");
  expect(result.textContent).toContain("未重复入账");
});

test("失败渲染服务端错误句（展示失败原因）", async () => {
  installFetchStub(() => json({ error: "Administrator access required." }, 403));
  const view = renderCard();
  await fillAndSubmit(view);

  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("Administrator access required.");
  expect(view.queryByTestId("grant-result")).toBeNull();
});

test("同一表单会话内重试复用同一幂等键", async () => {
  let calls = 0;
  const requests = installFetchStub(() => {
    calls += 1;
    if (calls === 1) return json({ error: "网络闪断" }, 500);
    return json({
      inserted: true,
      grant: { id: "cg-2", total: 1000 },
      account: {
        id: "pa-1",
        kind: "personal",
        payerId: "user-abc-123",
        externalCustomerId: "openbot-personal-user-abc-123",
      },
    });
  });
  const view = renderCard();
  await fillAndSubmit(view);
  await view.findByRole("alert");

  // The retry re-sends the same session's key without re-typing anything.
  await userEvent.setup({ document }).click(view.getByTestId("grant-submit"));
  await view.findByTestId("grant-result");

  expect(requests).toHaveLength(2);
  expect(requests[0].body.idempotencyKey).toBe(requests[1].body.idempotencyKey);
});

test("重新打开发放表单会话生成新的幂等键", async () => {
  const requests = installFetchStub(() =>
    json({
      inserted: true,
      grant: { id: "cg-3", total: 1000 },
      account: {
        id: "pa-1",
        kind: "personal",
        payerId: "user-abc-123",
        externalCustomerId: "openbot-personal-user-abc-123",
      },
    }),
  );
  const first = renderCard();
  await fillAndSubmit(first);
  await first.findByTestId("grant-result");
  first.unmount();

  const second = renderCard();
  await fillAndSubmit(second);
  await second.findByTestId("grant-result");

  expect(requests).toHaveLength(2);
  const firstKey = requests[0].body.idempotencyKey;
  const secondKey = requests[1].body.idempotencyKey;
  expect(typeof firstKey).toBe("string");
  expect(typeof secondKey).toBe("string");
  // Two intentional sessions are two grants: their keys differ.
  expect(secondKey).not.toBe(firstKey);
});
