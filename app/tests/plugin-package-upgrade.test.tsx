import "./preload";
// app/tests/plugin-package-upgrade.test.tsx
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
import i18n from "../src/lib/i18n";

/**
 * The PKG06 upgrade/rollback flow of `/admin/market`'s 插件包 shelf.
 *
 * WHAT THESE CASES HOLD. A company administrator with an installed v1.0.0
 * sees the upgrade fact on the card and in the detail dialog, picks the exact
 * published target, reviews the server's version diff (the permission
 * increment included), and confirms once. A 409 at apply discards the plan
 * and offers a fresh preview — the recovery path the revision CAS implies. A
 * member never sees the version management surface. The server decides every
 * write; the shelf only states facts.
 *
 * The harness is the repository's native e2e pattern (see
 * `plugin-package-install.test.tsx`): happy-dom per file, a fetch stub that
 * records path/headers/body, one retry-free QueryClient, and `settle` as the
 * act boundary.
 */

const SCOPE_A = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  principalId: "user-1",
};

const PACKAGE_KEY = "release-labs/notes-writer";
const DIGEST_V1 = "a".repeat(64);
const DIGEST_V2 = "b".repeat(64);

const INSTALLED_V1: PackageInstallDTO = {
  installId: "install-1",
  packageKey: PACKAGE_KEY,
  version: "1.0.0",
  artifactDigest: DIGEST_V1,
  revision: 1,
  generation: 1,
  status: "enabled",
  readiness: "needs_grant",
  blockers: [{ code: "NEEDS_GRANT" }],
  allowedActions: ["plan", "apply", "grant", "createExpert"],
};

const RELEASE_ITEM: PackagePageItem = {
  packageKey: PACKAGE_KEY,
  version: "2.0.0",
  displayName: "Release Notes Writer",
  summary: "Writes release notes from a changelog.",
  category: "writing",
  install: INSTALLED_V1,
  installable: true,
  blockers: [],
};

const RELEASE_DETAIL: PackageCatalogueDetail = {
  packageKey: PACKAGE_KEY,
  version: "2.0.0",
  artifactDigest: DIGEST_V2,
  displayName: "Release Notes Writer",
  summary: "Writes release notes from a changelog.",
  category: "writing",
  publisher: "release-labs",
  name: "notes-writer",
  resources: [{ id: "notes-skill", kind: "skill", available: true }],
  installable: true,
  blockers: [],
  versions: [
    {
      version: "2.0.0",
      artifactDigest: DIGEST_V2,
      verified: true,
      listed: true,
    },
    {
      version: "1.0.0",
      artifactDigest: DIGEST_V1,
      verified: true,
      listed: true,
    },
  ],
};

const UPGRADE_PLAN_DIFF: PackagePlanDTO["diff"] = {
  currentVersion: "1.0.0",
  currentRevision: 1,
  addedResources: [{ id: "fresh-guide", kind: "skill" }],
  removedResources: [{ id: "legacy-note", kind: "skill" }],
  changedTools: [
    {
      ref: "tracker:create-note",
      previousEffect: "read",
      effect: "write",
      previousSchemaDigest: "d".repeat(64),
      schemaDigest: "c".repeat(64),
    },
  ],
  configChanges: [{ key: "region", change: "changed" }],
  connectionChanges: [],
};

const UPGRADE_PLAN: PackagePlanDTO = {
  planId: "plan-up-1",
  operation: "upgrade",
  packageKey: PACKAGE_KEY,
  version: "2.0.0",
  artifactDigest: DIGEST_V2,
  expectedRevision: 1,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  resources: [{ id: "notes-skill", kind: "skill" }],
  addedTools: [
    {
      ref: "tracker:create-note",
      effect: "write",
      schemaDigest: "c".repeat(64),
    },
  ],
  removedTools: ["tracker:purge-note"],
  blockers: [],
  diff: UPGRADE_PLAN_DIFF,
};

const INSTALL_AFTER_UPGRADE: PackageInstallDTO = {
  ...INSTALLED_V1,
  version: "2.0.0",
  artifactDigest: DIGEST_V2,
  revision: 2,
};

