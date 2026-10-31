import "./preload";
// app/tests/plugin-package-experts.test.tsx
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { settleReactWork } from "./settle-react-work";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PackageCatalogueDetail,
  PackageExpertCreatedDTO,
  PackageInstallDetailDTO,
  PackageInstallDTO,
  PackagePage,
  PackagePageItem,
} from "../../shared/enterprise/plugin-package-contracts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "../../tests/support/e2e-compat";
import i18n from "../src/lib/i18n";
import { pluginPackageKeys } from "../src/lib/plugin-packages/queries";

/*
 * The wizard's success handoff is TanStack Router's own `Link` (the agent-card.tsx pattern), so
 * the pane renders under a real router. That cannot happen with the module as the native Node
 * runner loads it: `@tanstack/router-core`'s `./isServer` export answers the `node` condition,
 * where NODE_ENV !== "test" means `isServer = true`, and Matches.js then skips the Transitioner
 * that arms `router._rendered` and crashes on it (`reading '0'` — the exact reason the repo's
 * other router-rendering suites live in the Bun-driven layer). This suite stays native, so the
 * mock pins the one value back to the client truth the DOM shim actually is. It is
 * shape-compatible with the client build (`loadServerRoute` is `void 0` there too) and
 * registry-level like every mock.module here — the value it supplies is what a browser
 * environment means, so later files in the same process read the same fact.
 *
 * Both router-touched imports below are dynamic and load AFTER the mock (top-level await, the
 * billing-credits-ui.test.tsx pattern): a static import would evaluate the router's own
 * `isServer` binding before the mock registers.
 */
mock.module("@tanstack/router-core/isServer", () => ({
  isServer: false,
  loadServerRoute: undefined,
}));

const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} = await import("@tanstack/react-router");
const { PackagePane } = await import("../src/components/market/package-pane");

/**
 * The expert-creation wizard of the package detail dialog, PKG04 slice B.
 *
 * WHAT THESE CASES HOLD. A company tenant_admin sees one create affordance per expertTemplate
 * resource of the installed revision; submitting POSTs the slice-A route with the scope headers,
 * one idempotency key and EXACTLY the contract body — identity, CAS revision, display name.
 * Nothing else travels: the profile block names the verified-template source (no profile
 * field exists on the wire — the server writes the new Bot's profile from that file), and no
 * owner/scope field exists anywhere. The key is
 * generated once per dialog open and reused for retries of the same intent; success shows the
 * created agentId with its Bot-detail link. Server refusals surface the server's own sentence.
 * A plain member gets no section; a revision without templates renders no shell; a creation
 * answered after a team switch can only touch the tree it left under.
 *
 * THE HARNESS IS THIS REPOSITORY'S native e2e pattern (see `plugin-package-grants.test.tsx`):
 * happy-dom registered per file, a fetch stub that records method/path/headers/body, one
 * `QueryClient` with `retry: false`, and `settle` as the act boundary that flushes React Query.
 */

const SCOPE_A = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  principalId: "user-1",
};
const SCOPE_B = {
  tenantId: "tenant-b",
  workspaceId: "workspace-b",
  principalId: "user-1",
};

const INSTALL_ID = "install-1";
const PACKAGE_KEY = "release-labs/notes-writer";
const DIGEST = "b".repeat(64);
const RESOURCE_ID = "assistant";
// A second template keeps the experts section (and the open wizard) mounted while the
// assistant template disappears from the read — the mid-dialog revision-drift scenario.
const SECOND_TEMPLATE_ID = "planner";
const DETAIL_PATH = `/api/enterprise/plugin-packages/installs/${INSTALL_ID}`;
const EXPERT_PATH = `${DETAIL_PATH}/experts/${RESOURCE_ID}`;

const RELEASE_ITEM: PackagePageItem = {
  packageKey: PACKAGE_KEY,
  version: "2.0.0",
  displayName: "Release Notes Writer",
  summary: "Writes release notes from a changelog.",
  category: "writing",
  install: null,
  installable: true,
  blockers: [],
};

