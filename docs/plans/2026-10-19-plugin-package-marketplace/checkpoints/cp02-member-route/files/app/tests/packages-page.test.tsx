import "./preload";
// app/tests/packages-page.test.tsx
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
} from "../../shared/enterprise/plugin-package-contracts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import { PackagesMarketPage } from "../src/components/market/packages-page";
import { storeSelection } from "../src/lib/enterprise/tenant/selection";

/**
 * The member-reachable package shelf at /_authed/packages (spec §7: members browse;
 * spec §11: /admin/market stays the console entry).
 *
 * The route itself must impose no deployment-admin gate — the authed boundary above
 * it is the only gate — and the page must derive the member's own team scope with
 * scope headers, hiding the install verb from a plain company member while a company
 * tenant_admin keeps it. Detail opens the same way the catalogue suite drives it:
 * an Enter keydown on the card. React Query resolves outside React events on this
 * runner, so assertions poll through an act boundary.
 */

const RELEASE: PackagePage["items"][number] = {
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
  packageKey: "release-labs/notes-writer",
  version: "2.0.0",
  artifactDigest: "b".repeat(64),
  displayName: "Release Notes Writer",
  summary: "Writes release notes from a changelog.",
  category: "writing",
  publisher: "release-labs",
  name: "notes-writer",
  resources: [{ id: "notes-writer", kind: "skill", available: true }],
  installable: true,
  blockers: [],
};

let deploymentRole: string;
let companyRole: string;
let seen: Array<{ path: string; headers: Record<string, string> }>;

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

beforeEach(() => {
  deploymentRole = "user";
  companyRole = "member";
  seen = [];
  window.localStorage.clear();
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
      seen.push({ path: url.pathname, headers });
      if (url.pathname === "/api/me") {
        return json({
          user: {
            id: "user-1",
            email: "member@example.com",
            name: "Team Member",
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
      if (url.pathname === "/api/enterprise/plugin-packages") {
        const page: PackagePage = { items: [RELEASE], nextCursor: null };
        return json(page);
      }
      if (
        url.pathname ===
        "/api/enterprise/plugin-packages/catalogue/release-labs/notes-writer"
      ) {
        return json(DETAIL);
      }
      return new Response(null, { status: 404 });
    },
  ) as typeof fetch;
});

async function settle(assert: () => void): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    try {
      assert();
      return;
    } catch {
      /* keep polling until the reads land or the budget runs out */
    }
  }
  assert();
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PackagesMarketPage />
    </QueryClientProvider>,
  );
}

test("a plain company member browses the catalogue with their team scope headers", async () => {
  deploymentRole = "user";
  companyRole = "member";
  storeSelection("user-1", {
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
  });

  const view = renderPage();
  await settle(() => {
    expect(view.getByText("Release Notes Writer")).toBeDefined();
  });
  const listReads = seen.filter(
    (entry) => entry.path === "/api/enterprise/plugin-packages",
  );
  expect(listReads.length).toBeGreaterThan(0);
  expect(listReads[0]?.headers["x-openbot-tenant"]).toBe("tenant-a");
  expect(listReads[0]?.headers["x-openbot-workspace"]).toBe("workspace-a");
});

test("a company member sees no install verb on this surface", async () => {
  deploymentRole = "user";
  companyRole = "member";
  storeSelection("user-1", {
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
  });

  const view = renderPage();
  await settle(() => {
    expect(view.getByText("Release Notes Writer")).toBeDefined();
  });
  await act(async () => {
    fireEvent.keyDown(view.getByText("Release Notes Writer"), {
      key: "Enter",
    });
  });
  await settle(() => {
    const dialog = view.getByRole("dialog");
    expect(
      within(dialog).queryByRole("button", { name: "Preview install" }),
    ).toBeNull();
  });
});

test("a company tenant_admin keeps the install verb without any deployment role", async () => {
  deploymentRole = "user";
  companyRole = "tenant_admin";
  storeSelection("user-1", {
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
  });

  const view = renderPage();
  await settle(() => {
    expect(view.getByText("Release Notes Writer")).toBeDefined();
  });
  await act(async () => {
    fireEvent.keyDown(view.getByText("Release Notes Writer"), {
      key: "Enter",
    });
  });
  await settle(() => {
    const dialog = view.getByRole("dialog");
    expect(
      within(dialog).getByRole("button", { name: "Preview install" }),
    ).toBeDefined();
  });
});
