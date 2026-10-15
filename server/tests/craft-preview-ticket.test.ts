// #360 — the preview-ticket auth primitive (spec: craft-preview-origin D4/D9).
//
// Cross-host previews lose the platform session cookie by design (F2/D1), so the
// main-site cookie exchanges for a short-lived, single-use ticket bound to the
// triple (userId, sessionId, previewHost); redeeming it on the preview origin
// yields the userId and plants the preview domain's own session-scoped cookie.
//
// D9 locks the shape: TTL 30s, single use, no idle invalidation, and a
// session-level HttpOnly cookie (no Max-Age/Expires) on redeem. The clock is
// injectable throughout — expiry is tested by advancing a fake clock, never by
// sleeping.

import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { loadCraftConfig } from "../src/craft/config";
import {
  createPreviewTickets,
  PREVIEW_SESSION_COOKIE,
  PREVIEW_TICKET_TTL_MS,
  previewSessionCookieHeader,
} from "../src/craft/preview-ticket";
import type { CraftStore } from "../src/craft/store";
import { createWebappProxyRoutes } from "../src/craft/webapp-proxy";

const SESSION_ID = "cs-444455556666";
const USER_ID = "u1";
const PREVIEW_HOST = "127.0.0.1:3010";

/** A steppable clock — the expiry paths advance it instead of sleeping. */
function fakeClock(startMs = 1_700_000_000_000) {
  let at = startMs;
  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at += ms;
    },
  };
}

/**
 * The minimal store seam the ticket redemption re-checks: the session row by
 * (id, owner). Flipping `owner` or nulling the row simulates deletion / owner
 * change AFTER issue — the in-memory ticket root alone must never suffice.
 */
function fakeStore(ownerUserId: string | null = USER_ID) {
  const state = { owner: ownerUserId };
  const row = () =>
    state.owner ? { id: SESSION_ID, userId: state.owner } : undefined;
  const store = {
    async findSession(sessionId: string, userId: string) {
      return sessionId === SESSION_ID && userId === state.owner ? row() : undefined;
    },
    // The issuing route's ownership check (the service's re-check uses the
    // bump-free findSession above).
    async getSession(sessionId: string, userId: string) {
      return sessionId === SESSION_ID && userId === state.owner ? row() : undefined;
    },
  } as unknown as CraftStore;
  return { store, state };
}

function ticketsWith(
  store: CraftStore,
  clock: ReturnType<typeof fakeClock>,
) {
  return createPreviewTickets({ store, now: clock.now });
}

// ── the service: issue → redeem ───────────────────────────────────────────────

