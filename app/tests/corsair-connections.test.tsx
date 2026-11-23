import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CorsairAccounts } from "@/components/connections/corsair-accounts";
import { ConnectionSurface } from "@/components/connections/connection-surface";

const originalFetch = globalThis.fetch;
const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const approval = "00000000-0000-4000-8000-000000000003";
const base = "/api/corsair/slack";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

test("Slack default and explicit actions keep the reviewed account as the default changes", async () => {
  let defaultId = first;
  let selected = first;
  let revoked = false;
  const requests: { selected?: string; sent?: string; answer?: string }[] = [];
  const fetchFixture = async (...[input, init]: Parameters<typeof fetch>) => {
    const path = String(input);
    if (path === "/api/agents")
      return Response.json({ agents: [{ id: "bot", name: "Assistant" }] });
    if (path === `${base}/bots/bot/tools`) {
      return Response.json({ tools: [{ ref: "corsair/slack.post_message" }] });
    }
    if (path === `${base}/connections`) {
      return Response.json({
        teamId: "T1",
        defaultConnectionId: defaultId,
        connections: [
          {
            id: first,
            userId: "U1",
            subjectScope: "T1",
            label: "Sam",
            verificationRequiredAt: null,
          },
          {
            id: second,
            userId: "U2",
            subjectScope: "E1",
            label: "Sam",
            verificationRequiredAt: null,
          },
        ]
          .filter(({ id }) => !revoked || id !== first)
          .map((row) => ({ ...row, expiresAt: "2020-01-01T00:00:00Z" })),
      });
    }
    if (path === `${base}/connections/revocations`) {
      return Response.json({
        connections: revoked
          ? [{ id: first, label: "Sam", revocation: { status: "pending" } }]
          : [],
      });
    }
    expect(new Headers(init?.headers).get("X-OpenBot-Pilot")).toBe("slack");
    if (
      path === `${base}/connections/${first}/revocation` &&
      init?.method === "DELETE"
    ) {
      revoked = true;
      return Response.json({ status: "pending" });
    }
    const body = JSON.parse(String(init?.body));
    if (path === `${base}/connections/default`) {
      defaultId = body.connectionId;
      return Response.json({ defaultConnectionId: defaultId });
    }
    if (path === `${base}/approvals`) {
      requests.push({ selected: body.connectionId });
      selected = body.connectionId ?? defaultId;
      return Response.json({
        id: approval,
        action: {
          account: "Sam",
          target: {
            connectionId: selected,
            teamId: "T1",
            userId: selected === first ? "U1" : "U2",
            channelId: "C1",
          },
        },
      });
    }
    if (path === `${base}/approvals/${approval}/decision`) {
      requests.push({ answer: body.decision });
      return Response.json({ id: approval });
    }
    if (path === `${base}/approvals/${approval}/execute`) {
      requests.push({ sent: body.connectionId });
      expect(body).toEqual({
        botId: "bot",
        channelId: "C1",
        text: "Hello",
        connectionId: selected,
      });
      return Response.json({ message: { channel: "C1" } });
    }
    throw new Error(`Unexpected request ${path}`);
  };
  globalThis.fetch = Object.assign(fetchFixture, {
    preconnect: originalFetch.preconnect,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const user = userEvent.setup({ document });
  const screen = render(
    <QueryClientProvider client={queryClient}>
      <ConnectionSurface>
        <CorsairAccounts provider="slack" outcome="connected" />
      </ConnectionSurface>
    </QueryClientProvider>,
  );

  await screen.findByText("Slack authorization completed.");
  await screen.findByText("Workspace T1 · User U1 · Authorized · Default");
  await user.click(
    screen.getByRole("button", { name: "Post a Slack message" }),
  );
  await user.click(await screen.findByRole("combobox", { name: "Bot" }));
  await screen.findByRole("option", { name: "Assistant" });
  await user.keyboard("{ArrowDown}{Enter}");
  await user.type(screen.getByLabelText("Slack channel ID"), "C1");
  await user.type(screen.getByLabelText("Message"), "Hello");
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Review action" })
        .getAttribute("aria-disabled"),
    ).not.toBe("true"),
  );
  await user.click(screen.getByRole("button", { name: "Review action" }));
  await screen.findByText("Account: Sam (Workspace T1 · User U1)");

  await user.click(
    screen.getByRole("button", { name: /Make Sam .*User U2.* default/ }),
  );
  await screen.findByText(
    "Workspace T1 · User U2 · Enterprise E1 · Authorized · Default",
  );
  await user.click(screen.getByRole("button", { name: "Approve and send" }));
  await screen.findByText("Slack message posted.");

  await user.click(
    screen.getByRole("button", { name: "Post a Slack message" }),
  );
  await user.click(
    screen.getByRole("combobox", { name: "Account for this action" }),
  );
  await screen.findByRole("option", { name: /Sam.*User U1/ });
  await user.keyboard("{ArrowDown}{Enter}");
  await user.click(screen.getByRole("button", { name: "Review action" }));
  await screen.findByText("Account: Sam (Workspace T1 · User U1)");
  await user.click(screen.getByRole("button", { name: "Decline" }));
  await screen.findByText("Approval declined.");
  expect(requests).toEqual([
    { selected: undefined },
    { answer: "allow_once" },
    { sent: first },
    { selected: first },
    { answer: "deny" },
  ]);

  await user.click(
    screen.getByRole("button", { name: /Disconnect Sam .*User U1/ }),
  );
  await user.click(screen.getByRole("button", { name: "Confirm disconnect" }));
  await screen.findByText(
    "Disconnected · Provider revocation pending confirmation",
  );
  expect(screen.queryByText("Workspace T1 · User U1 · Authorized")).toBeNull();
  expect(
    screen.getByText(
      "Workspace T1 · User U2 · Enterprise E1 · Authorized · Default",
    ),
  ).toBeDefined();
}, 30_000);
