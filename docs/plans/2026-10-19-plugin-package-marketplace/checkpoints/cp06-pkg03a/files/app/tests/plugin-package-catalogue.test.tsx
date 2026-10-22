import "./preload";
// app/tests/plugin-package-catalogue.test.tsx
import { GlobalRegistrator } from "@happy-dom/global-registrator";
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

/**
 * The read-only plugin-package shelf of `/admin/market`, PKG01.
 *
 * WHAT THESE CASES HOLD. The pane is a client of two enterprise reads that are scoped by the
 * selection headers, so every case installs its own fetch stub (the repository's harness, as in
 * `plugin-read-failure.test.tsx`) and records the headers each request carried. A team switch must
 * ask again under the new pair and must never paint the old team's packages while it does; an
 * unavailable package must say why in the reader's language; and a scope that was never chosen
 * must not be guessed into a request.
 *
 * WHY POLLING GOES THROUGH `act`. This is a native e2e suite: React Query resolves its reads
 * outside a React event, and this runner's DOM keeps them queued until an act boundary rather
 * than flushing on the testing-library `waitFor` wrapper. `settle` is that boundary — each turn
 * flushes pending React work, then the caller's assertion says whether the UI arrived.
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

const TRIAGE: PackagePageItem = {
  packageKey: "incident-labs/triage-kit",
  version: "1.2.0",
  displayName: "Incident Triage Kit",
  summary: "Turns an alert into a triage plan.",
  category: "operations",
  install: null,
  installable: false,
  blockers: [{ code: "ARTIFACT_MISSING", resourceId: "triage-runbook" }],
};

const RELEASE: PackagePageItem = {
  packageKey: "release-labs/notes-writer",
  version: "2.0.0",
  displayName: "Release Notes Writer",
  summary: "Writes release notes from a changelog.",
  category: "writing",
  install: null,
  installable: true,
  blockers: [],
};

const DETAIL: PackageCatalogueDetail = {
  packageKey: "incident-labs/triage-kit",
  version: "1.2.0",
  artifactDigest: "a".repeat(64),
  displayName: "Incident Triage Kit",
  summary: "Turns an alert into a triage plan.",
  category: "operations",
  publisher: "incident-labs",
  name: "triage-kit",
  resources: [{ id: "triage-runbook", kind: "skill", available: true }],
  installable: false,
  blockers: [{ code: "ARTIFACT_MISSING", resourceId: "triage-runbook" }],
};

type Captured = {
  path: string;
  params: URLSearchParams;
  headers: Record<string, string>;
};

let pagesByTenant: Record<string, PackagePage>;
let pagesByCursor: Record<string, PackagePage>;
let failCursors: Set<string>;
let listFailure: { status: number; body?: unknown } | null;
let seen: Captured[];
const originalFetch = global.fetch;

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

beforeEach(() => {
  pagesByTenant = {
    "tenant-a": { items: [TRIAGE, RELEASE], nextCursor: null },
    "tenant-b": { items: [RELEASE], nextCursor: null },
  };
  pagesByCursor = {};
  failCursors = new Set();
  listFailure = null;
  seen = [];
  global.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = new URL(String(input), "http://localhost");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      seen.push({ path: url.pathname, params: url.searchParams, headers });
      if (url.pathname === "/api/enterprise/plugin-packages") {
        if (listFailure !== null) {
          return listFailure.body === undefined
            ? new Response(null, { status: listFailure.status })
            : json(listFailure.body, listFailure.status);
        }
        if (url.searchParams.get("search") === "release") {
          return json({ items: [RELEASE], nextCursor: null });
        }
        const cursor = url.searchParams.get("cursor");
        if (cursor !== null) {
          if (failCursors.has(cursor))
            return new Response(null, { status: 503 });
          return json(pagesByCursor[cursor] ?? { items: [], nextCursor: null });
        }
        const tenant = headers["x-openbot-tenant"] ?? "";
        const page = pagesByTenant[tenant] ?? { items: [], nextCursor: null };
        const category = url.searchParams.get("category");
        if (category === null) return json(page);
        return json({
          items: page.items.filter((item) => item.category === category),
          nextCursor: null,
        });
      }
      if (
        url.pathname ===
        "/api/enterprise/plugin-packages/catalogue/incident-labs/triage-kit"
      ) {
        return json(DETAIL);
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** Flush pending React work, then let the caller's assertion decide whether the UI arrived. */
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
    : new Error("The package shelf never settled.");
}

