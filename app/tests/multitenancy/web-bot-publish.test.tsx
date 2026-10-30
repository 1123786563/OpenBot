import "../preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { SharingSections } from "../../src/components/bot-profile/sharing";
import { BotSubpage } from "../../src/components/bot-profile/bot-subpage";
import type { AgentProfile } from "../../src/lib/agents/queries";
import {
  type ScopeSelection,
  storeSelection,
} from "../../src/lib/enterprise/tenant/selection";
import type { TeamBot, TeamBotsData } from "../../src/lib/team-bots";

/**
 * MT085 / Issue #128: the sharing and publishing surface shows what the SERVER says this person
 * may do. Entries and buttons come from the capability fields of the publication answer, never
 * re-derived from an ownership flag or a role of the client's own (AC1); the audience choices are
 * the ranges the server names — the design's set, with no cross-company option to invent (AC2);
 * unpublishing is reflected at once, leaving no clickable remnant of the retired publication
 * (AC3); and a person with no right to the page at all gets an explicit refusal state, not a
 * silent blank (AC4).
 *
 * THE HARNESS IS THE REAL COMPONENT AND THE REAL SCOPE SOURCE, as in MT084's
 * `web-bot-detail.test.tsx`: `SharingSections` renders inside a memory router, the scope source
 * (`/api/me`) and storage seed the selection exactly as production does, and `fetch` answers by
 * path while recording every request — the capability fields the server put in its answer, and the
 * pair the requests carried, are the evidence. AC4's page-level case renders the sharing page's
 * real frame (`BotSubpage`), the same one every `/bots/$agentId/<area>` page reads through.
 */

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };

const OWN_BOT: AgentProfile = {
  id: "expenses",
  name: "Expenses",
  title: "Finance",
  roleDescription: "Receipts.",
  avatarSeed: "e",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

/** The design's audience set — what the server names, and all it ever names. */
const DESIGN_AUDIENCES = ["team", "people"] as const;

function publishedRow(overrides: Partial<TeamBot> = {}): TeamBot {
  return {
    id: "expenses",
    name: "Expenses",
    title: "Finance",
    roleDescription: "Receipts.",
    mine: true,
    audience: "team",
    publishedAt: "2026-10-01T00:00:00Z",
    assigned: false,
    visibleToTeam: true,
    canUnpublish: true,
    canEditPublication: true,
    canAssign: false,
    people: [],
    groups: [],
    assignments: [],
    ...overrides,
  };
}

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());
afterEach(cleanup);

const originalFetch = global.fetch;

type Write = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};
let writes: Write[] = [];
let asked: { input: string; init: RequestInit | undefined }[] = [];

function headerOf(
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return (headers as Record<string, string>)[name];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * `/api/me` answers this one person; `/api/team-bots` answers the test's own capability sheet,
 * refreshed per call so a mutation's invalidation refetch can answer differently; writes are
 * recorded, body and headers both, and answer `{}`.
 */
function serveTeamBots(
  data: () => TeamBotsData,
  onWrite?: (write: Write) => void,
): void {
  writes = [];
  asked = [];
  global.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    asked.push({ input: url, init });
    if (url === "/api/me") {
      return jsonResponse(200, {
        user: { id: USER, role: "user", email: "me@example.test", name: "Me" },
      });
    }
    if (init?.method && init.method !== "GET") {
      const write = {
        url,
        method: init.method,
        headers: {
          tenant: headerOf(init, "x-openbot-tenant") ?? "",
          workspace: headerOf(init, "x-openbot-workspace") ?? "",
        },
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      writes.push(write);
      onWrite?.(write);
      return jsonResponse(init.method === "DELETE" ? 204 : 200, {});
    }
    if (url.includes("/api/team-bots")) return jsonResponse(200, data());
    if (url.includes("/shared-use/bot/"))
      return jsonResponse(200, { apps: [] });
    if (url.includes("/shared-use")) return jsonResponse(200, { requests: [] });
    return jsonResponse(200, {});
  }) as unknown as typeof fetch;
}

/** The page-level harness: the sharing frame's own detail read answered by `detail`. */
function serveSharingPage(
  detail: (path: string) => Response | undefined,
): void {
  asked = [];
  global.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    asked.push({ input: url, init });
    if (url === "/api/me") {
      return jsonResponse(200, { user: { id: USER, role: "user" } });
    }
    return detail(url) ?? jsonResponse(200, {});
  }) as unknown as typeof fetch;
}

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function drawSharing(queryClient: QueryClient, agent: AgentProfile) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <SharingSections agent={agent} />,
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

function drawSharingPage(queryClient: QueryClient) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <BotSubpage agentId="expenses" description="The area" title="Sharing">
          {(agent) => <SharingSections agent={agent} />}
        </BotSubpage>
      ),
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// AC1 — entries and buttons are the server's capability answer, not a client-side inference
// ---------------------------------------------------------------------------

