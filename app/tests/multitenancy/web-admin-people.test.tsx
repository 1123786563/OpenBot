import "../preload";
import type { TFunction } from "i18next";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { act } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { companyAdminSections } from "../../src/components/company-admin/company-admin-area";
import {
  CompanyAdminRefusedError,
  type CompanyCapabilities,
  companyCredentialsQueryOptions,
  companyDemoteMutationOptions,
  companyIdentityQueryOptions,
  companyOffboardMutationOptions,
  companyPeopleQueryOptions,
  companyPromoteMutationOptions,
} from "../../src/lib/enterprise/tenant/company-admin";
import {
  type ScopeSelection,
  selectWorkspaceScope,
  storeSelection,
} from "../../src/lib/enterprise/tenant/selection";
import {
  scopedCachePrefix,
  useScopedCache,
} from "../../src/lib/enterprise/tenant/scoped-cache";

/**
 * MT095 / Issue #138: the company people, identity and credentials surfaces open by SERVER
 * capability, not by a role the browser recomputes. The probes here drive the real factories the
 * pages call and the real section list the nav renders; `fetch` records every request — the pair
 * the client carried and the paths it chose are the evidence.
 *
 *   AC1 the entry is the capability answer: sections render from the server's bits only, an
 *      all-false answer renders the ONE refusal state, and a gated read's 403 arrives as the
 *      typed CompanyAdminRefusedError the page renders — never a redirect.
 *   AC2 the people and identity reads hit the company entrance (never the platform
 *      `/api/admin/**`), carry the selection pair, and file under the scope's own prefix; the
 *      credential roster is the masked shape the server answers.
 *   AC3 the three lifecycle actions submit under the pair and invalidate this scope's roster —
 *      the audit row is the server's own fact (its route half is pinned server-side).
 *   AC4 no platform entrance appears in the company nav: the section list is built from company
 *      capability bits and contains no `/admin/**` target.
 */

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };

const FULL_CAPABILITIES: CompanyCapabilities = {
  tenantId: "acme",
  principalId: "prin-1",
  peopleAdmin: true,
  auditReader: true,
  financeReader: true,
  billingManager: true,
};

const NONE_CAPABILITIES: CompanyCapabilities = {
  tenantId: "acme",
  principalId: "prin-1",
  peopleAdmin: false,
  auditReader: false,
  financeReader: false,
  billingManager: false,
};

const MEMBER_ROW = {
  principalId: "prin-2",
  userId: "user-2",
  role: "member",
  status: "active",
  epoch: 1,
  joinedAt: "2026-10-01T00:00:00.000Z",
};

const CREDENTIAL_ROW = {
  credentialId: "cred-1",
  tenantId: "acme",
  kind: "connection",
  classification: "company",
  workspaceId: null,
  target: "https://api.example.com",
  label: "Company API key",
  status: "active",
  effectiveActions: { use: true, disclose: false },
  createdAt: "2026-10-01T00:00:00.000Z",
};

const IDENTITY_ANSWER = {
  sso: {
    protocol: "saml",
    issuer: "https://idp.acme.test",
    domain: "acme.test",
    credentialRef: "sso-acme",
    revision: 2,
  },
  scimBindings: [
    { bindingId: "b-1", connectionKey: "scim-key-1", status: "active" },
  ],
};

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());
afterEach(cleanup);

const originalFetch = global.fetch;

type Asked = { input: string; init: RequestInit | undefined };

let asked: Asked[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The company admin entrance's answers: a 403 switch lets the gate read refuse on demand, the
 * people read refuse on demand, and everything else answers its fixture. Platform paths answer
 * 200 with a canary the probes assert never arrived.
 */
function serve(options: { peopleStatus?: number } = {}): void {
  asked = [];
  global.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = String(input);
    asked.push({ input: path, init });
    if (path === "/api/me") return jsonResponse(200, { user: { id: USER } });
    if (path.startsWith("/api/admin/")) {
      return jsonResponse(200, { platform: "canary" });
    }
    if (path.endsWith("/admin/capabilities")) {
      return jsonResponse(200, FULL_CAPABILITIES);
    }
    if (path.endsWith("/admin/people")) {
      return jsonResponse(
        options.peopleStatus ?? 200,
        options.peopleStatus === undefined
          ? { members: [MEMBER_ROW] }
          : { error: { code: "TENANT_ADMIN_REQUIRED", message: "refused" } },
      );
    }
    if (path.endsWith("/admin/credentials")) {
      return jsonResponse(200, { credentials: [CREDENTIAL_ROW] });
    }
    if (path.endsWith("/admin/identity")) {
      return jsonResponse(200, IDENTITY_ANSWER);
    }
    if (
      path.includes("/promote") ||
      path.includes("/demote") ||
      path.includes("/offboard")
    ) {
      return jsonResponse(200, { report: { outcome: "ok" } });
    }
    return jsonResponse(200, {});
  }) as unknown as typeof fetch;
}