const RELEASE_DETAIL: PackageCatalogueDetail = {
  packageKey: PACKAGE_KEY,
  version: "2.0.0",
  artifactDigest: DIGEST,
  displayName: "Release Notes Writer",
  summary: "Writes release notes from a changelog.",
  category: "writing",
  publisher: "release-labs",
  name: "notes-writer",
  resources: [
    { id: RESOURCE_ID, kind: "expertTemplate", available: true },
    { id: "notes-writer", kind: "skill", available: true },
    { id: "archive-reader", kind: "skill", available: true },
  ],
  installable: true,
  blockers: [],
};

const INSTALL: PackageInstallDTO = {
  installId: INSTALL_ID,
  packageKey: PACKAGE_KEY,
  version: "2.0.0",
  artifactDigest: DIGEST,
  revision: 1,
  generation: 1,
  status: "enabled",
  readiness: "ready",
  blockers: [],
  allowedActions: [],
};

const EXPERT: PackageExpertCreatedDTO = {
  agentId: "pkg-expert-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  installId: INSTALL_ID,
  packageKey: PACKAGE_KEY,
  version: "2.0.0",
  resourceId: RESOURCE_ID,
  expertTemplateRef: `${PACKAGE_KEY}/${RESOURCE_ID}`,
  displayName: "Meeting Assistant",
  grantRevision: 1,
  resources: [{ resourceId: "notes-writer", kind: "skill" }],
};

function installDetail(): PackageInstallDetailDTO {
  return {
    installId: INSTALL_ID,
    packageKey: PACKAGE_KEY,
    version: "2.0.0",
    artifactDigest: DIGEST,
    revision: 1,
    generation: 1,
    status: "enabled",
    readiness: "ready",
    blockers: [],
    allowedActions: [],
    resources: [
      ...(!templatesInstalled
        ? []
        : [
            ...(assistantDeclared
              ? [
                  {
                    id: RESOURCE_ID,
                    kind: "expertTemplate" as const,
                    available: true,
                  },
                ]
              : []),
            {
              id: SECOND_TEMPLATE_ID,
              kind: "expertTemplate" as const,
              available: true,
            },
          ]),
      { id: "notes-writer", kind: "skill", available: true },
      { id: "archive-reader", kind: "skill", available: true },
      { id: "tracker", kind: "managedConnector", available: false },
    ],
    grants: [],
  };
}

type Captured = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
};

let templatesInstalled: boolean;
let assistantDeclared: boolean;
let expertPosts: Captured[];
let expertSeen: Captured[];
let seen: Captured[];
let expertGate: Promise<Response> | null;
let respondExpert: (() => Response) | null;
const originalFetch = global.fetch;

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  templatesInstalled = true;
  assistantDeclared = true;
  expertPosts = [];
  expertSeen = [];
  seen = [];
  expertGate = null;
  respondExpert = null;
  window.localStorage.clear();
  global.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = new URL(String(input), "http://localhost");
      const headers: Record<string, string> = {};
      new Headers(init?.headers as HeadersInit | undefined).forEach(
        (value, key) => {
          headers[key] = value;
        },
      );
      const captured: Captured = {
        method: init?.method ?? "GET",
        path: url.pathname,
        headers,
        body: typeof init?.body === "string" ? init.body : null,
      };
      seen.push(captured);
      if (url.pathname === EXPERT_PATH) {
        expertSeen.push(captured);
      }
      if (url.pathname === "/api/me") {
        return json({
          user: {
            id: "user-1",
            email: "user-1@example.test",
            name: "User One",
            role: "user",
            onboarding: null,
          },
        });
      }
      if (url.pathname === "/api/enterprise/workspace-scope") {
        return json({
          companies: [
            {
              tenantId: "tenant-a",
              name: "Tenant A",
              role: "tenant_admin",
              memberEpoch: 1,
              teams: [{ workspaceId: "workspace-a", name: "Team A" }],
            },
          ],
        });
      }
      if (
        url.pathname === "/api/enterprise/plugin-packages" &&
        captured.method === "GET"
      ) {
        const page: PackagePage = {
          items: [{ ...RELEASE_ITEM, install: INSTALL }],
          nextCursor: null,
        };
        return json(page);
      }
      if (
        url.pathname ===
        "/api/enterprise/plugin-packages/catalogue/release-labs/notes-writer"
      ) {
        return json(RELEASE_DETAIL);
      }
      if (url.pathname === DETAIL_PATH && captured.method === "GET") {
        return json(installDetail());
      }
      if (url.pathname === EXPERT_PATH && captured.method === "POST") {
        expertPosts.push(captured);
        if (respondExpert) return respondExpert();
        if (expertGate) return expertGate;
        return json(EXPERT, 201);
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
  void i18n.changeLanguage("en");
});

