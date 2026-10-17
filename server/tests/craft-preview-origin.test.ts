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
// OWN session cookie — session-level (no Max-Age/Expires), HttpOnly, SameSite=None; Secure (#365 F-1).

import { describe, expect, test } from "bun:test";
import { loadCraftConfig } from "../src/craft/config";
import {
  createPreviewOrigin,
  type ServePreview,
} from "../src/craft/preview-origin";
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
  servePreview: ServePreview = async () =>
    new Response("unproxied", { status: 503 }),
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
    servePreview,
  });
}

// ── config: the two admission fields ───────────────────────────────────────

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

  // ── M-1 (#362): the deployment's main host can NEVER be claimed as preview ──
  //
  // AC1's isolation rests on this: if a main-site hostname could ever satisfy
  // the suffix match, preview traffic (cookie-gated, no platform session) would
  // land on the host that DOES carry the platform session — the exact crossing
  // the origin split exists to prevent. Near-miss hosts pin the boundary.
  test("M-1: suffix near-misses and the main host itself are never preview (AC1's premise)", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    for (const hostname of [
      "example.com", // the deployment's registrable domain, not the preview base
      "app.example.com", // a sibling subdomain of the main site
      "notpreview.example.com", // ends with "preview.example.com"'s tail, no dot boundary
      "preview.example.com.evil.com", // the base as a substring of an attacker host
      "xn--preview.example.com", // not the base, however it is spelled
    ]) {
      expect(origin.handlesRequest(new Request(`https://${hostname}/`))).toBe(
        false,
      );
    }
    // The base and its subdomains ARE claimed (fail closed inside the wildcard).
    for (const hostname of ["preview.example.com", "x.preview.example.com"]) {
      expect(origin.handlesRequest(new Request(`https://${hostname}/`))).toBe(
        true,
      );
    }
  });

  test("M-1 (dev form): only the exact 127.0.0.1 host is preview — every neighbour is main", () => {
    const origin = originWith({}, { PORT: "3001" });
    for (const hostname of [
      "localhost",
      "127.0.0.2",
      "0.0.0.0",
      "[::1]",
      "127.0.0.1.example.com",
    ]) {
      const request = new Request(`http://${hostname}:3001/`);
      expect(origin.handlesRequest(request)).toBe(false);
    }
  });

  // ── M-1 (#361 Pi 终审)：尾点 FQDN 绝不逃逸 ──────────────────────────────
  //
  // WHATWG URL 对非 IPv4 主机保留尾点（`x.preview.example.com.` 与
  // `x.preview.example.com` 是同一台主机），裸 endsWith 会漏判 → 已打开的预览
  // 页里相对跳到尾点形态的请求会落进主站路由——主站 cookie 就在那里。匹配前
  // 必须折叠尾点；主站主机的尾点形态照样不被 claim。
  test("M-1: a trailing-dot preview host is claimed and resolves the same session", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    const address = origin.originFor(SESSION_ID);
    const label = new URL(address).hostname.split(".")[0];

    const dotted = new Request(`https://${label}.preview.example.com./`);
    expect(origin.handlesRequest(dotted)).toBe(true);
    expect(origin.resolvePreviewRequest(dotted)).toEqual({
      sessionId: SESSION_ID,
    });

    // The apex's dotted form stays inside the namespace (404), never main.
    const apex = new Request("https://preview.example.com./");
    expect(origin.handlesRequest(apex)).toBe(true);
    expect(origin.resolvePreviewRequest(apex).refuse?.status).toBe(404);
  });

  test("M-1: a main-site host's trailing-dot form is still never preview", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    for (const hostname of [
      "app.example.com.",
      "example.com.",
      "notpreview.example.com.",
      "preview.example.com.evil.com.",
    ]) {
      expect(origin.handlesRequest(new Request(`https://${hostname}/`))).toBe(
        false,
      );
    }
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

  test("dev port 80: the default-port form is still the preview host (WHATWG drops http's :80)", () => {
    // WHATWG URL serialization drops http's default port: a listener on :80
    // sees `http://127.0.0.1/<label>/…` whose url.port is "" — a naive
    // `url.port === String(80)` never matches, the claim fails, and preview
    // traffic falls through to the main-site routes (#361 final review,
    // fixed in #363). Both spellings must claim; other ports must not.
    const origin = originWith({}, { PORT: "80" });
    expect(origin.originFor(SESSION_ID)).toMatch(
      /^http:\/\/127\.0\.0\.1\/[0-9a-f]+$/,
    );
    const address = origin.originFor(SESSION_ID);
    for (const url of [`${address}/`, "http://127.0.0.1:80/x"]) {
      expect(origin.handlesRequest(new Request(url))).toBe(true);
    }
    expect(origin.handlesRequest(new Request("http://127.0.0.1:3002/x"))).toBe(
      false,
    );
  });

  test("dev port 80: a ticket minted for the default-port address redeems there", async () => {
    // The triple's host element must round-trip: originFor mints a no-port
    // address, the browser presents `127.0.0.1` (no :80), and redemption
    // compares the two — a `:80` suffix on either side would refuse forever.
    const { store } = fakeStore();
    const previewTickets = createPreviewTickets({ store });
    const origin = originWith({}, { PORT: "80" }, previewTickets);
    const address = origin.originFor(SESSION_ID);
    const { ticket } = previewTickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: new URL(address).host,
    });
    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}?ticket=${encodeURIComponent(ticket)}`),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain(
      `${PREVIEW_SESSION_COOKIE}=`,
    );
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

  // ── 跨票吸收（#359 审阅 F2）：parseTemplate 边缘输入黄金用例 ────────────
  //
  // 这些形状旧实现会开闸（admission ok）但产出坏预览地址或与证书推导不匹配：
  // 尾点主机名、空 base、userinfo、IDN、下划线 label。全部收紧为 invalid，
  // 理由命名变量；合法形状（显式端口、普通多级域名）保持放行。
  test.each([
    "https://{session}.example.com.", // trailing-dot FQDN: originFor would mint a dotted address
    "https://{session}.", // empty base: <label>. is not a host anyone resolves
    "https://user@{session}.x.com", // userinfo smuggled in and silently dropped
    "https://user:pw@{session}.x.com",
    "https://{session}.例え.jp", // IDN: the cert derivation sees the ASCII form only
    "https://{session}.pre_view.example.com", // underscore is not a DNS label char
    "https://{session}.x.com:8443x", // malformed port
  ])(
    "parseTemplate refuses %p with a reason naming the variable",
    (template) => {
      const broken = originWith({ previewOriginTemplate: template });
      const admission = broken.admission();
      expect(admission.ok).toBe(false);
      if (!admission.ok) {
        expect(admission.reason).toContain(
          "OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE",
        );
      }
      expect(
        broken.resolvePreviewRequest(
          new Request("https://whatever.preview.example.com/"),
        ),
      ).toEqual({ refuse: { status: 503, reason: expect.any(String) } });
    },
  );

  // ── #361 检查点 96b8a2b8 的前导锚定（#362 重写 parseTemplate 时未迁移）────
  //
  // {session} 必须是 hostname 的前导 label，且在 RAW 模板上判定 —— 在替换后
  // 的 probe URL 上判定是可被欺骗的：`https://probe.{session}.…` 探针得到
  // probe.probe.example.com（放行），铸出未声明的 *.probe.example.com；
  // `https://{session}.x@evil.com` 的 userinfo 永远不进 hostname，base 会
  // 退化成 example.com apex。两者都必须 admission closed（AC6）。
  test("the leading-label check reads the RAW template — a `probe.` static prefix or a trailing userinfo form stays closed", () => {
    for (const template of [
      "https://probe.{session}.example.com",
      "https://{session}.x@evil.com",
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

  test("parseTemplate accepts the legitimate shapes: explicit port, multi-level base", () => {
    for (const template of [
      "https://{session}.x.com:8443",
      "https://{session}.a.b.example.com",
      "http://{session}.localhost:3001",
    ]) {
      const origin = originWith({ previewOriginTemplate: template });
      expect(origin.admission().ok).toBe(true);
      expect(origin.originFor(SESSION_ID)).toMatch(/^https?:\/\/\w+\./);
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
    // The D9 shape exactly: HttpOnly, Path=/, SameSite=None; Secure (#365 F-1:
    // the iframe is cross-site, Lax was refused), and SESSION-LEVEL — the
    // absence of Max-Age and Expires is what makes the browser drop it at close.
    expect(cookie).toContain(`${PREVIEW_SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    // Exact attribute boundary (R-9): the host form stays the root Path, and a
    // scoped dev Path must never satisfy this assertion by substring.
    expect(cookie).toContain("Path=/;");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Secure");
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

  test("a protocol-relative pathname cannot turn the redemption 302 into an open redirect (review-362 low)", async () => {
    const { origin, address, ticket } = entryCase(
      { previewOriginTemplate: TEMPLATE },
      {},
    );
    // `//evil.com` as a Location value is scheme-relative: the browser would
    // leave the preview origin entirely. The redemption must land on a
    // same-origin path — normalized, never echoed verbatim.
    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}//evil.com?ticket=${encodeURIComponent(ticket)}`),
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("//")).toBe(false);
    expect(location).toBe("/evil.com");
    // The redemption itself still worked — the pass is planted, only the
    // redirect target was normalized.
    expect(response.headers.get("set-cookie")).toContain(
      `${PREVIEW_SESSION_COOKIE}=`,
    );
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

// ── R-9 (OCR round 2, medium): the dev form's shared-host cookie isolation ───
//
// Every dev session lives on ONE shared host — 127.0.0.1:<SERVER_PORT> (D5) —
// so the redemption pass is one cookie-jar slot under Path=/: same name, same
// domain, same path means the LAST redeemer overwrites every earlier preview's
// pass, and the first-in iframe's traffic (and its HMR upgrade) sits at 401
// forever — preview-tab never re-redeems inside an entry's lifetime, so it
// never self-heals. The fix scopes the dev form's Set-Cookie to the session's
// own /<label> (the same path the dev server is mounted under, F-2):
// concurrent passes coexist in the jar, and the browser only ever sends the
// pass whose Path matches the address — exactly the label the request's own
// host resolution derived. The host form is one host per session and stays
// Path=/ (pinned in the redemption describe above).
describe("R-9: the dev form's cookie is scoped to the session's label path", () => {
  /** A store that owns several sessions — the shared host serves them all. */
  function multiSessionStore(...sessionIds: string[]) {
    const ids = new Set(sessionIds);
    return {
      async findSession(sessionId: string, userId: string) {
        return ids.has(sessionId) ? { id: sessionId, userId } : undefined;
      },
    } as unknown as CraftStore;
  }

  /** RFC 6265 §5.1.4 path-match — the browser rule that decides which stored
   * pass a request carries; the jar simulation below runs on exactly this. */
  function pathMatches(cookiePath: string, requestPath: string): boolean {
    if (requestPath === cookiePath) return true;
    return (
      requestPath.startsWith(cookiePath) &&
      (cookiePath.endsWith("/") ||
        requestPath.charAt(cookiePath.length) === "/")
    );
  }

  /** A cookie jar under Set-Cookie replace semantics: same name+path is a
   * REPLACE, never an append — the exact rule that made Path=/ one
   * overwriteable slot shared by every dev preview on the host. */
  function plant(
    jar: { value: string; path: string }[],
    setCookie: string,
  ): void {
    const path = /(?:^|; )Path=([^;]*)/.exec(setCookie)?.[1] ?? "/";
    const value = setCookie.split(";")[0]?.split("=").slice(1).join("=") ?? "";
    const at = jar.findIndex((entry) => entry.path === path);
    if (at >= 0) jar[at] = { value, path };
    else jar.push({ value, path });
  }

  function redeemingOrigin(sessionIds: string[]) {
    const store = multiSessionStore(...sessionIds);
    const tickets = createPreviewTickets({ store });
    const calls: { sessionId: string; appPath: string }[] = [];
    const servePreview: ServePreview = async ({ sessionId, appPath }) => {
      calls.push({ sessionId, appPath });
      return new Response("proxied-body", { status: 200 });
    };
    const origin = originWith({}, { PORT: "3001" }, tickets, servePreview);
    const redeem = async (sessionId: string) => {
      const address = origin.originFor(sessionId);
      const { ticket } = tickets.issuePreviewTicket({
        sessionId,
        userId: USER_ID,
        previewHost: new URL(address).host,
      });
      const response = await origin.handlePreviewRequest(
        sessionId,
        new Request(`${address}?ticket=${encodeURIComponent(ticket)}`),
      );
      return { address, response };
    };
    return { origin, redeem, calls };
  }

  test("two dev sessions redeem in sequence → both passes coexist in a browser jar, and the FIRST session's traffic (HMR path included) stays 200", async () => {
    const { origin, redeem, calls } = redeemingOrigin([
      SESSION_ID,
      OTHER_SESSION_ID,
    ]);

    const first = await redeem(SESSION_ID);
    const second = await redeem(OTHER_SESSION_ID);
    expect(first.response.status).toBe(302);
    expect(second.response.status).toBe(302);

    // The scoping itself: each pass rides its own session's label path.
    const firstLabel = new URL(first.address).pathname; // "/<labelA>"
    const secondLabel = new URL(second.address).pathname;
    expect(first.response.headers.get("set-cookie")).toContain(
      `Path=${firstLabel}`,
    );
    expect(second.response.headers.get("set-cookie")).toContain(
      `Path=${secondLabel}`,
    );
    expect(firstLabel).not.toBe(secondLabel);

    // A browser jar under Set-Cookie replace semantics: two passes coexist.
    // (Under the old Path=/ the second redemption REPLACED the first's slot
    // and this jar held exactly one entry — the later session's.)
    const jar: { value: string; path: string }[] = [];
    plant(jar, first.response.headers.get("set-cookie") ?? "");
    plant(jar, second.response.headers.get("set-cookie") ?? "");
    expect(jar).toHaveLength(2);

    // Path-filtered sends — the browser's rule: the FIRST session's follow-up
    // requests still carry ITS pass and gate through, the document path and
    // the HMR upgrade path /<label>/_next/… both under the scoped Path.
    const cookieHeaderFor = (pathname: string) =>
      jar
        .filter((entry) => pathMatches(entry.path, pathname))
        .map((entry) => `${PREVIEW_SESSION_COOKIE}=${entry.value}`)
        .join("; ");
    for (const pathname of [
      `${firstLabel}/api/things`,
      `${firstLabel}/_next/webpack-hmr`,
    ]) {
      const response = await origin.handlePreviewRequest(
        SESSION_ID,
        new Request(`http://127.0.0.1:3001${pathname}`, {
          headers: { cookie: cookieHeaderFor(pathname) },
        }),
      );
      expect(`${pathname}: ${response.status}`).toBe(`${pathname}: 200`);
    }
    expect(calls).toEqual([
      { sessionId: SESSION_ID, appPath: `${firstLabel}/api/things` },
      { sessionId: SESSION_ID, appPath: `${firstLabel}/_next/webpack-hmr` },
    ]);
  });

  test("the scoped dev pass keeps F-1's semantics: HttpOnly, SameSite=None; Secure, session-level (no Max-Age/Expires)", async () => {
    const { redeem } = redeemingOrigin([SESSION_ID]);
    const { address, response } = await redeem(SESSION_ID);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`Path=${new URL(address).pathname}`);
    // #365 F-1 rides along the scoped path unchanged: the iframe is
    // cross-site, None is the only attribute that crosses the hop, Secure
    // its escort — and D9's session-level shape must not be perturbed.
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain("Max-Age");
    expect(cookie).not.toContain("Expires");
  });
});

// ── M-2 (#362): the restart gap, accepted and pinned ──────────────────────────
//
// The label→session registry is in-memory by design (a restart-tolerant reverse
// index would be a store/DB column — deferred until a deployment needs it). What
// that means for a person: after a server restart, an already-open preview tab's
// reload answers 404 "Unknown preview host" until the main site re-enters (the
// webapp-info poll / a fresh ticket both re-mint the address, which re-registers
// the label). These tests pin BOTH halves so the behavior is a contract, not an
// accident.

describe("the restart gap (M-2, documented in docs/craft-preview-origin.md)", () => {
  test("a restarted registry 404s a previously-registered host (the reload answer)", () => {
    const before = originWith({ previewOriginTemplate: TEMPLATE });
    const address = before.originFor(SESSION_ID); // registers the label

    // A fresh instance with the SAME deployment secret: labels re-derive, the
    // reverse index does not survive.
    const after = originWith({ previewOriginTemplate: TEMPLATE });
    expect(
      after.resolvePreviewRequest(new Request(`${address}/`)),
    ).toEqual({ refuse: { status: 404, reason: expect.any(String) } });
  });

  test("recovery is the main-site hop: re-minting the address re-registers it", () => {
    const before = originWith({ previewOriginTemplate: TEMPLATE });
    const address = before.originFor(SESSION_ID);
    const after = originWith({ previewOriginTemplate: TEMPLATE });

    // The main-site re-entry (webapp-info's originFor, or a fresh ticket) — the
    // re-derived address is identical (stability) and now resolves again.
    expect(after.originFor(SESSION_ID)).toBe(address);
    expect(after.resolvePreviewRequest(new Request(`${address}/`))).toEqual({
      sessionId: SESSION_ID,
    });
  });

  test("the dev form restarts the same way: the path label forgets, re-minting restores", () => {
    const before = originWith({}, { PORT: "3001" });
    const address = before.originFor(SESSION_ID);
    const after = originWith({}, { PORT: "3001" });
    expect(
      after.resolvePreviewRequest(new Request(`${address}/some/path`)),
    ).toEqual({ refuse: { status: 404, reason: expect.any(String) } });
    expect(after.originFor(SESSION_ID)).toBe(address);
    expect(
      after.resolvePreviewRequest(new Request(`${address}/some/path`)),
    ).toEqual({ sessionId: SESSION_ID });
  });
});

// ── the preview's traffic: cookie-gated proxying (#362, AC1/AC2) ─────────────
//
// The redemption entry plants the preview domain's own cookie; every further
// request on the preview host — the app document, its API calls, Server Actions
// — is gated on THAT cookie and then handed to the session's dev server via the
// injected servePreview seam (webapp-proxy's createPreviewProxy in production).
// The gate is exact: the cookie must exist AND name THIS host's session, so a
// pass for session A never opens session B's host (and vice versa).

describe("appPathFor — the shared app-relative derivation (#363's HMR consumer)", () => {
  test("dev form: the pathname rides in full — the label included (F-2, #365)", () => {
    // The dev form's dev server mounts the app UNDER the label (its start
    // script injects ONYX_WEBAPP_BASE_PATH=/<label> — webappBasePathFor below),
    // so the upstream-resolvable path is the browser's pathname verbatim:
    // stripping the label here would dial the port root, where a basePath-
    //mounted Next answers 404 for everything (the F-2 gap: asset URLs 404ed
    // and the preview never hydrated).
    const origin = originWith({}, { PORT: "3001" });
    const address = origin.originFor(SESSION_ID);
    const label = new URL(address).pathname.replace(/^\//, "");
    expect(origin.appPathFor(new Request(`${address}/_next/webpack-hmr`))).toBe(
      `/${label}/_next/webpack-hmr`,
    );
    expect(origin.appPathFor(new Request(`${address}/`))).toBe(`/${label}/`);
    expect(origin.appPathFor(new Request(address))).toBe(`/${label}`);
  });

  test("host form: the pathname rides verbatim (the app lives at the origin root)", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    const address = origin.originFor(SESSION_ID);
    expect(origin.appPathFor(new Request(`${address}/_next/webpack-hmr`))).toBe(
      "/_next/webpack-hmr",
    );
    expect(origin.appPathFor(new Request(`${address}/deep/nested/path`))).toBe(
      "/deep/nested/path",
    );
  });
});

// ── F-2 (#365): the basePath the session's dev server must mount ──────────────
//
// The dev form's preview address is http://127.0.0.1:<port>/<label> — a PATH
// label, not a host label — so the app's own resource URLs must carry that
// label to resolve on the preview origin. The app cannot guess it: the start
// script's generated env injection is what mounts the dev server at /<label>,
// and THIS method is the one derivation both sides share (the same HMAC label
// originFor mints). The host form and any closed origin answer null — root
// path, the production behavior, unchanged (spec D3/D7; #364's retirement of
// the cwd-guessed basePath stays retired: env comes from the controlled start
// side, never a cwd sniff).

describe("webappBasePathFor — the dev server's mount for the preview's URL shape (F-2)", () => {
  test("dev form: /<label> — the same label the minted address rides", () => {
    const origin = originWith({}, { PORT: "3001" });
    const address = origin.originFor(SESSION_ID);
    const label = new URL(address).pathname.replace(/^\//, "");
    expect(origin.webappBasePathFor(SESSION_ID)).toBe(`/${label}`);
    // Stable like the address itself (AC6), and per-session distinct (AC9) —
    // never the session id, never another session's label.
    expect(origin.webappBasePathFor(SESSION_ID)).toBe(`/${label}`);
    expect(origin.webappBasePathFor(OTHER_SESSION_ID)).not.toBe(`/${label}`);
    // The F-2 invariant: every path the proxy forwards (appPathFor) is
    // addressable under the mount this method hands the start script —
    // prefix + the app-relative remainder, one derivation both sides share.
    expect(origin.appPathFor(new Request(`${address}/api/x`))).toBe(
      `${origin.webappBasePathFor(SESSION_ID)}/api/x`,
    );
  });

  test("host form: null — the app lives at the origin's root", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    expect(origin.webappBasePathFor(SESSION_ID)).toBeNull();
  });

  test("closed admission: null — a closed origin has no address shape to mirror", () => {
    const disabled = originWith(
      { previewOriginEnabled: false },
      { PORT: "3001" },
    );
    expect(disabled.webappBasePathFor(SESSION_ID)).toBeNull();
    const malformed = originWith({ previewOriginTemplate: "not a url" });
    expect(malformed.webappBasePathFor(SESSION_ID)).toBeNull();
  });
});

describe("the preview origin's proxied traffic (cookie gate + servePreview seam)", () => {
  type RecordedCall = {
    sessionId: string;
    appPath: string;
    query: string;
    method: string;
    cookie: string | null;
  };

  function recordingServe() {
    const calls: RecordedCall[] = [];
    const servePreview: ServePreview = async ({
      sessionId,
      request,
      appPath,
      query,
    }) => {
      calls.push({
        sessionId,
        appPath,
        query,
        method: request.method,
        cookie: request.headers.get("cookie"),
      });
      return new Response("proxied-body", { status: 200 });
    };
    return { calls, servePreview };
  }

  test("dev form: a valid cookie proxies the pathname in full — label included; method, query and cookie preserved", async () => {
    const { calls, servePreview } = recordingServe();
    const origin = originWith({}, { PORT: "3001" }, undefined, servePreview);
    const address = origin.originFor(SESSION_ID);
    const label = new URL(address).pathname.replace(/^\//, "");

    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/api/probe?x=1&y=2`, {
        method: "POST",
        headers: {
          cookie: `${PREVIEW_SESSION_COOKIE}=${SESSION_ID}; other=irrelevant`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("proxied-body");
    expect(calls).toEqual([
      {
        sessionId: SESSION_ID,
        appPath: `/${label}/api/probe`,
        query: "?x=1&y=2",
        method: "POST",
        cookie: `${PREVIEW_SESSION_COOKIE}=${SESSION_ID}; other=irrelevant`,
      },
    ]);
  });

  test("dev form: the bare label address proxies to the mount root, trailing slash or not", async () => {
    const { calls, servePreview } = recordingServe();
    const origin = originWith({}, { PORT: "3001" }, undefined, servePreview);
    const address = origin.originFor(SESSION_ID);
    const label = new URL(address).pathname.replace(/^\//, "");

    for (const suffix of ["", "/"]) {
      const response = await origin.handlePreviewRequest(
        SESSION_ID,
        new Request(`${address}${suffix}`, {
          headers: { cookie: `${PREVIEW_SESSION_COOKIE}=${SESSION_ID}` },
        }),
      );
      expect(response.status).toBe(200);
    }
    expect(calls.map((call) => call.appPath)).toEqual([
      `/${label}`,
      `/${label}/`,
    ]);
  });

  test("host form: a valid cookie proxies the pathname verbatim (the app lives at the origin root)", async () => {
    const { calls, servePreview } = recordingServe();
    const origin = originWith(
      { previewOriginTemplate: TEMPLATE },
      {},
      undefined,
      servePreview,
    );
    const address = origin.originFor(SESSION_ID);

    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/dashboard/settings?tab=2`, {
        headers: { cookie: `${PREVIEW_SESSION_COOKIE}=${SESSION_ID}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.appPath).toBe("/dashboard/settings");
    expect(calls[0]?.query).toBe("?tab=2");
  });

  test("no cookie → 401 for a programmatic caller, never proxied", async () => {
    const { calls, servePreview } = recordingServe();
    const origin = originWith(
      { previewOriginTemplate: TEMPLATE },
      {},
      undefined,
      servePreview,
    );
    const address = origin.originFor(SESSION_ID);

    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/api/probe`, { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a browser-shaped refusal is a readable HTML page (the iframe lands on it)", async () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    const address = origin.originFor(SESSION_ID);

    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(address, {
        headers: { accept: "text/html,application/xhtml+xml" },
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("<!"); // an actual page, not raw JSON in a frame
    // The cookie never echoes into the refusal.
    expect(body).not.toContain(PREVIEW_SESSION_COOKIE);
  });

  test("another session's pass on this host is refused — the cookie names THIS host's session", async () => {
    const { calls, servePreview } = recordingServe();
    const origin = originWith(
      { previewOriginTemplate: TEMPLATE },
      {},
      undefined,
      servePreview,
    );
    const address = origin.originFor(SESSION_ID);

    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/`, {
        headers: { cookie: `${PREVIEW_SESSION_COOKIE}=${OTHER_SESSION_ID}` },
      }),
    );
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("a cookie jar without the preview pass is refused", async () => {
    const origin = originWith({}, { PORT: "3001" });
    const address = origin.originFor(SESSION_ID);

    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/`, {
        headers: { cookie: "session=platform-cookie-value; theme=dark" },
      }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()) as { error: string }).toEqual({
      error: expect.any(String),
    });
  });

  test("admission closed → 503 with the reason before any cookie judgment", async () => {
    const { calls, servePreview } = recordingServe();
    const open = originWith(
      { previewOriginTemplate: TEMPLATE },
      {},
      undefined,
      servePreview,
    );
    const address = open.originFor(SESSION_ID);
    const closed = originWith(
      { previewOriginTemplate: TEMPLATE, previewOriginEnabled: false },
      {},
      undefined,
      servePreview,
    );

    const response = await closed.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/`, {
        headers: { cookie: `${PREVIEW_SESSION_COOKIE}=${SESSION_ID}` },
      }),
    );
    expect(response.status).toBe(503);
    expect(calls).toEqual([]);
  });
});

// ── review-365 M-1: the cookie gate reads the LAST preview pass, not the first ──
//
// RFC 6265 §5.4 sends a jar's same-named cookies longest-path first, so a
// shadow `openbot_preview_session` planted by preview-page JS on a deeper path
// (`document.cookie="openbot_preview_session=…; path=/<label>"` — HttpOnly
// does not stop a DEEPER same-name cookie) arrives in the Cookie header BEFORE
// the legitimate Path=/ pass the redemption hop planted. A first-match parser
// judges the shadow, so the defense-in-depth gate rests on a page-writable
// value. Last-match reads the jar in reverse specificity: the planted-at-`/`
// pass is the LAST same-named cookie sent, so the shadow loses. The Cookie
// header carries no path attribute (the server cannot see where a cookie was
// planted) — send order is the only signal, and it favors the legitimate pass.
describe("review-365 M-1: the cookie gate judges the last-sent preview pass", () => {
  function recordingServe() {
    const calls: unknown[] = [];
    const servePreview: ServePreview = async ({ sessionId, appPath, query }) => {
      calls.push({ sessionId, appPath, query });
      return new Response("proxied-body", { status: 200 });
    };
    return { calls, servePreview };
  }

  test("a shadow pass sent first never overrides the legitimate pass that follows it", async () => {
    const { calls, servePreview } = recordingServe();
    const origin = originWith(
      { previewOriginTemplate: TEMPLATE },
      {},
      undefined,
      servePreview,
    );
    const address = origin.originFor(SESSION_ID);

    // Shadow value first (a deeper-path cookie is sent first), legitimate pass
    // last — the jar the RFC's send order produces for a shadowed preview host.
    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/`, {
        headers: {
          cookie: `${PREVIEW_SESSION_COOKIE}=${OTHER_SESSION_ID}; ${PREVIEW_SESSION_COOKIE}=${SESSION_ID}`,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("a jar holding only the shadow value is still refused", async () => {
    const { calls, servePreview } = recordingServe();
    const origin = originWith(
      { previewOriginTemplate: TEMPLATE },
      {},
      undefined,
      servePreview,
    );
    const address = origin.originFor(SESSION_ID);

    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/`, {
        headers: {
          cookie: `${PREVIEW_SESSION_COOKIE}=${OTHER_SESSION_ID}; theme=dark`,
        },
      }),
    );

    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });
});
