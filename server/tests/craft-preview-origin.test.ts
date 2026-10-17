// #361 — the preview origin's host routing and admission (spec: craft-preview-origin
// D5/D7, AC6/AC9).
//
// The preview origin is a different HOST from the main site (F2/D1): dev rides
// `127.0.0.1:<SERVER_PORT>` beside a `localhost` login (D5), production rides
// `<hash-label>.<preview-base>` subdomains (D3/D7). This file pins the three
// behaviours that make those hosts safe to serve on the SAME port as the main
// site: the Host→session mapping (unknown hosts 404, never main routes), the
// hash-label derivation (stable, keyed, unguessable, DNS-safe — never the
// session id), and admission (closed = displayable reason, never a silent
// fallback to the same-origin form).
//
// The redemption entry closes D9's loop from #360: a ticket minted on the main
// site redeems at the preview origin's entry and plants the preview domain's
// OWN session cookie — session-level (no Max-Age/Expires), HttpOnly, Lax.

import { describe, expect, test } from "bun:test";
import { loadCraftConfig } from "../src/craft/config";
import { createPreviewOrigin } from "../src/craft/preview-origin";
import {
  createPreviewTickets,
  PREVIEW_SESSION_COOKIE,
  type PreviewTickets,
} from "../src/craft/preview-ticket";
import type { CraftStore } from "../src/craft/store";

const SESSION_ID = "cs-a1b2c3d4e5f6";
const OTHER_SESSION_ID = "cs-z9y8x7w6v5u4";
const USER_ID = "u1";
const SECRET = "test-preview-origin-secret";
const TEMPLATE = "https://{session}.preview.example.com";

/** The minimal store seam redemption re-checks (the bump-free findSession). */
function fakeStore(ownerUserId: string | null = USER_ID) {
  const state = { owner: ownerUserId };
  const store = {
    async findSession(sessionId: string, userId: string) {
      return sessionId === SESSION_ID && state.owner === userId
        ? { id: SESSION_ID, userId: state.owner }
        : undefined;
    },
  } as unknown as CraftStore;
  return { store, state };
}

type OriginOverrides = Partial<{
  enabled: boolean;
  webappProxyEnabled: boolean;
  previewOriginEnabled: boolean;
  previewOriginTemplate: string;
}>;

function originWith(
  overrides: OriginOverrides = {},
  env: Record<string, string | undefined> = {},
  tickets: PreviewTickets = createPreviewTickets({ store: fakeStore().store }),
) {
  return createPreviewOrigin({
    config: {
      enabled: true,
      webappProxyEnabled: true,
      previewOriginEnabled: true,
      previewOriginTemplate: "",
      ...overrides,
    },
    previewTickets: tickets,
    secret: SECRET,
    env,
  });
}

/** The label a session's preview hostname carries, read back out of originFor. */
function labelOf(origin: ReturnType<typeof originWith>, sessionId: string) {
  return new URL(origin.originFor(sessionId)).hostname.split(".")[0];
}

// ── config: the two admission fields ─────────────────────────────────────────

describe("loadCraftConfig: preview origin fields", () => {
  test("defaults to enabled with the empty template (the D5 dev form)", () => {
    const config = loadCraftConfig({});
    expect(config.previewOriginEnabled).toBe(true);
    expect(config.previewOriginTemplate).toBe("");
  });

  test("reads OPENBOT_CRAFT_PREVIEW_ORIGIN_{ENABLED,TEMPLATE}", () => {
    const config = loadCraftConfig({
      OPENBOT_CRAFT_PREVIEW_ORIGIN_ENABLED: "false",
      OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE: TEMPLATE,
    });
    expect(config.previewOriginEnabled).toBe(false);
    expect(config.previewOriginTemplate).toBe(TEMPLATE);
  });
});

// ── the hash-label derivation (D7/AC9) ───────────────────────────────────────