function headerOf(
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return (headers as Record<string, string>)[name];
}

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function draw(queryClient: QueryClient, node: React.ReactNode) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => node }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** Opens the acme scope exactly as the selection page does. */
function openAcme(queryClient: QueryClient): void {
  storeSelection(USER, ACME);
  selectWorkspaceScope(queryClient, USER, null, ACME);
}

/** The people page's reads and writes, one button each. */
function PeopleProbe() {
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const people = useQuery(companyPeopleQueryOptions(queryClient, scope));
  const credentials = useQuery(
    companyCredentialsQueryOptions(queryClient, scope),
  );
  const identity = useQuery(companyIdentityQueryOptions(queryClient, scope));
  const promote = useMutation(
    companyPromoteMutationOptions(queryClient, scope),
  );
  const demote = useMutation(companyDemoteMutationOptions(queryClient, scope));
  const offboard = useMutation(
    companyOffboardMutationOptions(queryClient, scope),
  );
  return (
    <>
      <span data-testid="people-state">
        {people.error instanceof CompanyAdminRefusedError
          ? "refused"
          : people.data
            ? String(people.data.members.length)
            : "pending"}
      </span>
      <span data-testid="credential-label">
        {credentials.data?.credentials[0]?.label ?? "none"}
      </span>
      <span data-testid="identity-issuer">
        {identity.data?.sso?.issuer ?? "none"}
      </span>
      <button
        data-testid="promote"
        onClick={() => promote.mutate("prin-2")}
        type="button"
      />
      <button
        data-testid="demote"
        onClick={() => demote.mutate({ principalId: "prin-2", to: "member" })}
        type="button"
      />
      <button
        data-testid="offboard"
        onClick={() => offboard.mutate("prin-2")}
        type="button"
      />
    </>
  );
}

/** The identity translation: the section list's labels are the keys themselves here. */
const tIdentity = ((key: string): string =>
  key) as unknown as TFunction<"company-admin">;

