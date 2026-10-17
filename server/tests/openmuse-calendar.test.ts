import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  decodeCalendarCursor,
  encodeCalendarCursor,
} from "../src/openmuse-calendar/calendar";
import {
  buildOpenMuseCalendarClient,
  type CalendarWireDial,
} from "../src/openmuse-calendar/client";
import { createOpenMuseCalendarClient } from "../src/openmuse-calendar/client";
import { createOpenMuseCalendarRoutes } from "../src/openmuse-calendar/routes";
import {
  OpenMuseConnectionRefusedError,
  type OpenMuseGoogleOAuth,
} from "../src/openmuse-connectors/google-oauth";
import type { StoredOpenMuseGoogleConnection } from "../src/openmuse-connectors/store";

const actorOne: AuthenticatedActor = {
  id: "user-1",
  email: "one@openbot.test",
  role: "user",
};

const actorTwo: AuthenticatedActor = {
  id: "user-2",
  email: "two@openbot.test",
  role: "user",
};

let currentActor: AuthenticatedActor = actorOne;

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", currentActor);
  await next();
};

/**
 * The connection row a connected owner's guard answers — alias is what the
 * dial must send. Calendar's guard is provider-aware by necessity: a Gmail
 * row must NOT satisfy a `googlecalendar` ask (G03), so the fake keys on
 * both.
 */
function connection(
  userId: string,
  alias: string,
  provider: StoredOpenMuseGoogleConnection["provider"] = "googlecalendar",
  status: StoredOpenMuseGoogleConnection["status"] = "connected",
): StoredOpenMuseGoogleConnection {
  return {
    id: `conn-${userId}-${provider}`,
    userId,
    provider,
    accountEmail: `${userId}@gmail.test`,
    status,
    grantedScopes: ["calendar.readonly"],
    generation: 1,
    alias,
    connectedAt: new Date("2026-10-01T00:00:00Z"),
  };
}

/** The requireConnection seam A01 borrows from G01/G03: connected row or the stable 409 refusal. */
function fakeGuard(
  connections: Map<string, StoredOpenMuseGoogleConnection>,
): Pick<OpenMuseGoogleOAuth, "requireConnection"> {
  return {
    async requireConnection(userId, provider) {
      const row = connections.get(`${userId}:${provider}`);
      if (row === undefined || row.status !== "connected") {
        throw new OpenMuseConnectionRefusedError(provider);
      }
      return row;
    },
  };
}

type RecordedCall = {
  path: string;
  headers: Record<string, string>;
  body: unknown;
};

/**
 * One fake wire answering the scripted payload on every call, recording what
 * was sent. The answer callback sees the request's `input`, so window tests
 * can filter the way the vendor is recorded to (O02 verifies the live dial).
 */
function fakeDial(
  answer: (input: Record<string, unknown>) => unknown,
  ok = true,
) {
  const calls: RecordedCall[] = [];
  const dial: CalendarWireDial = async (path, init) => {
    calls.push({ path, headers: init.headers, body: init.body });
    const input =
      (init.body as { input?: Record<string, unknown> } | undefined)?.input ??
      {};
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => answer(input),
    };
  };
  return { calls, dial };
}

/**
 * The §4 LA DST fixture as the provider's default row: one real hour from
 * 01:30 to 03:30 across the spring-forward gap, plus the fields only the
 * provider carries, which must never cross the mapping.
 */
function providerEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    calendarId: "calendar-1",
    etag: '"3386307200000000"',
    title: "Design review",
    start: "2026-03-08T01:30:00-08:00",
    end: "2026-03-08T03:30:00-07:00",
    allDay: false,
    timeZone: "America/Los_Angeles",
    location: "Room 5",
    description: "Quarterly design review.",
    attendees: [{ email: "ava@example.test" }, { email: "sam@example.test" }],
    hangoutLink: "https://meet.example.test/xyz",
    creator: { email: "ava@example.test" },
    ...overrides,
  };
}

/** The runtime face's envelope, as the real dial would deliver it to the client. */
const envelope = (data: unknown) => ({ data });

/** The §4 default window every plain request asks for. */
const WINDOW = new URLSearchParams({
  timeMin: "2026-03-01T00:00:00Z",
  timeMax: "2026-04-01T00:00:00Z",
}).toString();

function calendarApp(input: {
  dial: CalendarWireDial;
  connections: Map<string, StoredOpenMuseGoogleConnection>;
  ownerDisabled?: (userId: string) => Promise<boolean>;
}) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createOpenMuseCalendarRoutes({
      client: buildOpenMuseCalendarClient({ dial: input.dial }),
      service: fakeGuard(input.connections),
      requireUser,
      ownerDisabled: input.ownerDisabled ?? (async () => false),
    }),
  );
  return app;
}

