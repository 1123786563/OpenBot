import "../preload";
import type { TFunction } from "i18next";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
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
  AuditScopeForbiddenError,
  CompanyAdminRefusedError,
  type CompanyCapabilities,
  companyAuditEventsQueryOptions,
  companyConfigQueryOptions,
  exportCompanyAuditEvents,
  companyLearningQueryOptions,
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
 * MT096 / Issue #139: the audit, enterprise-settings and learning surfaces open by capability,
 * and the audit query/export obey the scope. The probes drive the real factories; the export
 * runs through the real `exportCompanyAuditEvents` seam. The server's own halves (the domain
 * matrix, the masking, the export's audit row) are pinned server-side in
 * company-admin-routes.test.ts and audit-domains.test.ts.
 *
 *   AC1 the audit query carries the pair, files under the scope's own prefix, and a refusal
 *      arrives as the ONE typed AuditScopeForbiddenError; the export is a fetch (not a link —
 *      a link cannot carry the pair) returning the CSV text.
 *   AC2 the enterprise config read is the company entrance under the pair; a cross-company
 *      refusal (the other company's selection) arrives as the typed refusal, never content.
 *   AC3 the learning read is the scope's own answer: other scopes' containers never appear
 *      because the client renders exactly the rows the server returned.
 *   AC4 the billing entry renders only when the server's grant bits say so.
 */

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };
const GLOBEX: ScopeSelection = {
  tenantId: "globex",
  workspaceId: "globex-ops",
};

const CAPABILITIES: CompanyCapabilities = {
  tenantId: "acme",
  principalId: "prin-1",
  peopleAdmin: true,
  auditReader: true,
  financeReader: false,
  billingManager: false,
};

const AUDIT_EVENTS = {
  events: [
    {
      id: "e-1",
      domain: "business",
      eventType: "company_member.promoted",
      actorId: "prin-admin",
      targetId: "prin-2",
      payload: { grants_deleted: 0 },
      createdAt: "2026-10-21T10:00:00.000Z",
    },
  ],
};

const CONFIG_ANSWER = {
  tenantId: "acme",
  name: "Acme",
  status: "active",
  teams: [{ workspaceId: "acme-finance", name: "Finance" }],
  membersByRole: [
    { role: "tenant_admin", count: 1 },
    { role: "member", count: 2 },
    { role: "auditor", count: 1 },
  ],
  offboardedCount: 0,
};

const LEARNING_ANSWER = {
  records: [
    {
      recordId: "r-1",
      kind: "research",
      title: "Q4 cost research",
      containerId: "mt040-container-acme",
    },
  ],
};

const EXPORT_CSV =
  "id,domain,eventType,actorId,targetId,createdAt\ne-1,business,company_member.promoted,prin-admin,prin-2,2026-10-21T10:00:00.000Z\n";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());
afterEach(cleanup);

type Asked = { input: string; init: RequestInit | undefined };