function renderPane(
  scope: typeof SCOPE_A | null,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  const view = render(
    <QueryClientProvider client={client}>
      <PackagePane scope={scope} />
    </QueryClientProvider>,
  );
  return { view, client };
}

function listRequests(): Captured[] {
  return seen.filter(
    (request) => request.path === "/api/enterprise/plugin-packages",
  );
}

test("the list renders the package the server published, scoped by the selection headers", async () => {
  const { view } = renderPane(SCOPE_A);

  await settle(() => {
    expect(view.getByText("Incident Triage Kit")).toBeDefined();
  });
  expect(view.getByText("incident-labs/triage-kit")).toBeDefined();
  expect(view.getByText("v1.2.0")).toBeDefined();
  expect(view.getByText("Turns an alert into a triage plan.")).toBeDefined();
  expect(view.getByLabelText("Search plugin packages")).toBeDefined();

  const [first] = listRequests();
  expect(first?.headers["x-openbot-tenant"]).toBe("tenant-a");
  expect(first?.headers["x-openbot-workspace"]).toBe("workspace-a");
});

test("an unavailable package shows the localized blocker reason and no install verb", async () => {
  const { view } = renderPane(SCOPE_A);

  await settle(() => {
    expect(
      view.getByText("The package artifact is missing from this deployment."),
    ).toBeDefined();
  });
  expect(view.getByText("Unavailable")).toBeDefined();
  expect(view.queryByText("Install")).toBeNull();
});

test("switching teams asks under the new scope headers and never paints the old team's packages", async () => {
  const { view, client } = renderPane(SCOPE_A);
  await settle(() => {
    expect(view.getByText("Incident Triage Kit")).toBeDefined();
  });
  const before = seen.length;

  view.rerender(
    <QueryClientProvider client={client}>
      <PackagePane scope={SCOPE_B} />
    </QueryClientProvider>,
  );

  expect(view.queryByText("Incident Triage Kit")).toBeNull();
  await settle(() => {
    expect(view.getByText("Release Notes Writer")).toBeDefined();
  });
  expect(view.queryByText("Incident Triage Kit")).toBeNull();

  const switched = seen
    .slice(before)
    .find((request) => request.path === "/api/enterprise/plugin-packages");
  expect(switched?.headers["x-openbot-tenant"]).toBe("tenant-b");
  expect(switched?.headers["x-openbot-workspace"]).toBe("workspace-b");
  expect(switched?.headers["x-openbot-tenant"]).not.toBe("tenant-a");
});

test("a team with no packages shows the empty state, not a blank shelf", async () => {
  pagesByTenant["tenant-a"] = { items: [], nextCursor: null };
  const { view } = renderPane(SCOPE_A);

  await settle(() => {
    expect(
      view.getByText("No plugin packages are available in this team yet."),
    ).toBeDefined();
  });
  expect(view.queryByText("Unavailable")).toBeNull();
});

test("a failed list read says so and recovers on retry", async () => {
  listFailure = { status: 503 };
  const { view } = renderPane(SCOPE_A);

  await settle(() => {
    expect(
      view.getByText("Plugin packages could not be loaded."),
    ).toBeDefined();
  });

  listFailure = null;
  fireEvent.click(view.getByRole("button", { name: "Try again" }));

  await settle(() => {
    expect(view.getByText("Incident Triage Kit")).toBeDefined();
  });
});

