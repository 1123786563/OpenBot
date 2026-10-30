import "./preload";
// app/tests/plugin-package-lifecycle.test.tsx
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
import type {
  PackageCatalogueDetail,
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
  test,
} from "../../tests/support/e2e-compat";
import { PackagePane } from "../src/components/market/package-pane";
import i18n from "../src/lib/i18n";

/**
 * The PKG07 disable / uninstall / reinstall flow of `/admin/market`'s 插件包
 * shelf.
 *
 * WHAT THESE CASES HOLD. A company administrator sees the lifecycle verbs the
 * SERVER named in `allowedActions` (never a local guess), and each one opens a
 * confirmation that states the real effect and the assets involved before
 * anything is sent. Confirming sends exactly the wire contract — target status
 * plus the revision the screen read — with one idempotency key and no double
 * submit; a stale revision (409) tells the person to reopen instead of retrying
 * blind. A disabled install offers only turn-on and uninstall, an uninstalled
 * tombstone offers only reinstall, and a member never sees the surface at all.
 *
 * The harness is the repository's native e2e pattern (see
 * `plugin-package-upgrade.test.tsx`): happy-dom per file, a fetch stub that
 * records path/headers/body, one retry-free QueryClient, and `settle` as the
 * act boundary.
 */

const SCOPE_A = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  principalId: "user-1",
};

const PACKAGE_KEY = "release-labs/notes-writer";
const DIGEST = "a".repeat(64);

const ENABLED_ACTIONS: PackageInstallDTO["allowedActions"] = [
  "plan",
  "apply",
  "grant",
  "createExpert",
  "disable",
  "uninstall",
];

function enabledInstall(): PackageInstallDTO {
  return {
    installId: "install-1",
    packageKey: PACKAGE_KEY,
    version: "1.0.0",
    artifactDigest: DIGEST,
    revision: 1,
    generation: 1,
    status: "enabled",
    readiness: "ready",
    blockers: [],
    allowedActions: [...ENABLED_ACTIONS],
  };
}

const RELEASE_ITEM: PackagePageItem = {
  packageKey: PACKAGE_KEY,
  version: "1.0.0",
  displayName: "Release Notes Writer",
  summary: "Writes release notes from a changelog.",
  category: "writing",
  install: enabledInstall(),
  installable: true,
  blockers: [],
};

const RELEASE_DETAIL: PackageCatalogueDetail = {
  packageKey: PACKAGE_KEY,
  version: "1.0.0",
  artifactDigest: DIGEST,
  displayName: "Release Notes Writer",
  summary: "Writes release notes from a changelog.",
  category: "writing",
  publisher: "release-labs",
  name: "notes-writer",
  resources: [
    { id: "notes-skill", kind: "skill", available: true },
    { id: "tracker", kind: "managedConnector", available: true },
  ],
  installable: true,
  blockers: [],
  versions: [
    { version: "1.0.0", artifactDigest: DIGEST, verified: true, listed: true },
  ],
};

type Captured = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
};

let currentInstall: PackageInstallDTO;
let statusRequests: Captured[];
let statusFailure: { status: number; code: string } | null;
let pageReads: number;
let companyRole: string;
let patchGate: { promise: Promise<void> } | null;
const seen: Captured[] = [];
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

function errorBody(code: string) {
  return { error: { code, message: `Server says ${code}` } };
}

function installDetail(): PackageInstallDetailDTO {
  return {
    ...currentInstall,
    resources: [
      { id: "notes-skill", kind: "skill", available: true },
      {
        id: "tracker",
        kind: "managedConnector",
        available: true,
        tools: [{ ref: "tracker:create-note", effect: "read" }],
      },
    ],
    grants: [
      {
        installId: "install-1",
        botId: "bot-1",
        revision: 1,
        resources: [{ resourceId: "notes-skill", kind: "skill" }],
      },
    ],
    latestPublishedVersion: "1.0.0",
    availableVersions: [{ version: "1.0.0", artifactDigest: DIGEST }],
  };
}

