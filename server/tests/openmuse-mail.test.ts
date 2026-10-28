import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  OpenMuseConnectionRefusedError,
  type OpenMuseGoogleOAuth,
} from "../src/openmuse-connectors/google-oauth";
import type { StoredOpenMuseGoogleConnection } from "../src/openmuse-connectors/store";
import {
  buildOpenMuseMailClient,
  type MailWireDial,
} from "../src/openmuse-mail/client";
import { decodeMailCursor, encodeMailCursor } from "../src/openmuse-mail/mail";
import {
  ATTACHMENT_MAX_BYTES,
  createOpenMuseMailRoutes,
} from "../src/openmuse-mail/routes";

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

/** The connection row a connected owner's guard answers — alias is what the dial must send. */
function connection(
  userId: string,
  alias: string,
  status: StoredOpenMuseGoogleConnection["status"] = "connected",
): StoredOpenMuseGoogleConnection {
  return {
    id: `conn-${userId}`,
    userId,
    provider: "gmail",
    accountEmail: `${userId}@gmail.test`,
    status,
    grantedScopes: ["gmail.readonly"],
    generation: 1,
    alias,
    connectedAt: new Date("2026-10-01T00:00:00Z"),
  };
}

/** The requireConnection seam M01 borrows from G01: connected row or the stable 409 refusal. */
function fakeGuard(
  connections: Map<string, StoredOpenMuseGoogleConnection>,
): Pick<OpenMuseGoogleOAuth, "requireConnection"> {
  return {
    async requireConnection(userId, provider) {
      const row = connections.get(userId);
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

/** One fake wire answering the scripted payload on every call, recording what was sent. */
function fakeDial(answer: () => unknown, ok = true) {
  const calls: RecordedCall[] = [];
  const dial: MailWireDial = async (path, init) => {
    calls.push({ path, headers: init.headers, body: init.body });
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => answer(),
    };
  };
  return { calls, dial };
}

function providerMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    threadId: "thread-1",
    from: "sender@example.test",
    to: ["reader@example.test"],
    subject: "Quarterly report",
    bodyText: "The numbers are attached.",
    receivedAt: 1760000000000,
    unread: true,
    labels: ["INBOX", "UNREAD"],
    attachments: [
      {
        id: "att-1",
        name: "report.pdf",
        mimeType: "application/pdf",
        size: 1024,
      },
    ],
    ...overrides,
  };
}

/** The runtime face's envelope, as the real dial would deliver it to the client. */
const envelope = (data: unknown) => ({ data });

function mailApp(input: {
  dial: MailWireDial;
  connections: Map<string, StoredOpenMuseGoogleConnection>;
  ownerDisabled?: (userId: string) => Promise<boolean>;
}) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createOpenMuseMailRoutes({
      client: buildOpenMuseMailClient({ dial: input.dial }),
      service: fakeGuard(input.connections),
      requireUser,
      ownerDisabled: input.ownerDisabled,
    }),
  );
  return app;
}

function connectedUsers() {
  return new Map<string, StoredOpenMuseGoogleConnection>([
    [actorOne.id, connection(actorOne.id, "openmuse-alias-one")],
    [actorTwo.id, connection(actorTwo.id, "openmuse-alias-two")],
  ]);
}