test("a package card opens a detail dialog with resources, scope headers and blocker reasons", async () => {
  const { view } = renderPane(SCOPE_A);

  await settle(() => {
    expect(view.getByText("Incident Triage Kit")).toBeDefined();
  });
  fireEvent.keyDown(view.getByText("Incident Triage Kit"), { key: "Enter" });

  await settle(() => {
    expect(view.getByRole("dialog")).toBeDefined();
    expect(
      within(view.getByRole("dialog")).getByText("incident-labs"),
    ).toBeDefined();
  });

  const dialog = view.getByRole("dialog");
  expect(within(dialog).getByText("Incident Triage Kit")).toBeDefined();
  expect(
    within(dialog).getByText("Turns an alert into a triage plan."),
  ).toBeDefined();
  expect(within(dialog).getByText("1.2.0")).toBeDefined();
  expect(within(dialog).getByText(DETAIL.artifactDigest)).toBeDefined();
  expect(within(dialog).getByText("Skill")).toBeDefined();
  // The resource row and the blocker both name the resource id.
  expect(within(dialog).getAllByText("triage-runbook")).toHaveLength(2);
  expect(within(dialog).getByText("Available")).toBeDefined();
  expect(
    within(dialog).getByText(
      "The package artifact is missing from this deployment.",
    ),
  ).toBeDefined();

  const detail = seen.find((request) =>
    request.path.startsWith("/api/enterprise/plugin-packages/catalogue/"),
  );
  expect(detail?.path).toBe(
    "/api/enterprise/plugin-packages/catalogue/incident-labs/triage-kit",
  );
  expect(detail?.headers["x-openbot-tenant"]).toBe("tenant-a");
  expect(detail?.headers["x-openbot-workspace"]).toBe("workspace-a");
});

test("no chosen team means no request and a clear instruction", () => {
  const { view } = renderPane(null);

  expect(view.getByText("Select a team first")).toBeDefined();
  expect(seen).toHaveLength(0);
});

test("loading more appends the next page and asks under the same scope triple", async () => {
  pagesByTenant["tenant-a"] = { items: [TRIAGE], nextCursor: "cursor-2" };
  pagesByCursor["cursor-2"] = { items: [RELEASE], nextCursor: null };
  const { view } = renderPane(SCOPE_A);

  await settle(() => {
    expect(view.getByText("Incident Triage Kit")).toBeDefined();
  });
  fireEvent.click(view.getByRole("button", { name: "Load more" }));

  await settle(() => {
    expect(view.getByText("Release Notes Writer")).toBeDefined();
  });
  expect(view.getByText("Incident Triage Kit")).toBeDefined();
  expect(view.queryByRole("button", { name: "Load more" })).toBeNull();

  const second = listRequests().find(
    (request) => request.params.get("cursor") === "cursor-2",
  );
  expect(second?.headers["x-openbot-tenant"]).toBe("tenant-a");
  expect(second?.headers["x-openbot-workspace"]).toBe("workspace-a");
});

test("a failed load-more keeps the loaded page and retries that same cursor", async () => {
  pagesByTenant["tenant-a"] = { items: [TRIAGE], nextCursor: "cursor-2" };
  pagesByCursor["cursor-2"] = { items: [RELEASE], nextCursor: null };
  failCursors.add("cursor-2");
  const { view } = renderPane(SCOPE_A);

  await settle(() => {
    expect(view.getByText("Incident Triage Kit")).toBeDefined();
  });
  fireEvent.click(view.getByRole("button", { name: "Load more" }));

  await settle(() => {
    expect(view.getByText("More packages could not be loaded.")).toBeDefined();
  });
  // The loaded page stays, and the failed page gets a retry instead of a duplicated "Load more".
  expect(view.getByText("Incident Triage Kit")).toBeDefined();
  expect(view.queryByRole("button", { name: "Load more" })).toBeNull();

  failCursors.delete("cursor-2");
  fireEvent.click(view.getByRole("button", { name: "Try again" }));

  await settle(() => {
    expect(view.getByText("Release Notes Writer")).toBeDefined();
  });
  expect(view.queryByText("More packages could not be loaded.")).toBeNull();
  const retried = listRequests().filter(
    (request) => request.params.get("cursor") === "cursor-2",
  );
  expect(retried).toHaveLength(2);
});