const INSTALL_DETAIL: PackageInstallDetailDTO = {
  ...INSTALLED_V1,
  resources: [{ id: "notes-skill", kind: "skill", available: true }],
  grants: [],
  latestPublishedVersion: "2.0.0",
  availableVersions: [
    { version: "2.0.0", artifactDigest: DIGEST_V2 },
    { version: "1.0.0", artifactDigest: DIGEST_V1 },
  ],
};

type Captured = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
};

let pagesByTenant: Record<string, PackagePage>;
let planRequests: Captured[];
let applyRequests: Captured[];
let planFailure: { status: number; code: string } | null;
let applyFailure: { status: number; code: string } | null;
let planAnswer: PackagePlanDTO;
let companyRole: string;
let seen: Captured[];
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

beforeEach(() => {
  pagesByTenant = {
    "tenant-a": { items: [RELEASE_ITEM], nextCursor: null },
    "tenant-b": { items: [RELEASE_ITEM], nextCursor: null },
  };
  planRequests = [];
  applyRequests = [];
  planFailure = null;
  applyFailure = null;
  planAnswer = UPGRADE_PLAN;
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
        return json(
          pagesByTenant[headers["x-openbot-tenant"] ?? ""] ?? {
            items: [],
            nextCursor: null,
          },
        );
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
        // The install detail mirrors the list's reported install so the
        // dialog's facts block never contradicts the shelf.
        const current =
          pagesByTenant["tenant-a"]?.items[0]?.install ?? INSTALLED_V1;
        return json({
          ...INSTALL_DETAIL,
          ...current,
          resources: INSTALL_DETAIL.resources,
          grants: [],
          latestPublishedVersion: "2.0.0",
          availableVersions: [
            { version: "2.0.0", artifactDigest: DIGEST_V2 },
            { version: "1.0.0", artifactDigest: DIGEST_V1 },
          ],
        } satisfies PackageInstallDetailDTO);
      }
      if (
        url.pathname === "/api/enterprise/plugin-packages/plans" &&
        captured.method === "POST"
      ) {
        planRequests.push(captured);
        if (planFailure) {
          return json(errorBody(planFailure.code), planFailure.status);
        }
        // The answer mirrors the request's operation and exact target, the
        // way the real plan endpoint does — the rollback case gets its own
        // headline instead of the upgrade fixture's.
        const asked = JSON.parse(
          captured.body ?? "{}",
        ) as Partial<PackagePlanDTO> & { operation?: string; version?: string };
        const operation =
          asked.operation === "rollback" ? "rollback" : "upgrade";
        const currentVersion =
          asked.operation === "rollback" ? "2.0.0" : "1.0.0";
        return json({
          ...planAnswer,
          operation,
          version: asked.version ?? planAnswer.version,
          diff: {
            ...(planAnswer.diff ?? UPGRADE_PLAN_DIFF),
            currentVersion,
          },
        });
      }
      if (
        url.pathname ===
          "/api/enterprise/plugin-packages/plans/plan-up-1/apply" &&
        captured.method === "POST"
      ) {
        applyRequests.push(captured);
        if (applyFailure) {
          return json(errorBody(applyFailure.code), applyFailure.status);
        }
        return json(INSTALL_AFTER_UPGRADE, 200);
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
    : new Error("The package upgrade flow never settled.");
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
    expect(within(view.getByRole("dialog")).getByText(DIGEST_V2)).toBeDefined();
  });
}