describe("GET /api/mobile/openmuse-mail", () => {
  /*
   * Round 6 (M28): the dial's own transport failure (connection refused, the
   * seam's 30s timeout) is a NAMED vendor failure — 502 with the monitor log
   * entry a JSON failure already gets — not the generic 503 it used to fall
   * into, indistinguishable from an unconfigured OPENCONNECTOR_URL.
   */
  test("a transport-level dial failure answers 502 as a named vendor failure", async () => {
    const dial: MailWireDial = async () => {
      throw new TypeError("connect ECONNREFUSED");
    };
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request("/");
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("could not be reached");
  });

  test("a sparse vendor page drops its null rows instead of 500ing the whole list (M29)", async () => {
    const dial: MailWireDial = async () => ({
      ok: true,
      status: 200,
      json: async () =>
        envelope({
          messages: [providerMessage({ id: "m-real" }), null],
          truncated: false,
          nextToken: null,
        }),
    });
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request("/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: Array<{ id: string }>;
    };
    expect(body.messages.map((message) => message.id)).toEqual(["m-real"]);
  });

  test("maps the provider payload to the §4 DTO and drops extra provider fields", async () => {
    const { calls, dial } = fakeDial(() =>
      envelope({
        messages: [
          providerMessage({
            snippet: "provider-only field",
            historyId: 42,
            attachments: [
              {
                id: "att-1",
                name: "report.pdf",
                mimeType: "application/pdf",
                size: 1024,
                data: "should not cross",
              },
            ],
          }),
        ],
      }),
    );
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request("/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: unknown[];
      truncated: boolean;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toEqual({
      id: "msg-1",
      threadId: "thread-1",
      from: "sender@example.test",
      to: ["reader@example.test"],
      subject: "Quarterly report",
      bodyText: "The numbers are attached.",
      receivedAt: new Date(1760000000000).toISOString(),
      unread: true,
      labels: ["INBOX", "UNREAD"],
      attachments: [
        {
          id: "att-1",
          name: "report.pdf",
          mimeType: "application/pdf",
          size: 1024,
        },
      ],
    });
    expect(calls).toHaveLength(1);
  });

  test("orders newest receivedAt first with id descending as the tiebreak", async () => {
    const at = 1760000000000;
    const { dial } = fakeDial(() =>
      envelope({
        messages: [
          providerMessage({ id: "m-b", receivedAt: at }),
          providerMessage({ id: "m-c", receivedAt: at - 1000 }),
          providerMessage({ id: "m-a", receivedAt: at }),
        ],
      }),
    );
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request("/");
    const body = (await response.json()) as { messages: { id: string }[] };
    // Equal timestamps tiebreak on id DESCENDING (m-b before m-a), then the
    // older m-c trails: the §4 order.
    expect(body.messages.map((message) => message.id)).toEqual([
      "m-b",
      "m-a",
      "m-c",
    ]);
  });

  test("pages three equal-timestamp messages at size two: each id exactly once, cursor opaque", async () => {
    const at = 1760000000000;
    const all = [
      providerMessage({ id: "m-a", receivedAt: at }),
      providerMessage({ id: "m-b", receivedAt: at }),
      providerMessage({ id: "m-c", receivedAt: at }),
    ];
    const { dial } = fakeDial(() => envelope({ messages: all }));
    const app = mailApp({ dial, connections: connectedUsers() });
    const first = await app.request("/?limit=2");
    const pageOne = (await first.json()) as {
      messages: { id: string }[];
      nextCursor?: string;
    };
    // Id DESCENDING at equal timestamps: m-c, m-b on page one; m-a on page two.
    expect(pageOne.messages.map((message) => message.id)).toEqual([
      "m-c",
      "m-b",
    ]);
    expect(pageOne.nextCursor).toBeDefined();
    // Opaque: not the raw ids in clear text, and base64-decodable.
    expect(pageOne.nextCursor).not.toContain("m-a");
    expect(() =>
      JSON.parse(
        Buffer.from(pageOne.nextCursor as string, "base64").toString(),
      ),
    ).not.toThrow();

    const second = await app.request(`/?limit=2&cursor=${pageOne.nextCursor}`);
    const pageTwo = (await second.json()) as {
      messages: { id: string }[];
      nextCursor?: string;
    };
    expect(pageTwo.messages.map((message) => message.id)).toEqual(["m-a"]);
    expect(pageTwo.nextCursor).toBeUndefined();
    const seen = [
      ...pageOne.messages.map((message) => message.id),
      ...pageTwo.messages.map((message) => message.id),
    ];
    expect(new Set(seen).size).toBe(3);
  });

  test("rejects another user's cursor with 400", async () => {
    const at = 1760000000000;
    const all = [
      providerMessage({ id: "m-a", receivedAt: at }),
      providerMessage({ id: "m-b", receivedAt: at }),
      providerMessage({ id: "m-c", receivedAt: at }),
    ];
    const { dial } = fakeDial(() => envelope({ messages: all }));
    const app = mailApp({ dial, connections: connectedUsers() });
    currentActor = actorOne;
    const first = await app.request("/?limit=1");
    const pageOne = (await first.json()) as { nextCursor: string };

    currentActor = actorTwo;
    const second = await app.request(`/?cursor=${pageOne.nextCursor}`);
    expect(second.status).toBe(400);
    currentActor = actorOne;
  });

  test("defaults to 25 per page", async () => {
    const at = 1760000000000;
    const all = Array.from({ length: 30 }, (_, index) =>
      providerMessage({
        id: `m-${String(index).padStart(3, "0")}`,
        receivedAt: at - index,
      }),
    );
    const { dial } = fakeDial(() => envelope({ messages: all }));
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request("/");
    const body = (await response.json()) as {
      messages: { id: string }[];
      nextCursor?: string;
    };
    expect(body.messages).toHaveLength(25);
    expect(body.nextCursor).toBeDefined();
  });

  test("clamps limit 101 to 100", async () => {
    const at = 1760000000000;
    const all = Array.from({ length: 120 }, (_, index) =>
      providerMessage({
        id: `m-${String(index).padStart(3, "0")}`,
        receivedAt: at - index,
      }),
    );
    const { dial } = fakeDial(() => envelope({ messages: all }));
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request("/?limit=101");
    const body = (await response.json()) as { messages: unknown[] };
    expect(body.messages).toHaveLength(100);
  });

  test("continues from a cursor that sits between two equal-timestamp rows", async () => {
    const at = 1760000000000;
    const rows = ["m-a", "m-b", "m-c", "m-d"].map((id) =>
      providerMessage({ id, receivedAt: at }),
    );
    const { dial } = fakeDial(() => envelope({ messages: rows }));
    const app = mailApp({ dial, connections: connectedUsers() });
    // A cursor id between m-b and m-c at the same timestamp: strictly "after"
    // means older or smaller id — m-b then m-a, never m-c or m-d again.
    const cursor = encodeMailCursor({
      owner: actorOne.id,
      alias: "openmuse-alias-one",
      receivedAt: at,
      id: "m-bb",
    });
    const response = await app.request(`/?limit=10&cursor=${cursor}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: { id: string }[];
      nextCursor?: string;
    };
    expect(body.messages.map((message) => message.id)).toEqual(["m-b", "m-a"]);
    expect(body.nextCursor).toBeUndefined();
  });

  test("rejects malformed cursors with 400", async () => {
    const { dial } = fakeDial(() => envelope({ messages: [] }));
    const app = mailApp({ dial, connections: connectedUsers() });
    // Not base64 at all.
    const malformed = await app.request("/?cursor=%%%not-base64%%%");
    expect(malformed.status).toBe(400);
    // Base64, but the inner shape is not a mail cursor.
    const wrongShape = Buffer.from(
      JSON.stringify({ nope: true }),
      "utf8",
    ).toString("base64");
    const shaped = await app.request(`/?cursor=${wrongShape}`);
    expect(shaped.status).toBe(400);
  });

  test("the cursor alphabet is URL-safe: no +, / or = survives the query round trip, and legacy cursors still decode", async () => {
    const cursor = {
      owner: actorOne.id,
      alias: "openmuse-alias-one",
      receivedAt: 1760000000000,
      id: "m-b",
      providerToken: "pt+/==",
    };
    const encoded = encodeMailCursor(cursor);
    // The value travels as a query parameter: `+` would arrive as a space
    // under form-urlencoded semantics and shift every following bit.
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeMailCursor(encoded)).toEqual({
      ...cursor,
      query: null,
      providerToken: "pt+/==",
    });
    // Backwards compatibility: a cursor minted with the standard alphabet
    // (pre-fix) still decodes — the decoder is lenient across both, and a
    // cursor minted before the query binding existed reads as null.
    const legacy = Buffer.from(JSON.stringify(cursor), "utf8").toString(
      "base64",
    );
    expect(decodeMailCursor(legacy)).toEqual({ ...cursor, query: null });
  });

  test("rejects a search cursor replayed against a different query with 400", async () => {
    const at = 1760000000000;
    const rows = [
      providerMessage({ id: "m-a", receivedAt: at }),
      providerMessage({ id: "m-b", receivedAt: at }),
      providerMessage({ id: "m-c", receivedAt: at }),
    ];
    const { dial } = fakeDial(() => envelope({ messages: rows }));
    const app = mailApp({ dial, connections: connectedUsers() });
    const first = await app.request("/?q=invoice&limit=1");
    const pageOne = (await first.json()) as { nextCursor: string };
    expect(pageOne.nextCursor).toBeDefined();

    // The page walk belongs to the query that started it: replaying it
    // against a different q (or none) must refuse, not silently continue
    // one result set's token inside another's walk.
    const other = await app.request(
      `/?q=receipt&limit=1&cursor=${pageOne.nextCursor}`,
    );
    expect(other.status).toBe(400);
    const plain = await app.request(`/?limit=1&cursor=${pageOne.nextCursor}`);
    expect(plain.status).toBe(400);
    // The query it was minted under still resumes.
    const same = await app.request(
      `/?q=invoice&limit=1&cursor=${pageOne.nextCursor}`,
    );
    expect(same.status).toBe(200);
  });

  test("truncation accumulates across stitched pages: an early held-back page stays visible", async () => {
    const at = 1760000000000;
    const row = (id: string) => providerMessage({ id, receivedAt: at });
    const providerPages = new Map<
      string,
      { messages: unknown[]; nextToken?: string; truncated?: boolean }
    >([
      [
        "",
        {
          messages: [row("m-e"), row("m-c")],
          nextToken: "pt-1",
          truncated: true,
        },
      ],
      ["pt-1", { messages: [row("m-a"), row("m-d")], nextToken: "pt-2" }],
      ["pt-2", { messages: [row("m-b")], truncated: false }],
    ]);
    const dial: MailWireDial = async (_path, init) => {
      const input =
        (init.body as { input?: { pageToken?: string } }).input ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => envelope(providerPages.get(input.pageToken ?? "")),
      };
    };
    const app = mailApp({ dial, connections: connectedUsers() });
    const response = await app.request("/?limit=2");
    const body = (await response.json()) as {
      truncated: boolean;
      nextCursor?: string;
    };
    // The first page's vendor-held rows must not be erased by the last
    // page's clean flag.
    expect(body.truncated).toBe(true);
    expect(body.nextCursor).toBeDefined();
  });

  test("an involuntary stop tells the truth: a repeating token or the page cap never reads as a clean end", async () => {
    const at = 1760000000000;
    // A vendor that loops its own token: page one repeats forever.
    const looping = new Map<
      string,
      { messages: unknown[]; nextToken?: string }
    >([
      [
        "",
        {
          messages: [providerMessage({ id: "m-a", receivedAt: at })],
          nextToken: "pt-loop",
        },
      ],
      ["pt-loop", { messages: [], nextToken: "pt-loop" }],
    ]);
    const dial: MailWireDial = async (_path, init) => {
      const input =
        (init.body as { input?: { pageToken?: string } }).input ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => envelope(looping.get(input.pageToken ?? "")),
      };
    };
    const app = mailApp({ dial, connections: connectedUsers() });
    const response = await app.request("/?limit=5");
    const body = (await response.json()) as {
      messages: unknown[];
      truncated: boolean;
      nextCursor?: string;
    };
    expect(body.messages).toHaveLength(1);
    // The walk was cut by the vendor's loop, not finished: truncated stays
    // on even though no page said so and no page is left to resume.
    expect(body.truncated).toBe(true);
    expect(body.nextCursor).toBeUndefined();
  });

  test("the stitch stops at its total time budget and answers a resumable cursor", async () => {
    const at = 1760000000000;
    // Sparse pages — one row each — so the walk only stops by budget, not
    // surplus.
    const providerPages = new Map<
      string,
      { messages: unknown[]; nextToken?: string }
    >([
      [
        "",
        {
          messages: [providerMessage({ id: "m-a", receivedAt: at })],
          nextToken: "pt-1",
        },
      ],
      [
        "pt-1",
        {
          messages: [providerMessage({ id: "m-b", receivedAt: at })],
          nextToken: "pt-2",
        },
      ],
      ["pt-2", { messages: [providerMessage({ id: "m-c", receivedAt: at })] }],
    ]);
    const calls: RecordedCall[] = [];
    const dial: MailWireDial = async (path, init) => {
      calls.push({ path, headers: init.headers, body: init.body });
      const input =
        (init.body as { input?: { pageToken?: string } }).input ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => envelope(providerPages.get(input.pageToken ?? "")),
      };
    };
    const app = mailApp({ dial, connections: connectedUsers() });
    // A clock that outruns the budget on the second loop check, the way a
    // slow-but-valid vendor would across real dials.
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => (clock += 40_000);
    try {
      const response = await app.request("/?limit=10");
      const body = (await response.json()) as {
        messages: unknown[];
        truncated: boolean;
        nextCursor?: string;
      };
      expect(body.messages).toHaveLength(1);
      expect(body.truncated).toBe(true);
      expect(body.nextCursor).toBeDefined();
      // One page, then the budget stops the walk: never the full 100 dials.
      expect(calls).toHaveLength(1);
    } finally {
      Date.now = realNow;
    }
  });

  test("answers 403 for a disabled owner on the list route without calling the vendor (§9)", async () => {
    const { calls, dial } = fakeDial(() => envelope({ messages: [] }));
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
      ownerDisabled: async (userId) => userId === actorOne.id,
    }).request("/");
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("rejects a cursor minted under a previous alias of the same owner with 400", async () => {
    const at = 1760000000000;
    const rows = [
      providerMessage({ id: "m-a", receivedAt: at }),
      providerMessage({ id: "m-b", receivedAt: at }),
    ];
    const { dial } = fakeDial(() => envelope({ messages: rows }));
    // Same owner, reconnected onto a fresh alias seat: the old cursor names a
    // connection that no longer holds this account's pages.
    const reconnected = new Map<string, StoredOpenMuseGoogleConnection>([
      [actorOne.id, connection(actorOne.id, "openmuse-alias-newseat")],
    ]);
    const app = mailApp({ dial, connections: reconnected });
    const cursor = encodeMailCursor({
      owner: actorOne.id,
      alias: "openmuse-alias-one",
      receivedAt: at,
      id: "m-b",
    });
    const response = await app.request(`/?cursor=${cursor}`);
    expect(response.status).toBe(400);
  });

  test("stitches provider token pages with no gaps or duplicates and propagates truncation", async () => {
    const at = 1760000000000;
    const row = (id: string) => providerMessage({ id, receivedAt: at });
    // The provider pages by its own token, out of DTO order, with the
    // truncation flag on its last page. Request input carries `pageToken`;
    // the answer carries `nextToken` when more pages are held back.
    const providerPages = new Map<
      string,
      { messages: unknown[]; nextToken?: string; truncated?: boolean }
    >([
      ["", { messages: [row("m-e"), row("m-c")], nextToken: "pt-1" }],
      ["pt-1", { messages: [row("m-a"), row("m-d")], nextToken: "pt-2" }],
      ["pt-2", { messages: [row("m-b")], truncated: true }],
    ]);
    const calls: RecordedCall[] = [];
    const dial: MailWireDial = async (path, init) => {
      calls.push({ path, headers: init.headers, body: init.body });
      const input =
        (init.body as { input?: { pageToken?: string } }).input ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => envelope(providerPages.get(input.pageToken ?? "")),
      };
    };
    const app = mailApp({ dial, connections: connectedUsers() });

    // Page one: one provider page cannot fill limit 2 plus the surplus that
    // proves a cursor is warranted, so the stitch dials on before answering.
    const first = await app.request("/?limit=2");
    const pageOne = (await first.json()) as {
      messages: { id: string }[];
      truncated: boolean;
      nextCursor?: string;
    };
    expect(pageOne.messages.map((message) => message.id)).toEqual([
      "m-e",
      "m-d",
    ]);
    expect(pageOne.truncated).toBe(false);
    expect(calls.map((call) => call.body)).toEqual([
      { input: {} },
      { input: { pageToken: "pt-1" } },
    ]);

    const second = await app.request(`/?limit=2&cursor=${pageOne.nextCursor}`);
    const pageTwo = (await second.json()) as {
      messages: { id: string }[];
      truncated: boolean;
      nextCursor?: string;
    };
    expect(pageTwo.messages.map((message) => message.id)).toEqual([
      "m-c",
      "m-b",
    ]);
    // The provider's truncation flag, read off the final page of the stitch.
    expect(pageTwo.truncated).toBe(true);

    const third = await app.request(`/?limit=2&cursor=${pageTwo.nextCursor}`);
    const pageThree = (await third.json()) as {
      messages: { id: string }[];
      truncated: boolean;
      nextCursor?: string;
    };
    expect(pageThree.messages.map((message) => message.id)).toEqual(["m-a"]);
    expect(pageThree.nextCursor).toBeUndefined();
    expect(pageThree.truncated).toBe(true);

    const seen = [
      ...pageOne.messages,
      ...pageTwo.messages,
      ...pageThree.messages,
    ].map((message) => message.id);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  test("clamps limit 101 to 100 while stitching provider pages", async () => {
    const at = 1760000000000;
    const page = (index: number) =>
      Array.from({ length: 40 }, (_, offset) =>
        providerMessage({
          id: `m-${String(index * 40 + offset).padStart(3, "0")}`,
          receivedAt: at - (index * 40 + offset),
        }),
      );
    const providerPages = new Map<
      string,
      { messages: unknown[]; nextToken?: string }
    >([
      ["", { messages: page(0), nextToken: "pt-1" }],
      ["pt-1", { messages: page(1), nextToken: "pt-2" }],
      ["pt-2", { messages: page(2), nextToken: "pt-3" }],
      ["pt-3", { messages: page(3) }],
    ]);
    const calls: RecordedCall[] = [];
    const dial: MailWireDial = async (path, init) => {
      calls.push({ path, headers: init.headers, body: init.body });
      const input =
        (init.body as { input?: { pageToken?: string } }).input ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => envelope(providerPages.get(input.pageToken ?? "")),
      };
    };
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request("/?limit=101");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: unknown[] };
    expect(body.messages).toHaveLength(100);
    // Three provider pages reach 120 rows — surplus past the clamp — so the
    // fourth page is never dialed.
    expect(calls).toHaveLength(3);
  });

  test("answers 400 for a limit that is not a positive integer", async () => {
    const { dial } = fakeDial(() => envelope({ messages: [] }));
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request("/?limit=abc");
    expect(response.status).toBe(400);
  });

  test("forwards a non-empty q to the search action and an empty q to the list action", async () => {
    const searching = fakeDial(() =>
      envelope({ messages: [providerMessage()] }),
    );
    const appSearch = mailApp({
      dial: searching.dial,
      connections: connectedUsers(),
    });
    const response = await appSearch.request("/?q=invoice");
    expect(response.status).toBe(200);
    expect(searching.calls).toHaveLength(1);
    expect(searching.calls[0].path).toContain("gmail.search");
    expect(searching.calls[0].body).toEqual({ input: { query: "invoice" } });

    const listing = fakeDial(() => envelope({ messages: [providerMessage()] }));
    const appList = mailApp({
      dial: listing.dial,
      connections: connectedUsers(),
    });
    for (const query of ["?q=", ""]) {
      const answer = await appList.request(`/${query}`);
      expect(answer.status).toBe(200);
    }
    expect(listing.calls).toHaveLength(2);
    expect(listing.calls[0].path).toContain("gmail.list");
    expect(listing.calls[0].body).toEqual({ input: {} });
  });

  test("surfaces provider truncation as truncated:true", async () => {
    const { dial } = fakeDial(() =>
      envelope({ messages: [providerMessage()], truncated: true }),
    );
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request("/");
    const body = (await response.json()) as {
      messages: unknown[];
      truncated: boolean;
      nextCursor?: string;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.truncated).toBe(true);
  });

  test("answers a stable 409 when gmail is not connected, without calling the vendor", async () => {
    const { calls, dial } = fakeDial(() => envelope({ messages: [] }));
    const disconnected = new Map<string, StoredOpenMuseGoogleConnection>([
      [
        actorOne.id,
        connection(actorOne.id, "openmuse-alias-one", "disconnected"),
      ],
    ]);
    const response = await mailApp({ dial, connections: disconnected }).request(
      "/",
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("connection_required");
    expect(calls).toHaveLength(0);
  });

  test("dials with the requesting user's own alias, never another's", async () => {
    const { calls, dial } = fakeDial(() => envelope({ messages: [] }));
    currentActor = actorTwo;
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request("/");
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["x-oo-connector-alias"]).toBe("openmuse-alias-two");
    currentActor = actorOne;
  });

  test("answers 502 with no messages when the vendor fails", async () => {
    const { dial } = fakeDial(() => ({ message: "vendor exploded" }), false);
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request("/");
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.messages).toBeUndefined();
    expect(typeof body.error).toBe("string");
  });
});

describe("GET /api/mobile/openmuse-mail/threads/:threadId", () => {
  /**
   * A dial answering only the thread action: the fake indexes mail by alias,
   * the way an alias-bound vendor does, and answering `null` scripts its
   * not-found (the fake defines this contract; O02 verifies the live signal).
   */
  function threadDial(answer: (alias: string, threadId: string) => unknown) {
    const calls: RecordedCall[] = [];
    const dial: MailWireDial = async (path, init) => {
      calls.push({ path, headers: init.headers, body: init.body });
      const alias = init.headers["x-oo-connector-alias"];
      const threadId = (init.body as { input: { threadId: string } }).input
        .threadId;
      const data = answer(alias, threadId);
      return data === null
        ? {
            ok: false,
            status: 404,
            json: async () => ({ message: "thread not found" }),
          }
        : { ok: true, status: 200, json: async () => envelope(data) };
    };
    return { calls, dial };
  }

  test("returns the thread's messages oldest-first by time then id asc, as the §4 DTO", async () => {
    const at = 1760000000000;
    const { calls, dial } = threadDial(() => ({
      id: "thread-1",
      messages: [
        providerMessage({
          id: "m-c",
          receivedAt: at + 5000,
          snippet: "provider-only field",
        }),
        providerMessage({ id: "m-b2", receivedAt: at }),
        providerMessage({ id: "m-b1", receivedAt: at }),
        providerMessage({ id: "m-a", receivedAt: at - 5000 }),
      ],
    }));
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request("/threads/thread-1");
    expect(response.status).toBe(200);
    const messages = (await response.json()) as Array<Record<string, unknown>>;
    // Oldest time first; the equal-timestamp pair ties on id ASCENDING.
    expect(messages.map((message) => message.id)).toEqual([
      "m-a",
      "m-b1",
      "m-b2",
      "m-c",
    ]);
    expect(messages[0]).toEqual({
      id: "m-a",
      threadId: "thread-1",
      from: "sender@example.test",
      to: ["reader@example.test"],
      subject: "Quarterly report",
      bodyText: "The numbers are attached.",
      receivedAt: new Date(at - 5000).toISOString(),
      unread: true,
      labels: ["INBOX", "UNREAD"],
      attachments: [
        {
          id: "att-1",
          name: "report.pdf",
          mimeType: "application/pdf",
          size: 1024,
        },
      ],
    });
    // The provider-only field does not cross the mapping.
    expect(messages[3].snippet).toBeUndefined();
    // The dial went out alias-bound on the thread action with the thread id.
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain("gmail.thread");
    expect(calls[0].headers["x-oo-connector-alias"]).toBe("openmuse-alias-one");
    expect(calls[0].body).toEqual({ input: { threadId: "thread-1" } });
  });

  test("normalizes bodies: HTML-only falls back to stripped text, CRLF becomes LF, empty stays empty string", async () => {
    const { dial } = threadDial(() => ({
      id: "thread-1",
      messages: [
        providerMessage({
          id: "m-html",
          bodyText: undefined,
          bodyHtml: "<p>Hello&nbsp;Wu,</p><p>line\r\ntwo &amp; done.</p>",
        }),
        providerMessage({ id: "m-crlf", bodyText: "a\r\nb\rc" }),
        providerMessage({ id: "m-empty", bodyText: "" }),
      ],
    }));
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request("/threads/thread-1");
    expect(response.status).toBe(200);
    const messages = (await response.json()) as Array<{
      id: string;
      bodyText: string;
    }>;
    const byId = new Map(messages.map((message) => [message.id, message]));
    expect(byId.get("m-html")?.bodyText).toBe("Hello Wu,\nline two & done.");
    expect(byId.get("m-crlf")?.bodyText).toBe("a\nb\nc");
    expect(byId.get("m-empty")?.bodyText).toBe("");
  });

  test("a foreign thread id and a missing thread id answer the same outward 404", async () => {
    const { calls, dial } = threadDial((alias, threadId) =>
      alias === "openmuse-alias-one" && threadId === "thread-1"
        ? { id: "thread-1", messages: [providerMessage()] }
        : null,
    );
    const app = mailApp({ dial, connections: connectedUsers() });
    // The foreign ask goes out under actor two's own alias, and the vendor —
    // which only ever sees that alias's mailbox — answers the same not-found
    // as for a thread nobody has.
    currentActor = actorTwo;
    const foreign = await app.request("/threads/thread-1");
    currentActor = actorOne;
    const missing = await app.request("/threads/thread-none");
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(await foreign.json());
    expect(calls).toHaveLength(2);
    expect(calls[0].headers["x-oo-connector-alias"]).toBe("openmuse-alias-two");
    expect(calls[1].headers["x-oo-connector-alias"]).toBe("openmuse-alias-one");
  });

  test("answers 502 with no partial thread when the vendor fails beyond not-found", async () => {
    const calls: RecordedCall[] = [];
    const failing: MailWireDial = async (path, init) => {
      calls.push({ path, headers: init.headers, body: init.body });
      return {
        ok: false,
        status: 500,
        json: async () => ({ message: "vendor exploded" }),
      };
    };
    const response = await mailApp({
      dial: failing,
      connections: connectedUsers(),
    }).request("/threads/thread-1");
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect(Array.isArray(body)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("answers a stable 409 when gmail is not connected, without calling the vendor", async () => {
    const { calls, dial } = threadDial(() => ({
      id: "thread-1",
      messages: [],
    }));
    const disconnected = new Map<string, StoredOpenMuseGoogleConnection>([
      [
        actorOne.id,
        connection(actorOne.id, "openmuse-alias-one", "disconnected"),
      ],
    ]);
    const response = await mailApp({
      dial,
      connections: disconnected,
    }).request("/threads/thread-1");
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("connection_required");
    expect(calls).toHaveLength(0);
  });

  test("answers 403 for a disabled owner without calling the vendor (§9)", async () => {
    const { calls, dial } = threadDial(() => ({
      id: "thread-1",
      messages: [],
    }));
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
      ownerDisabled: async (userId) => userId === actorOne.id,
    }).request("/threads/thread-1");
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("derives stable ids from (thread id, index) when rows lack their own", async () => {
    const { dial } = threadDial(() => ({
      id: "thread-9",
      messages: [
        { threadId: "thread-9", receivedAt: 1760000000000, subject: "one" },
        { threadId: "thread-9", receivedAt: 1760000001000, subject: "two" },
      ],
    }));
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request("/threads/thread-9");
    expect(response.status).toBe(200);
    const messages = (await response.json()) as Array<{ id: string }>;
    expect(messages.map((message) => message.id)).toEqual([
      "thread-9-0",
      "thread-9-1",
    ]);
  });
});

/**
 * M04's attachment fake: mailboxes indexed by alias, each row keyed on the
 * attachment id, the way an alias-bound vendor sees them. The metadata
 * action and the bytes action both key on the request's (alias, attachment
 * id) — a copied foreign id, or an id that mailbox never had, finds no row
 * and answers not-found, which is the isolation under test. The bytes answer
 * carries base64 data plus an optional sha256 digest, the shape the client
 * layer decodes; the fake defines this contract and O02 verifies the live
 * one.
 */
type AttachmentMailbox = Map<
  string,
  {
    metadata: Record<string, unknown>;
    bytes: { data: string; sha256?: string };
  }
>;

function attachmentDial(mailboxes: Map<string, AttachmentMailbox>) {
  const calls: RecordedCall[] = [];
  const dial: MailWireDial = async (path, init) => {
    calls.push({ path, headers: init.headers, body: init.body });
    const alias = init.headers["x-oo-connector-alias"];
    const attachmentId = (init.body as { input: { attachmentId: string } })
      .input.attachmentId;
    const row = mailboxes.get(alias)?.get(attachmentId);
    if (path.includes("gmail.attachment.get")) {
      return row === undefined
        ? {
            ok: false,
            status: 404,
            json: async () => ({ message: "attachment not found" }),
          }
        : { ok: true, status: 200, json: async () => envelope(row.metadata) };
    }
    return row === undefined
      ? {
          ok: false,
          status: 404,
          json: async () => ({ message: "attachment not found" }),
        }
      : { ok: true, status: 200, json: async () => envelope(row.bytes) };
  };
  const bytesCalls = () =>
    calls.filter((call) => call.path.includes("gmail.attachment.bytes"));
  return { calls, dial, bytesCalls };
}

const ATTACHMENT_PATH = "/threads/thread-1/messages/msg-1/attachments/att-1";

/** Two alias-bound mailboxes: only alias-one holds the attachment. */
function attachmentMailboxes(): Map<string, AttachmentMailbox> {
  return new Map([
    [
      "openmuse-alias-one",
      new Map([
        [
          "att-1",
          {
            metadata: {
              id: "att-1",
              name: "report.pdf",
              mimeType: "application/pdf",
              size: 1024,
              crc32: "provider-only field",
              data: "should not cross",
            },
            bytes: {
              data: Buffer.from("%PDF-1.4 exact bytes").toString("base64"),
              sha256: "a".repeat(64),
            },
          },
        ],
      ]),
    ],
    ["openmuse-alias-two", new Map()],
  ]);
}

describe("attachment bytes decode-side ceiling (round 6 M30)", () => {
  test("a lying provider's oversized base64 is refused before the decode allocates", async () => {
    const { buildOpenMuseMailClient } = await import(
      "../src/openmuse-mail/client"
    );
    const oversized = "A".repeat(
      Math.ceil((ATTACHMENT_MAX_BYTES + 2) / 3) * 4 + 4,
    );
    const client = buildOpenMuseMailClient({
      dial: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: { data: oversized } }),
      }),
    });
    await expect(
      client.getAttachmentBytes("alias", "t", "m", "a"),
    ).rejects.toThrow("over this deployment's byte ceiling");
  });
});

describe("GET /api/mobile/openmuse-mail/threads/:threadId/messages/:messageId/attachments/:attachmentId", () => {
  test("maps the attachment metadata to the §4 DTO exactly and drops extra provider fields", async () => {
    const { calls, dial } = attachmentDial(attachmentMailboxes());
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request(ATTACHMENT_PATH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "att-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 1024,
    });
    // One metadata dial, alias-bound, carrying all three scoping ids.
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain("gmail.attachment.get");
    expect(calls[0].headers["x-oo-connector-alias"]).toBe("openmuse-alias-one");
    expect(calls[0].body).toEqual({
      input: {
        threadId: "thread-1",
        messageId: "msg-1",
        attachmentId: "att-1",
      },
    });
  });

  test("a copied foreign attachment id and a missing one answer the same outward 404", async () => {
    const { calls, dial } = attachmentDial(attachmentMailboxes());
    const app = mailApp({ dial, connections: connectedUsers() });
    // The foreign ask goes out under actor two's own alias, whose mailbox —
    // the only one the alias-bound vendor ever sees — does not hold the id.
    currentActor = actorTwo;
    const foreign = await app.request(ATTACHMENT_PATH);
    currentActor = actorOne;
    const missing = await app.request(
      "/threads/thread-1/messages/msg-1/attachments/att-none",
    );
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(await foreign.json());
    expect(calls).toHaveLength(2);
    expect(calls[0].headers["x-oo-connector-alias"]).toBe("openmuse-alias-two");
    expect(calls[1].headers["x-oo-connector-alias"]).toBe("openmuse-alias-one");
  });

  test("answers a stable 409 when gmail is not connected, without calling the vendor", async () => {
    const { calls, dial } = attachmentDial(attachmentMailboxes());
    const disconnected = new Map<string, StoredOpenMuseGoogleConnection>([
      [
        actorOne.id,
        connection(actorOne.id, "openmuse-alias-one", "disconnected"),
      ],
    ]);
    const response = await mailApp({
      dial,
      connections: disconnected,
    }).request(ATTACHMENT_PATH);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("connection_required");
    expect(calls).toHaveLength(0);
  });

  test("answers 403 for a disabled owner without calling the vendor (§9)", async () => {
    const { calls, dial } = attachmentDial(attachmentMailboxes());
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
      ownerDisabled: async (userId) => userId === actorOne.id,
    }).request(ATTACHMENT_PATH);
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("answers 502 with no partial metadata when the vendor fails beyond not-found", async () => {
    const calls: RecordedCall[] = [];
    const failing: MailWireDial = async (path, init) => {
      calls.push({ path, headers: init.headers, body: init.body });
      return {
        ok: false,
        status: 500,
        json: async () => ({ message: "vendor exploded" }),
      };
    };
    const response = await mailApp({
      dial: failing,
      connections: connectedUsers(),
    }).request(ATTACHMENT_PATH);
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect(calls).toHaveLength(1);
  });
});

describe("GET /api/mobile/openmuse-mail/threads/:threadId/messages/:messageId/attachments/:attachmentId/content", () => {
  test("streams the exact bytes with Content-Type, Content-Length, and the provider's sha256 as ETag", async () => {
    const { dial } = attachmentDial(attachmentMailboxes());
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request(`${ATTACHMENT_PATH}/content`);
    expect(response.status).toBe(200);
    const raw = Buffer.from(await response.arrayBuffer());
    expect(raw.toString("utf8")).toBe("%PDF-1.4 exact bytes");
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Length")).toBe(
      String(Buffer.byteLength("%PDF-1.4 exact bytes")),
    );
    expect(response.headers.get("ETag")).toBe(`"${"a".repeat(64)}"`);
  });

  test("omits ETag when the provider supplies no digest", async () => {
    const mailboxes = attachmentMailboxes();
    delete mailboxes.get("openmuse-alias-one")?.get("att-1")?.bytes.sha256;
    const { dial } = attachmentDial(mailboxes);
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request(`${ATTACHMENT_PATH}/content`);
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBeNull();
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
  });

  test("a copied foreign attachment id refuses with 404 and zero bytes dials", async () => {
    const { calls, bytesCalls, dial } = attachmentDial(attachmentMailboxes());
    currentActor = actorTwo;
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request(`${ATTACHMENT_PATH}/content`);
    currentActor = actorOne;
    expect(response.status).toBe(404);
    // The metadata dial went out under the asker's own alias; the bytes dial
    // never happened because the metadata answer already refused.
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain("gmail.attachment.get");
    expect(calls[0].headers["x-oo-connector-alias"]).toBe("openmuse-alias-two");
    expect(bytesCalls()).toHaveLength(0);
  });

  test("refuses a lying provider's oversized base64 at the decode, before any full-size copy (round 6 M30)", async () => {
    // Provider metadata and the real bytes can disagree (a sparse or lying
    // answer): the metadata pre-check passes, and the payload used to be
    // buffered whole only to 413 at the route's re-check — the amplify-OOM
    // path. The decode-side ceiling now refuses the base64 BEFORE the
    // replaceAll copy, the decode and the Uint8Array copy each allocate a
    // full-size twin: the lying vendor gets the clean 502 of a named vendor
    // error, and the limit stays a property of the bytes, not the metadata.
    const mailboxes = attachmentMailboxes();
    const row = mailboxes.get("openmuse-alias-one")?.get("att-1");
    if (row === undefined) throw new Error("fixture row missing");
    row.bytes = {
      // One base64 quantum past the ceiling: long enough to be refused,
      // small enough to keep the fixture cheap.
      data: "A".repeat(Math.ceil((ATTACHMENT_MAX_BYTES + 2) / 3) * 4 + 4),
      sha256: "b".repeat(64),
    };
    const { bytesCalls, dial } = attachmentDial(mailboxes);
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request(`${ATTACHMENT_PATH}/content`);
    expect(response.status).toBe(502);
    expect(bytesCalls()).toHaveLength(1);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("byte ceiling");
  });

  test("serves the download as an attachment with nosniff, never an inline provider-controlled type", async () => {
    // Mail attachments are attacker-controlled content: a renderable
    // Content-Type served inline is a script-execution surface in a browser
    // or webview, so the download carries the channels-surface pair
    // (attachment + X-Content-Type-Options: nosniff) whatever the metadata says.
    const mailboxes = attachmentMailboxes();
    const row = mailboxes.get("openmuse-alias-one")?.get("att-1");
    if (row === undefined) throw new Error("fixture row missing");
    row.metadata = {
      ...row.metadata,
      mimeType: "text/html",
    };
    row.bytes = {
      data: Buffer.from("<script>alert(1)</script>").toString("base64"),
    };
    const { dial } = attachmentDial(mailboxes);
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request(`${ATTACHMENT_PATH}/content`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(response.headers.get("Content-Disposition")).toBe("attachment");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("refuses an attachment over the size limit with 413 naming the limit, before any bytes dial", async () => {
    const mailboxes = attachmentMailboxes();
    const oversize = mailboxes.get("openmuse-alias-one")?.get("att-1");
    if (oversize !== undefined)
      oversize.metadata.size = ATTACHMENT_MAX_BYTES + 1;
    const { bytesCalls, dial } = attachmentDial(mailboxes);
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
    }).request(`${ATTACHMENT_PATH}/content`);
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("25 MiB");
    expect(body.error).toContain(String(ATTACHMENT_MAX_BYTES));
    expect(bytesCalls()).toHaveLength(0);
  });

  test("answers a stable 409 when gmail is not connected, without calling the vendor", async () => {
    const { calls, dial } = attachmentDial(attachmentMailboxes());
    const disconnected = new Map<string, StoredOpenMuseGoogleConnection>([
      [
        actorOne.id,
        connection(actorOne.id, "openmuse-alias-one", "disconnected"),
      ],
    ]);
    const response = await mailApp({
      dial,
      connections: disconnected,
    }).request(`${ATTACHMENT_PATH}/content`);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("connection_required");
    expect(calls).toHaveLength(0);
  });

  test("answers 403 for a disabled owner without calling the vendor (§9)", async () => {
    const { calls, dial } = attachmentDial(attachmentMailboxes());
    const response = await mailApp({
      dial,
      connections: connectedUsers(),
      ownerDisabled: async (userId) => userId === actorOne.id,
    }).request(`${ATTACHMENT_PATH}/content`);
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("answers 502 with no partial body when the vendor fails on the bytes dial", async () => {
    const calls: RecordedCall[] = [];
    // Metadata answers fine; the bytes action explodes after it.
    const failing: MailWireDial = async (path, init) => {
      calls.push({ path, headers: init.headers, body: init.body });
      if (path.includes("gmail.attachment.bytes")) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ message: "vendor exploded" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () =>
          envelope({
            id: "att-1",
            name: "report.pdf",
            mimeType: "application/pdf",
            size: 1024,
          }),
      };
    };
    const response = await mailApp({
      dial: failing,
      connections: connectedUsers(),
    }).request(`${ATTACHMENT_PATH}/content`);
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect(response.headers.get("Content-Type")).not.toBe("application/pdf");
    expect(calls).toHaveLength(2);
  });
});
