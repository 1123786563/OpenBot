import "./preload";
import { afterAll, afterEach, beforeAll, expect, test } from "../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ModelAccessAuthorizations } from "@/components/settings/model-access-authorizations";
import i18n from "@/lib/i18n";
import { settleReactWork } from "./settle-react-work";

/**
 * Settings → Model access: the person's own authorizations (Bifrost #240, 04.7).
 *
 * The page lists each Bot's authorization — display name, external identity, status, created at —
 * and a Revoke press per active grant. The visibility rule itself lives server-side (the list
 * endpoint answers only the session's own rows); what the UI owes is that it renders exactly the
 * state the server reports, sends the revocation to the one grant pressed, and shows the revoked
 * state the moment the refetched list reports it.
 */

beforeAll(async () => {
  GlobalRegistrator.register();
  await i18n.changeLanguage("en");
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  void i18n.changeLanguage("en");
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

type Grant = {
  grantId: string;
  botId: string;
  botDisplayName: string;
  externalIdentity: string;
  scope: string;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
};

let grants: Grant[];
let revocations: Array<{ grantId: string }>;

function serving() {
  grants = [
    {
      grantId: "g-active",
      botId: "bot-a",
      botDisplayName: "Research Bot",
      externalIdentity: "slack:U123",
      scope: "model-access",
      status: "active",
      createdAt: "2026-10-16T08:00:00.000Z",
      revokedAt: null,
    },
    {
      grantId: "g-revoked",
      botId: "bot-b",
      botDisplayName: "Legacy Bot",
      externalIdentity: "github:4567",
      scope: "model-access",
      status: "revoked",
      createdAt: "2026-10-15T08:00:00.000Z",
      revokedAt: "2026-10-16T09:00:00.000Z",
    },
  ];
  revocations = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const revoke = url.match(/^\/api\/model-access\/grants\/([^/]+)\/revoke$/);
    if (method === "GET" && url === "/api/model-access/grants") {
      return Response.json({ grants });
    }
    if (method === "POST" && revoke) {
      const grantId = revoke[1];
      revocations.push({ grantId });
      grants = grants.map((grant) =>
        grant.grantId === grantId
          ? {
              ...grant,
              status: "revoked" as const,
              revokedAt: "2026-10-16T10:00:00.000Z",
            }
          : grant,
      );
      const target = grants.find((grant) => grant.grantId === grantId);
      return Response.json({ accessGrant: target, revoked: true });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as unknown as typeof fetch;
}

function draw(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

test("each Bot's authorization is listed with its identity, status and created time", async () => {
  serving();
  const view = draw(<ModelAccessAuthorizations />);

  expect(await view.findByText("Research Bot")).toBeTruthy();
  expect(view.getByText("Legacy Bot")).toBeTruthy();
  expect(view.getByText(/slack:U123/)).toBeTruthy();
  expect(view.getByText(/github:4567/)).toBeTruthy();

  // The active grant reads as active, the revoked one as revoked — the state the server reports,
  // word for word, each inside its own item row.
  const activeRow = view
    .getByText("Research Bot")
    .closest('[data-slot="item"]');
  expect(activeRow?.textContent).toContain("Active");
  expect(activeRow?.textContent).not.toContain("Revoked");
  const revokedRow = view.getByText("Legacy Bot").closest('[data-slot="item"]');
  expect(revokedRow?.textContent).toContain("Revoked");

  // And the created times are rendered, not dropped — one per row.
  expect(view.getAllByText(/2026/).length).toBe(2);
});

test("only the active grant offers a Revoke press, and pressing it revokes exactly that grant", async () => {
  serving();
  const view = draw(<ModelAccessAuthorizations />);

  const buttons = await view.findAllByRole("button", { name: /Revoke/ });
  // One press for one grant: the revoked one offers nothing to press.
  expect(buttons).toHaveLength(1);

  fireEvent.click(buttons[0]);

  await waitFor(() => expect(revocations).toEqual([{ grantId: "g-active" }]));

  // The list comes back with the revocation in it: the grant now reads revoked and the press is
  // gone — revocation is visible the moment the server has committed it.
  await waitFor(() => {
    const row = view.getByText("Research Bot").closest('[data-slot="item"]');
    expect(row?.textContent).toContain("Revoked");
  });
  expect(view.queryByRole("button", { name: /Revoke/ })).toBeNull();
});

test("a refused revocation says so instead of quietly pretending", async () => {
  serving();
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "GET" && url === "/api/model-access/grants")
      return Response.json({ grants });
    return Response.json(
      { error: "That model access grant cannot be used." },
      { status: 404 },
    );
  }) as unknown as typeof fetch;
  const view = draw(<ModelAccessAuthorizations />);

  const button = await view.findByRole("button", { name: /Revoke/ });
  fireEvent.click(button);

  await view.findByRole("alert");
  expect(revocations).toEqual([]);
});

test("an empty list says there is nothing authorized yet", async () => {
  serving();
  grants = [];
  const view = draw(<ModelAccessAuthorizations />);

  expect(await view.findByText(/No Bots are authorized/)).toBeTruthy();
});