test("a category chip filters on the server and keeps every cached category on screen", async () => {
  const { view } = renderPane(SCOPE_A);

  await settle(() => {
    expect(view.getByText("Incident Triage Kit")).toBeDefined();
    expect(view.getByText("Release Notes Writer")).toBeDefined();
  });
  expect(view.getByRole("button", { name: "operations" })).toBeDefined();

  fireEvent.click(view.getByRole("button", { name: "writing" }));

  await settle(() => {
    expect(view.getByText("Release Notes Writer")).toBeDefined();
    expect(view.queryByText("Incident Triage Kit")).toBeNull();
  });
  // Narrowing the list must not erase the chip that would widen it again.
  expect(view.getByRole("button", { name: "operations" })).toBeDefined();
  const filtered = listRequests().find(
    (request) => request.params.get("category") === "writing",
  );
  expect(filtered?.headers["x-openbot-tenant"]).toBe("tenant-a");
});

test("a category with no packages says which category is empty", async () => {
  const { view } = renderPane(SCOPE_A);

  await settle(() => {
    expect(view.getByText("Release Notes Writer")).toBeDefined();
  });

  // The chip row still remembers "writing" from the unfiltered page; the filter itself answers empty.
  pagesByTenant["tenant-a"] = { items: [TRIAGE], nextCursor: null };
  fireEvent.click(view.getByRole("button", { name: "writing" }));

  await settle(() => {
    expect(
      view.getByText("No plugin packages in the “writing” category."),
    ).toBeDefined();
  });
});

test("the list cache key names tenant, workspace and principal, so dropping one cannot share an entry", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { view } = renderPane(SCOPE_A, client);

  await settle(() => {
    expect(view.getByText("Incident Triage Kit")).toBeDefined();
  });

  const listKey = client
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey)
    .find((key) => key[0] === "plugin-packages" && key.includes("list"));
  expect(listKey?.slice(0, 5)).toEqual([
    "plugin-packages",
    "tenant-a",
    "workspace-a",
    "user-1",
    "list",
  ]);
});

test("a permission refusal is named as one, quoting the server's own sentence", async () => {
  listFailure = {
    status: 403,
    body: {
      error: {
        code: "FORBIDDEN",
        request_id: "req-1",
        retryable: false,
        summary: "Not a member of this team.",
      },
    },
  };
  const { view } = renderPane(SCOPE_A);

  await settle(() => {
    expect(
      view.getByText(
        "You do not have permission to browse this team's plugin packages.",
      ),
    ).toBeDefined();
  });
  expect(view.getByText("Not a member of this team.")).toBeDefined();
  expect(view.queryByText("Plugin packages could not be loaded.")).toBeNull();
});

test("an unresolved or failed current-user read never reads as 'select a team'", () => {
  const pending = render(<PackagePane currentUserPending scope={null} />);
  expect(pending.queryByText("Select a team first")).toBeNull();
  pending.unmount();

  const failed = render(<PackagePane currentUserError scope={null} />);
  expect(
    failed.getByText(
      "Your account could not be loaded, so plugin packages cannot pick a team yet.",
    ),
  ).toBeDefined();
  expect(failed.queryByText("Select a team first")).toBeNull();
  expect(seen).toHaveLength(0);
});

test("a search term is sent to the server and replaces the previous page", async () => {
  const { view } = renderPane(SCOPE_A);
  await settle(() => {
    expect(view.getByText("Incident Triage Kit")).toBeDefined();
  });

  fireEvent.change(view.getByLabelText("Search plugin packages"), {
    target: { value: "release" },
  });

  await settle(() => {
    expect(view.getByText("Release Notes Writer")).toBeDefined();
    expect(view.queryByText("Incident Triage Kit")).toBeNull();
  });
  const searched = listRequests().find(
    (request) => request.params.get("search") === "release",
  );
  expect(searched).toBeDefined();
  expect(searched?.headers["x-openbot-tenant"]).toBe("tenant-a");
});
