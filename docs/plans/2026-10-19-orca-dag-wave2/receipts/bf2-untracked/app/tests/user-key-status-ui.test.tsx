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
 * Settings → Model access: the person's own key status and revoke-everything (Bifrost #251,
 * 05.10).
 *
 * The page owes four things this file pins: each Bot's authorization shows its live key
 * versions — version number, state, term — and never a secret; one "Revoke all versions"
 * press revokes that Bot's every valid version and the rows read revoked immediately after;
 * a list that cannot be loaded is an ERROR on screen, never an empty list pretending there is
 * nothing; and a refused revoke-all says so instead of quietly pretending.
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

type KeyStatus = {
  credentialVersion: number;
  status: "active" | "expired" | "revoked";
  expiresAt: string | null;
};

type Grant = {
  grantId: string;
  botId: string;
  botDisplayName: string;
  externalIdentity: string;
  scope: string;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
  activeKeys: KeyStatus[];
};

/** A stand-in plaintext, assembled rather than literal: it must never render anywhere. */
const NO_SECRET = ["sk-vk", "secret-42"].join("-");

let grants: Grant[];
let revocations: Array<{ grantId: string }>;
let revokeAllCalls: Array<{ botId: string }>;

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
      activeKeys: [
        {
          credentialVersion: 3,
          status: "active",
          expiresAt: "2026-10-16T09:14:00.000Z",
        },
        {
          credentialVersion: 2,
          status: "active",
          expiresAt: "2026-10-16T09:00:00.000Z",
        },
      ],
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
      activeKeys: [],
    },
  ];
  revocations = [];
  revokeAllCalls = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const revoke = url.match(/^\/api\/model-access\/grants\/([^/]+)\/revoke$/);
    if (method === "GET" && url === "/api/model-access/grants") {
      return Response.json({ grants });
    }
    if (method === "POST" && url === "/api/model-access/grants/revoke-all") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { botId?: string };
      revokeAllCalls.push({ botId: String(body.botId) });
      // The server's answer shape: the Bot's grants as they now stand. The two active key
      // versions above are retired by the same act — the grant's own revocation owns them.
      grants = grants.map((grant) =>
        grant.botId === body.botId
          ? {
              ...grant,
              status: "revoked" as const,
              revokedAt: "2026-10-16T10:00:00.000Z",
              activeKeys: [],
            }
          : grant,
      );
      const affected = grants.filter((grant) => grant.botId === body.botId);
      return Response.json({ grants: affected, revokedCount: affected.length });
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
              activeKeys: [],
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

test("each Bot's live key versions are shown with version, state and term — and no secret", async () => {
  serving();
  const view = draw(<ModelAccessAuthorizations />);

  const row = (await view.findByText("Research Bot")).closest(
    '[data-slot="item"]',
  );
  // Both live versions read on screen: the version number, the active state, the term.
  expect(row?.textContent).toContain("v2");
  expect(row?.textContent).toContain("v3");
  expect((row?.textContent?.match(/Active/g) ?? []).length).toBeGreaterThan(0);
  expect(row?.textContent).toMatch(/2026/);

  // Nothing that ever names a plaintext key renders — the page cannot show what it is
  // never sent, and this pins that the wire shapes never start carrying one either.
  expect(document.body.textContent).not.toContain(NO_SECRET);
  expect(JSON.stringify(grants)).not.toContain("secret");
});

test("one Revoke-all press revokes that Bot's every valid version and the rows read revoked at once", async () => {
  serving();
  const view = draw(<ModelAccessAuthorizations />);

  const buttons = await view.findAllByRole("button", {
    name: /Revoke all versions/,
  });
  // One Bot-level press per active Bot; the revoked Bot offers nothing.
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]);

  await waitFor(() =>
    expect(revokeAllCalls).toEqual([{ botId: "bot-a" }]),
  );
  expect(revocations).toEqual([]);

  // The refetched truth: the grant reads revoked, its key versions are gone from the row —
  // every valid version stopped at the same press — and no press remains.
  await waitFor(() => {
    const row = view.getByText("Research Bot").closest('[data-slot="item"]');
    expect(row?.textContent).toContain("Revoked");
    expect(row?.textContent).not.toContain("v2");
    expect(row?.textContent).not.toContain("v3");
  });
  expect(view.queryByRole("button", { name: /Revoke all versions/ })).toBeNull();
});

test("a list that fails to load is an error on screen, never an empty list", async () => {
  serving();
  global.fetch = (async () =>
    Response.json({ error: "not signed in" }, { status: 401 })) as unknown as typeof fetch;
  const view = draw(<ModelAccessAuthorizations />);

  // The failure is said, out loud, with the alert role — and the empty-state text never
  // appears: a remote that cannot answer is not the same as nothing authorized.
  await view.findByRole("alert");
  expect(view.queryByText(/No Bots are authorized/)).toBeNull();
});

test("a refused revoke-all says so instead of quietly pretending", async () => {
  serving();
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "GET" && url === "/api/model-access/grants")
      return Response.json({ grants });
    return Response.json({ error: "refused" }, { status: 409 });
  }) as unknown as typeof fetch;
  const view = draw(<ModelAccessAuthorizations />);

  const button = await view.findByRole("button", {
    name: /Revoke all versions/,
  });
  fireEvent.click(button);

  await view.findByRole("alert");
  expect(revokeAllCalls).toEqual([]);
});