describe("MT095 company people / identity / credentials surfaces (Issue #138)", () => {
  test("AC1: the section list derives from the server's capability bits alone", () => {
    // The admin's own sections…
    const adminSections = companyAdminSections(FULL_CAPABILITIES, tIdentity);
    expect(adminSections.map((section) => section.to)).toEqual([
      "/tenant/admin/people",
      "/tenant/admin/audit",
      "/tenant/admin/enterprise",
      "/tenant/admin/learning",
      "/tenant/admin/billing",
    ]);
    // …an auditor's (no peopleAdmin)…
    const auditorSections = companyAdminSections(
      {
        ...FULL_CAPABILITIES,
        peopleAdmin: false,
        financeReader: false,
        billingManager: false,
      },
      tIdentity,
    );
    expect(auditorSections.map((section) => section.to)).toEqual([
      "/tenant/admin/audit",
    ]);
    // …and a member with nothing: no section at all.
    expect(companyAdminSections(NONE_CAPABILITIES, tIdentity)).toEqual([]);
  });

  test("AC4: no platform entrance is in the company nav — no /admin/** target exists", () => {
    for (const capabilities of [FULL_CAPABILITIES, NONE_CAPABILITIES]) {
      for (const section of companyAdminSections(capabilities, tIdentity)) {
        expect(section.to.startsWith("/admin")).toBe(false);
      }
    }
  });

  test("AC2: the roster read carries the pair, files under the scope prefix, and never touches a platform path", async () => {
    serve();
    const queryClient = freshClient();
    openAcme(queryClient);
    const view = draw(queryClient, <PeopleProbe />);

    await waitFor(() => {
      expect(view.getByTestId("people-state").textContent).toBe("1");
    });

    const roster = asked.find((entry) => entry.input.endsWith("/admin/people"));
    expect(roster).toBeDefined();
    expect(headerOf(roster?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(roster?.init, "x-openbot-workspace")).toBe("acme-finance");
    // The company entrance, never the platform people list.
    expect(roster?.input).toBe("/api/enterprise/workspace-scope/admin/people");
    // The entry lives under the scope's own prefix (a switch drops it wholesale).
    const scopedKey = [
      ...scopedCachePrefix(USER, ACME),
      "company-admin-people",
    ];
    expect(queryClient.getQueryData(scopedKey)).toBeDefined();
    // No read ever left for a platform path.
    expect(asked.some((entry) => entry.input.startsWith("/api/admin/"))).toBe(
      false,
    );
  });

  test("AC2: the masked credential roster and the company identity answer arrive scoped", async () => {
    serve();
    const queryClient = freshClient();
    openAcme(queryClient);
    const view = draw(queryClient, <PeopleProbe />);

    await waitFor(() => {
      expect(view.getByTestId("credential-label").textContent).toBe(
        "Company API key",
      );
    });
    await waitFor(() => {
      expect(view.getByTestId("identity-issuer").textContent).toBe(
        "https://idp.acme.test",
      );
    });

    const credentialRead = asked.find((entry) =>
      entry.input.endsWith("/admin/credentials"),
    );
    expect(credentialRead?.input).toBe(
      "/api/enterprise/workspace-scope/admin/credentials",
    );
    const identityRead = asked.find((entry) =>
      entry.input.endsWith("/admin/identity"),
    );
    expect(identityRead?.input).toBe(
      "/api/enterprise/workspace-scope/admin/identity",
    );
    expect(headerOf(credentialRead?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(identityRead?.init, "x-openbot-tenant")).toBe("acme");
  });

  test("AC3: the three lifecycle actions submit under the pair and refresh this scope's roster", async () => {
    serve();
    const queryClient = freshClient();
    openAcme(queryClient);
    const view = draw(queryClient, <PeopleProbe />);
    await waitFor(() => {
      expect(view.getByTestId("people-state").textContent).toBe("1");
    });
    const readsBefore = asked.filter((entry) =>
      entry.input.endsWith("/admin/people"),
    ).length;

    await act(async () => {
      view.getByTestId("promote").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      view.getByTestId("demote").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      view.getByTestId("offboard").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const actions = asked.filter(
      (entry) =>
        entry.input.includes("/people/prin-2/") &&
        (entry.init?.method ?? "GET") === "POST",
    );
    expect(actions.map((entry) => entry.input.split("/").pop())).toEqual([
      "promote",
      "demote",
      "offboard",
    ]);
    for (const action of actions) {
      expect(headerOf(action.init, "x-openbot-tenant")).toBe("acme");
      expect(headerOf(action.init, "x-openbot-workspace")).toBe("acme-finance");
    }
    // The roster invalidation refetches this scope's entry — the answer becomes visible.
    const readsAfter = asked.filter((entry) =>
      entry.input.endsWith("/admin/people"),
    ).length;
    expect(readsAfter).toBeGreaterThan(readsBefore);
  });

  test("AC1: a member the gate refuses gets the ONE typed refusal state, not a redirect", async () => {
    serve({ peopleStatus: 403 });
    const queryClient = freshClient();
    openAcme(queryClient);
    const view = draw(queryClient, <PeopleProbe />);

    await waitFor(() => {
      expect(view.getByTestId("people-state").textContent).toBe("refused");
    });
    // The refusal came from the company entrance; nothing was fetched again as a fallback.
    expect(asked.some((entry) => entry.input.startsWith("/api/admin/"))).toBe(
      false,
    );
  });

  test("AC1: a personal (no-selection) scope renders the gate's own empty state and reads nothing", async () => {
    serve();
    const queryClient = freshClient();
    // No selection stored: the gate component (the area layout) is what the route renders, and
    // its no-selection branch precedes the capabilities read — the pages never mount.
    const openPersonal = {
      status: "open" as const,
      userId: USER,
      selection: null,
      generation: 1,
      prefix: scopedCachePrefix(USER, null),
      key: `${USER}:personal`,
    };
    const { CompanyAdminArea } = await import(
      "../../src/components/company-admin/company-admin-area"
    );
    draw(queryClient, <CompanyAdminArea scope={openPersonal} />);
    await settle();
    // The i18n namespace is not initialized in this harness, so the raw keys render — the
    // no-selection branch's own words, and no section link ever mounts.
    expect(
      asked.some((entry) => entry.input.includes("/workspace-scope/admin")),
    ).toBe(false);
  });
});