test("the card and the detail dialog state the upgrade fact and the admin reviews the server's diff", async () => {
  const view = renderPane();
  // The card: installed v1.0.0 while v2.0.0 is published.
  await settle(() => {
    expect(view.getByText("Upgrade available")).toBeDefined();
  });
  await openDetail(view);

  const dialog = view.getByRole("dialog");
  // The version section: current facts, newest published, exact picker.
  expect(
    within(dialog).getAllByText("Upgrade available").length,
  ).toBeGreaterThan(0);
  expect(
    within(dialog).getByText(/Newest published release: v2.0.0/),
  ).toBeDefined();
  expect(within(dialog).getByLabelText("Target version")).toBeDefined();

  fireEvent.click(
    within(dialog).getByRole("button", { name: "Review upgrade" }),
  );

  await settle(() => {
    expect(
      within(view.getByRole("dialog")).getByText("v1.0.0 → v2.0.0"),
    ).toBeDefined();
  });

  // The plan request carried the operation and the read revision verbatim.
  expect(planRequests).toHaveLength(1);
  expect(JSON.parse(planRequests[0]?.body ?? "{}")).toEqual({
    operation: "upgrade",
    packageKey: PACKAGE_KEY,
    version: "2.0.0",
    expectedRevision: 1,
    config: {},
    connectorInstalls: {},
  });
  expect(planRequests[0]?.headers["x-openbot-tenant"]).toBe("tenant-a");

  // The diff the server previewed: resources, the permission increment and
  // the changed tool contract, the removed tool, the config change.
  const upgradeDialog = view.getByRole("dialog");
  expect(within(upgradeDialog).getByText("Version changes")).toBeDefined();
  expect(within(upgradeDialog).getByText("New resource")).toBeDefined();
  expect(within(upgradeDialog).getByText("Removed resource")).toBeDefined();
  expect(
    within(upgradeDialog).getByText(
      "tracker:create-note — effect read → write",
    ),
  ).toBeDefined();
  expect(within(upgradeDialog).getByText("Removed tool")).toBeDefined();
  expect(within(upgradeDialog).getByText("region (changed)")).toBeDefined();
  expect(
    within(upgradeDialog).getByText(/take effect only after a Bot is granted/),
  ).toBeDefined();
});

test("confirming an upgrade sends one apply and shows the new install facts", async () => {
  const view = renderPane();
  await openDetail(view);
  fireEvent.click(
    within(view.getByRole("dialog")).getByRole("button", {
      name: "Review upgrade",
    }),
  );
  await settle(() => {
    expect(
      within(view.getByRole("dialog")).getByText("v1.0.0 → v2.0.0"),
    ).toBeDefined();
  });

  fireEvent.click(
    within(view.getByRole("dialog")).getByRole("button", {
      name: "Upgrade to v2.0.0",
    }),
  );

  await settle(() => {
    expect(within(view.getByRole("dialog")).getByText("r2")).toBeDefined();
  });
  expect(applyRequests).toHaveLength(1);
  const request = applyRequests[0];
  expect(request?.headers["idempotency-key"]).toBeDefined();
  expect(JSON.parse(request?.body ?? "null")).toBeNull();

  // The captured scope's cache was invalidated: the shelf refetched the list.
  const listReads = seen.filter(
    (entry) =>
      entry.path === "/api/enterprise/plugin-packages" &&
      entry.method === "GET",
  );
  expect(listReads.length).toBeGreaterThan(1);
});

