import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { type AuditEvent, subjectText } from "@/components/audit/audit-cells";
import { agentKeys } from "@/lib/agents/queries";
import { Route as AdminAuditRoute } from "@/routes/_authed/admin/audit";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/*
 * Removing an identity provider and deleting a saved login, as the trail reads.
 *
 * Both rows named what happened and nothing else: "Remove an identity provider · Allowed" and
 * "Delete a login · Allowed". The provider's id and the login's site were on the row and only the
 * export showed them, so neither could be found with the page's search either.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const PROVIDER = "acme-okta";
const SITE = "https://example.com";

function row(
  id: string,
  eventType: string,
  targetType: string,
  targetId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    actorUserId: "admin-1",
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType,
    targetId,
    payload,
    createdAt: `2026-11-25T18:0${id}:00Z`,
  };
}

const REMOVED = row(
  "1",
  "identity_provider.removed",
  "identity_provider",
  PROVIDER,
  {
    removedBy: "admin@example.test",
  },
);
const LOGIN_DELETED = row("2", "password.deleted", "password", "login-1", {
  site: SITE,
  login: "login-1",
});
const LOGIN_SAVED = row("3", "password.saved", "password", "login-2", {
  site: SITE,
  login: "login-2",
});
/** A Bot's app source for memory, as `removeSource` writes it. */
const SOURCE_REMOVED = row(
  "4",
  "configuration.changed",
  "memory_source",
  "source-1",
  {
    change: "memory_source_removed",
    agentId: "personal-assistant",
    app: "composio-gmail",
  },
);

async function drawn(rows: Record<string, unknown>[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  seedAuditPage(queryClient, "", { events: rows });
  queryClient.setQueryData(agentKeys.list(false), []);
  const router = createRouter({
    routeTree: createRootRoute({
      component: AdminAuditRoute.options.component,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByText("Decision");
  return [...view.container.querySelectorAll("tbody tr")].map((tr) =>
    [...(tr.querySelector("[data-column=what]")?.children ?? [])].map(
      (line) => line.textContent,
    ),
  );
}

test("a removed provider is named by its id, and a saved login by its site", async () => {
  // Newest first, as the trail draws every row.
  expect(await drawn([LOGIN_SAVED, LOGIN_DELETED, REMOVED])).toEqual([
    ["Save a login", SITE],
    ["Delete a login", SITE],
    ["Remove an identity provider", PROVIDER],
  ]);
});

test("a removed app source names the app it read", async () => {
  expect(await drawn([SOURCE_REMOVED])).toEqual([
    ["Remove an app source", "composio-gmail"],
  ]);
});

test("the personal edition's words name them too, an app in words", () => {
  // A provider's id is the provider's name everywhere, so it reads the same on Activity.
  expect(subjectText(REMOVED as unknown as AuditEvent, false)).toBe(PROVIDER);
  expect(subjectText(LOGIN_DELETED as unknown as AuditEvent, false)).toBe(SITE);
  expect(subjectText(LOGIN_SAVED as unknown as AuditEvent, false)).toBe(SITE);
  expect(subjectText(SOURCE_REMOVED as unknown as AuditEvent, false)).toBe(
    "Gmail",
  );
});