async function settle(check: () => void, turns = 80): Promise<void> {
  let last: unknown;
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      check();
      return;
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error
    ? last
    : new Error("The expert wizard flow never settled.");
}

/** Unconditional act turns: used where the assertion is an absence and must outwait a refetch. */
async function flush(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function renderPane(
  scope: typeof SCOPE_A | typeof SCOPE_B,
  canInstall = true,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  // The wizard's success handoff is the router's own `Link`, so the pane renders
  // under a router whose tree registers its one target (`/bots/$agentId`), the same
  // decoy-tree shape `bot-roster.test.tsx` uses. Nothing here navigates; the link's
  // href is the assertion.
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <PackagePane canInstall={canInstall} scope={scope} />
      </QueryClientProvider>
    ),
  });
  const botRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bots/$agentId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([botRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(<RouterProvider router={router as never} />);
  return { view, client };
}

async function openDetail(view: ReturnType<typeof render>) {
  await settle(() => {
    expect(view.getByText("Release Notes Writer")).toBeDefined();
  });
  fireEvent.keyDown(view.getByText("Release Notes Writer"), { key: "Enter" });
  await settle(() => {
    expect(view.getByRole("dialog")).toBeDefined();
    expect(within(view.getByRole("dialog")).getByText(DIGEST)).toBeDefined();
  });
}

/**
 * The topmost accessible dialog. Base UI marks the background content of a stacked modal
 * `aria-hidden`, so while the wizard is open the ONLY dialog in the accessibility tree is the
 * wizard itself; before it opens the one dialog is the package detail.
 */
function topDialog(view: ReturnType<typeof render>): HTMLElement {
  const dialogs = view.getAllByRole("dialog");
  return dialogs[dialogs.length - 1]!;
}

async function openWizard(
  view: ReturnType<typeof render>,
): Promise<HTMLElement> {
  // The affordance lives in the detail dialog; wait past the install-detail read.
  await settle(() => {
    expect(
      within(topDialog(view)).getByRole("button", {
        name: "Create an expert from the template assistant",
      }),
    ).toBeDefined();
  });
  fireEvent.click(
    within(topDialog(view)).getByRole("button", {
      name: "Create an expert from the template assistant",
    }),
  );
  await settle(() => {
    expect(
      within(topDialog(view)).getByText("Create expert from template"),
    ).toBeDefined();
  });
  return topDialog(view);
}

test("an admin creation POSTs exactly the contract body and shows the created agentId", async () => {
  const { view } = renderPane(SCOPE_A);
  await openDetail(view);
  await settle(() => {
    expect(
      within(view.getByRole("dialog")).getByText("Experts from templates"),
    ).toBeDefined();
  });

  const dialog = await openWizard(view);
  // The name draft is prefilled from the package identity and stays editable.
  const nameInput = within(dialog).getByLabelText("Expert name");
  expect((nameInput as HTMLInputElement).value).toBe("Release Notes Writer");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.clear(nameInput);
  await user.type(nameInput, "Meeting Assistant");
  // The profile block is sourced from the install detail's expertTemplate resource: it names
  // the exact ref (packageKey/resourceId) the server's provenance records when the creation
  // writes the profile from the VERIFIED template file. The list row's display copy is a
  // DIFFERENT string than the template's own summary, so it must not appear anywhere in the
  // wizard — and no fake-value textareas exist to carry it.
  expect(
    within(dialog).getByText("Verified template profile (read-only)"),
  ).toBeDefined();
  expect(
    within(dialog).getByText("release-labs/notes-writer/assistant"),
  ).toBeDefined();
  // One provenance chain: the displayed ref is the very `expertTemplateRef` the server's
  // creation receipt records — the display names the source the server writes from.
  expect(EXPERT.expertTemplateRef).toBe("release-labs/notes-writer/assistant");
  expect(
    within(dialog).getByText(
      "The new Bot's summary and system prompt are written by the server from this installed revision's verified template file; their wording is not exposed to the client.",
    ),
  ).toBeDefined();
  expect(
    within(dialog).queryByText("Writes release notes from a changelog."),
  ).toBeNull();
  expect(within(dialog).queryByLabelText("Summary")).toBeNull();
  expect(within(dialog).queryByLabelText("System prompt")).toBeNull();
  // The revision's skill resources are listed read-only — no checkboxes — and the
  // note states the subset rule instead of promising the whole set as the grant.
  expect(
    within(dialog).getByText(
      "Skill resources of the installed revision (read-only)",
    ),
  ).toBeDefined();
  expect(
    within(dialog).getByText(
      "Creating grants the skills this template declares — a subset of the revision's skill resources above, never more. The server confirms the exact set, which the result lists after creation.",
    ),
  ).toBeDefined();
  expect(within(dialog).queryByRole("checkbox")).toBeNull();

  fireEvent.click(
    within(dialog).getByRole("button", { name: "Create expert" }),
  );

  await settle(() => {
    expect(within(topDialog(view)).getByText("Expert created")).toBeDefined();
  });
  expect(within(topDialog(view)).getByText(EXPERT.agentId)).toBeDefined();
  // The app's Bot detail route exists, so success hands off with a real link. This app draws
  // links through the system Button's `render` prop, and Base UI exposes the result as a
  // button-role anchor (see button.tsx) — the assertion holds it to its href.
  const link = within(topDialog(view)).getByRole("link", {
    name: "Open Bot",
  });
  expect(link.getAttribute("href")).toBe(`/bots/${EXPERT.agentId}`);

  expect(expertPosts).toHaveLength(1);
  const request = expertPosts[0];
  expect(request?.method).toBe("POST");
  expect(request?.path).toBe(EXPERT_PATH);
  expect(request?.headers["x-openbot-tenant"]).toBe("tenant-a");
  expect(request?.headers["x-openbot-workspace"]).toBe("workspace-a");
  const key = request?.headers["idempotency-key"] ?? "";
  expect(key.length).toBeGreaterThan(0);
  expect(key.length).toBeLessThanOrEqual(128);
  // Exactly `PackageExpertCreateInputSchema`: identity + CAS revision + display name.
  // Scope and actor never travel in the body; no summary/system-prompt field exists on the wire.
  expect(JSON.parse(request?.body ?? "{}")).toEqual({
    installId: INSTALL_ID,
    resourceId: RESOURCE_ID,
    expectedRevision: 1,
    name: "Meeting Assistant",
  });
});

test("a plain company member has no expert section and no expert requests leave", async () => {
  const { view } = renderPane(SCOPE_A, false);
  await openDetail(view);

  expect(view.queryByText("Experts from templates")).toBeNull();
  expect(seen.some((entry) => entry.path === DETAIL_PATH)).toBeFalse();
  expect(expertSeen).toHaveLength(0);
  expect(expertPosts).toHaveLength(0);
});

test("a revision without expertTemplate resources renders no section shell", async () => {
  templatesInstalled = false;
  const { view } = renderPane(SCOPE_A);
  await openDetail(view);
  await flush();

  expect(view.queryByText("Experts from templates")).toBeNull();
  expect(
    within(view.getByRole("dialog")).queryByRole("button", {
      name: "Create expert from this template",
    }),
  ).toBeNull();
  expect(expertPosts).toHaveLength(0);
});

test("when the install detail stops declaring the template, the wizard notes the missing source instead of the list copy", async () => {
  const { view, client } = renderPane(SCOPE_A);
  await openDetail(view);
  const dialog = await openWizard(view);

  // While the read declares the template, the block names its source: the same
  // packageKey/resourceId ref the server's provenance records on creation.
  expect(
    within(dialog).getByText("release-labs/notes-writer/assistant"),
  ).toBeDefined();

  // The revision's read drifts under the open wizard: assistant gone, another template in —
  // so the section (and the wizard) stay mounted, but the profile's source vanished.
  assistantDeclared = false;
  await act(async () => {
    await client.refetchQueries();
  });
  await flush();

  const wizard = topDialog(view);
  expect(within(wizard).getByText("Create expert from template")).toBeDefined();
  expect(
    within(wizard).getByText(
      "The install detail does not currently declare this template resource, so its verified profile cannot be shown from that source. The server re-validates the template at creation and refuses an unknown resource.",
    ),
  ).toBeDefined();
  // The vanished ref and the list row's display copy are both absent — the fallback notes the
  // source instead of substituting a different string for it.
  expect(
    within(wizard).queryByText("release-labs/notes-writer/assistant"),
  ).toBeNull();
  expect(
    within(wizard).queryByText("Writes release notes from a changelog."),
  ).toBeNull();
});

test("400 TEMPLATE_FIELD_REJECTED and 409 IDEMPOTENCY_CONFLICT surface the server sentence verbatim", async () => {
  const { view } = renderPane(SCOPE_A);
  await openDetail(view);
  const dialog = await openWizard(view);

  respondExpert = () =>
    json(
      {
        error: {
          code: "TEMPLATE_FIELD_REJECTED",
          message: "The expert template carries fields this version refuses.",
        },
      },
      400,
    );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Create expert" }),
  );
  await settle(() => {
    expect(
      within(topDialog(view)).getByText(
        "The expert template carries fields this version refuses.",
      ),
    ).toBeDefined();
  });

  respondExpert = () =>
    json(
      {
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message:
            "This idempotency key was already used for a different request.",
        },
      },
      409,
    );
  fireEvent.click(
    within(topDialog(view)).getByRole("button", { name: "Create expert" }),
  );
  await settle(() => {
    expect(
      within(topDialog(view)).getByText(
        "This idempotency key was already used for a different request.",
      ),
    ).toBeDefined();
  });
  expect(within(topDialog(view)).queryByText("Expert created")).toBeNull();
});

