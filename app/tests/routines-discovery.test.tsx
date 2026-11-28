import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type * as React from "react";

import { RoutineComposerButton } from "@/components/routines/new-routine-button";
import { RoutinesConnectionPage } from "@/components/routines/routines-connection-page";
import { RoutinesList } from "@/components/routines/routines-list";
import {
  cronFrom,
  scheduleSentence,
  usesDaylightSaving,
} from "@/lib/routines/form";
import {
  type RoutineRecord,
  type RoutineRunRecord,
  type RoutinesPage,
  routineRunsQueryOptions,
  routinesQueryOptions,
} from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Somebody who wants a Bot to do something every morning, and does not know Routines exist, has to
 * be led to the one page where routines are made: from Connections, from an empty list, and from the
 * clock beside a conversation's message box. The sidebar entry is in `app-navigation.test.tsx`.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function routine(overrides: Partial<RoutineRecord>): RoutineRecord {
  return {
    id: "routine-1",
    agentId: "lead-desk",
    schedule: "Weekdays at 09:00",
    timezone: "Europe/Madrid",
    instruction: "Send me a summary of yesterday's new leads",
    title: "Morning leads",
    channel: {
      id: "conversation-1",
      name: "Lead Desk",
      title: "Leads",
      gone: false,
    },
    enabled: true,
    nextRunAt: "2099-01-01T08:00:00.000Z",
    lastRun: null,
    ...overrides,
  };
}

/** `/api/routines` and `/api/agents` in the shapes the server sends them. */
function draw(
  element: React.ReactNode,
  page: RoutinesPage | Promise<RoutinesPage>,
  runs: RoutineRunRecord[] = [],
) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/runs")) return Response.json({ runs });
    if (path.startsWith("/api/routines")) return Response.json(await page);
    if (path.startsWith("/api/agents"))
      return Response.json({
        agents: path.includes("hidden=true")
          ? []
          : [{ id: "lead-desk", name: "Lead Desk", avatarSeed: "lead-desk" }],
      });
    return Response.json({});
  }) as unknown as typeof fetch;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => element }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const newRoutineRole = "link";
const SWEEP = { lastSweptAt: new Date().toISOString(), working: true };

test("Connections > Routines distinguishes loading from an empty list", async () => {
  const response = Promise.withResolvers<RoutinesPage>();
  const view = draw(<RoutinesConnectionPage />, response.promise);

  try {
    expect(
      (await view.findByText("Loading your routines…")).getAttribute("role"),
    ).toBe("status");
    expect(view.queryByText("No routines yet.")).toBeNull();
  } finally {
    response.resolve({ routines: [], sweep: SWEEP });
  }

  expect(await view.findByText("No routines yet.")).toBeTruthy();
  expect(view.queryByText("Loading your routines…")).toBeNull();
});

test("Connections > Routines says what Routines is and leads to the Routines page", async () => {
  const view = draw(<RoutinesConnectionPage />, {
    routines: [routine({}), routine({ id: "routine-2", enabled: false })],
    sweep: SWEEP,
  });
  expect(
    await view.findByText(
      "Schedule work with the built-in Routines tool. Every Bot can set up a routine for you.",
    ),
  ).toBeTruthy();
  const row = await view.findByRole("link", { name: /Your routines/ });
  expect(row.getAttribute("href")).toBe("/routines");
  expect(await within(row).findByText("2 routines, 1 on.")).toBeTruthy();
  expect(
    view
      .getByRole(newRoutineRole, { name: "New routine" })
      .getAttribute("href"),
  ).toBe("/routines/new");
  // No tools listing: nothing here is a tool to grant.
  expect(view.queryByText(/create_routine/)).toBeNull();
});

test("an empty Routines page offers New routine, and a Bot's own page starts it for that Bot", async () => {
  const empty = { routines: [], sweep: SWEEP };
  const page = draw(<RoutinesList />, empty);
  expect(
    (
      await page.findByRole(newRoutineRole, { name: "New routine" })
    ).getAttribute("href"),
  ).toBe("/routines/new");
  cleanup();
  queryClient.clear();

  const botPage = draw(<RoutinesList agentId="lead-desk" />, empty);
  expect(await botPage.findByText("No routines for this Bot yet")).toBeTruthy();
  expect(
    (
      await botPage.findByRole(newRoutineRole, { name: "New routine" })
    ).getAttribute("href"),
  ).toBe("/routines/new?agentId=lead-desk");
});

