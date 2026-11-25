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
 * The three People actions, as an administrator reads them in the trail.
 *
 * Every row said "Change a person's role · Started by a person · Allowed": neither which person nor
 * which role. The address and both roles were already on the payload, written for exactly this
 * reading, and only the export showed them.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const EMAIL = "member@example.test";

function row(
  id: string,
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    actorUserId: "admin-1",
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType: "person",
    targetId: "u1",
    payload,
    createdAt: `2026-11-25T18:0${id}:00Z`,
  };
}

const ROLE = row("1", "person.role_changed", {
  email: EMAIL,
  from: "user",
  to: "admin",
});
const REMOVED = row("2", "person.access_revoked", { email: EMAIL });
const RESTORED = row("3", "person.access_restored", { email: EMAIL });
const STOPPED = row("4", "computer.terminated", {
  email: EMAIL,
  by: "admin@example.test",
  stopped: [`person:u1`],
  failed: [],
  note: "Running Bots stopped; durable disks kept; each Bot gets a fresh computer next session.",
});

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

test("a role change names the person and both roles", async () => {
  expect(await drawn([ROLE])).toEqual([
    ["Change a person's role", `${EMAIL} · Member → Admin`],
  ]);
});

test("removing and restoring access name the person", async () => {
  // Newest first, as the trail draws every row.
  expect(await drawn([REMOVED, RESTORED])).toEqual([
    ["Restore a person's access", EMAIL],
    ["Remove a person's access", EMAIL],
  ]);
});

test("stopping somebody's computers names the person", async () => {
  expect(await drawn([STOPPED])).toEqual([["Shut down a computer", EMAIL]]);
});

// Rows written before the stop carried an address still draw, with no subject rather than a wrong one.
test("a stop written before it named the person still draws", async () => {
  const { email: _email, ...withoutEmail } = STOPPED.payload as Record<
    string,
    unknown
  >;
  expect(await drawn([{ ...STOPPED, payload: withoutEmail }])).toEqual([
    ["Shut down a computer"],
  ]);
});

/** The personal edition says things in words, and an address is not one of them. */
test("the personal edition's words carry no address", () => {
  expect(subjectText(ROLE as unknown as AuditEvent, false)).toBe("");
  expect(subjectText(REMOVED as unknown as AuditEvent, false)).toBe("");
});