describe("preview hostname derivation", () => {
  test("one session, one hostname: stable across calls and across instances", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    const first = origin.originFor(SESSION_ID);
    expect(origin.originFor(SESSION_ID)).toBe(first);
    // A second instance keyed by the same deployment secret re-derives the same
    // address — the label is a function of (secret, sessionId), never of memory.
    expect(originWith({ previewOriginTemplate: TEMPLATE }).originFor(SESSION_ID)).toBe(
      first,
    );
  });

  test("distinct sessions get distinct hostnames; a label is DNS-safe and never the session id (AC9)", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    const hostname = new URL(origin.originFor(SESSION_ID)).hostname;
    const other = new URL(origin.originFor(OTHER_SESSION_ID)).hostname;

    expect(hostname).not.toBe(other);
    // Not the id itself, not any form that embeds it, and a single DNS label:
    // lowercase hex, comfortably under the 63-char limit.
    expect(hostname).not.toContain(SESSION_ID);
    expect(hostname.split(".")[0]).toMatch(/^[0-9a-f]{16,63}$/);
  });

  test("the label is keyed by the deployment secret, not a plain hash of the id", () => {
    const keyed = originWith({ previewOriginTemplate: TEMPLATE });
    const rekeyed = createPreviewOrigin({
      config: {
        enabled: true,
        webappProxyEnabled: true,
        previewOriginEnabled: true,
        previewOriginTemplate: TEMPLATE,
      },
      previewTickets: createPreviewTickets({ store: fakeStore().store }),
      secret: "a-different-deployment-secret",
      env: {},
    });
    expect(rekeyed.originFor(SESSION_ID)).not.toBe(keyed.originFor(SESSION_ID));
  });
});

// ── resolvePreviewRequest: Host header → session id, the only entry ─────────

describe("resolvePreviewRequest (wildcard-host form)", () => {
  test("a registered hostname resolves to its session", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    const url = origin.originFor(SESSION_ID);
    expect(origin.resolvePreviewRequest(new Request(`${url}/`))).toEqual({
      sessionId: SESSION_ID,
    });
  });

  test("an unregistered label under the preview base is a 404 that never reaches main routes", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    const request = new Request("https://nobody-registered-this.preview.example.com/");
    expect(origin.handlesRequest(request)).toBe(true);
    expect(origin.resolvePreviewRequest(request)).toEqual({
      refuse: { status: 404, reason: expect.any(String) },
    });
  });

  test("the preview apex and deeper hosts stay inside the preview namespace (404, not main)", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    for (const hostname of [
      "preview.example.com",
      "a.b.preview.example.com",
    ]) {
      const request = new Request(`https://${hostname}/`);
      expect(origin.handlesRequest(request)).toBe(true);
      expect(origin.resolvePreviewRequest(request).refuse?.status).toBe(404);
    }
  });

  test("a main-site host is not the preview origin's business", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    expect(origin.handlesRequest(new Request("http://localhost:3001/"))).toBe(
      false,
    );
    expect(
      origin.handlesRequest(new Request("https://app.example.com/")),
    ).toBe(false);
  });
});

describe("resolvePreviewRequest (D5 dev form: 127.0.0.1:<SERVER_PORT>)", () => {
  test("127.0.0.1:<SERVER_PORT>/<label>/ resolves the session; localhost stays main", () => {
    const origin = originWith({}, { PORT: "3001" });
    const address = origin.originFor(SESSION_ID); // http://127.0.0.1:3001/<label>
    expect(origin.resolvePreviewRequest(new Request(`${address}/`))).toEqual({
      sessionId: SESSION_ID,
    });
    const main = new Request("http://localhost:3001/");
    expect(origin.handlesRequest(main)).toBe(false);
  });

  test("an unknown or missing label on the dev host is a 404, never main routes", () => {
    const origin = originWith({}, { PORT: "3001" });
    for (const path of ["/never-registered/", "/"]) {
      const request = new Request(`http://127.0.0.1:3001${path}`);
      expect(origin.handlesRequest(request)).toBe(true);
      expect(origin.resolvePreviewRequest(request).refuse?.status).toBe(404);
    }
  });

  test("PORT=80 rides http's default port: the minted address stays claimed and resolves", () => {
    const origin = originWith({}, { PORT: "80" });
    // URL serialization drops http's default :80 — the minted address carries
    // no explicit port, the exact shape url.host compares against.
    const address = origin.originFor(SESSION_ID);
    expect(address).not.toContain(":80");
    const request = new Request(`${address}/`); // the Request URL normalizes the same way
    expect(origin.handlesRequest(request)).toBe(true);
    expect(origin.resolvePreviewRequest(request)).toEqual({
      sessionId: SESSION_ID,
    });
    expect(origin.handlesRequest(new Request("http://127.0.0.1:3001/"))).toBe(
      false,
    );
  });

  test("PORT/SERVER_PORT disagreement closes admission with a displayable reason", () => {
    const origin = originWith({}, { PORT: "3001", SERVER_PORT: "3002" });
    const admission = origin.admission();
    expect(admission.ok).toBe(false);
    if (!admission.ok) {
      expect(admission.reason).toContain("PORT");
      expect(admission.reason).toContain("SERVER_PORT");
    }
    expect(
      origin.resolvePreviewRequest(new Request("http://127.0.0.1:3001/x")),
    ).toEqual({ refuse: { status: 503, reason: expect.any(String) } });
  });
});