test("the idempotency key is generated once per dialog open and reused on retry", async () => {
  const { view } = renderPane(SCOPE_A);
  await openDetail(view);
  const dialog = await openWizard(view);
  respondExpert = () =>
    json(
      {
        error: {
          code: "REVISION_CONFLICT",
          message: "The package is already installed at another revision.",
        },
      },
      409,
    );

  fireEvent.click(
    within(dialog).getByRole("button", { name: "Create expert" }),
  );
  await settle(() => {
    expect(expertPosts).toHaveLength(1);
  });
  const firstKey = expertPosts[0]?.headers["idempotency-key"];
  expect(firstKey).toBeTruthy();

  // Retrying the same creation intent reuses the dialog's one key…
  fireEvent.click(
    within(topDialog(view)).getByRole("button", { name: "Create expert" }),
  );
  await settle(() => {
    expect(expertPosts).toHaveLength(2);
  });
  expect(expertPosts[1]?.headers["idempotency-key"]).toBe(firstKey);

  // …while a fresh dialog (a new intent) carries a new one.
  respondExpert = null;
  fireEvent.click(
    within(topDialog(view)).getByRole("button", { name: "Close" }),
  );
  await settle(() => {
    expect(view.getAllByRole("dialog")).toHaveLength(1);
  });
  const reopened = await openWizard(view);
  fireEvent.click(
    within(reopened).getByRole("button", { name: "Create expert" }),
  );
  await settle(() => {
    expect(expertPosts).toHaveLength(3);
  });
  const newKey = expertPosts[2]?.headers["idempotency-key"];
  expect(newKey).toBeTruthy();
  expect(newKey).not.toBe(firstKey);
});