test("a plan whose diff removes config keys blocks confirm until the admin acknowledges", async () => {
  // V1 plans never echo the installed config, so an untouched (empty) editor
  // reports every stored key as removed. Confirming that would wipe the live
  // configuration; the dialog must name the keys and wait for an explicit yes.
  planAnswer = {
    ...UPGRADE_PLAN,
    diff: {
      ...UPGRADE_PLAN_DIFF,
      configChanges: [
        { key: "region", change: "removed" },
        { key: "endpoint", change: "removed" },
      ],
    },
  };
  const view = renderPane();
  await openDetail(view);
  fireEvent.click(
    within(view.getByRole("dialog")).getByRole("button", {
      name: "Review upgrade",
    }),
  );
  await settle(() => {
    expect(
      within(view.getByRole("dialog")).getByText("v1.0.0 → v2.0.0"),
    ).toBeDefined();
  });

  const dialog = view.getByRole("dialog");
  expect(
    within(dialog).getByText(
      "This version change removes these configuration keys: region, endpoint. Add them below if the new version still needs them.",
    ),
  ).toBeDefined();
  const confirmButton = within(dialog).getByRole("button", {
    name: "Upgrade to v2.0.0",
  }) as HTMLButtonElement;
  expect(confirmButton.disabled).toBe(true);

  fireEvent.click(confirmButton);
  expect(applyRequests).toHaveLength(0);

  fireEvent.click(
    within(view.getByRole("dialog")).getByRole("checkbox", {
      name: "I understand these keys will be removed.",
    }),
  );
  await settle(() => {
    expect(
      (
        within(view.getByRole("dialog")).getByRole("button", {
          name: "Upgrade to v2.0.0",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  fireEvent.click(
    within(view.getByRole("dialog")).getByRole("button", {
      name: "Upgrade to v2.0.0",
    }),
  );
  await settle(() => {
    expect(applyRequests).toHaveLength(1);
  });
});

test("a 409 at apply discards the plan and offers a fresh preview (revision CAS recovery)", async () => {
  applyFailure = { status: 409, code: "REVISION_CONFLICT" };
  const view = renderPane();
  await openDetail(view);
  fireEvent.click(
    within(view.getByRole("dialog")).getByRole("button", {
      name: "Review upgrade",
    }),
  );
  await settle(() => {
    expect(
      within(view.getByRole("dialog")).getByText("v1.0.0 → v2.0.0"),
    ).toBeDefined();
  });
  fireEvent.click(
    within(view.getByRole("dialog")).getByRole("button", {
      name: "Upgrade to v2.0.0",
    }),
  );
  await settle(() => {
    expect(
      within(view.getByRole("dialog")).getByText(
        "This package changed or this confirmation was already used. Review a fresh preview before trying again.",
      ),
    ).toBeDefined();
  });
  // The plan id is spent: the confirm button is gone until a new preview.
  expect(
    within(view.getByRole("dialog")).queryByRole("button", {
      name: "Upgrade to v2.0.0",
    }),
  ).toBeNull();

  // Recovery: a fresh preview answers and can be confirmed again.
  applyFailure = null;
  fireEvent.click(
    within(view.getByRole("dialog")).getByRole("button", {
      name: "Preview install",
    }),
  );
  await settle(() => {
    expect(
      within(view.getByRole("dialog")).getByRole("button", {
        name: "Upgrade to v2.0.0",
      }),
    ).toBeDefined();
  });
  expect(planRequests).toHaveLength(2);
});

test("an installed v2.0.0 picks 1.0.0 and names the rollback verb with its own CAS", async () => {
  // The deployment reports the install at v2.0.0: the picker then offers the
  // older published release, and the verb is rollback with revision 2.
  const installedV2: PackageInstallDTO = {
    ...INSTALLED_V1,
    version: "2.0.0",
    artifactDigest: DIGEST_V2,
    revision: 2,
  };
  pagesByTenant["tenant-a"] = {
    items: [{ ...RELEASE_ITEM, install: installedV2 }],
    nextCursor: null,
  };
  const view = renderPane();
  await openDetail(view);
  const dialog = view.getByRole("dialog");
  const picker = within(dialog).getByLabelText("Target version");
  expect(within(picker).getAllByText("v1.0.0").length).toBeGreaterThan(0);
  expect(within(dialog).queryByText("Upgrade available")).toBeNull();

  fireEvent.click(
    within(dialog).getByRole("button", { name: "Review rollback" }),
  );
  await settle(() => {
    expect(
      within(view.getByRole("dialog")).getByText("v2.0.0 → v1.0.0"),
    ).toBeDefined();
  });
  expect(planRequests).toHaveLength(1);
  expect(JSON.parse(planRequests[0]?.body ?? "{}")).toEqual({
    operation: "rollback",
    packageKey: PACKAGE_KEY,
    version: "1.0.0",
    expectedRevision: 2,
    config: {},
    connectorInstalls: {},
  });
});

test("a member sees the install facts and no version management surface", async () => {
  companyRole = "member";
  const view = renderPane(false);
  await openDetail(view);
  const dialog = view.getByRole("dialog");
  expect(within(dialog).getByText("Installed")).toBeDefined();
  expect(within(dialog).queryByText("Versions")).toBeNull();
  expect(within(dialog).queryByLabelText("Target version")).toBeNull();
  expect(planRequests).toHaveLength(0);
});