function connectedUsers() {
  return new Map<string, StoredOpenMuseGoogleConnection>([
    [
      `${actorOne.id}:googlecalendar`,
      connection(actorOne.id, "openmuse-alias-one"),
    ],
    [
      `${actorTwo.id}:googlecalendar`,
      connection(actorTwo.id, "openmuse-alias-two"),
    ],
  ]);
}

describe("GET /api/mobile/openmuse-calendar", () => {
  test("maps the provider payload to the §4 DTO and drops extra provider fields", async () => {
    const { calls, dial } = fakeDial(() =>
      envelope({ events: [providerEvent()] }),
    );
    const response = await calendarApp({
      dial,
      connections: connectedUsers(),
    }).request(`/?${WINDOW}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      events: unknown[];
      truncated: boolean;
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toEqual({
      id: "evt-1",
      calendarId: "calendar-1",
      etag: '"3386307200000000"',
      title: "Design review",
      // Pass-through: the offset strings survive verbatim, not re-serialized.
      start: "2026-03-08T01:30:00-08:00",
      end: "2026-03-08T03:30:00-07:00",
      allDay: false,
      timeZone: "America/Los_Angeles",
      location: "Room 5",
      description: "Quarterly design review.",
      attendees: ["ava@example.test", "sam@example.test"],
    });
    // The alias-bound dial on the placeholder list action, window forwarded.
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain("gcalendar.list");
    expect(calls[0].headers["x-oo-connector-alias"]).toBe("openmuse-alias-one");
    expect(calls[0].body).toEqual({
      input: {
        timeMin: "2026-03-01T00:00:00Z",
        timeMax: "2026-04-01T00:00:00Z",
      },
    });
  });

  test("passes all-day events through with date-only start and exclusive date-only end", async () => {
    const { dial } = fakeDial(() =>
      envelope({
        events: [
          providerEvent({
            id: "evt-allday",
            start: "2026-03-08",
            end: "2026-03-09",
            allDay: true,
            attendees: ["organizer@example.test"],
          }),
        ],
      }),
    );
    const response = await calendarApp({
      dial,
      connections: connectedUsers(),
    }).request(`/?${WINDOW}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      events: Array<Record<string, unknown>>;
    };
    // Date-only strings and a bare-string attendee list map as they stand;
    // A03 owns rendering them.
    expect(body.events[0]).toEqual({
      id: "evt-allday",
      calendarId: "calendar-1",
      etag: '"3386307200000000"',
      title: "Design review",
      start: "2026-03-08",
      end: "2026-03-09",
      allDay: true,
      timeZone: "America/Los_Angeles",
      location: "Room 5",
      description: "Quarterly design review.",
      attendees: ["organizer@example.test"],
    });
  });

  test("orders ascending start with id ascending as the tiebreak", async () => {
    const at = "2026-03-08T09:00:00Z";
    const { dial } = fakeDial(() =>
      envelope({
        events: [
          providerEvent({ id: "e-b", start: at }),
          providerEvent({ id: "e-a", start: at }),
          providerEvent({ id: "e-c", start: "2026-03-07T09:00:00Z" }),
        ],
      }),
    );
    const response = await calendarApp({
      dial,
      connections: connectedUsers(),
    }).request(`/?${WINDOW}`);
    const body = (await response.json()) as { events: { id: string }[] };
    // The earlier start leads; the equal-start pair ties on id ASCENDING.
    expect(body.events.map((event) => event.id)).toEqual(["e-c", "e-a", "e-b"]);
  });

  test("two events sharing an id across calendars both serve and page apart at equal starts", async () => {
    // Provider event ids are unique per calendar only: an aggregated answer
    // that reuses one id on two calendars holds two real events, and neither
    // the dedupe nor the keyset may silently collapse them.
    const at = "2026-03-08T09:00:00Z";
    const all = [
      providerEvent({ id: "e-1", start: at, calendarId: "cal-b" }),
      providerEvent({ id: "e-1", start: at, calendarId: "cal-a" }),
    ];
    const { dial } = fakeDial(() => envelope({ events: all }));
    const app = calendarApp({ dial, connections: connectedUsers() });
    const first = await app.request(`/?${WINDOW}&limit=1`);
    const pageOne = (await first.json()) as {
      events: { id: string; calendarId: string }[];
      nextCursor?: string;
    };
    expect(pageOne.events.map((event) => [event.calendarId, event.id])).toEqual(
      [["cal-a", "e-1"]],
    );
    expect(pageOne.nextCursor).toBeDefined();

    const second = await app.request(
      `/?${WINDOW}&limit=1&cursor=${pageOne.nextCursor}`,
    );
    const pageTwo = (await second.json()) as {
      events: { id: string; calendarId: string }[];
      nextCursor?: string;
    };
    expect(pageTwo.events.map((event) => [event.calendarId, event.id])).toEqual(
      [["cal-b", "e-1"]],
    );
    expect(pageTwo.nextCursor).toBeUndefined();
  });

  test("pages three equal-start events at size two: each id exactly once, cursor opaque", async () => {
    const at = "2026-03-08T09:00:00Z";
    const all = [
      providerEvent({ id: "e-a", start: at }),
      providerEvent({ id: "e-b", start: at }),
      providerEvent({ id: "e-c", start: at }),
    ];
    const { dial } = fakeDial(() => envelope({ events: all }));
    const app = calendarApp({ dial, connections: connectedUsers() });
    const first = await app.request(`/?${WINDOW}&limit=2`);
    const pageOne = (await first.json()) as {
      events: { id: string }[];
      nextCursor?: string;
    };
    // Id ASCENDING at equal starts: e-a, e-b on page one; e-c on page two.
    expect(pageOne.events.map((event) => event.id)).toEqual(["e-a", "e-b"]);
    expect(pageOne.nextCursor).toBeDefined();
    // Opaque: not the raw ids in clear text, and base64-decodable.
    expect(pageOne.nextCursor).not.toContain("e-b");
    expect(() =>
      JSON.parse(
        Buffer.from(pageOne.nextCursor as string, "base64").toString(),
      ),
    ).not.toThrow();

    const second = await app.request(
      `/?${WINDOW}&limit=2&cursor=${pageOne.nextCursor}`,
    );
    const pageTwo = (await second.json()) as {
      events: { id: string }[];
      nextCursor?: string;
    };
    expect(pageTwo.events.map((event) => event.id)).toEqual(["e-c"]);
    expect(pageTwo.nextCursor).toBeUndefined();
    const seen = [
      ...pageOne.events.map((event) => event.id),
      ...pageTwo.events.map((event) => event.id),
    ];
    expect(new Set(seen).size).toBe(3);
  });

  test("continues from a cursor that sits between two equal-start rows", async () => {
    const at = "2026-03-08T09:00:00Z";
    const rows = ["e-a", "e-b", "e-c", "e-d"].map((id) =>
      providerEvent({ id, start: at }),
    );
    const { dial } = fakeDial(() => envelope({ events: rows }));
    const app = calendarApp({ dial, connections: connectedUsers() });
    // A cursor id between e-b and e-c at the same start: strictly "after"
    // means a later start or a greater id — e-c then e-d, never e-b or e-a.
    const cursor = encodeCalendarCursor({
      owner: actorOne.id,
      alias: "openmuse-alias-one",
      start: at,
      // M11: the window is part of the cursor's binding.
      timeMin: "2026-03-01T00:00:00Z",
      timeMax: "2026-04-01T00:00:00Z",
      id: "e-bb",
      calendarId: "calendar-1",
    });
    const response = await app.request(`/?${WINDOW}&limit=10&cursor=${cursor}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      events: { id: string }[];
      nextCursor?: string;
    };
    expect(body.events.map((event) => event.id)).toEqual(["e-c", "e-d"]);
    expect(body.nextCursor).toBeUndefined();
  });

  test("defaults to 50 per page", async () => {
    const all = Array.from({ length: 60 }, (_, index) =>
      providerEvent({
        id: `e-${String(index).padStart(3, "0")}`,
        start: `2026-03-08T${String(index).padStart(2, "0")}:00:00Z`,
      }),
    );
    const { dial } = fakeDial(() => envelope({ events: all }));
    const response = await calendarApp({
      dial,
      connections: connectedUsers(),
    }).request(`/?${WINDOW}`);
    const body = (await response.json()) as {
      events: unknown[];
      nextCursor?: string;
    };
    expect(body.events).toHaveLength(50);
    expect(body.nextCursor).toBeDefined();
  });

  test("clamps limit 101 to 100", async () => {
    const all = Array.from({ length: 120 }, (_, index) =>
      providerEvent({
        id: `e-${String(index).padStart(3, "0")}`,
        start: `2026-03-${String((index % 31) + 1).padStart(2, "0")}T12:00:00Z`,
      }),
    );
    const { dial } = fakeDial(() => envelope({ events: all }));
    const response = await calendarApp({
      dial,
      connections: connectedUsers(),
    }).request(`/?${WINDOW}&limit=101`);
    const body = (await response.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(100);
  });

  test("rejects a limit that is not a positive integer", async () => {
    const { dial } = fakeDial(() => envelope({ events: [] }));
    const response = await calendarApp({
      dial,
      connections: connectedUsers(),
    }).request(`/?${WINDOW}&limit=abc`);
    expect(response.status).toBe(400);
  });

  test("the range is half-open: the event at timeMin is in, the event at timeMax is out", async () => {
    const timeMin = "2026-03-08T00:00:00Z";
    const timeMax = "2026-03-09T00:00:00Z";
    const events = [
      providerEvent({ id: "e-min", start: timeMin }),
      providerEvent({ id: "e-max", start: timeMax }),
      providerEvent({ id: "e-mid", start: "2026-03-08T12:00:00Z" }),
    ];
    /*
     * The fake applies the window the way the vendor's own events list is
     * RECORDED to (half-open [timeMin, timeMax), on the instant; O02
     * verifies the live dial answers the same edge): rows the provider
     * filters never reach the DTO, and the window reaches it verbatim.
     */
    const { calls, dial } = fakeDial((input) =>
      envelope({
        events: events.filter((event) => {
          const at = Date.parse(event.start);
          return (
            at >= Date.parse(input.timeMin as string) &&
            at < Date.parse(input.timeMax as string)
          );
        }),
      }),
    );
    const response = await calendarApp({
      dial,
      connections: connectedUsers(),
    }).request(`/?timeMin=${timeMin}&timeMax=${timeMax}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: { id: string }[] };
    expect(body.events.map((event) => event.id)).toEqual(["e-min", "e-mid"]);
    expect(calls[0].body).toEqual({ input: { timeMin, timeMax } });
  });

  test("serves a window of exactly 366 days and refuses a longer one", async () => {
    const { calls, dial } = fakeDial(() => envelope({ events: [] }));
    const app = calendarApp({ dial, connections: connectedUsers() });
    // Exactly 366 days: §4's ceiling, inclusive of the edge.
    const edge = await app.request(
      "/?timeMin=2026-03-01T00:00:00Z&timeMax=2027-03-02T00:00:00Z",
    );
    expect(edge.status).toBe(200);
    // One day past the ceiling answers 400 before any vendor call.
    const beyond = await app.request(
      "/?timeMin=2026-03-01T00:00:00Z&timeMax=2027-03-03T00:00:00Z",
    );
    expect(beyond.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  test("rejects a Date.parse-loose window that is not an RFC 3339 instant with 400", async () => {
    const { calls, dial } = fakeDial(() => envelope({ events: [] }));
    const app = calendarApp({ dial, connections: connectedUsers() });
    // Date.parse would accept both — the shape check must not, or the value
    // travels to the vendor and comes back as its 502, not this 400.
    const loose = await app.request(
      "/?timeMin=March 5, 2026&timeMax=2026-03-09T00:00:00Z",
    );
    expect(loose.status).toBe(400);
    const slashes = await app.request(
      "/?timeMin=2026/03/05T00:00:00Z&timeMax=2026-03-09T00:00:00Z",
    );
    expect(slashes.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("rejects missing or unparseable timeMin/timeMax with 400", async () => {
    const { calls, dial } = fakeDial(() => envelope({ events: [] }));
    const app = calendarApp({ dial, connections: connectedUsers() });
    // Both required: each missing on its own, then both.
    for (const query of [
      "/?timeMax=2026-03-09T00:00:00Z",
      "/?timeMin=2026-03-08T00:00:00Z",
      "/",
    ]) {
      const missing = await app.request(query);
      expect(missing.status).toBe(400);
    }
    // A string that is not an instant is a 400, not a provider guess.
    const unparseable = await app.request(
      "/?timeMin=whenever&timeMax=2026-03-09T00:00:00Z",
    );
    expect(unparseable.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("rejects an inverted range with 400", async () => {
    const { calls, dial } = fakeDial(() => envelope({ events: [] }));
    const response = await calendarApp({
      dial,
      connections: connectedUsers(),
    }).request("/?timeMin=2026-03-09T00:00:00Z&timeMax=2026-03-08T00:00:00Z");
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("answers a stable 409 when googlecalendar is not connected, without calling the vendor", async () => {
    const { calls, dial } = fakeDial(() => envelope({ events: [] }));
    // Gmail connected but calendar not: the G03 branch refuses (G03).
    const gmailOnly = new Map<string, StoredOpenMuseGoogleConnection>([
      [
        `${actorOne.id}:gmail`,
        connection(actorOne.id, "openmuse-alias-one", "gmail"),
      ],
    ]);
    const refused = await calendarApp({
      dial,
      connections: gmailOnly,
    }).request(`/?${WINDOW}`);
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: string; code: string };
    expect(body.code).toBe("connection_required");
    expect(calls).toHaveLength(0);

    // Nothing connected at all: the same stable refusal.
    const none = await calendarApp({
      dial,
      connections: new Map(),
    }).request(`/?${WINDOW}`);
    expect(none.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  test("rejects another user's cursor with 400", async () => {
    const at = "2026-03-08T09:00:00Z";
    const all = [
      providerEvent({ id: "e-a", start: at }),
      providerEvent({ id: "e-b", start: at }),
      providerEvent({ id: "e-c", start: at }),
    ];
    const { dial } = fakeDial(() => envelope({ events: all }));
    const app = calendarApp({ dial, connections: connectedUsers() });
    currentActor = actorOne;
    const first = await app.request(`/?${WINDOW}&limit=1`);
    const pageOne = (await first.json()) as { nextCursor: string };

    currentActor = actorTwo;
    const second = await app.request(
      `/?${WINDOW}&cursor=${pageOne.nextCursor}`,
    );
    expect(second.status).toBe(400);
    currentActor = actorOne;
  });

  test("rejects a cursor minted under a previous alias of the same owner with 400", async () => {
    const at = "2026-03-08T09:00:00Z";
    const rows = [
      providerEvent({ id: "e-a", start: at }),
      providerEvent({ id: "e-b", start: at }),
    ];
    const { dial } = fakeDial(() => envelope({ events: rows }));
    // Same owner, reconnected onto a fresh alias seat: the old cursor names a
    // connection that no longer holds this account's pages.
    const reconnected = new Map<string, StoredOpenMuseGoogleConnection>([
      [
        `${actorOne.id}:googlecalendar`,
        connection(actorOne.id, "openmuse-alias-newseat"),
      ],
    ]);
    const app = calendarApp({ dial, connections: reconnected });
    const cursor = encodeCalendarCursor({
      owner: actorOne.id,
      alias: "openmuse-alias-one",
      start: at,
      // M11: the window is part of the cursor's binding.
      timeMin: "2026-03-01T00:00:00Z",
      timeMax: "2026-04-01T00:00:00Z",
      id: "e-b",
      calendarId: "calendar-1",
    });
    const response = await app.request(`/?${WINDOW}&cursor=${cursor}`);
    expect(response.status).toBe(400);
  });

  test("rejects malformed cursors with 400", async () => {
    const { dial } = fakeDial(() => envelope({ events: [] }));
    const app = calendarApp({ dial, connections: connectedUsers() });
    // Not base64 at all.
    const malformed = await app.request(`/?${WINDOW}&cursor=%%%not-base64%%%`);
    expect(malformed.status).toBe(400);
    // Base64, but the inner shape is not a calendar cursor.
    const wrongShape = Buffer.from(
      JSON.stringify({ nope: true }),
      "utf8",
    ).toString("base64");
    const shaped = await app.request(`/?${WINDOW}&cursor=${wrongShape}`);
    expect(shaped.status).toBe(400);
  });

  test("surfaces provider truncation as truncated:true", async () => {
    const { dial } = fakeDial(() =>
      envelope({ events: [providerEvent()], truncated: true }),
    );
    const response = await calendarApp({
      dial,
      connections: connectedUsers(),
    }).request(`/?${WINDOW}`);
    const body = (await response.json()) as {
      events: unknown[];
      truncated: boolean;
      nextCursor?: string;
    };
    expect(body.events).toHaveLength(1);
    expect(body.truncated).toBe(true);
  });

  test("stitches provider token pages with no gaps or duplicates and propagates truncation", async () => {
    const at = "2026-03-08T09:00:00Z";
    const row = (id: string) => providerEvent({ id, start: at });
    // The provider pages by its own token, out of DTO order, with the
    // truncation flag on its last page. Request input carries `pageToken`;
    // the answer carries `nextToken` when more pages are held back.
    const providerPages = new Map<
      string,
      { events: unknown[]; nextToken?: string; truncated?: boolean }
    >([
      ["", { events: [row("e-c"), row("e-a")], nextToken: "pt-1" }],
      ["pt-1", { events: [row("e-e"), row("e-b")], nextToken: "pt-2" }],
      ["pt-2", { events: [row("e-d")], truncated: true }],
    ]);
    const calls: RecordedCall[] = [];
    const dial: CalendarWireDial = async (path, init) => {
      calls.push({ path, headers: init.headers, body: init.body });
      const input =
        (init.body as { input?: { pageToken?: string } }).input ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => envelope(providerPages.get(input.pageToken ?? "")),
      };
    };
    const app = calendarApp({ dial, connections: connectedUsers() });

    // Page one: one provider page cannot fill limit 2 plus the surplus that
    // proves a cursor is warranted, so the stitch dials on before answering.
    const first = await app.request(`/?${WINDOW}&limit=2`);
    const pageOne = (await first.json()) as {
      events: { id: string }[];
      truncated: boolean;
      nextCursor?: string;
    };
    expect(pageOne.events.map((event) => event.id)).toEqual(["e-a", "e-b"]);
    expect(pageOne.truncated).toBe(false);
    expect(calls.map((call) => call.body)).toEqual([
      {
        input: {
          timeMin: "2026-03-01T00:00:00Z",
          timeMax: "2026-04-01T00:00:00Z",
        },
      },
      {
        input: {
          timeMin: "2026-03-01T00:00:00Z",
          timeMax: "2026-04-01T00:00:00Z",
          pageToken: "pt-1",
        },
      },
    ]);

    const second = await app.request(
      `/?${WINDOW}&limit=2&cursor=${pageOne.nextCursor}`,
    );
    const pageTwo = (await second.json()) as {
      events: { id: string }[];
      truncated: boolean;
      nextCursor?: string;
    };
    expect(pageTwo.events.map((event) => event.id)).toEqual(["e-c", "e-d"]);

    const third = await app.request(
      `/?${WINDOW}&limit=2&cursor=${pageTwo.nextCursor}`,
    );
    const pageThree = (await third.json()) as {
      events: { id: string }[];
      truncated: boolean;
      nextCursor?: string;
    };
    expect(pageThree.events.map((event) => event.id)).toEqual(["e-e"]);
    expect(pageThree.nextCursor).toBeUndefined();
    // The provider's truncation flag, read off the final page of the stitch.
    expect(pageThree.truncated).toBe(true);

    const seen = [
      ...pageOne.events,
      ...pageTwo.events,
      ...pageThree.events,
    ].map((event) => event.id);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  test("the outbound cursor carries the provider resume token, and the next page walks from it", async () => {
    const at = "2026-03-08T09:00:00Z";
    const row = (id: string) => providerEvent({ id, start: at });
    const providerPages = new Map<
      string,
      { events: unknown[]; nextToken?: string }
    >([
      ["", { events: [row("e-a"), row("e-b")], nextToken: "pt-1" }],
      ["pt-1", { events: [row("e-c"), row("e-d")], nextToken: "pt-2" }],
      ["pt-2", { events: [row("e-e")] }],
    ]);
    const calls: RecordedCall[] = [];
    const dial: CalendarWireDial = async (path, init) => {
      calls.push({ path, headers: init.headers, body: init.body });
      const input =
        (init.body as { input?: { pageToken?: string } }).input ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => envelope(providerPages.get(input.pageToken ?? "")),
      };
    };
    const app = calendarApp({ dial, connections: connectedUsers() });

    // Page one ships e-a, e-b; the unshipped rows live on pt-1, so the
    // cursor's provider token is pt-1 — NOT a from-scratch re-walk.
    const first = await app.request(`/?${WINDOW}&limit=2`);
    const pageOne = (await first.json()) as {
      events: { id: string }[];
      nextCursor?: string;
    };
    expect(pageOne.events.map((event) => event.id)).toEqual(["e-a", "e-b"]);
    const decoded = JSON.parse(
      Buffer.from(pageOne.nextCursor as string, "base64").toString(),
    ) as { providerToken: string | null };
    expect(decoded.providerToken).toBe("pt-1");

    calls.length = 0;
    const second = await app.request(
      `/?${WINDOW}&limit=2&cursor=${pageOne.nextCursor}`,
    );
    const pageTwo = (await second.json()) as { events: { id: string }[] };
    expect(pageTwo.events.map((event) => event.id)).toEqual(["e-c", "e-d"]);
    // The resumed walk STARTS at the recorded token: the first dial is
    // pt-1, never the provider's first page again.
    expect(calls[0]?.body).toMatchObject({
      input: {
        timeMin: "2026-03-01T00:00:00Z",
        timeMax: "2026-04-01T00:00:00Z",
        pageToken: "pt-1",
      },
    });
  });

  test("truncation accumulates across stitched pages: an early held-back page stays visible", async () => {
    const at = "2026-03-08T09:00:00Z";
    const row = (id: string) => providerEvent({ id, start: at });
    const providerPages = new Map<
      string,
      { events: unknown[]; nextToken?: string; truncated?: boolean }
    >([
      [
        "",
        {
          events: [row("e-c"), row("e-a")],
          nextToken: "pt-1",
          truncated: true,
        },
      ],
      ["pt-1", { events: [row("e-e"), row("e-b")], nextToken: "pt-2" }],
      ["pt-2", { events: [row("e-d")], truncated: false }],
    ]);
    const dial: CalendarWireDial = async (_path, init) => {
      const input =
        (init.body as { input?: { pageToken?: string } }).input ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => envelope(providerPages.get(input.pageToken ?? "")),
      };
    };
    const app = calendarApp({ dial, connections: connectedUsers() });
    const response = await app.request(`/?${WINDOW}&limit=2`);
    const body = (await response.json()) as {
      truncated: boolean;
      nextCursor?: string;
    };
    expect(body.truncated).toBe(true);
    expect(body.nextCursor).toBeDefined();
  });

  test("an involuntary stop tells the truth: a repeating vendor token never reads as a clean end", async () => {
    const at = "2026-03-08T09:00:00Z";
    const looping = new Map<string, { events: unknown[]; nextToken?: string }>([
      [
        "",
        {
          events: [providerEvent({ id: "e-a", start: at })],
          nextToken: "pt-loop",
        },
      ],
      ["pt-loop", { events: [], nextToken: "pt-loop" }],
    ]);
    const dial: CalendarWireDial = async (_path, init) => {
      const input =
        (init.body as { input?: { pageToken?: string } }).input ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => envelope(looping.get(input.pageToken ?? "")),
      };
    };
    const app = calendarApp({ dial, connections: connectedUsers() });
    const response = await app.request(`/?${WINDOW}&limit=5`);
    const body = (await response.json()) as {
      events: unknown[];
      truncated: boolean;
      nextCursor?: string;
    };
    expect(body.events).toHaveLength(1);
    expect(body.truncated).toBe(true);
    // Round 6 (M12): an involuntary stop keeps its position — the truncated
    // response always carries a resumable cursor now, so the client resumes
    // from the keyset instead of restarting the walk into the same ring.
    expect(body.nextCursor).toBeDefined();
  });

  test("an EMPTY page under an involuntary stop still states the inbound resume position (round 6 M10)", async () => {
    const at = "2026-03-08T09:00:00Z";
    // First page ships one event and a surplus-less stop? No — page one fills
    // the limit, page two (the cursor walk) hits a token ring immediately
    // and every fetched row sorts at-or-before the cursor: an empty page
    // under stoppedShort.
    const looping = new Map<string, { events: unknown[]; nextToken?: string }>([
      [
        "",
        {
          events: [
            providerEvent({ id: "e-a", start: at }),
            providerEvent({ id: "e-b", start: at }),
            providerEvent({ id: "e-c", start: at }),
          ],
          nextToken: "pt-loop",
        },
      ],
      // The ring page re-serves only rows at-or-before the outbound cursor:
      // every fetched row sorts out of the keyset, so the page is EMPTY.
      [
        "pt-loop",
        {
          events: [providerEvent({ id: "e-a", start: at })],
          nextToken: "pt-loop",
        },
      ],
    ]);
    const dial: CalendarWireDial = async (_path, init) => {
      const input =
        (init.body as { input?: { pageToken?: string } }).input ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => envelope(looping.get(input.pageToken ?? "")),
      };
    };
    const app = calendarApp({ dial, connections: connectedUsers() });
    const first = await app.request(`/?${WINDOW}&limit=3`);
    const pageOne = (await first.json()) as { nextCursor?: string };
    expect(pageOne.nextCursor).toBeDefined();

    const second = await app.request(
      `/?${WINDOW}&limit=3&cursor=${pageOne.nextCursor}`,
    );
    const body = (await second.json()) as {
      events: unknown[];
      truncated: boolean;
      nextCursor?: string;
    };
    // The empty capped page has no `last`, but the inbound cursor's own
    // position rides out: the client keeps its place instead of losing it.
    expect(body.events).toHaveLength(0);
    expect(body.truncated).toBe(true);
    expect(body.nextCursor).toBeDefined();
    const decoded = decodeCalendarCursor(body.nextCursor ?? "");
    expect(decoded?.id).toBe("e-c");
    expect(decoded?.providerToken).toBe("pt-loop");
  });

  test("a cursor reused against a different window refuses with 400 (round 6 M11)", async () => {
    const at = "2026-03-08T09:00:00Z";
    const { dial } = fakeDial(() =>
      envelope({
        events: [
          providerEvent({ id: "e-a", start: at }),
          providerEvent({ id: "e-b", start: at }),
        ],
      }),
    );
    const app = calendarApp({ dial, connections: connectedUsers() });
    const first = await app.request(`/?${WINDOW}&limit=1`);
    const pageOne = (await first.json()) as { nextCursor?: string };
    expect(pageOne.nextCursor).toBeDefined();
    // Same owner, same alias — but a shifted window: the keyset position and
    // the provider token are window-shaped, so reuse must refuse, not page
    // from the old window's position.
    const shifted =
      "timeMin=2026-03-02T00%3A00%3A00Z&timeMax=2026-04-01T00%3A00%3A00Z";
    const response = await app.request(
      `/?${shifted}&limit=1&cursor=${pageOne.nextCursor}`,
    );
    expect(response.status).toBe(400);
  });

  test("the stitch stops at its total time budget and answers a resumable cursor", async () => {
    const at = "2026-03-08T09:00:00Z";
    // Sparse pages — one event each — so the walk only stops by budget, not
    // surplus.
    const providerPages = new Map<
      string,
      { events: unknown[]; nextToken?: string }
    >([
      [
        "",
        {
          events: [providerEvent({ id: "e-a", start: at })],
          nextToken: "pt-1",
        },
      ],
      [
        "pt-1",
        {
          events: [providerEvent({ id: "e-b", start: at })],
          nextToken: "pt-2",
        },
      ],
      ["pt-2", { events: [providerEvent({ id: "e-c", start: at })] }],
    ]);
    const calls: RecordedCall[] = [];
    const dial: CalendarWireDial = async (path, init) => {
      calls.push({ path, headers: init.headers, body: init.body });
      const input =
        (init.body as { input?: { pageToken?: string } }).input ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => envelope(providerPages.get(input.pageToken ?? "")),
      };
    };
    const app = calendarApp({ dial, connections: connectedUsers() });
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => (clock += 40_000);
    try {
      const response = await app.request(`/?${WINDOW}&limit=10`);
      const body = (await response.json()) as {
        events: unknown[];
        truncated: boolean;
        nextCursor?: string;
      };
      expect(body.events).toHaveLength(1);
      expect(body.truncated).toBe(true);
      expect(body.nextCursor).toBeDefined();
      expect(calls).toHaveLength(1);
    } finally {
      Date.now = realNow;
    }
  });

  test("clamps limit 101 to 100 while stitching provider pages", async () => {
    const at = Date.parse("2026-03-08T09:00:00Z");
    const page = (index: number) =>
      Array.from({ length: 40 }, (_, offset) => {
        const row = index * 40 + offset;
        return providerEvent({
          id: `e-${String(row).padStart(3, "0")}`,
          start: new Date(at + row * 60_000).toISOString(),
        });
      });
    const providerPages = new Map<
      string,
      { events: unknown[]; nextToken?: string }
    >([
      ["", { events: page(0), nextToken: "pt-1" }],
      ["pt-1", { events: page(1), nextToken: "pt-2" }],
      ["pt-2", { events: page(2), nextToken: "pt-3" }],
      ["pt-3", { events: page(3) }],
    ]);
    const calls: RecordedCall[] = [];
    const dial: CalendarWireDial = async (path, init) => {
      calls.push({ path, headers: init.headers, body: init.body });
      const input =
        (init.body as { input?: { pageToken?: string } }).input ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => envelope(providerPages.get(input.pageToken ?? "")),
      };
    };
    const response = await calendarApp({
      dial,
      connections: connectedUsers(),
    }).request(`/?${WINDOW}&limit=101`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(100);
    // Three provider pages reach 120 rows — surplus past the clamp — so the
    // fourth page is never dialed.
    expect(calls).toHaveLength(3);
  });

  test("answers 403 for a disabled owner without calling the vendor (§9)", async () => {
    const { calls, dial } = fakeDial(() => envelope({ events: [] }));
    const response = await calendarApp({
      dial,
      connections: connectedUsers(),
      ownerDisabled: async (userId) => userId === actorOne.id,
    }).request(`/?${WINDOW}`);
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("answers 502 with no events when the vendor fails", async () => {
    const { dial } = fakeDial(() => ({ message: "vendor exploded" }), false);
    const response = await calendarApp({
      dial,
      connections: connectedUsers(),
    }).request(`/?${WINDOW}`);
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.events).toBeUndefined();
    expect(typeof body.error).toBe("string");
  });

  test("dials with the requesting user's own alias, never another's", async () => {
    const { calls, dial } = fakeDial(() => envelope({ events: [] }));
    currentActor = actorTwo;
    const response = await calendarApp({
      dial,
      connections: connectedUsers(),
    }).request(`/?${WINDOW}`);
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["x-oo-connector-alias"]).toBe("openmuse-alias-two");
    currentActor = actorOne;
  });
});

describe("the calendar transport layer (createOpenMuseCalendarClient)", () => {
  test("an https OPENCONNECTOR_URL constructs — the scheme check compares the URL protocol, colon included", () => {
    // Regression: the check once compared against "https://" (with slashes),
    // a string URL.protocol never equals, so every https deployment refused
    // to build its calendar client and reads answered 503 forever.
    expect(() =>
      createOpenMuseCalendarClient({ url: "https://openconnector.example" }),
    ).not.toThrow();
    expect(() =>
      createOpenMuseCalendarClient({ url: "http://localhost:3000" }),
    ).not.toThrow();
    expect(() =>
      createOpenMuseCalendarClient({ url: "ftp://openconnector.example" }),
    ).toThrow(/scheme/);
  });
});