test("the submit is disabled with an empty name and while the creation is pending", async () => {
  const { view } = renderPane(SCOPE_A);
  await openDetail(view);
  const dialog = await openWizard(view);
  const submit = () =>
    within(topDialog(view)).getByRole("button", { name: "Create expert" });

  // No name, no creation.
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const nameInput = within(dialog).getByLabelText("Expert name");
  await user.clear(nameInput);
  await user.type(nameInput, "   ");
  expect((submit() as HTMLButtonElement).disabled).toBe(true);
  await user.clear(nameInput);
  await user.type(nameInput, "Meeting Assistant");
  expect((submit() as HTMLButtonElement).disabled).toBe(false);

  let release = (_response: Response) => {};
  expertGate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  fireEvent.click(submit());
  await settle(() => {
    expect(expertPosts).toHaveLength(1);
  });
  // While the POST is pending the verb is the pending label and refuses a second press.
  const pending = within(topDialog(view)).getByRole("button", {
    name: "Creating…",
  }) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  fireEvent.click(pending);
  expect(expertPosts).toHaveLength(1);

  release(json(EXPERT, 201));
  await settle(() => {
    expect(within(topDialog(view)).getByText("Expert created")).toBeDefined();
  });
  expect(expertPosts).toHaveLength(1);
});