describe("issuePreviewTicket / redeemPreviewTicket", () => {
  test("round-trips the issuing userId for the bound triple", async () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const tickets = ticketsWith(store, clock);

    const issued = tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: PREVIEW_HOST,
    });
    expect(typeof issued.ticket).toBe("string");
    expect(issued.expiresAt.getTime()).toBe(
      clock.now().getTime() + PREVIEW_TICKET_TTL_MS,
    );

    const redeemed = await tickets.redeemPreviewTicket({
      ticket: issued.ticket,
      sessionId: SESSION_ID,
      previewHost: PREVIEW_HOST,
    });
    expect(redeemed).toEqual({ userId: USER_ID });
  });

  test("issues unguessable, distinct tickets (32 random bytes)", () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const tickets = ticketsWith(store, clock);
    const first = tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: PREVIEW_HOST,
    });
    const second = tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: PREVIEW_HOST,
    });
    expect(first.ticket).not.toBe(second.ticket);
    // base64url of 32 bytes ≈ 43 chars; never a short guessable string.
    expect(first.ticket.length).toBeGreaterThanOrEqual(32);
  });

  // ── single use (D9) ────────────────────────────────────────────────────────
  test("a redeemed ticket is dead: replay is refused as unknown", async () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const tickets = ticketsWith(store, clock);
    const issued = tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: PREVIEW_HOST,
    });

    expect(
      await tickets.redeemPreviewTicket({
        ticket: issued.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ userId: USER_ID });
    expect(
      await tickets.redeemPreviewTicket({
        ticket: issued.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ reason: "unknown" });
  });

  test("a mismatched triple consumes the ticket too — probing with another session or host burns it", async () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const tickets = ticketsWith(store, clock);
    const issued = tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: PREVIEW_HOST,
    });

    // Wrong session: refused…
    expect(
      await tickets.redeemPreviewTicket({
        ticket: issued.ticket,
        sessionId: "cs-someone-else",
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ reason: "mismatch" });
    // …and the ticket is gone, so the RIGHT triple no longer works either.
    expect(
      await tickets.redeemPreviewTicket({
        ticket: issued.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ reason: "unknown" });
  });

  test("a ticket redeemed against a different preview host is refused (triple: host)", async () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const tickets = ticketsWith(store, clock);
    const issued = tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: PREVIEW_HOST,
    });
    expect(
      await tickets.redeemPreviewTicket({
        ticket: issued.ticket,
        sessionId: SESSION_ID,
        previewHost: "evil.example:443",
      }),
    ).toEqual({ reason: "mismatch" });
  });

  // ── TTL (D9: 30s, clock-advanced — never sleep) ────────────────────────────
  test("a ticket survives 29.999s and dies at exactly 30s (TTL window, no idle rule)", async () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const tickets = ticketsWith(store, clock);
    const issued = tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: PREVIEW_HOST,
    });

    clock.advance(PREVIEW_TICKET_TTL_MS - 1);
    expect(
      await tickets.redeemPreviewTicket({
        ticket: issued.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ userId: USER_ID });

    clock.advance(1); // total 30s on a fresh ticket
    const late = tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: PREVIEW_HOST,
    });
    clock.advance(PREVIEW_TICKET_TTL_MS);
    expect(
      await tickets.redeemPreviewTicket({
        ticket: late.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ reason: "expired" });
  });

  // ── the store re-check: deletion / owner change voids unredeemed tickets ────
  test("a session deleted after issue is refused at redeem", async () => {
    const clock = fakeClock();
    const { store, state } = fakeStore();
    const tickets = ticketsWith(store, clock);
    const issued = tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: PREVIEW_HOST,
    });

    state.owner = null; // the row is gone
    expect(
      await tickets.redeemPreviewTicket({
        ticket: issued.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ reason: "session" });
  });

  test("a session reassigned to another user is refused at redeem", async () => {
    const clock = fakeClock();
    const { store, state } = fakeStore();
    const tickets = ticketsWith(store, clock);
    const issued = tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: PREVIEW_HOST,
    });

    state.owner = "u2"; // userId changed under the ticket
    expect(
      await tickets.redeemPreviewTicket({
        ticket: issued.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ reason: "session" });
  });

  test("an unknown ticket is refused without touching the store", async () => {
    const clock = fakeClock();
    let findCalls = 0;
    const store = {
      async findSession() {
        findCalls++;
        return { id: SESSION_ID, userId: USER_ID };
      },
    } as unknown as CraftStore;
    const tickets = ticketsWith(store, clock);
    expect(
      await tickets.redeemPreviewTicket({
        ticket: "totally-made-up",
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ).toEqual({ reason: "unknown" });
    expect(findCalls).toBe(0);
  });

  test("expired entries are swept on issue — the TTL table does not accumulate", () => {
    const clock = fakeClock();
    const { store } = fakeStore();
    const tickets = ticketsWith(store, clock);
    for (let i = 0; i < 5; i++) {
      tickets.issuePreviewTicket({
        sessionId: SESSION_ID,
        userId: USER_ID,
        previewHost: PREVIEW_HOST,
      });
    }
    clock.advance(PREVIEW_TICKET_TTL_MS * 10);
    tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: PREVIEW_HOST,
    });
    // One live entry remains; the five expired ones were dropped at sweep time.
    expect(tickets.size()).toBe(1);
  });

  // ── no ticket value in any refusal (AC: 错误响应不回显票据值) ────────────────
  test("every refusal reason is ticket-free — no echo in any failure shape", async () => {
    const clock = fakeClock();
    const { store, state } = fakeStore();
    const tickets = ticketsWith(store, clock);

    const unknown = tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: PREVIEW_HOST,
    });
    const expired = tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: PREVIEW_HOST,
    });
    const mismatched = tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: PREVIEW_HOST,
    });
    const orphaned = tickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: PREVIEW_HOST,
    });

    clock.advance(PREVIEW_TICKET_TTL_MS); // expire `expired` and free others
    state.owner = null; // orphan `orphaned` from its session
    const refusals = [
      await tickets.redeemPreviewTicket({
        ticket: "no-such-ticket",
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
      await tickets.redeemPreviewTicket({
        ticket: unknown.ticket,
        sessionId: "cs-wrong",
        previewHost: PREVIEW_HOST,
      }),
      await tickets.redeemPreviewTicket({
        ticket: expired.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
      await tickets.redeemPreviewTicket({
        ticket: orphaned.ticket,
        sessionId: SESSION_ID,
        previewHost: PREVIEW_HOST,
      }),
    ];
    const serialized = JSON.stringify(refusals);
    expect(serialized).not.toContain(unknown.ticket);
    expect(serialized).not.toContain(expired.ticket);
    expect(serialized).not.toContain(mismatched.ticket);
    expect(serialized).not.toContain(orphaned.ticket);
  });
});