describe("MT085 AC1 — the server's capabilities decide what is offered", () => {
  test("a teammate of a published Bot gets the use entry and none of the manage ones", async () => {
    serveTeamBots(() => ({
      teamBots: [
        publishedRow({
          mine: false,
          canUnpublish: false,
          canEditPublication: false,
          canAssign: false,
        }),
      ],
      publishable: [],
      publishAudiences: DESIGN_AUDIENCES,
    }));
    const view = drawSharing(freshClient(), { ...OWN_BOT, mine: false });
    // The use side is there: the publication's audience row, and the link to a chat with it.
    expect(await view.findByText("To the whole team")).toBeTruthy();
    expect(view.getByRole("button", { name: "Copy link" })).toBeTruthy();
    // None of the manage actions: nothing to unpublish, nothing to aim, nothing to assign.
    expect(view.queryByRole("button", { name: "Unpublish" })).toBeNull();
    expect(view.queryByRole("button", { name: /Audience/ })).toBeNull();
    expect(
      view.queryByRole("button", { name: /Assign to a group/ }),
    ).toBeNull();
  });

  test("the capabilities decide, not the person's role: an assign granted below admin shows, one withheld above admin does not", async () => {
    // A plain user the server says may assign: the section is there BECAUSE the server said so —
    // no role of the client's own could have drawn it.
    serveTeamBots(() => ({
      teamBots: [
        publishedRow({
          mine: false,
          canUnpublish: false,
          canEditPublication: false,
          canAssign: true,
        }),
      ],
      publishable: [],
      publishAudiences: DESIGN_AUDIENCES,
    }));
    let view = drawSharing(freshClient(), { ...OWN_BOT, mine: false });
    expect(
      await view.findByRole("button", { name: /Assign to a group/ }),
    ).toBeTruthy();
    cleanup();

    // The same plain user on a Bot the server says they may not assign: nothing is offered, even
    // though every other fact about them is unchanged.
    serveTeamBots(() => ({
      teamBots: [
        publishedRow({
          mine: false,
          canUnpublish: false,
          canEditPublication: false,
          canAssign: false,
        }),
      ],
      publishable: [],
      publishAudiences: DESIGN_AUDIENCES,
    }));
    view = drawSharing(freshClient(), { ...OWN_BOT, mine: false });
    expect(await view.findByText("To the whole team")).toBeTruthy();
    expect(
      view.queryByRole("button", { name: /Assign to a group/ }),
    ).toBeNull();
  });

  test("the retire/aim split renders from its two fields, and the reads carry the scope pair", async () => {
    storeSelection(USER, ACME);
    serveTeamBots(() => ({
      teamBots: [
        publishedRow({
          mine: false,
          canUnpublish: true,
          canEditPublication: false,
          canAssign: false,
        }),
      ],
      publishable: [],
      publishAudiences: DESIGN_AUDIENCES,
    }));
    const view = drawSharing(freshClient(), { ...OWN_BOT, mine: false });
    // An administrator-style answer on somebody else's Bot: retire yes, aim no.
    expect(await view.findByRole("button", { name: "Unpublish" })).toBeTruthy();
    expect(view.queryByRole("button", { name: /Audience/ })).toBeNull();
    // The list read itself left with the selection pair on it (MT085 binds the surface).
    const read = asked.find((ask) => ask.input.includes("/api/team-bots"));
    expect(read).toBeTruthy();
    expect(headerOf(read?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(read?.init, "x-openbot-workspace")).toBe("acme-finance");
  });
});

// ---------------------------------------------------------------------------
// AC2 — the audience choices are the server's named ranges, nothing wider
// ---------------------------------------------------------------------------

describe("MT085 AC2 — the audience select offers the design's ranges, and only those", () => {
  test("the dialog offers exactly the two named ranges; specific people brings its fields", async () => {
    serveTeamBots(() => ({
      teamBots: [],
      publishable: [{ id: "expenses", name: "Expenses", title: "Finance" }],
      publishAudiences: DESIGN_AUDIENCES,
    }));
    const view = drawSharing(freshClient(), OWN_BOT);
    const user = userEvent.setup({ document });
    await user.click(await view.findByRole("button", { name: /Audience/ }));
    // HeroUI Select.Trigger is a plain button with aria-haspopup (see approval-team-settings):
    // the combobox role the ui/select wrapper forwards does not survive the HeroUI render.
    await user.click(view.getByRole("button", { name: /^Published to/ }));
    const offered = await view.findAllByRole("option");
    // The design's set, whole: two ranges, the team and named people — and nothing else. A
    // cross-company option is not a thing the server names, so it is not a thing this form
    // offers; there is no third option to find.
    expect(offered.length).toBe(2);
    expect(offered.map((option) => option.textContent)).toEqual([
      "The whole team",
      "Specific people or groups",
    ]);
    await user.click(
      await view.findByRole("option", { name: "Specific people or groups" }),
    );
    expect(view.getByLabelText("People, by email")).toBeTruthy();
    expect(view.getByLabelText("Groups")).toBeTruthy();
  });

  test("a server that names one range offers exactly that one", async () => {
    serveTeamBots(() => ({
      teamBots: [],
      publishable: [{ id: "expenses", name: "Expenses", title: "Finance" }],
      publishAudiences: ["team"],
    }));
    const view = drawSharing(freshClient(), OWN_BOT);
    const user = userEvent.setup({ document });
    await user.click(await view.findByRole("button", { name: /Audience/ }));
    // HeroUI Select.Trigger is a plain button with aria-haspopup (see approval-team-settings):
    // the combobox role the ui/select wrapper forwards does not survive the HeroUI render.
    await user.click(view.getByRole("button", { name: /^Published to/ }));
    const offered = await view.findAllByRole("option");
    expect(offered.length).toBe(1);
    expect(offered[0]?.textContent).toBe("The whole team");
    // The people/groups fields belong to a range the server did not name, so they cannot appear.
    expect(view.queryByLabelText("People, by email")).toBeNull();
    expect(view.queryByLabelText("Groups")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC3 — unpublishing is reflected at once, with no clickable remnant
// ---------------------------------------------------------------------------

describe("MT085 AC3 — unpublish reflects immediately and leaves nothing clickable behind", () => {
  test("unpublish carries the scope pair, and the retired publication leaves no manage actions", async () => {
    storeSelection(USER, ACME);
    let retired = false;
    serveTeamBots(
      () =>
        retired
          ? {
              teamBots: [],
              publishable: [],
              publishAudiences: DESIGN_AUDIENCES,
            }
          : {
              teamBots: [
                publishedRow({ canUnpublish: true, canEditPublication: false }),
              ],
              publishable: [],
              publishAudiences: DESIGN_AUDIENCES,
            },
      // The retire takes effect server-side the moment the DELETE lands, so the invalidation's
      // refetch already answers the retired world.
      (write) => {
        if (write.method === "DELETE") retired = true;
      },
    );
    const view = drawSharing(freshClient(), { ...OWN_BOT, mine: false });
    const unpublish = await view.findByRole("button", { name: "Unpublish" });

    await act(async () => {
      unpublish.click();
    });
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]).toMatchObject({
      url: expect.stringContaining("/publication"),
      method: "DELETE",
      headers: { tenant: "acme", workspace: "acme-finance" },
    });

    // The settle invalidates, the refetch answers the retired world, and the page shows it: the
    // publication's own empty state, no Unpublish, no Audience row — the retired publication left
    // nothing clickable behind.
    await waitFor(() => expect(view.getByText("Not published.")).toBeTruthy());
    expect(view.queryByRole("button", { name: "Unpublish" })).toBeNull();
    expect(view.queryByRole("button", { name: /Audience/ })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC4 — no right to the page is an explicit refusal, never a silent blank
// ---------------------------------------------------------------------------

describe("MT085 AC4 — refused access says so", () => {
  test("a Bot this person cannot reach answers the page-level unavailable state", async () => {
    serveSharingPage((path) => {
      if (path === "/api/agents/expenses") return jsonResponse(404, {});
      return undefined;
    });
    const view = drawSharingPage(freshClient());
    const note = await waitFor(() => view.getByTestId("bot-unavailable"));
    expect(note.textContent).toBe("This Bot is not available here.");
    // The refusal is the whole answer: no sharing sections render beside it, and no alert
    // pretends the infrastructure failed.
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByRole("button", { name: "Copy link" })).toBeNull();
  });

  test("a publish the server refuses is said in the server's own words", async () => {
    // The "Team Bots" switch is off for this person: the server refuses the PUT itself.
    global.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if (url === "/api/me") {
        return jsonResponse(200, { user: { id: USER, role: "user" } });
      }
      if (init?.method === "PUT" && url.includes("/publication")) {
        return jsonResponse(403, {
          error: "An administrator has turned Team Bots off.",
        });
      }
      if (url.includes("/api/team-bots")) {
        return jsonResponse(200, {
          teamBots: [],
          publishable: [{ id: "expenses", name: "Expenses", title: "Finance" }],
          publishAudiences: DESIGN_AUDIENCES,
        });
      }
      if (url.includes("/shared-use/bot/"))
        return jsonResponse(200, { apps: [] });
      if (url.includes("/shared-use"))
        return jsonResponse(200, { requests: [] });
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;
    const view = drawSharing(freshClient(), OWN_BOT);
    const user = userEvent.setup({ document });
    await user.click(await view.findByRole("button", { name: /Audience/ }));
    fireEvent.submit(
      (
        view.getByRole("button", {
          name: "Publish to team",
        }) as HTMLButtonElement
      ).form as HTMLFormElement,
    );
    expect(
      await view.findByText("An administrator has turned Team Bots off."),
    ).toBeTruthy();
  });
});