beforeEach(() => {
  currentInstall = enabledInstall();
  statusRequests = [];
  statusFailure = null;
  pageReads = 0;
  companyRole = "tenant_admin";
  patchGate = null;
  seen.length = 0;
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
        pageReads += 1;
        const page: PackagePage = {
          items: [{ ...RELEASE_ITEM, install: currentInstall }],
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
      if (
        url.pathname === "/api/enterprise/plugin-packages/installs/install-1" &&
        captured.method === "GET"
      ) {
        return json(installDetail());
      }
      if (
        url.pathname ===
          "/api/enterprise/plugin-packages/installs/install-1/status" &&
        captured.method === "PATCH"
      ) {
        statusRequests.push(captured);
        if (patchGate) await patchGate.promise;
        if (statusFailure) {
          return json(errorBody(statusFailure.code), statusFailure.status);
        }
        const asked = JSON.parse(captured.body ?? "{}") as {
          status: PackageInstallDTO["status"];
        };
        currentInstall = {
          ...currentInstall,
          status: asked.status,
          generation: currentInstall.generation + 1,
          readiness: asked.status === "enabled" ? "needs_grant" : "unavailable",
          blockers: asked.status === "enabled" ? [{ code: "NEEDS_GRANT" }] : [],
          allowedActions:
            asked.status === "enabled"
              ? [...ENABLED_ACTIONS]
              : asked.status === "disabled"
                ? ["enable", "uninstall"]
                : ["enable"],
        };
        return json(currentInstall, 200);
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
    : new Error("The package lifecycle flow never settled.");
}

function renderPane(canInstall = true) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <PackagePane canInstall={canInstall} scope={SCOPE_A} />
    </QueryClientProvider>,
  );
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

/** The lifecycle confirmation is a second dialog, named by its own title. */
function lifecycleDialog(
  view: ReturnType<typeof render>,
  title: string,
): HTMLElement {
  return view.getByRole("dialog", { name: title });
}

test("an admin sees the lifecycle verbs and the confirmation states the real impact and linked assets", async () => {
  const view = renderPane();
  await openDetail(view);

  const detailDialog = view.getByRole("dialog");
  expect(
    within(detailDialog).getByRole("button", { name: "Turn off" }),
  ).toBeDefined();
  expect(
    within(detailDialog).getByRole("button", { name: "Uninstall" }),
  ).toBeDefined();

  fireEvent.click(
    within(detailDialog).getByRole("button", { name: "Turn off" }),
  );

  const confirm = lifecycleDialog(view, "Turn off Release Notes Writer");
  expect(
    within(confirm).getByText("New tool calls from this package are refused."),
  ).toBeDefined();
  expect(
    within(confirm).getByText(
      "Bot access is removed. Turn the package on and give access again to restore it.",
    ),
  ).toBeDefined();
  // Associated assets: the current revision's resources and the granted Bots.
  expect(within(confirm).getByText("notes-skill")).toBeDefined();
  expect(within(confirm).getByText("tracker")).toBeDefined();
  expect(within(confirm).getByText("Bots with access: 1")).toBeDefined();
  // Nothing has been sent yet: this screen only previews.
  expect(statusRequests).toHaveLength(0);
});

test("confirming sends one PATCH with the exact status and CAS revision, blocks a double submit, and refreshes the shelf", async () => {
  let release: () => void = () => {};
  patchGate = {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const view = renderPane();
  await openDetail(view);
  fireEvent.click(
    within(view.getByRole("dialog")).getByRole("button", { name: "Turn off" }),
  );
  const confirm = lifecycleDialog(view, "Turn off Release Notes Writer");
  const button = within(confirm).getByRole("button", {
    name: "Turn off package",
  });
  fireEvent.click(button);
  await settle(() => {
    expect(statusRequests).toHaveLength(1);
  });
  // A second click while the first is in flight must not send a second write.
  fireEvent.click(within(confirm).getByRole("button", { name: "Saving…" }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(statusRequests).toHaveLength(1);

  const request = statusRequests[0];
  expect(request?.method).toBe("PATCH");
  expect(JSON.parse(request?.body ?? "{}")).toEqual({
    status: "disabled",
    expectedRevision: 1,
  });
  expect(request?.headers["idempotency-key"]).toBeDefined();
  expect(request?.headers["x-openbot-tenant"]).toBe("tenant-a");

  const readsBefore = pageReads;
  release();
  await settle(() => {
    expect(
      view.queryByRole("dialog", { name: "Turn off Release Notes Writer" }),
    ).toBeNull();
  });
  // The captured scope's cache was invalidated: the shelf refetched and now
  // reads the disabled install the server answered with.
  expect(pageReads).toBeGreaterThan(readsBefore);
  await settle(() => {
    expect(
      within(view.getByRole("dialog")).getAllByText("Disabled").length,
    ).toBeGreaterThan(0);
  });
});

test("a disabled install hides the version surface and offers turn-on and uninstall (access is not restored)", async () => {
  currentInstall = {
    ...enabledInstall(),
    status: "disabled",
    generation: 2,
    readiness: "unavailable",
    blockers: [],
    allowedActions: ["enable", "uninstall"],
  };
  const view = renderPane();
  await openDetail(view);

  const detailDialog = view.getByRole("dialog");
  expect(within(detailDialog).queryByText("Versions")).toBeNull();
  expect(within(detailDialog).queryByLabelText("Target version")).toBeNull();
  expect(
    within(detailDialog).getByRole("button", { name: "Turn on" }),
  ).toBeDefined();
  expect(
    within(detailDialog).getByRole("button", { name: "Uninstall" }),
  ).toBeDefined();

  fireEvent.click(
    within(detailDialog).getByRole("button", { name: "Turn on" }),
  );
  const confirm = lifecycleDialog(view, "Turn on Release Notes Writer");
  expect(
    within(confirm).getByText(
      "Access you removed stays removed. Nothing comes back on its own.",
    ),
  ).toBeDefined();
  fireEvent.click(
    within(confirm).getByRole("button", { name: "Turn on package" }),
  );
  await settle(() => {
    expect(statusRequests).toHaveLength(1);
  });
  expect(JSON.parse(statusRequests[0]?.body ?? "{}")).toEqual({
    status: "enabled",
    expectedRevision: 1,
  });
});

test("an uninstalled tombstone offers reinstall only, with its own copy and payload", async () => {
  currentInstall = {
    ...enabledInstall(),
    status: "uninstalled",
    generation: 2,
    readiness: "unavailable",
    blockers: [],
    allowedActions: ["enable"],
  };
  const view = renderPane();
  await openDetail(view);

  const detailDialog = view.getByRole("dialog");
  expect(
    within(detailDialog).queryByRole("button", { name: "Uninstall" }),
  ).toBeNull();
  fireEvent.click(
    within(detailDialog).getByRole("button", { name: "Reinstall" }),
  );

  const confirm = lifecycleDialog(view, "Reinstall Release Notes Writer");
  expect(
    within(confirm).getByText(
      "Old access and approvals don't come back. Give Bots access again.",
    ),
  ).toBeDefined();
  fireEvent.click(
    within(confirm).getByRole("button", { name: "Reinstall package" }),
  );
  await settle(() => {
    expect(statusRequests).toHaveLength(1);
  });
  expect(JSON.parse(statusRequests[0]?.body ?? "{}")).toEqual({
    status: "enabled",
    expectedRevision: 1,
  });
});

test("a 409 tells the person to reopen and disables the blind retry", async () => {
  statusFailure = { status: 409, code: "REVISION_CONFLICT" };
  const view = renderPane();
  await openDetail(view);
  fireEvent.click(
    within(view.getByRole("dialog")).getByRole("button", { name: "Uninstall" }),
  );
  const confirm = lifecycleDialog(view, "Uninstall Release Notes Writer");
  fireEvent.click(
    within(confirm).getByRole("button", { name: "Uninstall package" }),
  );
  await settle(() => {
    expect(
      within(confirm).getByText(
        "This package changed while you were here. Close this and open it again.",
      ),
    ).toBeDefined();
  });
  const retry = within(confirm).getByRole("button", {
    name: "Uninstall package",
  }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  fireEvent.click(retry);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(statusRequests).toHaveLength(1);
});

test("a member sees the install facts and no lifecycle surface", async () => {
  companyRole = "member";
  currentInstall = { ...enabledInstall(), allowedActions: [] };
  const view = renderPane(false);
  await openDetail(view);
  const detailDialog = view.getByRole("dialog");
  expect(within(detailDialog).getByText("Enabled")).toBeDefined();
  expect(
    within(detailDialog).queryByRole("button", { name: "Turn off" }),
  ).toBeNull();
  expect(
    within(detailDialog).queryByRole("button", { name: "Uninstall" }),
  ).toBeNull();
  expect(within(detailDialog).queryByText("Lifecycle")).toBeNull();
  expect(statusRequests).toHaveLength(0);
});