// ── admission (AC6/AC2): closed = displayable reason, never a silent fallback ─

describe("preview origin admission", () => {
  test("previewOriginEnabled=false → preview hosts answer 503 with the reason; main hosts untouched", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    const closed = originWith({
      previewOriginTemplate: TEMPLATE,
      previewOriginEnabled: false,
    });
    // The host is still claimed by the preview branch — it must NOT fall through
    // to the main-site routes in any state.
    const request = new Request("https://whatever.preview.example.com/");
    expect(closed.handlesRequest(request)).toBe(true);
    expect(closed.resolvePreviewRequest(request)).toEqual({
      refuse: { status: 503, reason: expect.any(String) },
    });
    expect(origin.handlesRequest(new Request("http://localhost:3001/"))).toBe(
      false,
    );
  });

  test("webappProxyEnabled=false closes the preview origin too, with its own reason", () => {
    const closed = originWith({
      previewOriginTemplate: TEMPLATE,
      webappProxyEnabled: false,
    });
    const admission = closed.admission();
    expect(admission.ok).toBe(false);
    expect(
      closed.resolvePreviewRequest(
        new Request("https://x.preview.example.com/"),
      ).refuse?.status,
    ).toBe(503);
  });

  test("a template without {session} is a configuration error naming the variable", () => {
    const broken = originWith({
      previewOriginTemplate: "https://preview.example.com",
    });
    const admission = broken.admission();
    expect(admission.ok).toBe(false);
    if (!admission.ok) {
      expect(admission.reason).toContain("OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE");
    }
  });

  test("{session} must be the hostname's leading label — a mid-host or trailing {session} is closed, not parsed around", () => {
    for (const template of [
      "https://preview.{session}.example.com",
      "https://x.{session}",
    ]) {
      const broken = originWith({ previewOriginTemplate: template });
      const admission = broken.admission();
      expect(admission.ok).toBe(false);
      if (!admission.ok) {
        expect(admission.reason).toContain(
          "OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE",
        );
      }
    }
  });

  test("the leading-label check reads the RAW template — a `probe.` static prefix or a userinfo form stays closed", () => {
    // The two probe-URL escapes: both replace into a probe hostname that DOES
    // start "probe.", so a check on the replaced URL would accept them — the
    // first would mint undeclared *.probe.example.com addresses, the second
    // (userinfo never enters hostname) would claim the example.com APEX.
    for (const template of [
      "https://probe.{session}.example.com",
      "https://user@{session}.example.com",
    ]) {
      const broken = originWith({ previewOriginTemplate: template });
      const admission = broken.admission();
      expect(admission.ok).toBe(false);
      if (!admission.ok) {
        expect(admission.reason).toContain(
          "OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE",
        );
      }
      // Closed means claiming nothing: neither *.probe.example.com nor the
      // example.com apex may be pulled into the preview branch (AC6).
      expect(
        broken.handlesRequest(new Request("https://probe.example.com/")),
      ).toBe(false);
      expect(broken.handlesRequest(new Request("https://example.com/"))).toBe(
        false,
      );
      expect(() => broken.originFor(SESSION_ID)).toThrow();
    }
  });

  test("an empty base after {session}. (`https://{session}./`) is closed — never a wildcard claiming every trailing-dot host", () => {
    for (const template of ["https://{session}./", "http://{session}.:3001/"]) {
      const broken = originWith({ previewOriginTemplate: template });
      const admission = broken.admission();
      expect(admission.ok).toBe(false);
      if (!admission.ok) {
        expect(admission.reason).toContain(
          "OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE",
        );
      }
      // Closed means claiming nothing: no trailing-dot FQDN host may be pulled
      // into the preview branch's 404, and no dead address may be minted (AC6).
      expect(
        broken.handlesRequest(new Request("https://app.example.com./")),
      ).toBe(false);
      expect(() => broken.originFor(SESSION_ID)).toThrow();
    }
  });

  test("originFor answers absolute preview addresses only — never a same-origin shape", () => {
    const dev = originWith({}, { PORT: "3001" });
    const prod = originWith({ previewOriginTemplate: TEMPLATE });
    for (const address of [
      dev.originFor(SESSION_ID),
      prod.originFor(SESSION_ID),
    ]) {
      expect(address).toMatch(/^https?:\/\//);
      expect(address).not.toContain("/api/craft/");
    }
  });
});