test("the expert key carries the scope identifiers and a mid-flight creation cannot write the other team's cache", async () => {
  // The key is the isolation mechanism, so the assertion reads its value: the scope
  // triple (tenantId, workspaceId, principalId) sits in the prefix, install id after it.
  expect(pluginPackageKeys.installDetail(SCOPE_A, INSTALL_ID)).toEqual([
    "plugin-packages",
    "tenant-a",
    "workspace-a",
    "user-1",
    "install",
    INSTALL_ID,
  ]);
  expect(pluginPackageKeys.installDetail(SCOPE_B, INSTALL_ID)).toEqual([
    "plugin-packages",
    "tenant-b",
    "workspace-b",
    "user-1",
    "install",
    INSTALL_ID,
  ]);

  const { view, client } = renderPane(SCOPE_A);
  await openDetail(view);
  const dialog = await openWizard(view);

  let release = (_response: Response) => {};
  expertGate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Create expert" }),
  );
  await settle(() => {
    expect(expertPosts).toHaveLength(1);
  });
  expect(expertPosts[0]?.headers["x-openbot-tenant"]).toBe("tenant-a");

  // The person switches teams while the creation is still in flight.
  view.rerender(
    <QueryClientProvider client={client}>
      <PackagePane canInstall scope={SCOPE_B} />
    </QueryClientProvider>,
  );
  expect(view.queryByRole("dialog")).toBeNull();
  await settle(() => {
    expect(view.getByText("Release Notes Writer")).toBeDefined();
  });
  const tenantBReads = () =>
    seen.filter(
      (entry) =>
        entry.path === DETAIL_PATH &&
        entry.method === "GET" &&
        entry.headers["x-openbot-tenant"] === "tenant-b",
    ).length;
  expect(tenantBReads()).toBe(0);

  // Team A's creation only now answers. It may refresh A's tree; B's cache must stay empty.
  release(json(EXPERT, 201));
  await flush();

  expect(
    client.getQueryData(pluginPackageKeys.installDetail(SCOPE_B, INSTALL_ID)),
  ).toBeUndefined();
  expect(tenantBReads()).toBe(0);
  expect(expertPosts).toHaveLength(1);
});

test("the wizard lists the revision's skills as the superset and the receipt names the granted subset", async () => {
  // The installed revision declares two skills; the template this wizard creates from
  // declares only one. The wire contract's resource summaries carry no template→skill
  // mapping, so the wizard cannot enumerate the granted subset in advance — it lists the
  // revision's skills as the superset, states the subset rule, and the success view shows
  // the server's actual granted set (`PackageExpertCreatedDTO.resources`).
  const { view } = renderPane(SCOPE_A);
  await openDetail(view);
  const dialog = await openWizard(view);

  expect(
    within(dialog).getByText(
      "Skill resources of the installed revision (read-only)",
    ),
  ).toBeDefined();
  expect(
    within(dialog).getByText(
      "Creating grants the skills this template declares — a subset of the revision's skill resources above, never more. The server confirms the exact set, which the result lists after creation.",
    ),
  ).toBeDefined();
  expect(within(dialog).getByText("notes-writer")).toBeDefined();
  expect(within(dialog).getByText("archive-reader")).toBeDefined();

  const user = userEvent.setup({ document: view.container.ownerDocument });
  const nameInput = within(dialog).getByLabelText("Expert name");
  await user.clear(nameInput);
  await user.type(nameInput, "Meeting Assistant");
  await user.click(
    within(dialog).getByRole("button", { name: "Create expert" }),
  );

  await settle(() => {
    expect(within(topDialog(view)).getByText("Expert created")).toBeDefined();
  });
  // The receipt is the authoritative granted set: the template declared only
  // notes-writer, so archive-reader appears nowhere in the success view — the wizard
  // never promised it as the grant in the first place.
  expect(
    within(topDialog(view)).getByText(
      "Skills this creation granted (the server's receipt)",
    ),
  ).toBeDefined();
  expect(within(topDialog(view)).getByText("notes-writer")).toBeDefined();
  expect(within(topDialog(view)).queryByText("archive-reader")).toBeNull();
});