test("the Routines page says which Bot each routine belongs to", async () => {
  const nextRunAt = new Date(Date.now() + 8 * 86_400_000).toISOString();
  const view = draw(<RoutinesList />, {
    routines: [routine({ nextRunAt })],
    sweep: SWEEP,
  });
  const bot = await view.findByRole("link", { name: /Lead Desk/ });
  expect(bot.getAttribute("href")).toBe("/bots/lead-desk/routines");
  const nextRun = await view.findByText("next week", { exact: true });
  expect(nextRun.getAttribute("datetime")).toBe(nextRunAt);
  expect(nextRun.parentElement?.textContent).toBe("Runs next week");
});

test("the clock beside the message box opens New routine for this Bot, posting here", async () => {
  const view = draw(
    <RoutineComposerButton agentId="lead-desk" channelId="conversation-1" />,
    { routines: [], sweep: SWEEP },
  );
  const clock = await view.findByRole("button", { name: "Set up a routine" });
  expect(clock.getAttribute("href")).toBe(
    "/routines/new?agentId=lead-desk&channelId=conversation-1",
  );
});

test("the schedule picker writes the cron it reads back in words", () => {
  const at = { time: "09:00", weekday: "1", monthDay: "1" };
  const cases = [
    [{ ...at, repeat: "weekdays" }, "0 9 * * 1-5", "Every weekday at 9:00 AM"],
    [
      { ...at, repeat: "daily", time: "18:30" },
      "30 18 * * *",
      "Every day at 6:30 PM",
    ],
    [
      { ...at, repeat: "weekly", weekday: "5", time: "00:15" },
      "15 0 * * 5",
      "Every Friday at 12:15 AM",
    ],
    [
      { ...at, repeat: "monthly", monthDay: "22", time: "12:00" },
      "0 12 22 * *",
      "On the 22nd of every month at 12:00 PM",
    ],
    [{ ...at, repeat: "hourly" }, "0 * * * *", "Every hour, on the hour"],
  ] as const;
  for (const [schedule, cron, words] of cases) {
    expect(cronFrom(schedule)).toBe(cron);
    expect(scheduleSentence(schedule)).toBe(words);
  }
});

test("keyboard users can locate the results controlled by a routine's History button", async () => {
  const view = draw(<RoutinesList />, {
    routines: [routine({})],
    sweep: SWEEP,
  });
  const history = await view.findByRole("button", { name: /Run history/ });
  const region = document.getElementById(
    history.getAttribute("aria-controls") ?? "",
  );
  expect(region?.hidden).toBe(true);
  fireEvent.click(history);
  expect(
    (await view.findByRole("region", { name: "Run history for Morning leads" }))
      .id,
  ).toBe(region?.id ?? "");
  expect(history.getAttribute("aria-expanded")).toBe("true");
});

test("a transient refresh failure keeps the last loaded routines and runs", async () => {
  const task = routine({});
  const page = { routines: [task], sweep: SWEEP };
  const runs: RoutineRunRecord[] = [
    {
      id: "run-1",
      status: "succeeded",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      source: "schedule",
    },
  ];
  const view = draw(<RoutinesList />, page);
  const fallback = global.fetch;
  let status = 200;
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/routines") && status !== 200) {
        return Response.json({ error: "Read failed" }, { status });
      }
      if (path.endsWith("/runs")) return Response.json({ runs });
      return fallback(input, init);
    },
    { preconnect: fallback.preconnect },
  );
  fireEvent.click(await view.findByRole("button", { name: /Run history/ }));
  await view.findByText("Succeeded");

  const list = { ...routinesQueryOptions(), retry: false };
  const history = { ...routineRunsQueryOptions(task.id), retry: false };
  status = 503;
  await Promise.allSettled([
    queryClient.fetchQuery(list),
    queryClient.fetchQuery(history),
  ]);
  await view.findByText(
    "Showing the last loaded routines. Refresh to make changes.",
  );
  await view.findByText("Showing the last loaded runs.");
  expect(view.getByText("Morning leads")).toBeTruthy();
  expect(view.getByText("Succeeded")).toBeTruthy();
  expect(
    view.queryByRole("button", { name: "Run now for Morning leads" }),
  ).toBeNull();
  expect(
    view.queryByRole("button", { name: "Delete Morning leads" }),
  ).toBeNull();
  expect(
    view.queryByRole("switch", { name: "Enable Morning leads" }),
  ).toBeNull();

  status = 403;
  await queryClient.fetchQuery(list).catch(() => undefined);
  await view.findByText("You don’t have access to these routines.");
  expect(view.queryByText("Morning leads")).toBeNull();
  expect(view.queryByText("No routines yet")).toBeNull();

  status = 503;
  await queryClient.fetchQuery(list).catch(() => undefined);
  await view.findByText("Couldn’t load Routines");
  expect(view.queryByText("Morning leads")).toBeNull();
  expect(
    queryClient.getQueryData<RoutineRunRecord[]>(history.queryKey)?.length,
  ).toBe(0);
});