// ── the redemption entry (#360's D9 closure lands here) ──────────────────────

describe("the preview origin entry: ticket redemption + the D9 cookie", () => {
  function entryCase(
    overrides: OriginOverrides,
    env: Record<string, string | undefined>,
    sessionId = SESSION_ID,
  ) {
    const { store } = fakeStore();
    const previewTickets = createPreviewTickets({ store });
    const origin = originWith(overrides, env, previewTickets);
    const address = origin.originFor(sessionId);
    const host = new URL(address).host;
    const { ticket } = previewTickets.issuePreviewTicket({
      sessionId,
      userId: USER_ID,
      previewHost: host,
    });
    return { origin, previewTickets, address, ticket };
  }

  test("a valid ticket redeems at the entry: 302 to a clean path with the session cookie planted (wildcard form)", async () => {
    const { origin, address, ticket } = entryCase(
      { previewOriginTemplate: TEMPLATE },
      {},
    );
    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/?ticket=${encodeURIComponent(ticket)}`),
    );
    expect(response.status).toBe(302);
    // The clean path: no ticket survives into the redirect target (D4).
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("location")).not.toContain(ticket);

    const cookie = response.headers.get("set-cookie") ?? "";
    // The D9 shape exactly: HttpOnly, Path=/, SameSite=Lax, and SESSION-LEVEL —
    // the absence of Max-Age and Expires is what makes the browser drop it at close.
    expect(cookie).toContain(`${PREVIEW_SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Max-Age");
    expect(cookie).not.toContain("Expires");
  });

  test("the dev form redeems the same way and redirects to the session's own path", async () => {
    const { origin, address, ticket } = entryCase({}, { PORT: "3001" });
    const label = new URL(address).pathname.replace(/^\//, "");
    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}?ticket=${encodeURIComponent(ticket)}`),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/${label}`);
  });

  test("the 302 never leaves by a protocol-relative Location (open redirect)", async () => {
    const { origin, address, ticket } = entryCase(
      { previewOriginTemplate: TEMPLATE },
      {},
    );
    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}//evil.com?ticket=${encodeURIComponent(ticket)}`),
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("//")).toBe(false);
    expect(location).not.toContain("evil.com");
  });

  test("an unknown or replayed ticket → 401, no cookie, and the ticket value appears nowhere", async () => {
    const { origin, address, ticket } = entryCase(
      { previewOriginTemplate: TEMPLATE },
      {},
    );
    const spend = () =>
      origin.handlePreviewRequest(
        SESSION_ID,
        new Request(`${address}/?ticket=${encodeURIComponent(ticket)}`),
      );
    await spend(); // the one true redemption
    const replay = await spend();
    expect(replay.status).toBe(401);
    expect(replay.headers.get("set-cookie")).toBeNull();
    const body = JSON.stringify(await replay.json());
    expect(body).not.toContain(ticket);

    const invented = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/?ticket=${encodeURIComponent("made-up-ticket")}`),
    );
    expect(invented.status).toBe(401);
    expect(JSON.stringify(await invented.json())).not.toContain(ticket);
  });

  test("admission closed → 503 before the ticket is consumed", async () => {
    const { previewTickets, address, ticket } = entryCase(
      { previewOriginTemplate: TEMPLATE },
      {},
    );
    const closed = originWith(
      { previewOriginTemplate: TEMPLATE, previewOriginEnabled: false },
      {},
      previewTickets,
    );
    const response = await closed.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/?ticket=${encodeURIComponent(ticket)}`),
    );
    expect(response.status).toBe(503);
    expect(previewTickets.size()).toBe(1); // untouched — the gate refused first
  });

  test("a ticket bound to another host does not redeem here (the triple's host element)", async () => {
    const { origin, address } = entryCase(
      { previewOriginTemplate: TEMPLATE },
      {},
    );
    const { store } = fakeStore();
    const stranger = createPreviewTickets({ store });
    const { ticket } = stranger.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: "evil.example:443",
    });
    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/?ticket=${encodeURIComponent(ticket)}`),
    );
    expect(response.status).toBe(401);
  });
});