let asked: Asked[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The audit/config/learning answers, with per-surface refusal switches. A tenant the reader
 * cannot see (globex) answers the typed 403s the invisible-not-error discipline names.
 */
function serve(
  options: { auditStatus?: number; configStatus?: number } = {},
): void {
  asked = [];
  global.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = String(input);
    const tenant = headerOf(init, "x-openbot-tenant");
    asked.push({ input: path, init });
    if (path === "/api/me") return jsonResponse(200, { user: { id: USER } });
    if (path.endsWith("/admin/capabilities")) {
      return jsonResponse(200, CAPABILITIES);
    }
    if (path.endsWith("/admin/audit-events")) {
      if (options.auditStatus !== undefined) {
        return jsonResponse(options.auditStatus, {
          error: { code: "AUDIT_SCOPE_FORBIDDEN", message: "refused" },
        });
      }
      return jsonResponse(200, AUDIT_EVENTS);
    }
    if (path.endsWith("/admin/audit-events/export")) {
      return new Response(EXPORT_CSV, {
        status: 200,
        headers: { "content-type": "text/csv" },
      });
    }
    if (path.endsWith("/admin/enterprise-config")) {
      if (options.configStatus !== undefined || tenant === "globex") {
        return jsonResponse(403, {
          error: { code: "TENANT_ADMIN_REQUIRED", message: "refused" },
        });
      }
      return jsonResponse(200, CONFIG_ANSWER);
    }
    if (path.endsWith("/admin/learning")) {
      // The scope's own answer: acme sees its record; the globex selection sees its own (empty)
      // answer — never acme's, whatever the client asked.
      return jsonResponse(
        200,
        tenant === "globex" ? { records: [] } : LEARNING_ANSWER,
      );
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

function openScope(queryClient: QueryClient, selection: ScopeSelection): void {
  storeSelection(USER, selection);
  selectWorkspaceScope(queryClient, USER, null, selection);
}

/** The audit page's reads. */
function AuditProbe({ filter }: { filter?: string }) {
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const events = useQuery(
    companyAuditEventsQueryOptions(queryClient, scope, filter),
  );
  return (
    <span data-testid="audit-state">
      {events.error instanceof AuditScopeForbiddenError
        ? "forbidden"
        : events.data
          ? events.data.events.map((event) => event.eventType).join("|")
          : "pending"}
    </span>
  );
}

/** The enterprise settings page's read. */
function ConfigProbe() {
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const config = useQuery(companyConfigQueryOptions(queryClient, scope));
  return (
    <span data-testid="config-state">
      {config.error instanceof CompanyAdminRefusedError
        ? "refused"
        : config.data
          ? config.data.name
          : "pending"}
    </span>
  );
}

/** The learning page's read. */
function LearningProbe() {
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const learning = useQuery(companyLearningQueryOptions(queryClient, scope));
  return (
    <span data-testid="learning-state">
      {learning.data
        ? learning.data.records.map((record) => record.containerId).join("|") ||
          "empty"
        : "pending"}
    </span>
  );
}

/** The identity translation: the section list's labels are the keys themselves here. */
const tIdentity = ((key: string): string =>
  key) as unknown as TFunction<"company-admin">;

describe("MT096 company audit / enterprise / learning surfaces (Issue #139)", () => {
  test("AC1: the audit query carries the pair and files under the scope's own prefix", async () => {
    serve();
    const queryClient = freshClient();
    openScope(queryClient, ACME);
    const view = draw(queryClient, <AuditProbe />);

    await waitFor(() => {
      expect(view.getByTestId("audit-state").textContent).toBe(
        "company_member.promoted",
      );
    });
    const read = asked.find((entry) =>
      entry.input.endsWith("/admin/audit-events"),
    );
    expect(read?.input).toBe(
      "/api/enterprise/workspace-scope/admin/audit-events",
    );
    expect(headerOf(read?.init, "x-openbot-tenant")).toBe("acme");
    expect(headerOf(read?.init, "x-openbot-workspace")).toBe("acme-finance");
    const scopedKey = [
      ...scopedCachePrefix(USER, ACME),
      "company-admin-audit",
      { eventType: null },
    ];
    expect(queryClient.getQueryData(scopedKey)).toBeDefined();
  });

  test("AC1: the audit filter rides the query, not a client-side filter of everything", async () => {
    serve();
    const queryClient = freshClient();
    openScope(queryClient, ACME);
    draw(queryClient, <AuditProbe filter="company_member.promoted" />);
    await settle();
    const read = asked.find((entry) =>
      entry.input.includes("/admin/audit-events?"),
    );
    expect(read?.input).toContain("eventType=company_member.promoted");
  });

  test("AC1: the refusal arrives as the ONE typed state — no rows, no counts, no leak", async () => {
    serve({ auditStatus: 403 });
    const queryClient = freshClient();
    openScope(queryClient, ACME);
    const view = draw(queryClient, <AuditProbe />);
    await waitFor(() => {
      expect(view.getByTestId("audit-state").textContent).toBe("forbidden");
    });
  });

  test("AC1: the export is a fetch carrying the pair and answers the server's CSV text", async () => {
    serve();
    const queryClient = freshClient();
    openScope(queryClient, ACME);
    let csv = "";
    await act(async () => {
      csv = await exportCompanyAuditEvents(
        queryClient,
        // The export seam takes the scope the page holds; build the open cache value the
        // hook would have answered.
        {
          status: "open",
          userId: USER,
          selection: ACME,
          generation: queryClient.getQueryData([
            "enterprise-tenant",
            USER,
            ":generation",
          ]) as number,
          prefix: scopedCachePrefix(USER, ACME),
          key: `${ACME.tenantId}/${ACME.workspaceId}`,
        },
      );
    });
    expect(csv).toContain("company_member.promoted");
    const exportRead = asked.find((entry) =>
      entry.input.endsWith("/admin/audit-events/export"),
    );
    expect(exportRead).toBeDefined();
    expect(headerOf(exportRead?.init, "x-openbot-tenant")).toBe("acme");
  });

  test("AC2: the enterprise config shows own company only; the other company's selection refuses", async () => {
    serve();
    const queryClient = freshClient();
    openScope(queryClient, ACME);
    const view = draw(queryClient, <ConfigProbe />);
    await waitFor(() => {
      expect(view.getByTestId("config-state").textContent).toBe("Acme");
    });

    // Switch to another company the reader does not administer: the same read now answers
    // the typed refusal — cross-company content never renders (AC2).
    storeSelection(USER, GLOBEX);
    act(() => {
      selectWorkspaceScope(queryClient, USER, ACME, GLOBEX);
    });
    cleanup();
    const refused = draw(queryClient, <ConfigProbe />);
    await waitFor(() => {
      expect(refused.getByTestId("config-state").textContent).toBe("refused");
    });
  });

  test("AC3: the learning read is the scope's own answer — another scope's containers never appear", async () => {
    serve();
    const queryClient = freshClient();
    openScope(queryClient, ACME);
    const view = draw(queryClient, <LearningProbe />);
    await waitFor(() => {
      expect(view.getByTestId("learning-state").textContent).toBe(
        "mt040-container-acme",
      );
    });
    const read = asked.find((entry) => entry.input.endsWith("/admin/learning"));
    expect(headerOf(read?.init, "x-openbot-workspace")).toBe("acme-finance");

    // A switch to another scope: the new scope's answer is its own (empty here), and the old
    // scope's containers are gone from the view with it.
    storeSelection(USER, GLOBEX);
    act(() => {
      selectWorkspaceScope(queryClient, USER, ACME, GLOBEX);
    });
    cleanup();
    const other = draw(queryClient, <LearningProbe />);
    await waitFor(() => {
      expect(other.getByTestId("learning-state").textContent).toBe("empty");
    });
  });

  test("AC4: the billing entry appears only when the server's grant bits allow it", () => {
    // An administrator without the finance/billing grants: no billing entry.
    const withoutGrants = companyAdminSections(CAPABILITIES, tIdentity);
    expect(
      withoutGrants.some((section) => section.to === "/tenant/admin/billing"),
    ).toBe(false);
    // A finance reader: the entry appears — the same list, one more bit.
    const withFinance = companyAdminSections(
      { ...CAPABILITIES, financeReader: true },
      tIdentity,
    );
    expect(
      withFinance.some((section) => section.to === "/tenant/admin/billing"),
    ).toBe(true);
  });
});
