import "./preload";
// app/tests/plugin-package-grants.test.tsx
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
  PackageGrantDTO,
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
import { pluginPackageKeys } from "../src/lib/plugin-packages/queries";

/**
 * The Bot grant management section of the package detail dialog, PKG03 slice C.
 *
 * WHAT THESE CASES HOLD. A company tenant_admin sees, per installed package, which Bots hold
 * which skill-resource grants, grants skill resources of the current revision to a Bot (a real
 * PUT with scope headers, the contract body and one idempotency key — never a scope field in the
 * body), and revokes (DELETE with the CAS revision). After a grant the needs-grant notice clears
 * through the invalidated install-detail refetch. The scope identifiers are part of the query
 * key (asserted by value, not snapshot), so a grant answered after a team switch can only ever
 * touch the tree it left under. A plain company member gets no section and no requests.
 *
 * THE HARNESS IS THIS REPOSITORY'S native e2e pattern (see `plugin-package-install.test.tsx`):
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
const DETAIL_PATH = `/api/enterprise/plugin-packages/installs/${INSTALL_ID}`;
const GRANTS_PATH = `${DETAIL_PATH}/bots/bot-1/grants`;

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
  resources: [{ id: "notes-writer", kind: "skill", available: true }],
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
  readiness: "needs_grant",
  blockers: [{ code: "NEEDS_GRANT" }],
  allowedActions: [],
};

const GRANT: PackageGrantDTO = {
  installId: INSTALL_ID,
  botId: "bot-1",
  revision: 1,
  resources: [{ resourceId: "notes-skill", kind: "skill" }],
};

/** A second Bot's grant: the unrelated write the reseed-regression test revokes. */
const GRANT_A: PackageGrantDTO = {
  installId: INSTALL_ID,
  botId: "bot-a",
  revision: 1,
  resources: [{ resourceId: "notes-skill", kind: "skill" }],
};

function installDetail(granted: boolean): PackageInstallDetailDTO {
  return {
    installId: INSTALL_ID,
    packageKey: PACKAGE_KEY,
    version: "2.0.0",
    artifactDigest: DIGEST,
    revision: 1,
    generation: 1,
    status: "enabled",
    readiness: granted ? "ready" : "needs_grant",
    blockers: granted ? [] : [{ code: "NEEDS_GRANT" }],
    allowedActions: [],
    resources: [
      { id: "notes-skill", kind: "skill", available: true },
      { id: "tracker", kind: "managedConnector", available: false },
    ],
    grants: [
      ...(granted ? [GRANT] : []),
      ...(botAGrantActive ? [GRANT_A] : []),
    ],
  };
}

type Captured = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
};

let detailGranted: boolean;
let botAGrantActive: boolean;
let grantRequests: Captured[];
let revokeRequests: Captured[];
let botARevokeRequests: Captured[];
let grantGate: Promise<Response> | null;
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

