import "../../../tests/preload";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../../../tests/support/e2e-compat";
import type { OrganizationScopeAdapter } from "./organization-plugin";

/*
 * T01.09 (#521): the organization and account client adapters for the fixed UI.
 *
 * The pinned Better Auth UI source (better-auth-ui 3.2.13, ui-source.json) reads
 * four X-class native GETs — /organization/list, /organization/list-user-teams,
 * /organization/get-invitation, /organization/list-user-invitations — through its
 * own hooks. This task composes the fixed organization client, and registers local
 * adapters that feed every organization component from the OpenBot side instead:
 * eligibility comes from the workspace-scope listing, a switch is a selection
 * intent, and the dangerous actions (create organization/personal space, dynamic
 * roles, bare delete, impersonation) have no callable surface at all.
 *
 * The app modules are imported dynamically after happy-dom registers: the auth
 * client singleton is created at module scope and needs window.location, which
 * the native layer does not have while a test file's imports evaluate.
 */

type PinnedKit = typeof import("better-auth-ui");
type RegistryProvider = typeof import("../../components/auth/provider");
type UiProviderModule = typeof import("./ui-provider");
type OrganizationPlugin = typeof import("./organization-plugin");
type AuthPlugin = typeof import("./auth-plugin");
type AuthClientModule = typeof import("./client");

let pinned: PinnedKit;
let registry: RegistryProvider;
let ui: UiProviderModule;
let organization: OrganizationPlugin;
let authPlugin: AuthPlugin;
let authClient: AuthClientModule["authClient"];
let queryClient: typeof import("@/query-client")["queryClient"];

const REPO_ROOT = process.cwd();
const MANIFEST_PATH = join(REPO_ROOT, "app/src/lib/auth/ui-source.json");

/** The X-class native GETs the organization UI must never call directly (interfaces §3.2). */
const X_CLASS_ENDPOINTS = [
  "/organization/list",
  "/organization/list-user-teams",
  "/organization/get-invitation",
  "/organization/list-user-invitations",
  "/organization/get-role",
  "/organization/list-roles",
];

/** The client methods the pinned 3.2.13 organization components read or call (better-auth 1.7.1). */
const PINNED_CLIENT_SURFACE = [
  "organization.list",
  "organization.getInvitation",
  "organization.listUserInvitations",
  "organization.listMembers",
  "organization.setActive",
  "useListOrganizations",
  "useActiveOrganization",
];

let scopeSequence = 0;

/** A minimal real adapter: one company, a recording selection sink, a test-owned cache key. */
function fakeScope(
  companies: { id: string; name: string }[] = [
    { id: "tenant-a", name: "Alpha" },
  ],
) {
  const calls = { listed: 0, chosen: [] as (string | null)[] };
  const adapter: OrganizationScopeAdapter = {
    userId: "user-1",
    listingQueryKey: ["t0109", "listing", String(++scopeSequence)],
    listCompanies: async () => {
      calls.listed += 1;
      return companies;
    },
    activeCompanyId: null,
    selectCompany: (companyId) => {
      calls.chosen.push(companyId);
    },
  };
  return { adapter, calls };
}