test("overlapping routine writes keep feedback on the routine being changed", async () => {
  const view = draw(<RoutinesList />, {
    routines: [
      routine({}),
      routine({ id: "routine-2", title: "Evening leads" }),
    ],
    sweep: SWEEP,
  });
  let morningResponse = Promise.withResolvers<Response>();
  const eveningResponse = Promise.withResolvers<Response>();
  const fallback = global.fetch;
  global.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      switch (String(input)) {
        case "/api/routines/routine-1/enabled":
          return morningResponse.promise;
        case "/api/routines/routine-2/enabled":
          return eveningResponse.promise;
        default:
          return fallback(input, init);
      }
    },
    { preconnect: fallback.preconnect },
  );
  const morning = await view.findByRole("switch", {
    name: "Enable Morning leads",
  });
  const evening = view.getByRole("switch", { name: "Enable Evening leads" });
  if (
    !(morning instanceof HTMLInputElement) ||
    !(evening instanceof HTMLInputElement)
  )
    throw new Error("Missing routine switches");
  const isBlocked = (control: HTMLInputElement) =>
    control.disabled || control.getAttribute("aria-disabled") === "true";
  try {
    fireEvent.click(morning);
    await waitFor(() => expect(isBlocked(morning)).toBe(true));
    fireEvent.click(evening);
    await waitFor(() => expect(isBlocked(evening)).toBe(true));
    expect(isBlocked(morning)).toBe(true);

    eveningResponse.resolve(Response.json({ ok: true }));
    morningResponse.resolve(
      Response.json({ error: "Write unavailable" }, { status: 503 }),
    );
    const alert = await view.findByText(
      "Couldn’t update Morning leads. Try the switch again.",
    );
    expect(alert.getAttribute("role")).toBe("alert");
    expect(morning.checked).toBe(true);
    expect(isBlocked(morning)).toBe(false);

    morningResponse = Promise.withResolvers<Response>();
    fireEvent.click(morning);
    await waitFor(() => expect(isBlocked(morning)).toBe(true));
    morningResponse.resolve(
      Response.json(
        { error: "You no longer manage this routine." },
        { status: 403 },
      ),
    );
    expect(
      await view.findByText(
        "Couldn’t update Morning leads. You no longer manage this routine.",
      ),
    ).toBeTruthy();
  } finally {
    morningResponse.resolve(Response.json({ ok: true }));
    eveningResponse.resolve(Response.json({ ok: true }));
  }
});

test("embedded empty routines keep one create action in the section heading", async () => {
  const view = draw(<RoutinesList embedded />, { routines: [], sweep: SWEEP });
  await view.findByText("No routines yet");
  expect(view.container.querySelector("[data-slot=empty]")).toBeNull();
  expect(view.getAllByRole("link", { name: "New routine" })).toHaveLength(1);
  expect(
    view.getByRole("heading", { name: "Routines" }).parentElement?.textContent,
  ).toContain("New routine");
});

test.each([false, true])(
  "run history links to its source when conversation gone is %s",
  async (gone) => {
    const task = routine({});
    const view = draw(
      <RoutinesList />,
      {
        routines: [{ ...task, channel: { ...task.channel, gone } }],
        sweep: SWEEP,
      },
      [
        {
          id: "run-1",
          status: "succeeded",
          startedAt: "2026-01-05T09:00:00Z",
          finishedAt: null,
          error: null,
          source: "schedule",
          conversationRunId: "conversation-run",
        },
      ],
    );
    fireEvent.click(await view.findByRole("button", { name: /Run history/ }));
    const link = await view.findByRole("link", {
      name: gone ? "Open Bot" : "Open Conversation Run",
    });
    expect(link.getAttribute("href")).toBe(
      gone
        ? "/bots/lead-desk"
        : "/channel/conversation-1?runId=conversation-run",
    );
  },
);

test("the schedule distinguishes seasonal offsets from a fixed time zone", () => {
  expect(usesDaylightSaving("America/New_York")).toBe(true);
  expect(usesDaylightSaving("UTC")).toBe(false);
});