// ── the preview-domain cookie (D9: session-level HttpOnly) ────────────────────

describe("previewSessionCookieHeader", () => {
  test("is HttpOnly, Path=/, SameSite=Lax, with NO Max-Age and NO Expires", () => {
    const header = previewSessionCookieHeader("some-session-credential");
    expect(header).toContain(`${PREVIEW_SESSION_COOKIE}=some-session-credential`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Path=/");
    expect(header).toContain("SameSite=Lax");
    // D9: session cookie — the absence of both is what makes the browser drop
    // it at close; either one would turn it persistent.
    expect(header).not.toContain("Max-Age");
    expect(header).not.toContain("Expires");
  });
});

// ── POST /sessions/:id/preview-ticket — the issuing route ─────────────────────
//
// The route rides the webapp proxy's own requireUser: the main-site session
// cookie is the ONLY way in (401 without it), and the refusals reuse the
// surface's established shapes — 404 for a session that is not the actor's,
// 503 when the sandbox behind the preview is unavailable.

function signedInAs(
  userId: string,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: userId,
      email: `${userId}@example.com`,
      role: "user",
    });
    await next();
  };
}

const refusedSignIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
) => context.json({ error: "Authentication required." }, 401);

function ticketRoutes(options: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  store: CraftStore;
  botIdFor?: (sessionId: string) => Promise<string | null>;
  sandboxConnectionFor?: (
    botId: string,
  ) => { baseUrl: string; token: string | null } | null;
}) {
  return createWebappProxyRoutes(options.requireUser, {
    config: loadCraftConfig({}),
    store: options.store,
    gateway: {} as never,
    botIdFor: options.botIdFor ?? (async () => "craft-bot"),
    sandboxConnectionFor:
      options.sandboxConnectionFor ??
      (() => ({ baseUrl: "http://sbox.internal:4300", token: null })),
    previewOriginFor: () => `http://${PREVIEW_HOST}`,
  });
}

describe("POST /sessions/:id/preview-ticket (issuing route)", () => {
  test("answers { ticket, expiresAt, origin } for the session's owner", async () => {
    const { store } = fakeStore();
    const app = ticketRoutes({ requireUser: signedInAs(USER_ID), store });

    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-ticket`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ticket: string;
      expiresAt: string;
      origin: string;
    };
    expect(typeof body.ticket).toBe("string");
    expect(body.ticket.length).toBeGreaterThanOrEqual(32);
    expect(body.origin).toBe(`http://${PREVIEW_HOST}`);
    // ISO timestamp ~30s out — the client's countdown to redemption.
    const remaining =
      new Date(body.expiresAt).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(PREVIEW_TICKET_TTL_MS - 5_000);
    expect(remaining).toBeLessThanOrEqual(PREVIEW_TICKET_TTL_MS);
  });

  test("no main-site session cookie → 401, no ticket minted", async () => {
    const { store } = fakeStore();
    const app = ticketRoutes({ requireUser: refusedSignIn, store });

    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-ticket`,
      { method: "POST" },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Authentication required.",
    });
  });

  test("another user's session, or an unknown one → 404 Session not found", async () => {
    const { store } = fakeStore();
    const app = ticketRoutes({ requireUser: signedInAs("u2"), store });

    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-ticket`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });

    const unknown = await ticketRoutes({
      requireUser: signedInAs(USER_ID),
      store,
    }).request(`/sessions/never-heard-of/preview-ticket`, { method: "POST" });
    expect(unknown.status).toBe(404);
  });

  test("no sandbox behind the session → 503, the surface's unavailable shape", async () => {
    const { store } = fakeStore();
    const app = ticketRoutes({
      requireUser: signedInAs(USER_ID),
      store,
      sandboxConnectionFor: () => null,
    });

    const response = await app.request(
      `/sessions/${SESSION_ID}/preview-ticket`,
      { method: "POST" },
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect((body as { error: string }).error).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("ticket");
  });
});