/** The providers' tree as main.tsx mounts it: one query client, the app router. */
function mountUnderExistingProviders(node: ReactNode) {
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => node,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The pinned component as the declaration gate takes it. */
const pinnedComponent = (name: keyof PinnedKit) =>
  pinned[name] as unknown as ComponentType<Record<string, unknown>>;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  [pinned, registry, ui, organization, authPlugin] = await Promise.all([
    import("better-auth-ui"),
    import("../../components/auth/provider"),
    import("./ui-provider"),
    import("./organization-plugin"),
    import("./auth-plugin"),
  ]);
  ({ authClient } = await import("./client"));
  ({ queryClient } = await import("../../query-client"));
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

/**
 * The pinned kit's organization components are typed against a client that carries the
 * organization plugin's whole surface. `typeErrors` is what the compiler says about this
 * app's real `authClient` when that surface is exercised: an empty list means the composed
 * client matches the fixed better-auth version, and the control file proves the harness
 * actually reports a missing member instead of silently passing.
 */
function clientTypeErrors(): { typeErrors: string[]; controlErrors: string[] } {
  const scratch = mkdtempSync(join(REPO_ROOT, "app/.t0109-client-types-"));
  const fixture = "registry-client.fixture.ts";
  const control = "dangerous-control.fixture.ts";
  writeFileSync(
    join(scratch, fixture),
    [
      'import { authClient } from "@/lib/auth/client";',
      "",
      "export const registryClientSurface = [",
      ...PINNED_CLIENT_SURFACE.map((member) => `  authClient.${member},`),
      "];",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(scratch, control),
    [
      'import { authClient } from "@/lib/auth/client";',
      "",
      "// Must not exist: impersonation is not part of the fixed client surface.",
      "export const impersonation = authClient.organization.impersonateUser;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(scratch, "tsconfig.json"),
    JSON.stringify(
      {
        extends: "../tsconfig.json",
        include: [],
        files: [fixture, control],
      },
      null,
      2,
    ),
  );

  try {
    const compiled = spawnSync(
      join(REPO_ROOT, "node_modules/.bin/tsc"),
      ["--noEmit", "-p", join(scratch, "tsconfig.json")],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const diagnostics = `${compiled.stdout ?? ""}${compiled.stderr ?? ""}`
      .split("\n")
      .filter((line) => line.includes(": error TS"));
    return {
      typeErrors: diagnostics.filter((line) => line.includes(fixture)),
      controlErrors: diagnostics.filter((line) => line.includes(control)),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("registry_client_methods_match_fixed_version", () => {
  const { typeErrors, controlErrors } = clientTypeErrors();

  // Every method the pinned organization components use resolves on the composed client...
  expect(typeErrors).toEqual([]);
  // ...and the harness is not vacuous: a dangerous method the fixed surface does not
  // carry is reported as a type error.
  expect(controlErrors.some((line) => line.includes("TS2339"))).toBe(true);
});

test("dangerous_actions_have_no_adapter", () => {
  const exposedActions: string[] = [
    ...organization.ORGANIZATION_ADAPTER_ACTIONS,
  ];

  // No adapter action for impersonation, self-service company/personal-space creation,
  // dynamic roles, or a bare delete.
  for (const forbidden of [
    "impersonate",
    "impersonateUser",
    "createOrganization",
    "createPersonalOrganization",
    "deleteOrganization",
    "createRole",
    "updateRole",
    "deleteRole",
  ]) {
    expect(exposedActions).not.toContain(forbidden);
  }
  expect(exposedActions).not.toContain("impersonate");

  // The composed client has no admin plugin at all, so no impersonation namespace exists...
  expect("admin" in authClient).toBe(false);
  expect(
    authPlugin.openBotClientPlugins().map((plugin) => plugin.id),
  ).not.toContain("admin");

  // ...and the client the organization components run against exposes exactly one
  // organization action, the controlled selection intent. Everything else is undefined,
  // so calling it is not possible rather than merely discouraged.
  const { adapter } = fakeScope();
  const facade = organization.restrictedOrganizationClient(adapter);
  const clientOrganization = facade.organization as unknown as Record<
    string,
    unknown
  >;
  expect(Object.keys(clientOrganization)).toEqual(["setActive"]);
  for (const action of [
    "create",
    "delete",
    "update",
    "updateMemberRole",
    "inviteMember",
    "removeMember",
    "createRole",
    "deleteRole",
    "list",
    "getInvitation",
    "listUserInvitations",
    "impersonateUser",
  ]) {
    expect(clientOrganization[action]).toBeUndefined();
  }
});

test("declared_inject_components_have_registered_adapters", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    organization: Record<string, { reuse: string }>;
  };
  const injected = Object.entries(manifest.organization)
    .filter(([, declaration]) => declaration.reuse === "inject-openbot-adapter")
    .map(([name]) => name)
    .sort();
  const notReused = Object.entries(manifest.organization)
    .filter(([, declaration]) => declaration.reuse === "not-reused")
    .map(([name]) => name);

  // Every component the manifest says gets an adapter has one, and the ones it says are
  // not reused cannot mount through the gate.
  expect(Object.keys(organization.ORGANIZATION_ADAPTERS).sort()).toEqual(
    injected,
  );
  for (const name of notReused) {
    expect(organization.ORGANIZATION_ADAPTERS[name]).toBeUndefined();
  }
});

test("gate_renders_only_after_adapter_registration", async () => {
  const { adapter } = fakeScope();
  const { container } = mountUnderExistingProviders(
    <ui.OpenBotAuthProvider>
      <organization.OpenBotOrganizationScopeProvider adapter={adapter}>
        <div data-testid="raw-gate">
          <registry.FixedUiOrganization
            name="OrganizationSwitcher"
            component={pinnedComponent("OrganizationSwitcher")}
          />
        </div>
        <div data-testid="adapted-slot">
          <organization.OpenBotOrganizationSlot
            name="OrganizationSwitcher"
            component={pinnedComponent("OrganizationSwitcher")}
          />
        </div>
      </organization.OpenBotOrganizationScopeProvider>
    </ui.OpenBotAuthProvider>,
  );

  // The adapted slot mounts the pinned component...
  await waitFor(() => {
    expect(
      container.querySelector("[data-testid='adapted-slot'] button"),
    ).not.toBeNull();
  });
  // ...while a raw gate for a component whose adapter is not registered still renders nothing.
  await waitFor(() => {
    expect(container.querySelector("[data-testid='raw-gate']")).not.toBeNull();
  });
  expect(
    container.querySelector("[data-testid='raw-gate']")?.childElementCount,
  ).toBe(0);
});

test("adapted_switcher_reads_openbot_adapter_and_never_x_class_endpoints", async () => {
  const { adapter, calls } = fakeScope([{ id: "tenant-a", name: "Alpha" }]);
  const fetches: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetches.push(String(input));
    return new Response(JSON.stringify({ data: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const { container } = mountUnderExistingProviders(
      <ui.OpenBotAuthProvider>
        <organization.OpenBotOrganizationScopeProvider adapter={adapter}>
          <organization.OpenBotOrganizationSlot
            name="OrganizationSwitcher"
            component={pinnedComponent("OrganizationSwitcher")}
          />
        </organization.OpenBotOrganizationScopeProvider>
      </ui.OpenBotAuthProvider>,
    );

    // The eligibility read comes from the injected adapter, on the app's one QueryClient...
    await waitFor(() => {
      expect(calls.listed).toBeGreaterThan(0);
    });
    // ...and the pinned component mounted on top of it.
    await waitFor(() => {
      expect(container.querySelector("button")).not.toBeNull();
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const xClassCalls = fetches.filter((url) =>
    X_CLASS_ENDPOINTS.some((endpoint) => url.includes(endpoint)),
  );
  expect(xClassCalls).toEqual([]);
  // No organization-native read at all: even the non-X reads wait for their gated adapters.
  expect(fetches.filter((url) => url.includes("/organization/"))).toEqual([]);
});

test("switcher_selection_stays_an_intent", async () => {
  const { adapter, calls } = fakeScope();
  const facade = organization.restrictedOrganizationClient(adapter);

  // What a switch does is record an intent: no request, no scope header, no capability.
  await facade.organization.setActive({ organizationId: "tenant-a" });
  expect(calls.chosen).toEqual(["tenant-a"]);
  // Clearing the preference is the same intent, never an authorization decision.
  await facade.organization.setActive({ organizationId: null });
  expect(calls.chosen).toEqual(["tenant-a", null]);
  // This adapter carries no team authority and no permission answer.
  expect(
    (facade.organization as unknown as Record<string, unknown>).setActiveTeam,
  ).toBeUndefined();
  expect(
    (facade.organization as unknown as Record<string, unknown>).hasPermission,
  ).toBeUndefined();
});
