import "./preload";
// app/tests/plugin-package-install.test.tsx
import { GlobalRegistrator } from "@happy-dom/global-registrator";
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
  PackageInstallDTO,
  PackagePage,
  PackagePageItem,
  PackagePlanDTO,
} from "../../shared/enterprise/plugin-package-contracts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import { PackagePane } from "../src/components/market/package-pane";
import { storeSelection } from "../src/lib/enterprise/tenant/selection";
import i18n from "../src/lib/i18n";
import {
  PACKAGE_PAGE_SIZE,
  pluginPackageKeys,
} from "../src/lib/plugin-packages/queries";
import { MarketPage } from "../src/routes/_authed/admin/market";

/**
 * The plugin-package install flow of `/admin/market`, PKG02.
 *
 * WHAT THESE CASES HOLD. A company administrator previews an install, sees the exact
 * version/digest/team/resources/tools/blockers if the server would create them, and confirms
 * exactly once. A member sees the real install state and no install verb. Nothing on this screen
 * ever claims that installing grants a Bot execution rights; the plan preview is discarded on a
 * scope switch and a late apply response can only touch the scope it left under.
 *
 * THE HARNESS IS THIS REPOSITORY'S native e2e pattern (see `plugin-package-catalogue.test.tsx`):
 * happy-dom registered per file, a fetch stub that records path/headers/body, one `QueryClient`
 * with `retry: false`, and `settle` as the act boundary that flushes React Query's responses.
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

const PACKAGE_KEY = "release-labs/notes-writer";
const DIGEST = "b".repeat(64);

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
    { id: "notes-skill", kind: "skill", available: true },
    { id: "tracker", kind: "managedConnector", available: false },
  ],
  installable: true,
  blockers: [],
};

const PLAN: PackagePlanDTO = {
  planId: "plan-1",
  operation: "install",
  packageKey: PACKAGE_KEY,
  version: "2.0.0",
  artifactDigest: DIGEST,
  expectedRevision: null,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  resources: [
    { id: "notes-skill", kind: "skill" },
    { id: "tracker", kind: "managedConnector" },
  ],
  addedTools: [
    {
      ref: "tracker:create-note",
      effect: "write",
      schemaDigest: "c".repeat(64),
    },
    { ref: "tracker:read-notes", effect: "read", schemaDigest: "d".repeat(64) },
  ],
  removedTools: [],
  blockers: [{ code: "NEEDS_CONNECTION", resourceId: "tracker" }],
};

const INSTALL: PackageInstallDTO = {
  installId: "install-1",
  packageKey: PACKAGE_KEY,
  version: "2.0.0",
  artifactDigest: DIGEST,
  revision: 1,
  generation: 1,
  status: "enabled",
  readiness: "needs_grant",
  blockers: [{ code: "NEEDS_GRANT" }],
  allowedActions: [],
};

type Captured = {
  method: string;
  path: string;
  params: URLSearchParams;
  headers: Record<string, string>;
  body: string | null;
};

let pagesByTenant: Record<string, PackagePage>;
let planRequests: Captured[];
let applyRequests: Captured[];
let planFailure: { status: number; code: string } | null;
let applyFailure: { status: number; code: string } | null;
let planGate: Promise<Response> | null;
let applyGate: Promise<Response> | null;
let planAnswer: PackagePlanDTO;
let installsAfterApply: boolean;
let deploymentRole: "admin" | "user";
let companyRole: string;
let seen: Captured[];
const originalFetch = global.fetch;

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorBody(code: string) {
  return { error: { code, message: `Server says ${code}` } };
}

beforeEach(() => {
  pagesByTenant = {
    "tenant-a": { items: [RELEASE_ITEM], nextCursor: null },
    "tenant-b": { items: [RELEASE_ITEM], nextCursor: null },
  };
  planRequests = [];
  applyRequests = [];
  planFailure = null;
  applyFailure = null;
  planGate = null;
  applyGate = null;
  planAnswer = PLAN;
  installsAfterApply = false;
  deploymentRole = "user";
  companyRole = "tenant_admin";
  seen = [];
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
        params: url.searchParams,
        headers,
        body: typeof init?.body === "string" ? init.body : null,
      };
      seen.push(captured);
      // The `/admin/market` route's own reads, for the role-gating cases below.
      if (url.pathname === "/api/me") {
        return json({
          user: {
            id: "user-1",
            email: "user-1@example.test",
            name: "User One",
            role: deploymentRole,
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
              role: companyRole,
              memberEpoch: 1,
              teams: [{ workspaceId: "workspace-a", name: "Team A" }],
            },
          ],
        });
      }
      if (url.pathname === "/api/marketplace") {
        return json({
          experts: [],
          skills: [],
          categories: { experts: [], skills: [], connectors: [] },
        });
      }
      if (url.pathname === "/api/plugins") {
        return json({
          catalogue: [],
          servers: [],
          skills: [],
          botsMayCallBack: false,
          redirectUri: null,
          composioConfigured: false,
          openConnectorConfigured: false,
        });
      }
      if (url.pathname === "/api/agents") return json({ agents: [] });
      if (
        url.pathname === "/api/enterprise/plugin-packages" &&
        captured.method === "GET"
      ) {
        const tenant = headers["x-openbot-tenant"] ?? "";
        const page = pagesByTenant[tenant] ?? {
          items: [],
          nextCursor: null,
        };
        if (!installsAfterApply) return json(page);
        // After a successful apply this deployment's lists report the install, whichever team
        // asks — so an invalidation aimed at the wrong scope would refetch and show it.
        return json({
          ...page,
          items: page.items.map((item) => ({
            ...item,
            install: item.install ?? INSTALL,
          })),
        });
      }
      if (
        url.pathname ===
        "/api/enterprise/plugin-packages/catalogue/release-labs/notes-writer"
      ) {
        return json(RELEASE_DETAIL);
      }
      if (
        url.pathname === "/api/enterprise/plugin-packages/plans" &&
        captured.method === "POST"
      ) {
        planRequests.push(captured);
        if (planGate) return planGate;
        if (planFailure) {
          return json(errorBody(planFailure.code), planFailure.status);
        }
        return json(planAnswer);
      }
      if (
        url.pathname === "/api/enterprise/plugin-packages/plans/plan-1/apply" &&
        captured.method === "POST"
      ) {
        applyRequests.push(captured);
        if (applyGate) return applyGate;
        if (applyFailure) {
          return json(errorBody(applyFailure.code), applyFailure.status);
        }
        installsAfterApply = true;
        return json(INSTALL, 201);
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
    : new Error("The package install flow never settled.");
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
  const view = render(
    <QueryClientProvider client={client}>
      <PackagePane canInstall={canInstall} scope={scope} />
    </QueryClientProvider>,
  );
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

async function openPreview(view: ReturnType<typeof render>) {
  await openDetail(view);
  fireEvent.click(
    within(view.getByRole("dialog")).getByRole("button", {
      name: "Preview install",
    }),
  );
  await settle(() => {
    expect(view.getByRole("dialog")).toBeDefined();
    expect(within(view.getByRole("dialog")).getByText(DIGEST)).toBeDefined();
    expect(
      within(view.getByRole("dialog")).getByText("notes-skill"),
    ).toBeDefined();
  });
}

test("an admin preview shows the exact package, digest, team, resources, tools and blockers, and asks the server for a plan", async () => {
  const { view } = renderPane(SCOPE_A);
  await openPreview(view);

  const dialog = view.getByRole("dialog");
  expect(within(dialog).getByText(PACKAGE_KEY)).toBeDefined();
  expect(within(dialog).getByText("2.0.0")).toBeDefined();
  expect(within(dialog).getByText(DIGEST)).toBeDefined();
  expect(within(dialog).getByText("workspace-a")).toBeDefined();
  expect(within(dialog).getByText("notes-skill")).toBeDefined();
  // The resource row and the blocker both name the connector.
  expect(within(dialog).getAllByText("tracker")).toHaveLength(2);
  expect(within(dialog).getByText("Skill")).toBeDefined();
  expect(within(dialog).getByText("Connector")).toBeDefined();
  expect(within(dialog).getByText("tracker:create-note")).toBeDefined();
  expect(within(dialog).getByText("tracker:read-notes")).toBeDefined();
  expect(within(dialog).getByText("Write")).toBeDefined();
  expect(within(dialog).getByText("Read")).toBeDefined();
  expect(
    within(dialog).getByText("A required connector is not connected yet."),
  ).toBeDefined();
  expect(within(dialog).getByText(/10 minutes/)).toBeDefined();
  // A first install has no version diff: the editor keeps its own hint and
  // offers no removal acknowledgement.
  expect(
    within(dialog).getByText(/Flat, non-secret values only/),
  ).toBeDefined();
  expect(within(dialog).queryByRole("checkbox")).toBeNull();

  expect(planRequests).toHaveLength(1);
  const request = planRequests[0];
  expect(request?.method).toBe("POST");
  expect(request?.headers["x-openbot-tenant"]).toBe("tenant-a");
  expect(request?.headers["x-openbot-workspace"]).toBe("workspace-a");
  expect(JSON.parse(request?.body ?? "{}")).toEqual({
    operation: "install",
    packageKey: PACKAGE_KEY,
    version: "2.0.0",
    expectedRevision: null,
    config: {},
    connectorInstalls: {},
  });
});

test("a member sees the installed state read-only and has no install action", async () => {
  pagesByTenant["tenant-a"] = {
    items: [{ ...RELEASE_ITEM, install: INSTALL }],
    nextCursor: null,
  };
  const { view } = renderPane(SCOPE_A, false);
  await openDetail(view);

  const dialog = view.getByRole("dialog");
  expect(
    within(dialog).queryByRole("button", { name: "Preview install" }),
  ).toBeNull();
  expect(within(dialog).getByText("Installed")).toBeDefined();
  expect(within(dialog).getByText("Needs Bot grant")).toBeDefined();
  expect(
    within(dialog).getByText(
      "The package is installed, but no Bot may execute it yet: installation alone does not grant Bot execution rights.",
    ),
  ).toBeDefined();
  expect(planRequests).toHaveLength(0);
});

test("confirming sends exactly one apply with an idempotency key and shows needs_grant", async () => {
  const { view, client } = renderPane(SCOPE_A);
  await openPreview(view);

  fireEvent.click(
    within(view.getByRole("dialog")).getByRole("button", {
      name: "Confirm install",
    }),
  );

  await settle(() => {
    expect(
      within(view.getByRole("dialog")).getByText("Needs Bot grant"),
    ).toBeDefined();
  });
  expect(
    within(view.getByRole("dialog")).getByText(
      "The package is installed, but no Bot may execute it yet: installation alone does not grant Bot execution rights.",
    ),
  ).toBeDefined();

  expect(applyRequests).toHaveLength(1);
  const request = applyRequests[0];
  expect(request?.method).toBe("POST");
  expect(request?.headers["x-openbot-tenant"]).toBe("tenant-a");
  expect(request?.headers["x-openbot-workspace"]).toBe("workspace-a");
  const key = request?.headers["idempotency-key"] ?? "";
  expect(key.length).toBeGreaterThan(0);
  expect(key.length).toBeLessThanOrEqual(128);

  // The captured scope's cache was invalidated, so the shelf asked again.
  await settle(() => {
    const listReads = seen.filter(
      (entry) =>
        entry.path === "/api/enterprise/plugin-packages" &&
        entry.method === "GET",
    );
    expect(listReads.length).toBeGreaterThanOrEqual(2);
  });
  expect(
    client
      .getQueryCache()
      .getAll()
      .some((query) => query.queryKey[0] === "plugin-packages"),
  ).toBeTrue();
});

test("a second press while the apply is pending is disabled and sends no second request", async () => {
  const { view } = renderPane(SCOPE_A);
  await openPreview(view);

  let release = (_response: Response) => {};
  applyGate = new Promise<Response>((resolve) => {
    release = resolve;
  });

  const confirm = within(view.getByRole("dialog")).getByRole("button", {
    name: "Confirm install",
  });
  fireEvent.click(confirm);
  fireEvent.click(confirm);

  await settle(() => {
    expect(applyRequests).toHaveLength(1);
  });
  expect(
    within(view.getByRole("dialog")).getByRole("button", {
      name: "Installing…",
    }),
  ).toBeDefined();
  // The disabled button and the in-flight guard agree: still exactly one request.
  expect(applyRequests).toHaveLength(1);

  release(json(INSTALL, 201));
  await settle(() => {
    expect(
      within(view.getByRole("dialog")).getByText("Needs Bot grant"),
    ).toBeDefined();
  });
  expect(applyRequests).toHaveLength(1);
});

test("an expired plan returns to preview with the non-secret configuration kept", async () => {
  const { view } = renderPane(SCOPE_A);
  await openPreview(view);

  const dialog = () => view.getByRole("dialog");
  fireEvent.click(
    within(dialog()).getByRole("button", {
      name: "Add configuration field",
    }),
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(within(dialog()).getByLabelText("Configuration key"), "region");
  await user.type(
    within(dialog()).getByLabelText("Configuration value"),
    "eu-central",
  );
  // Editing after a preview discards the stale plan; a new preview is explicit.
  expect(
    within(dialog()).queryByRole("button", { name: "Confirm install" }),
  ).toBeNull();
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Preview install" }),
  );
  await settle(() => {
    expect(planRequests).toHaveLength(2);
    expect(
      within(dialog()).getByRole("button", { name: "Confirm install" }),
    ).toBeDefined();
  });
  expect(JSON.parse(planRequests[1]?.body ?? "{}").config).toEqual({
    region: "eu-central",
  });

  applyFailure = { status: 410, code: "PLAN_EXPIRED" };
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Confirm install" }),
  );

  await settle(() => {
    expect(
      within(dialog()).getByText(
        "This install preview expired. Your configuration was kept — create a new preview.",
      ),
    ).toBeDefined();
  });
  expect(
    within(dialog()).queryByRole("button", { name: "Confirm install" }),
  ).toBeNull();
  expect(
    (within(dialog()).getByLabelText("Configuration key") as HTMLInputElement)
      .value,
  ).toBe("region");
  expect(
    (within(dialog()).getByLabelText("Configuration value") as HTMLInputElement)
      .value,
  ).toBe("eu-central");

  applyFailure = null;
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Preview install" }),
  );
  await settle(() => {
    expect(planRequests).toHaveLength(3);
    expect(
      within(dialog()).getByRole("button", { name: "Confirm install" }),
    ).toBeDefined();
  });
});

test("a scope switch clears the pending plan and a late apply response cannot touch the new scope", async () => {
  const { view, client } = renderPane(SCOPE_A);
  await openPreview(view);

  let release = (_response: Response) => {};
  applyGate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  fireEvent.click(
    within(view.getByRole("dialog")).getByRole("button", {
      name: "Confirm install",
    }),
  );
  await settle(() => {
    expect(applyRequests).toHaveLength(1);
  });

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
        entry.path === "/api/enterprise/plugin-packages" &&
        entry.method === "GET" &&
        entry.headers["x-openbot-tenant"] === "tenant-b",
    ).length;
  const bReadsBefore = tenantBReads();

  // Team A's apply only now answers, and from here on every list reports an install. If the
  // mutation invalidated the wrong scope, team B's live shelf would refetch and show it.
  installsAfterApply = true;
  release(json(INSTALL, 201));
  await flush();

  expect(view.queryByText("Installed")).toBeNull();
  expect(view.queryByText("Needs Bot grant")).toBeNull();
  expect(tenantBReads()).toBe(bReadsBefore);
  const pageB = client.getQueryData<PackagePage>(
    pluginPackageKeys.list(SCOPE_B, {
      cursor: null,
      limit: PACKAGE_PAGE_SIZE,
    }),
  );
  expect(pageB?.items[0]?.install).toBeNull();
  expect(applyRequests[0]?.headers["x-openbot-tenant"]).toBe("tenant-a");

  // Team A's own tree was invalidated and now reads the install: A gains it, B never did.
  view.rerender(
    <QueryClientProvider client={client}>
      <PackagePane canInstall scope={SCOPE_A} />
    </QueryClientProvider>,
  );
  await settle(() => {
    expect(view.getByText("Installed")).toBeDefined();
  });
  // The old pending plan did not survive the remount either: the detail opens installed.
  fireEvent.keyDown(view.getByText("Release Notes Writer"), { key: "Enter" });
  await settle(() => {
    expect(
      within(view.getByRole("dialog")).getByText("Installed"),
    ).toBeDefined();
  });
  const pageA = client.getQueryData<PackagePage>(
    pluginPackageKeys.list(SCOPE_A, {
      cursor: null,
      limit: PACKAGE_PAGE_SIZE,
    }),
  );
  expect(pageA?.items[0]?.install).toEqual(INSTALL);
});

test("the list and detail draw the installed version, revision, status, readiness and blockers", async () => {
  pagesByTenant["tenant-a"] = {
    items: [{ ...RELEASE_ITEM, install: INSTALL }],
    nextCursor: null,
  };
  const { view } = renderPane(SCOPE_A);
  await settle(() => {
    expect(view.getByText("Release Notes Writer")).toBeDefined();
  });

  expect(view.getByText("Installed")).toBeDefined();
  expect(view.getByText("v2.0.0")).toBeDefined();
  expect(view.getByText("r1")).toBeDefined();
  expect(view.getByText("Enabled")).toBeDefined();
  expect(view.getByText("Needs Bot grant")).toBeDefined();
  expect(
    view.getByText(
      "The package is installed, but no Bot may execute it yet: installation alone does not grant Bot execution rights.",
    ),
  ).toBeDefined();

  fireEvent.keyDown(view.getByText("Release Notes Writer"), { key: "Enter" });
  await settle(() => {
    expect(view.getByRole("dialog")).toBeDefined();
    expect(
      within(view.getByRole("dialog")).getByText("Installed"),
    ).toBeDefined();
  });
  // The install state's own chip; the upgrade section carries a second one.
  expect(
    within(
      within(view.getByRole("dialog")).getByRole("region", {
        name: "Installation",
      }),
    ).getByText("r1"),
  ).toBeDefined();
});

test("a failed preview keeps the configuration and a retry asks for a new plan", async () => {
  planFailure = { status: 503, code: "ADMIN_CHANNEL_UNAVAILABLE" };
  const { view } = renderPane(SCOPE_A);
  await openDetail(view);
  fireEvent.click(
    within(view.getByRole("dialog")).getByRole("button", {
      name: "Preview install",
    }),
  );

  const dialog = () => view.getByRole("dialog");
  await settle(() => {
    expect(
      within(dialog()).getByText(
        "Package installation is unavailable on this deployment right now.",
      ),
    ).toBeDefined();
  });

  fireEvent.click(
    within(dialog()).getByRole("button", {
      name: "Add configuration field",
    }),
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(within(dialog()).getByLabelText("Configuration key"), "region");
  await user.type(
    within(dialog()).getByLabelText("Configuration value"),
    "eu-central",
  );

  planFailure = null;
  // Editing discarded the failed preview; the same button now re-plans with the kept config.
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Preview install" }),
  );
  await settle(() => {
    expect(planRequests).toHaveLength(2);
    expect(
      within(dialog()).getByRole("button", { name: "Confirm install" }),
    ).toBeDefined();
  });
  expect(JSON.parse(planRequests[1]?.body ?? "{}").config).toEqual({
    region: "eu-central",
  });
});

test("a secret-looking configuration key is refused before a request leaves the browser", async () => {
  const { view } = renderPane(SCOPE_A);
  await openPreview(view);

  const dialog = () => view.getByRole("dialog");
  fireEvent.click(
    within(dialog()).getByRole("button", {
      name: "Add configuration field",
    }),
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(within(dialog()).getByLabelText("Configuration key"), "api_token");
  await user.type(
    within(dialog()).getByLabelText("Configuration value"),
    "do-not-send",
  );
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Preview install" }),
  );

  await settle(() => {
    expect(
      within(dialog()).getByText(
        "Configuration keys must not look like secrets (token, password, API key…).",
      ),
    ).toBeDefined();
  });
  // The only plan that ever left is the empty one from opening the dialog.
  expect(planRequests).toHaveLength(1);
  expect(planRequests[0]?.body ?? "").not.toContain("do-not-send");
});

test("an edit during a pending preview clears the creating state and a stale answer cannot clobber the next preview", async () => {
  let release = (_response: Response) => {};
  planGate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const { view } = renderPane(SCOPE_A);
  await openDetail(view);

  const dialog = () => view.getByRole("dialog");
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Preview install" }),
  );
  await settle(() => {
    expect(
      within(dialog()).getByText("Creating the install preview…"),
    ).toBeDefined();
  });

  // Editing discards the request whose answer is still outstanding. The dialog owes the person
  // a way forward now, not "Creating preview…" forever.
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Add configuration field" }),
  );
  await settle(() => {
    expect(
      within(dialog()).queryByText("Creating the install preview…"),
    ).toBeNull();
    expect(
      within(dialog()).getByRole("button", { name: "Preview install" }),
    ).toBeDefined();
  });

  // A new preview starts under a newer token; the dropped answer must not clear its state.
  planGate = null;
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Preview install" }),
  );
  await settle(() => {
    expect(planRequests).toHaveLength(2);
    expect(
      within(dialog()).getByRole("button", { name: "Confirm install" }),
    ).toBeDefined();
  });

  release(json(PLAN));
  await flush();
  expect(
    within(dialog()).getByRole("button", { name: "Confirm install" }),
  ).toBeDefined();
  expect(
    within(dialog()).queryByText("Creating the install preview…"),
  ).toBeNull();
});

test("configuration fields are disabled while the apply is in flight", async () => {
  const { view } = renderPane(SCOPE_A);
  await openPreview(view);
  const dialog = () => view.getByRole("dialog");
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Add configuration field" }),
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(within(dialog()).getByLabelText("Configuration key"), "region");
  await user.type(
    within(dialog()).getByLabelText("Configuration value"),
    "eu-central",
  );
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Preview install" }),
  );
  await settle(() => {
    expect(
      within(dialog()).getByRole("button", { name: "Confirm install" }),
    ).toBeDefined();
  });

  let release = (_response: Response) => {};
  applyGate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Confirm install" }),
  );
  await settle(() => {
    expect(applyRequests).toHaveLength(1);
  });

  expect(
    (within(dialog()).getByLabelText("Configuration key") as HTMLInputElement)
      .disabled,
  ).toBe(true);
  expect(
    (within(dialog()).getByLabelText("Configuration value") as HTMLInputElement)
      .disabled,
  ).toBe(true);
  expect(
    (within(dialog()).getByLabelText("Configuration type") as HTMLSelectElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      within(dialog()).getByRole("button", {
        name: "Remove field",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      within(dialog()).getByRole("button", {
        name: "Add configuration field",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);

  release(json(INSTALL, 201));
  await settle(() => {
    expect(within(dialog()).getByText("Needs Bot grant")).toBeDefined();
  });
});

test("a 409 conflict drops the spent preview but keeps the configuration, and recovery is a fresh preview", async () => {
  const { view } = renderPane(SCOPE_A);
  await openPreview(view);
  const dialog = () => view.getByRole("dialog");
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Add configuration field" }),
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(within(dialog()).getByLabelText("Configuration key"), "region");
  await user.type(
    within(dialog()).getByLabelText("Configuration value"),
    "eu-central",
  );
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Preview install" }),
  );
  await settle(() => {
    expect(planRequests).toHaveLength(2);
    expect(
      within(dialog()).getByRole("button", { name: "Confirm install" }),
    ).toBeDefined();
  });

  applyFailure = { status: 409, code: "CONFLICT" };
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Confirm install" }),
  );
  await settle(() => {
    expect(
      within(dialog()).getByText(
        "This package changed or this confirmation was already used. Review a fresh preview before trying again.",
      ),
    ).toBeDefined();
  });
  expect(
    within(dialog()).queryByRole("button", { name: "Confirm install" }),
  ).toBeNull();
  expect(
    (within(dialog()).getByLabelText("Configuration key") as HTMLInputElement)
      .value,
  ).toBe("region");

  applyFailure = null;
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Preview install" }),
  );
  await settle(() => {
    expect(planRequests).toHaveLength(3);
    expect(
      within(dialog()).getByRole("button", { name: "Confirm install" }),
    ).toBeDefined();
  });
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Confirm install" }),
  );
  await settle(() => {
    expect(within(dialog()).getByText("Needs Bot grant")).toBeDefined();
  });
  expect(JSON.parse(planRequests[2]?.body ?? "{}").config).toEqual({
    region: "eu-central",
  });

  expect(applyRequests).toHaveLength(2);
  const firstKey = applyRequests[0]?.headers["idempotency-key"];
  const secondKey = applyRequests[1]?.headers["idempotency-key"];
  expect(firstKey).toBeDefined();
  expect(secondKey).toBeDefined();
  expect(secondKey).not.toBe(firstKey);
});

test("a 403 refusal keeps the valid preview and the retry is a new attempt with its own idempotency key", async () => {
  const { view } = renderPane(SCOPE_A);
  await openPreview(view);
  const dialog = () => view.getByRole("dialog");

  applyFailure = { status: 403, code: "FORBIDDEN" };
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Confirm install" }),
  );
  await settle(() => {
    expect(
      within(dialog()).getByText(
        "You do not have permission to install packages in this team.",
      ),
    ).toBeDefined();
  });
  // Nothing was spent: the unexpired plan can be confirmed again.
  expect(
    within(dialog()).getByRole("button", { name: "Confirm install" }),
  ).toBeDefined();

  applyFailure = null;
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Confirm install" }),
  );
  await settle(() => {
    expect(within(dialog()).getByText("Needs Bot grant")).toBeDefined();
  });

  expect(applyRequests).toHaveLength(2);
  const firstKey = applyRequests[0]?.headers["idempotency-key"];
  const secondKey = applyRequests[1]?.headers["idempotency-key"];
  expect(firstKey).toBeDefined();
  expect(secondKey).toBeDefined();
  expect(secondKey).not.toBe(firstKey);
});

test("the expiry time follows the app language, not the browser default", async () => {
  const fixed = new Date(2026, 9, 19, 22, 30, 0);
  planAnswer = { ...PLAN, expiresAt: fixed.toISOString() };
  const { view } = renderPane(SCOPE_A);
  await openPreview(view);

  await i18n.changeLanguage("zh-CN");
  const expected = fixed.toLocaleTimeString("zh-CN");
  await settle(() => {
    expect(
      within(view.getByRole("dialog")).getByText(
        `此预览 10 分钟内有效，截止 ${expected}。`,
      ),
    ).toBeDefined();
  });
});

test("a malformed expiry renders the fallback instead of Invalid Date", async () => {
  planAnswer = { ...PLAN, expiresAt: "not-a-time" };
  const { view } = renderPane(SCOPE_A);
  await openPreview(view);

  const dialog = view.getByRole("dialog");
  expect(
    within(dialog).getByText("This preview is valid for 10 minutes."),
  ).toBeDefined();
  expect(within(dialog).queryByText(/Invalid Date/)).toBeNull();
});

async function openMarketPackages() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MarketPage />
    </QueryClientProvider>,
  );
  await settle(() => {
    expect(view.getByRole("button", { name: "Plugin packages" })).toBeDefined();
  });
  fireEvent.click(view.getByRole("button", { name: "Plugin packages" }));
  await settle(() => {
    expect(view.getByText("Release Notes Writer")).toBeDefined();
  });
  fireEvent.keyDown(view.getByText("Release Notes Writer"), { key: "Enter" });
  await settle(() => {
    expect(view.getByRole("dialog")).toBeDefined();
    expect(within(view.getByRole("dialog")).getByText(DIGEST)).toBeDefined();
  });
  return view;
}

test("a deployment administrator who is only a company member sees no package install action", async () => {
  deploymentRole = "admin";
  companyRole = "member";
  storeSelection("user-1", {
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
  });

  const view = await openMarketPackages();
  await settle(() => {
    // The role source answered, and the detail still offers no install verb.
    expect(
      seen.some((entry) => entry.path === "/api/enterprise/workspace-scope"),
    ).toBeTrue();
    expect(
      within(view.getByRole("dialog")).queryByRole("button", {
        name: "Preview install",
      }),
    ).toBeNull();
  });
});

test("a company tenant_admin sees the package install action without the deployment admin role", async () => {
  deploymentRole = "user";
  companyRole = "tenant_admin";
  storeSelection("user-1", {
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
  });

  const view = await openMarketPackages();
  await settle(() => {
    expect(
      within(view.getByRole("dialog")).getByRole("button", {
        name: "Preview install",
      }),
    ).toBeDefined();
  });
});