beforeEach(() => {
  detailGranted = false;
  botAGrantActive = false;
  grantRequests = [];
  revokeRequests = [];
  botARevokeRequests = [];
  grantGate = null;
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
        return json(installDetail(detailGranted));
      }
      if (url.pathname === GRANTS_PATH && captured.method === "PUT") {
        grantRequests.push(captured);
        // The server commits before it answers, so even a gated answer describes
        // a world where the grant exists.
        detailGranted = true;
        if (grantGate) return grantGate;
        return json(GRANT, 201);
      }
      if (url.pathname === GRANTS_PATH && captured.method === "DELETE") {
        revokeRequests.push(captured);
        detailGranted = false;
        return json({ ...GRANT, revision: 2 }, 201);
      }
      if (
        url.pathname === `${DETAIL_PATH}/bots/bot-a/grants` &&
        captured.method === "DELETE"
      ) {
        botARevokeRequests.push(captured);
        botAGrantActive = false;
        return json({ ...GRANT_A, revision: 2 }, 201);
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
    : new Error("The package grant flow never settled.");
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

/** The grants section draws its form only once the install-detail read has answered. */
async function awaitGrantsSection(view: ReturnType<typeof render>) {
  await settle(() => {
    const dialog = view.getByRole("dialog");
    expect(within(dialog).getByText("Bot grants")).toBeDefined();
    expect(within(dialog).getByLabelText("Bot ID")).toBeDefined();
  });
}

/** Fill the grant form: the Bot id and exactly the named skill resources. */
async function fillGrantForm(
  view: ReturnType<typeof render>,
  botId: string,
  resources: string[],
) {
  const dialog = view.getByRole("dialog");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(within(dialog).getByLabelText("Bot ID"), botId);
  for (const resource of resources) {
    await user.click(within(dialog).getByLabelText(resource));
  }
}

const EMPTY_NOTICE =
  "No Bot holds a grant yet: until a grant is added below, no Bot can execute this package. Installing alone does not grant execution rights.";

test("an admin grant PUT carries the scope headers and exactly the contract body", async () => {
  const { view } = renderPane(SCOPE_A);
  await openDetail(view);
  await awaitGrantsSection(view);
  const dialog = () => view.getByRole("dialog");

  // The empty state names the real authorization situation: installed ≠ granted.
  expect(within(dialog()).getByText(EMPTY_NOTICE)).toBeDefined();
  expect(within(dialog()).queryByText("bot-1")).toBeNull();

  await fillGrantForm(view, "bot-1", ["notes-skill"]);
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Grant resources" }),
  );

  await settle(() => {
    expect(within(dialog()).getByText("bot-1")).toBeDefined();
    // The grant row carries its own revision chip.
    expect(
      within(
        within(dialog()).getByRole("list", { name: "Bot grants" }),
      ).getByText("r1"),
    ).toBeDefined();
  });
  expect(within(dialog()).queryByText(EMPTY_NOTICE)).toBeNull();
  expect(grantRequests).toHaveLength(1);
  const request = grantRequests[0];
  expect(request?.method).toBe("PUT");
  expect(request?.path).toBe(GRANTS_PATH);
  expect(request?.headers["x-openbot-tenant"]).toBe("tenant-a");
  expect(request?.headers["x-openbot-workspace"]).toBe("workspace-a");
  const key = request?.headers["idempotency-key"] ?? "";
  expect(key.length).toBeGreaterThan(0);
  expect(key.length).toBeLessThanOrEqual(128);
  // Scope and actor never travel in the body — headers only, per the wire contract.
  expect(JSON.parse(request?.body ?? "{}")).toEqual({
    installId: INSTALL_ID,
    botId: "bot-1",
    expectedGrantRevision: null,
    resources: [{ resourceId: "notes-skill", kind: "skill" }],
  });
});

test("after grant success the needs-grant notice clears through the invalidated refetch", async () => {
  const { view } = renderPane(SCOPE_A);
  await openDetail(view);
  await awaitGrantsSection(view);
  const dialog = () => view.getByRole("dialog");
  expect(within(dialog()).getByText(EMPTY_NOTICE)).toBeDefined();

  const detailReads = () =>
    seen.filter((entry) => entry.path === DETAIL_PATH && entry.method === "GET")
      .length;
  const readsBeforeGrant = detailReads();

  await fillGrantForm(view, "bot-1", ["notes-skill"]);
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Grant resources" }),
  );

  await settle(() => {
    expect(within(dialog()).queryByText(EMPTY_NOTICE)).toBeNull();
    expect(within(dialog()).getByText("bot-1")).toBeDefined();
  });
  // The notice cleared because the mutation invalidated exactly the install-detail
  // key and the section refetched it: a second read of the same install followed.
  expect(detailReads()).toBeGreaterThan(readsBeforeGrant);
});

test("revoke sends DELETE with the grant's CAS revision and an idempotency key", async () => {
  detailGranted = true;
  const { view } = renderPane(SCOPE_A);
  await openDetail(view);
  await awaitGrantsSection(view);
  const dialog = () => view.getByRole("dialog");
  expect(within(dialog()).queryByText(EMPTY_NOTICE)).toBeNull();

  fireEvent.click(
    within(dialog()).getByRole("button", {
      name: "Revoke the grant for bot-1",
    }),
  );

  await settle(() => {
    expect(within(dialog()).getByText(EMPTY_NOTICE)).toBeDefined();
  });
  expect(revokeRequests).toHaveLength(1);
  const request = revokeRequests[0];
  expect(request?.method).toBe("DELETE");
  expect(request?.path).toBe(GRANTS_PATH);
  expect(request?.headers["x-openbot-tenant"]).toBe("tenant-a");
  expect(request?.headers["x-openbot-workspace"]).toBe("workspace-a");
  expect((request?.headers["idempotency-key"] ?? "").length).toBeGreaterThan(0);
  expect(JSON.parse(request?.body ?? "{}")).toEqual({
    expectedGrantRevision: 1,
  });
});

test("the grant key carries the scope identifiers and a mid-flight grant cannot write the other team's cache", async () => {
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
  await awaitGrantsSection(view);
  const dialog = () => view.getByRole("dialog");

  let release = (_response: Response) => {};
  grantGate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  await fillGrantForm(view, "bot-1", ["notes-skill"]);
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Grant resources" }),
  );
  await settle(() => {
    expect(grantRequests).toHaveLength(1);
  });
  expect(grantRequests[0]?.headers["x-openbot-tenant"]).toBe("tenant-a");

  // The person switches teams while the grant is still in flight.
  view.rerender(
    <QueryClientProvider client={client}>
      <PackagePane canInstall scope={SCOPE_B} />
    </QueryClientProvider>,
  );
  expect(view.queryByRole("dialog")).toBeNull();
  await settle(() => {
    expect(view.getByText("Release Notes Writer")).toBeDefined();
  });
  const tenantBGrantReads = () =>
    seen.filter(
      (entry) =>
        entry.path === DETAIL_PATH &&
        entry.method === "GET" &&
        entry.headers["x-openbot-tenant"] === "tenant-b",
    ).length;
  expect(tenantBGrantReads()).toBe(0);

  // Team A's grant only now answers. It may refresh A's tree; B's cache must stay empty.
  release(json(GRANT, 201));
  await flush();

  expect(
    client.getQueryData(pluginPackageKeys.installDetail(SCOPE_B, INSTALL_ID)),
  ).toBeUndefined();
  expect(tenantBGrantReads()).toBe(0);

  // Back under team A the stale entry refetches and shows the grant that was made there.
  view.rerender(
    <QueryClientProvider client={client}>
      <PackagePane canInstall scope={SCOPE_A} />
    </QueryClientProvider>,
  );
  await openDetail(view);
  await awaitGrantsSection(view);
  expect(within(view.getByRole("dialog")).getByText("bot-1")).toBeDefined();
  expect(
    client.getQueryData<PackageInstallDetailDTO>(
      pluginPackageKeys.installDetail(SCOPE_A, INSTALL_ID),
    )?.grants,
  ).toEqual([GRANT]);
});

test("the submit is disabled with no resources selected and while the grant is pending", async () => {
  const { view } = renderPane(SCOPE_A);
  await openDetail(view);
  await awaitGrantsSection(view);
  const dialog = () => view.getByRole("dialog");
  const submit = () =>
    within(dialog()).getByRole("button", { name: "Grant resources" });

  // No Bot id and no resources: nothing to send.
  expect((submit() as HTMLButtonElement).disabled).toBe(true);

  // A Bot id alone is still zero resources selected.
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(within(dialog()).getByLabelText("Bot ID"), "bot-1");
  expect((submit() as HTMLButtonElement).disabled).toBe(true);

  let release = (_response: Response) => {};
  grantGate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  fireEvent.click(within(dialog()).getByLabelText("notes-skill"));
  expect((submit() as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(submit());

  await settle(() => {
    expect(grantRequests).toHaveLength(1);
  });
  // While the PUT is pending the verb is the pending label and refuses a second press.
  const pending = within(dialog()).getByRole("button", {
    name: "Granting…",
  }) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  fireEvent.click(pending);
  expect(grantRequests).toHaveLength(1);

  release(json(GRANT, 201));
  await settle(() => {
    expect(within(dialog()).getByText("bot-1")).toBeDefined();
  });
  expect(grantRequests).toHaveLength(1);
});

test("a plain company member has no grants section and no grant requests leave", async () => {
  const { view } = renderPane(SCOPE_A, false);
  await openDetail(view);

  expect(view.queryByLabelText("Bot ID")).toBeNull();
  expect(seen.some((entry) => entry.path === DETAIL_PATH)).toBeFalse();
  expect(grantRequests).toHaveLength(0);
  expect(revokeRequests).toHaveLength(0);
});

test("revoking one Bot keeps another Bot's in-progress selection", async () => {
  // Bot A holds a grant; the administrator is drafting Bot B's first grant while
  // Bot A's revoke succeeds. The refetch that the revoke's invalidation triggers
  // produces a new detail object — the draft's checked boxes must survive it,
  // because nothing about Bot B's own grant identity changed.
  botAGrantActive = true;
  const { view } = renderPane(SCOPE_A);
  await openDetail(view);
  await awaitGrantsSection(view);
  const dialog = () => view.getByRole("dialog");

  fireEvent.change(within(dialog()).getByLabelText("Bot ID"), {
    target: { value: "bot-b" },
  });
  fireEvent.click(within(dialog()).getByLabelText("notes-skill"));
  const checkbox = () =>
    within(dialog()).getByLabelText("notes-skill") as HTMLInputElement;
  expect(checkbox().checked).toBe(true);

  fireEvent.click(
    within(dialog()).getByRole("button", {
      name: "Revoke the grant for bot-a",
    }),
  );
  await settle(() => {
    expect(within(dialog()).queryByText("bot-a")).toBeNull();
    expect(botARevokeRequests).toHaveLength(1);
  });
  // Outwait any further refetch turns the invalidation could still produce.
  await flush();

  expect(checkbox().checked).toBe(true);
});

test("after a grant the dialog's install facts agree with the fresh install detail, not the stale list row", async () => {
  // The list endpoint keeps answering the stale pre-grant install for the whole
  // test; the only place the granted world exists is the install-detail read the
  // grant mutation invalidates. The facts block must therefore read that query
  // (the list row is only the first-render placeholder), or it would contradict
  // the grants section on the very same dialog after the write.
  const { view } = renderPane(SCOPE_A);
  await openDetail(view);
  await awaitGrantsSection(view);
  const dialog = () => view.getByRole("dialog");
  expect(within(dialog()).getByText("Needs Bot grant")).toBeDefined();

  await fillGrantForm(view, "bot-1", ["notes-skill"]);
  fireEvent.click(
    within(dialog()).getByRole("button", { name: "Grant resources" }),
  );

  await settle(() => {
    expect(within(dialog()).queryByText("Needs Bot grant")).toBeNull();
    expect(within(dialog()).getByText("Ready")).toBeDefined();
  });
  expect(
    within(dialog()).queryByText(
      "The package is installed, but no Bot may execute it yet: installation alone does not grant Bot execution rights.",
    ),
  ).toBeNull();
});
