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
import { createHmac } from "node:crypto";
import { loadCraftConfig } from "../src/craft/config";
import {
  createPreviewOrigin,
  type PreviewCookieScope,
  type ServePreview,
} from "../src/craft/preview-origin";
import { createPreviewPassCodec } from "../src/craft/preview-pass";
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

/** The pass codec the suite's origins derive from the SAME deps.secret — the
 * fixtures plant THIS shape as the preview pass, the signed value the gate now
 * verifies (the pre-repair fixtures planted the bare session id). */
const passCodec = createPreviewPassCodec(SECRET);
const passFor = (sessionId: string, userId = USER_ID) =>
  passCodec.issue(sessionId, userId);
const passCookie = (sessionId: string, userId = USER_ID) =>
  `${PREVIEW_SESSION_COOKIE}=${passFor(sessionId, userId)}`;

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
    expect(
      originWith({ previewOriginTemplate: TEMPLATE }).originFor(SESSION_ID),
    ).toBe(first);
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

  // ── fix-ocr3 (medium)：label HMAC 的域分离派生 ─────────────────────────────
  //
  // 库内成文惯例（server/src/auth/signed-value.ts 的 signingKey/sealingKey）：
  // 部署密钥从不直接做 MAC key——先在用途 label 下派生每用途密钥材料，
  // "a signature here can never be confused with a credential ciphertext
  // there"。preview label 原实现裸用 keyEncryptionKey（库内唯一无 label 用法），
  // 本用例钉住两级派生：label ≠ 裸 HMAC(KEK, sessionId)，且仍是 20 个小写 hex。
  test("the label is domain-separated from the bare key-encryption key (fix-ocr3 medium)", () => {
    const naive = createHmac("sha256", SECRET)
      .update(SESSION_ID)
      .digest("hex")
      .slice(0, 20);
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    const label = new URL(origin.originFor(SESSION_ID)).hostname.split(".")[0];
    expect(label).not.toBe(naive);
    // Still the committed shape: 20 lowercase hex chars, DNS-label safe.
    expect(label).toMatch(/^[0-9a-f]{20}$/);
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
    const request = new Request(
      "https://nobody-registered-this.preview.example.com/",
    );
    expect(origin.handlesRequest(request)).toBe(true);
    expect(origin.resolvePreviewRequest(request)).toEqual({
      refuse: { status: 404, reason: expect.any(String) },
    });
  });

  test("the preview apex and deeper hosts stay inside the preview namespace (404, not main)", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    for (const hostname of ["preview.example.com", "a.b.preview.example.com"]) {
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
    expect(origin.handlesRequest(new Request("https://app.example.com/"))).toBe(
      false,
    );
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

  // ── fix-ocr16: the fold must fold CLEAN — slice(0,-1) only ever folded ──
  // ONE trailing dot. `x.preview.example.com..` stayed one dot short of
  // normalized, the suffix match failed, and the host escaped the preview
  // namespace straight into the main-site routes — the exact leak the
  // "dotted forms never leak to the main site" declaration forbids. DNS
  // answers a multi-dot trailing form as the same host; every host-side
  // comparison must fold ALL trailing dots.
  test("fix-ocr16: a double-trailing-dot preview host is claimed and resolves the same session", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    const address = origin.originFor(SESSION_ID);
    const label = new URL(address).hostname.split(".")[0];

    const dotted = new Request(`https://${label}.preview.example.com../`);
    expect(origin.handlesRequest(dotted)).toBe(true);
    expect(origin.resolvePreviewRequest(dotted)).toEqual({
      sessionId: SESSION_ID,
    });

    // The apex's multi-dot form stays inside the namespace (404), never main.
    const apex = new Request("https://preview.example.com../");
    expect(origin.handlesRequest(apex)).toBe(true);
    expect(origin.resolvePreviewRequest(apex).refuse?.status).toBe(404);
  });

  test("fix-ocr16: a main-site host with doubled trailing dots is still never preview", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    for (const hostname of [
      "app.example.com..",
      "example.com..",
      "preview.example.com.evil.com..",
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

  // ── fix-ocr3 (critical)：dev 认领收紧后的语义 ─────────────────────────────
  //
  // 未注册首段不再被认领。安装形态（app/serve.ts）把全部 /api 以
  // fetch("http://127.0.0.1:<SERVER_PORT>/…") 转发（Host 头由目标 URL 派生），
  // 与 dev 形态预览共享同一台主机：`/api`、`/` 等未注册首段必须落回主站路由，
  // 否则安装形态主站被 preview 分支短路成 404。resolvePreviewRequest 的 404
  // 保留为防御——dispatcher 只在 handlesRequest 认领后才调它，dev 形态认领
  // 即注册命中，该分支对 dev 形态不可达、对 host 形态仍是主防线。
  test("an unregistered first segment on the dev host is NOT claimed — it falls back to the main site (fix-ocr3 critical)", () => {
    const origin = originWith({}, { PORT: "3001" });
    for (const path of ["/never-registered/", "/"]) {
      const request = new Request(`http://127.0.0.1:3001${path}`);
      expect(origin.handlesRequest(request)).toBe(false);
      // Defensive: direct resolution still answers 404, never a session.
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
    // fix-ocr3: all probes ride the REGISTERED label's path so this pins the
    // port logic alone — the registry dimension has its own tests above.
    const origin = originWith({}, { PORT: "80" });
    expect(origin.originFor(SESSION_ID)).toMatch(
      /^http:\/\/127\.0\.0\.1\/[0-9a-f]+$/,
    );
    const address = origin.originFor(SESSION_ID);
    const labelPath = new URL(address).pathname;
    for (const url of [`${address}/`, `http://127.0.0.1:80${labelPath}`]) {
      expect(origin.handlesRequest(new Request(url))).toBe(true);
    }
    expect(
      origin.handlesRequest(new Request(`http://127.0.0.1:3002${labelPath}`)),
    ).toBe(false);
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

// ── fix-ocr3 (critical)：dev 认领 = hostname + 已注册 label 的路径首段 ────────
//
// 安装形态（app/serve.ts）把全部 `/api` 以 fetch("http://127.0.0.1:<port>/…")
// 转发（Host 头由目标 URL 派生 = `127.0.0.1:<port>`），与 dev 形态预览共享
// 同一台主机。旧认领按 "hostname === 127.0.0.1 && 端口命中" 认领该主机上的
// 一切请求，dispatcher（index.ts）认领即短路主站 → `/api/...` 首段不在
// registry → 404 "Unknown preview host." → 安装形态主站瘫痪。dev 形态
// "主站走 localhost、预览走 127.0.0.1 两 host 分离"的设计假设被 serve.ts
// 打破。认领收紧一维：路径首段命中 registry（与 resolvePreviewRequest 的
// label 提取同一语义——leading path segment）。host 形态不动：整个 wildcard
// 域都是预览命名空间，无主站共存问题，fail-closed 全子域认领是正确语义。
describe("fix-ocr3: the dev form claims only registered label paths (install-form coexistence)", () => {
  test("a live session does NOT hand the preview branch `/api/...` — the install form's forwarded main-site traffic stays main", () => {
    // app/serve.ts 转发的 /api 请求 Host 头为 127.0.0.1:<SERVER_PORT>：
    // 即使某会话 label 已注册，/api 首段不在 registry，必须落回主站路由。
    const origin = originWith({}, { PORT: "3001" });
    origin.originFor(SESSION_ID); // a live session's label is registered
    expect(
      origin.handlesRequest(new Request("http://127.0.0.1:3001/api/health")),
    ).toBe(false);
  });

  test("an empty registry claims nothing on the dev host", () => {
    const origin = originWith({}, { PORT: "3001" });
    expect(
      origin.handlesRequest(new Request("http://127.0.0.1:3001/anything")),
    ).toBe(false);
  });

  test("a registered label's own paths stay claimed — assets included (regression pin)", () => {
    const origin = originWith({}, { PORT: "3001" });
    const address = origin.originFor(SESSION_ID);
    const label = new URL(address).pathname.replace(/^\//, "");
    expect(
      origin.handlesRequest(
        new Request(`http://127.0.0.1:3001/${label}/_next/static/x.js`),
      ),
    ).toBe(true);
  });

  test("an underivable port (PORT/SERVER_PORT conflict) claims nothing either — `/api/health` included", () => {
    // 旧实现在 devPort.port === undefined 时 `return true`，认领 127.0.0.1 上
    // 所有端口：认领面随 undefined 端口放大。收紧后未注册首段不认领，与端口
    // 是否可推导无关（准入关闭时 registry 亦无从注册）。
    const origin = originWith({}, { PORT: "3001", SERVER_PORT: "3002" });
    expect(
      origin.handlesRequest(new Request("http://127.0.0.1:3001/api/health")),
    ).toBe(false);
  });

  test("host form: an unknown subdomain under the base stays claimed (fail-closed, unchanged)", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    expect(
      origin.handlesRequest(
        new Request("https://unknown.preview.example.com/"),
      ),
    ).toBe(true);
  });
});

// ── fix-ocr22 #2: the localhost exemption cannot carry the wildcard claim ─────
//
// fix-ocr5 D kept `https://{session}.localhost:3001` as the local testing
// form, but the host branch claims "the whole hostname, any port" — so a
// localhost-base deployment claims the hostname `localhost` ITSELF: the local
// main site's traffic (localhost:<any port>) is swallowed into the preview
// branch and 404s "Unknown preview host." — the fix-ocr3 critical family all
// over again, on the host form this time. The claim narrows on two axes when
// the base is exactly localhost: the PORT must match the template's own port,
// and the bare apex (`localhost`, no label) is NEVER claimed — its traffic
// falls back to the main-site routes.
describe("fix-ocr22 #2: the localhost base claims only the template port, never the bare apex", () => {
  const LOCALHOST_TEMPLATE = "https://{session}.localhost:3001";

  test("bare localhost on any port is NOT claimed — main-site traffic falls back (was swallowed into a 404)", () => {
    const origin = originWith({ previewOriginTemplate: LOCALHOST_TEMPLATE });
    for (const url of [
      "https://localhost:3001/",
      "https://localhost:3002/",
      "http://localhost:3001/",
      "https://localhost/", // the scheme-default port is not the claim either
    ]) {
      expect(origin.handlesRequest(new Request(url))).toBe(false);
    }
  });

  test("regression pin: <label>.localhost:<template port> IS claimed and resolves its session", () => {
    const origin = originWith({ previewOriginTemplate: LOCALHOST_TEMPLATE });
    const address = origin.originFor(SESSION_ID); // https://<label>.localhost:3001
    const request = new Request(`${address}/`);
    expect(origin.handlesRequest(request)).toBe(true);
    expect(origin.resolvePreviewRequest(request)).toEqual({
      sessionId: SESSION_ID,
    });
  });

  test("a label host on the WRONG port is not claimed — the claim does not widen across ports", () => {
    const origin = originWith({ previewOriginTemplate: LOCALHOST_TEMPLATE });
    const address = origin.originFor(SESSION_ID);
    const wrongPort = new URL(address);
    wrongPort.port = "3002";
    expect(origin.handlesRequest(new Request(String(wrongPort)))).toBe(false);
  });

  test("a dotted localhost label host at the template port stays claimed (fold discipline unchanged)", () => {
    const origin = originWith({ previewOriginTemplate: LOCALHOST_TEMPLATE });
    const address = origin.originFor(SESSION_ID);
    const label = new URL(address).hostname.split(".")[0];
    expect(
      origin.handlesRequest(new Request(`https://${label}.localhost.:3001/`)),
    ).toBe(true);
  });

  test("non-localhost bases keep the whole-wildcard, any-port claim (fail-closed unchanged)", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    expect(
      origin.handlesRequest(new Request("https://preview.example.com/")),
    ).toBe(true);
    expect(
      origin.handlesRequest(
        new Request("https://x.preview.example.com:9999/"),
      ),
    ).toBe(true);
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
      expect(admission.reason).toContain(
        "OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE",
      );
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
    "https://{session}.x.com:0", // fix-ocr26 #9: port 0 has no serving meaning
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

  test("fix-ocr26 #9: port 0 is refused on BOTH faces — the server never serves what the sidecar refuses", () => {
    // WHATWG's parser accepts :0, but it has no serving meaning: the sidecar's
    // derive_preview_host rejects it (`-lt 1`, fix-ocr4 #5's category) and
    // crash-loops against a template the server used to accept. The server
    // now refuses it too — the same alignment discipline as :70000
    // (fix-ocr18 #8) and the bare `:` (fix-ocr4 #5).
    for (const template of [
      "https://{session}.x.com:0",
      "https://{session}.localhost:0",
      "https://{session}.x.com:00",
    ]) {
      const broken = originWith({ previewOriginTemplate: template });
      const admission = broken.admission();
      expect(admission.ok).toBe(false);
      if (!admission.ok) {
        expect(admission.reason).toContain(
          "OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE",
        );
      }
      expect(() => broken.originFor(SESSION_ID)).toThrow();
    }
  });

  test("parseTemplate accepts the legitimate shapes: explicit port, multi-label base", () => {
    for (const template of [
      "https://{session}.x.com:8443",
      "https://{session}.a.b.example.com",
      "https://{session}.localhost:3001",
      // fix-ocr4 #5 (two-口径一致): a bare trailing `:` is WHATWG's "empty
      // port = no port" — the URL parser normalizes it away, the sidecar's
      // derivation must agree (scripts/tls-pipeline.test.ts pins that side).
      // fix-ocr5 D renamed the host: the base must be multi-label (or exactly
      // localhost), so the bare-colon pin rides a dotted base now.
      "https://{session}.x.example.com:",
    ]) {
      const origin = originWith({ previewOriginTemplate: template });
      expect(origin.admission().ok).toBe(true);
      expect(origin.originFor(SESSION_ID)).toMatch(/^https?:\/\/\w+\./);
    }
  });

  // ── fix-ocr5 D: a single-label base claims an entire public suffix ──────
  //
  // `https://{session}.com` is a missing-base misconfiguration, not a
  // deployment: every host on earth ends with `.com`, so the wildcard's
  // suffix match (handlesRequest) would claim the whole space and the
  // dispatcher would 404 the entire site — the host-form twin of the
  // install-form paralysis fix-ocr3 closed. The base (everything after
  // `{session}.`) must be a multi-label domain (≥1 dot) or exactly
  // `localhost` (the local testing form — the existing
  // `https://{session}.localhost:3001` shape must keep passing).
  test("fix-ocr5 D: a single-label base like {session}.com is refused — it would claim a whole public suffix", () => {
    for (const template of ["https://{session}.com", "https://{session}.x:"]) {
      const broken = originWith({ previewOriginTemplate: template });
      const admission = broken.admission();
      expect(admission.ok).toBe(false);
      if (!admission.ok) {
        expect(admission.reason).toContain(
          "OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE",
        );
      }
      // Fail-closed (AC6): no address exists to route around the gate, and
      // the claimed namespace is empty — *.com is never pulled in.
      expect(() => broken.originFor(SESSION_ID)).toThrow();
      expect(broken.handlesRequest(new Request("https://abc.com/"))).toBe(
        false,
      );
      expect(broken.handlesRequest(new Request("https://x/"))).toBe(false);
    }
  });

  // ── fix-ocr27 #1: an IPv4-literal base is refused, and the refusal NAMES it ──
  //
  // `https://{session}.127.0.0.1:3001` (the dev address misfilled into the
  // template — a natural misconfiguration) has a dot-bearing base, so the
  // multi-label check alone would pass it, and its claim would be the
  // loopback apex: every `http://127.0.0.1:<any port>/…` request — the
  // install form's own /api forwarding included — would 404 "Unknown preview
  // host." (the fix-ocr3 critical family, host-form side). WHATWG's URL
  // parser happens to refuse these hosts itself (ends-in-a-number → IPv4
  // attempt → failure), which is why the refusal must be derived from the RAW
  // template text: the probe below never constructs, and the generic catch
  // names nothing the operator misconfigured.
  test("fix-ocr27 #1: an IPv4-literal base is refused with a reason that names it", () => {
    for (const template of [
      "https://{session}.127.0.0.1:3001",
      "https://{session}.127.0.0.1",
      "https://{session}.10.0.0.1:8443",
    ]) {
      const broken = originWith({ previewOriginTemplate: template });
      const admission = broken.admission();
      expect(admission.ok).toBe(false);
      if (!admission.ok) {
        expect(admission.reason).toContain(
          "OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE",
        );
        // The named refusal: the operator must read WHICH shape is wrong,
        // not the generic usage sentence.
        expect(admission.reason).toContain("IPv4");
      }
      // Fail-closed (AC6): no address exists, and the loopback host and port
      // space are never claimed into the preview namespace.
      expect(() => broken.originFor(SESSION_ID)).toThrow();
      expect(
        broken.handlesRequest(new Request("http://127.0.0.1:3001/")),
      ).toBe(false);
    }
  });

  // ── fix-ocr27 #2: an empty label anywhere in the base is refused ──────────
  //
  // `{session}..localhost` / `{session}.preview..example.com` pass the dot
  // check (WHATWG keeps empty interior labels parsable), but the wildcard
  // they produce is degenerate — and for the `.localhost` spelling the base
  // hostname is `..localhost`, so handlesRequest's port narrowing
  // (fix-ocr22 #2) never applies: the admission-open answer mints addresses
  // nothing routes. The base's labels must all be non-empty.
  test("fix-ocr27 #2: an empty label in the base is refused — the degenerate wildcard form", () => {
    for (const template of [
      "https://{session}..localhost",
      "https://{session}.preview..example.com",
    ]) {
      const broken = originWith({ previewOriginTemplate: template });
      const admission = broken.admission();
      // RED: both forms pass admission today (the dot check only counts
      // labels), minting unroutable degenerate wildcards.
      expect(admission.ok).toBe(false);
      if (!admission.ok) {
        expect(admission.reason).toContain(
          "OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE",
        );
      }
      expect(() => broken.originFor(SESSION_ID)).toThrow();
      expect(
        broken.handlesRequest(new Request("https://x..localhost/")),
      ).toBe(false);
    }
  });

  test("fix-ocr5 D: multi-label bases and exactly localhost stay ok", () => {
    for (const template of [
      "https://{session}.example.com",
      "https://{session}.localhost",
      "https://{session}.localhost:3001",
      "https://{session}.x.example.com:",
    ]) {
      const origin = originWith({ previewOriginTemplate: template });
      expect(origin.admission().ok).toBe(true);
      expect(origin.originFor(SESSION_ID)).toMatch(
        /^https?:\/\/[0-9a-f]{20}\./,
      );
    }
  });

  test("fix-ocr19 #9/fix-ocr27 #2: boundary hyphens stay ok; empty interior labels are now refused", () => {
    // Measured alignment (fix-ocr19 #9): WHATWG's domain-to-ASCII ACCEPTS a
    // hyphen at a label boundary (`a-.b`; UTS 46 CheckHyphens is off), so
    // new URL serves that template and the wildcard derivation in
    // scripts/tls-pipeline.test.ts pins the SAME base as ok — the two faces
    // agree on it. Empty interior labels (`a..b`) were pinned ok on both
    // faces by the same round; fix-ocr27 #2 tightens the SERVER side — they
    // mint degenerate wildcards and (for a `..localhost` base) bypass the
    // localhost claim narrowing — so the server now refuses what the sidecar
    // still accepts. That is a RECORDED lockstep deviation in the sidecar's
    // laxer direction, the same category as fix-ocr5 D's single-label base:
    // harmless because the server's gate refuses first (no address, no
    // serving origin exists to certify for), and LE would refuse an empty
    // label on its own terms anyway.
    const ok = originWith({ previewOriginTemplate: "https://{session}.a-.b" });
    expect(ok.admission().ok).toBe(true);
    expect(ok.originFor(SESSION_ID)).toMatch(/^https?:\/\/[0-9a-f]{20}\./);
    const emptyLabel = originWith({
      previewOriginTemplate: "https://{session}.a..b",
    });
    // RED (fix-ocr27 #2): this pin held ok before — the empty label passed
    // the dot check on both faces.
    expect(emptyLabel.admission().ok).toBe(false);
    expect(() => emptyLabel.originFor(SESSION_ID)).toThrow();
  });

  // ── fix-ocr4 #9: a non-https host template is refused ───────────────────
  // The preview pass cookie is hardcoded SameSite=None; Secure, and a
  // browser refuses a Secure cookie on a non-trustworthy (http) origin —
  // while an http cross-site iframe cannot carry a None cookie either. So an
  // http host template could never accept its own pass: whatever is
  // configured, the result is the 401 death loop the F-1 fix exists to
  // prevent, just under a misconfiguration. Admission closes fail-closed
  // (AC6's spirit); the dev form (127.0.0.1, a trustworthy origin where the
  // cookie demonstrably plants) is unaffected — it is the EMPTY template.
  // fix-ocr18 #9: the sidecar's derivation was aligned to this verdict (its
  // old skip drifted from it) — the cross-referenced golden case lives in
  // scripts/tls-pipeline.test.ts, "an http template is INVALID". The two
  // comments point at each other so the next change to either face updates
  // both.
  test("a non-https host template is refused: the preview cookie is SameSite=None; Secure", () => {
    const broken = originWith({
      previewOriginTemplate: "http://{session}.example.com",
    });
    const admission = broken.admission();
    expect(admission.ok).toBe(false);
    if (!admission.ok) {
      expect(admission.reason).toContain("https");
      expect(admission.reason).toContain("SameSite=None");
    }
    // Fail-closed: no address exists to route around the gate (AC6).
    expect(() => broken.originFor(SESSION_ID)).toThrow();
    expect(
      broken.handlesRequest(new Request("http://abc.preview.example.com/")),
    ).toBe(false);
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

  test("fix-ocr20 #2: //evil.com?ticket=… is off the entry root — never a redemption, never a 302", async () => {
    const { origin, address, ticket } = entryCase(
      { previewOriginTemplate: TEMPLATE },
      {},
    );
    // The old gate redeemed ANY path carrying ?ticket=, so a scheme-relative
    // pathname could ride the redemption hop and its Location had to be
    // normalized away from `//evil.com` (review-362 low). With redemption
    // pinned to the entry root, the premise is gone structurally: this shape
    // is now an ordinary request — the cookie gate answers it, the ticket is
    // not consumed, nothing is planted, and no redirect exists to hijack.
    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}//evil.com?ticket=${encodeURIComponent(ticket)}`),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();

    // The redemption 302's redirect target is the entry root ITSELF (the only
    // pathname that can reach it) — a same-origin path by construction, so
    // the scheme-relative echo the old normalization guarded against can no
    // longer exist. Pinned on both forms.
    const rootHost = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/?ticket=${encodeURIComponent(ticket)}`),
    );
    expect(rootHost.status).toBe(302);
    expect(rootHost.headers.get("location")).toBe("/");

    // Dev form: the entry root is /<label>, and that is what the 302 names.
    const { store } = fakeStore();
    const devTickets = createPreviewTickets({ store });
    const devOrigin = originWith({}, { PORT: "3001" }, devTickets);
    const devAddress2 = devOrigin.originFor(SESSION_ID);
    const { ticket: devTicket } = devTickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: new URL(devAddress2).host,
    });
    const rootDev = await devOrigin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${devAddress2}?ticket=${encodeURIComponent(devTicket)}`),
    );
    expect(rootDev.status).toBe(302);
    expect(rootDev.headers.get("location")).toBe(new URL(devAddress2).pathname);
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
    // fix-ocr27 #7: the redemption refusal rides the refusal family's
    // no-store discipline — a 401 describes a transient state (the ticket
    // burned, expired, or foreign) and is never a cacheable answer. RED:
    // this was the one refusal in the family without the header.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  // fix-ocr14: the dotted redemption host must redeem what the folded host
  // bound — the WHATWG URL keeps the FQDN trailing dot on the wire, and the
  // binding comparison folds it exactly like handlesRequest and
  // resolvePreviewRequest already do (`x.preview.example.com.` IS
  // `x.preview.example.com` to DNS and to the certificate): the dotted form
  // must never 401 a ticket issued for the undotted originFor address.
  test("fix-ocr14: a trailing-dot redemption host redeems the ticket bound to the folded host (no port)", async () => {
    const { origin, address, ticket } = entryCase(
      { previewOriginTemplate: TEMPLATE },
      {},
    );
    const label = new URL(address).hostname.split(".")[0];
    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(
        `https://${label}.preview.example.com./?ticket=${encodeURIComponent(ticket)}`,
      ),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain(
      `${PREVIEW_SESSION_COOKIE}=`,
    );
  });

  test("fix-ocr14: a trailing-dot redemption host with an explicit port keeps the port binding", async () => {
    const { origin, address, ticket } = entryCase(
      { previewOriginTemplate: "https://{session}.preview.example.com:8443" },
      {},
    );
    const label = new URL(address).hostname.split(".")[0];
    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(
        `https://${label}.preview.example.com.:8443/?ticket=${encodeURIComponent(ticket)}`,
      ),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain(
      `${PREVIEW_SESSION_COOKIE}=`,
    );
  });

  // fix-ocr16: the redemption binding folds the SAME way — a multi-dot FQDN
  // form must redeem the ticket its fully-folded host bound, never 401 on a
  // residual dot (the single-dot case is fix-ocr14's, unchanged).
  test("fix-ocr16: a double-trailing-dot redemption host redeems the folded binding", async () => {
    const { origin, address, ticket } = entryCase(
      { previewOriginTemplate: TEMPLATE },
      {},
    );
    const label = new URL(address).hostname.split(".")[0];
    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(
        `https://${label}.preview.example.com../?ticket=${encodeURIComponent(ticket)}`,
      ),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain(
      `${PREVIEW_SESSION_COOKIE}=`,
    );
  });

  // ── fix-ocr20 #2：兑换只发生在铸造地址根，?ticket= 别处是业务参数 ─────────
  //
  // 旧实现只要有 ?ticket= 就进兑换分支：LLM 生成应用里 `?ticket=5`（订单号、
  // 工单 id）是常见业务参数，全部被 401 拦死，永远到不了应用。兑换只发生在
  // 面板入口跳（铸造地址根：dev = /<label>，host = /），非根路径的
  // ?ticket= 必须按普通请求过 cookie 门后透传给应用（query 原样携带）。
  describe("fix-ocr20 #2: a ?ticket= off the entry root is a business parameter, not a redemption", () => {
    function recordingServe() {
      const calls: { sessionId: string; appPath: string; query: string }[] = [];
      const servePreview: ServePreview = async ({
        sessionId,
        appPath,
        query,
      }) => {
        calls.push({ sessionId, appPath, query });
        return new Response("proxied-body", { status: 200 });
      };
      return { calls, servePreview };
    }

    test("dev form: a valid pass + /<label>/detail?ticket=5 proxies through with the query intact (was a 401 interception)", async () => {
      const { calls, servePreview } = recordingServe();
      const origin = originWith({}, { PORT: "3001" }, undefined, servePreview);
      const address = origin.originFor(SESSION_ID);
      const label = new URL(address).pathname.replace(/^\//, "");

      const response = await origin.handlePreviewRequest(
        SESSION_ID,
        new Request(`${address}/detail?ticket=5`, {
          headers: { cookie: passCookie(SESSION_ID) },
        }),
      );
      expect(response.status).toBe(200);
      expect(calls).toEqual([
        {
          sessionId: SESSION_ID,
          appPath: `/${label}/detail`,
          query: "?ticket=5",
        },
      ]);
    });

    test("host form: a valid pass + /detail?ticket=5 proxies through with the query intact", async () => {
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
        new Request(`${address}/detail?ticket=5`, {
          headers: { cookie: passCookie(SESSION_ID) },
        }),
      );
      expect(response.status).toBe(200);
      expect(calls).toEqual([
        { sessionId: SESSION_ID, appPath: "/detail", query: "?ticket=5" },
      ]);
    });

    test("regression: the minted address root still redeems — dev /<label>?ticket=… → 302", async () => {
      const { store } = fakeStore();
      const previewTickets = createPreviewTickets({ store });
      const origin = originWith({}, { PORT: "3001" }, previewTickets);
      const address = origin.originFor(SESSION_ID);
      const { ticket } = previewTickets.issuePreviewTicket({
        sessionId: SESSION_ID,
        userId: USER_ID,
        previewHost: new URL(address).host,
      });
      const redemption = await origin.handlePreviewRequest(
        SESSION_ID,
        new Request(`${address}?ticket=${encodeURIComponent(ticket)}`),
      );
      expect(redemption.status).toBe(302);
      expect(redemption.headers.get("set-cookie")).toContain(
        `${PREVIEW_SESSION_COOKIE}=`,
      );
    });

    test("regression: the minted address root still redeems — host /?ticket=… → 302", async () => {
      const { store } = fakeStore();
      const previewTickets = createPreviewTickets({ store });
      const origin = originWith(
        { previewOriginTemplate: TEMPLATE },
        {},
        previewTickets,
      );
      const address = origin.originFor(SESSION_ID);
      const { ticket } = previewTickets.issuePreviewTicket({
        sessionId: SESSION_ID,
        userId: USER_ID,
        previewHost: new URL(address).host,
      });
      const redemption = await origin.handlePreviewRequest(
        SESSION_ID,
        new Request(`${address}/?ticket=${encodeURIComponent(ticket)}`),
      );
      expect(redemption.status).toBe(302);
      expect(redemption.headers.get("set-cookie")).toContain(
        `${PREVIEW_SESSION_COOKIE}=`,
      );
    });
  });
});

// ── fix-ocr22 #1: a valid pass never re-enters the redemption branch ──────────
//
// fix-ocr20 #2 pinned redemption to the entry ROOT, but the root itself still
// redeems unconditionally: an in-app navigation back to the session's own
// entry root CARRYING a business `?ticket=` parameter (an order id, a support
// case) while already holding a valid pass re-enters redemption, fails it
// (the business value is not a ticket) and 401s — and a refresh cannot
// self-heal, because the pass-holder never re-mints. Redemption therefore
// also requires NOT holding a valid pass: a pass-holder's entry-root
// ?ticket= is an ordinary request through the cookie gate, ticket and all.
describe("fix-ocr22 #1: a pass-holder's entry-root ?ticket= is a business parameter, not a redemption", () => {
  function recordingServe() {
    const calls: { sessionId: string; appPath: string; query: string }[] = [];
    const servePreview: ServePreview = async ({
      sessionId,
      appPath,
      query,
    }) => {
      calls.push({ sessionId, appPath, query });
      return new Response("proxied-body", { status: 200 });
    };
    return { calls, servePreview };
  }

  test("host form: entry root + ?ticket=5 + a valid pass → proxied with the query intact (was a 401 death loop)", async () => {
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
      new Request(`${address}/?ticket=5`, {
        headers: { cookie: passCookie(SESSION_ID) },
      }),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { sessionId: SESSION_ID, appPath: "/", query: "?ticket=5" },
    ]);
  });

  test("dev form: /<label>?ticket=5 + a valid pass → proxied (the in-app jump back to the entry root)", async () => {
    const { calls, servePreview } = recordingServe();
    const origin = originWith({}, { PORT: "3001" }, undefined, servePreview);
    const address = origin.originFor(SESSION_ID);
    const label = new URL(address).pathname.replace(/^\//, "");

    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}?ticket=5`, {
        headers: { cookie: passCookie(SESSION_ID) },
      }),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { sessionId: SESSION_ID, appPath: `/${label}`, query: "?ticket=5" },
    ]);
  });

  test("regression pin: WITHOUT a pass the entry root still redeems — 302 + cookie", async () => {
    const { store } = fakeStore();
    const previewTickets = createPreviewTickets({ store });
    const origin = originWith(
      { previewOriginTemplate: TEMPLATE },
      {},
      previewTickets,
    );
    const address = origin.originFor(SESSION_ID);
    const { ticket } = previewTickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: new URL(address).host,
    });
    const redemption = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/?ticket=${encodeURIComponent(ticket)}`),
    );
    expect(redemption.status).toBe(302);
    expect(redemption.headers.get("set-cookie")).toContain(
      `${PREVIEW_SESSION_COOKIE}=`,
    );
  });

  test("a pass-holder at the entry root WITHOUT ?ticket= keeps proxying (the gate's ordinary shape)", async () => {
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
        headers: { cookie: passCookie(SESSION_ID) },
      }),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { sessionId: SESSION_ID, appPath: "/", query: "" },
    ]);
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
    expect(after.resolvePreviewRequest(new Request(`${address}/`))).toEqual({
      refuse: { status: 404, reason: expect.any(String) },
    });
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
          cookie: `${PREVIEW_SESSION_COOKIE}=${passFor(SESSION_ID)}; other=irrelevant`,
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
        cookie: `${passCookie(SESSION_ID)}; other=irrelevant`,
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
          headers: { cookie: passCookie(SESSION_ID) },
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
        headers: { cookie: passCookie(SESSION_ID) },
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
        headers: { cookie: `${PREVIEW_SESSION_COOKIE}=${passFor(OTHER_SESSION_ID)}` },
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
        headers: { cookie: passCookie(SESSION_ID) },
      }),
    );
    expect(response.status).toBe(503);
    expect(calls).toEqual([]);
  });
});

// ── fix-ocr20 #3: the cookie gate judges ANY same-named candidate that names
// this session (supersedes fix-ocr5 E's first-match) ──────────────────────
//
// RFC 6265 §5.4 sends a jar's same-named cookies longest-path first, so the
// wire ORDER is by descending path — but the order alone does not identify
// the pass: a preview page can plant a same-named cookie on ANY path deeper
// than the pass's own (HttpOnly only protects the exact name+domain+path
// slot, so the deep slot is legal, and §5.4 puts it FIRST on the wire).
// fix-ocr5 E's first-match read exactly one value — the longest-path one —
// which neutralized only the SHALLOW shadow (Path=/, sent last): a DEEP
// shadow (e.g. dev-form session A planting Path=/<labelB>/x) precedes B's
// legitimate pass on the wire, first-match judged the shadow, and B sat at
// 401 until the jar was scrubbed by hand — one preview page's plant was a
// cross-session 401 DoS on the shared dev host.
//
// The gate therefore collects EVERY same-named value (§5.4 wire order) and
// passes when ANY candidate names THIS host's session; only a jar where no
// candidate matches is refused. The exactness is unchanged — the pass VALUE
// (the session id itself) is still the only thing that opens the gate, and
// a jar without it is still 401; what changes is that a shadow can no
// longer MASK a pass that is present. (Remaining risk, still recorded:
// the value is the session id, not an unguessable credential — the
// redemption hop's "ponytail" note stands.)
describe("fix-ocr20 #3: the cookie gate accepts the pass wherever it rides in the jar", () => {
  function recordingServe() {
    const calls: unknown[] = [];
    const servePreview: ServePreview = async ({
      sessionId,
      appPath,
      query,
    }) => {
      calls.push({ sessionId, appPath, query });
      return new Response("proxied-body", { status: 200 });
    };
    return { calls, servePreview };
  }

  test("a Path=/ shadow ordered AFTER the pass never wins (the shallow-shadow regression, fix-ocr5 E's case)", async () => {
    const { calls, servePreview } = recordingServe();
    const origin = originWith(
      { previewOriginTemplate: TEMPLATE },
      {},
      undefined,
      servePreview,
    );
    const address = origin.originFor(SESSION_ID);

    // The legitimate pass (longest path) first, the planted shadow (Path=/,
    // shortest) last — the pass is judged, the shadow never wins.
    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/`, {
        headers: {
          cookie: `${PREVIEW_SESSION_COOKIE}=${passFor(SESSION_ID)}; ${PREVIEW_SESSION_COOKIE}=shadow-garbage`,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("a deep-path shadow ordered BEFORE the pass no longer masks it — the pass still opens the gate (was a cross-session 401 DoS)", async () => {
    const { calls, servePreview } = recordingServe();
    const origin = originWith(
      { previewOriginTemplate: TEMPLATE },
      {},
      undefined,
      servePreview,
    );
    const address = origin.originFor(SESSION_ID);

    // §5.4's longest-first wire order with a DEEP shadow: another value
    // precedes the pass on the wire (a preview page planted it on a deeper
    // path — legal, HttpOnly protects only the pass's own slot). First-match
    // judged the shadow and 401'd the session (the fix-ocr5 E DoS, deeper
    // twin); any-candidate-match finds the pass and proxies.
    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/`, {
        headers: {
          cookie: `${PREVIEW_SESSION_COOKIE}=${passFor(OTHER_SESSION_ID)}; ${PREVIEW_SESSION_COOKIE}=${passFor(SESSION_ID)}`,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("dev form: session A's deep shadow (Path=/<labelB>/x) ahead of B's pass on the shared host does not 401 B", async () => {
    // The brief's exact scenario: one shared dev host, A's preview page
    // plants a deep shadow whose path sorts before B's pass; B's own
    // traffic must still gate through.
    const { calls, servePreview } = recordingServe();
    const origin = originWith({}, { PORT: "3001" }, undefined, servePreview);
    const addressB = origin.originFor(OTHER_SESSION_ID); // registers B's label

    const response = await origin.handlePreviewRequest(
      OTHER_SESSION_ID,
      new Request(`${addressB}/api/things`, {
        headers: {
          // A's deep shadow (A's own signed pass) first, B's pass after.
          cookie: `${PREVIEW_SESSION_COOKIE}=${passFor(SESSION_ID)}; ${PREVIEW_SESSION_COOKIE}=${passFor(OTHER_SESSION_ID)}`,
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("a jar holding only shadow values — no candidate names this session — is still refused", async () => {
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
          cookie: `${PREVIEW_SESSION_COOKIE}=${passFor(OTHER_SESSION_ID)}; ${PREVIEW_SESSION_COOKIE}=shadow-garbage; theme=dark`,
        },
      }),
    );

    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });
});

// ── fix-ocr13: hasSession — the registry reverse lookup the same-origin probe reads ──

describe("hasSession (fix-ocr13: the same-origin probe's registry half)", () => {
  test("originFor registers: true for that session, false for a session never entered", () => {
    const origin = originWith();
    origin.originFor(SESSION_ID);
    expect(origin.hasSession(SESSION_ID)).toBe(true);
    expect(origin.hasSession(OTHER_SESSION_ID)).toBe(false);
  });

  test("a fresh instance is the restart state (M-2): the label answers false", () => {
    const before = originWith();
    before.originFor(SESSION_ID);
    // A new server process = a new instance = an empty registry. The session
    // row survives (durable); its label does not — exactly the verdict the
    // pane's probe exists to read.
    expect(originWith().hasSession(SESSION_ID)).toBe(false);
  });
});

// ── #358 repair Task 2: the gate verifies a SIGNED pass, never a bare id ────
//
// Before the repair the pass WAS the session id: a request that knew the
// preview address and the session id presented `openbot_preview_session=<id>`
// and the gate compared it equal — no ticket redeemed, no signature, AC4
// bypassed. The gate now runs the pass codec: the cookie must be a pass the
// deployment signed for (sessionId, userId) at ticket redemption, the userId
// rides the verified claim to the proxy, and the store re-checks the owner.
// The forged shapes below are exactly the Review Focus inputs 1–3.
describe("#358 repair: the gate accepts only a deployment-signed pass", () => {
  /** The codec the origin derives from the SAME deployment secret (deps.secret). */
  const passCodec = createPreviewPassCodec(SECRET);
  const passFor = (sessionId: string, userId = USER_ID) =>
    passCodec.issue(sessionId, userId);
  const passCookie = (sessionId: string, userId = USER_ID) =>
    `${PREVIEW_SESSION_COOKIE}=${passFor(sessionId, userId)}`;

  function recordingServe() {
    const calls: { sessionId: string; userId: string; appPath: string }[] = [];
    const servePreview: ServePreview = async ({
      sessionId,
      userId,
      appPath,
    }) => {
      calls.push({ sessionId, userId, appPath });
      return new Response("proxied-body", { status: 200 });
    };
    return { calls, servePreview };
  }

  test("Review Focus 1: a forged plaintext session-id cookie is 401 on GET and POST, and servePreview is never reached", async () => {
    const { calls, servePreview } = recordingServe();
    const origin = originWith(
      { previewOriginTemplate: TEMPLATE },
      {},
      undefined,
      servePreview,
    );
    const address = origin.originFor(SESSION_ID);

    for (const method of ["GET", "POST"]) {
      const response = await origin.handlePreviewRequest(
        SESSION_ID,
        new Request(`${address}/api/things`, {
          method,
          headers: { cookie: `${PREVIEW_SESSION_COOKIE}=${SESSION_ID}` },
          body: method === "POST" ? "{}" : undefined,
        }),
      );
      expect(`${method}: ${response.status}`).toBe(`${method}: 401`);
    }
    // The bypass is closed at the seam that matters: zero proxy dials.
    expect(calls).toEqual([]);
  });

  test("Review Focus 1 (dev form): the same forged cookie on 127.0.0.1/<label> is 401", async () => {
    const { calls, servePreview } = recordingServe();
    const origin = originWith({}, { PORT: "3001" }, undefined, servePreview);
    const address = origin.originFor(SESSION_ID);

    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/api/things`, {
        headers: { cookie: `${PREVIEW_SESSION_COOKIE}=${SESSION_ID}` },
      }),
    );
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("redemption plants a SIGNED pass — the cookie value is verifiable and is NOT the session id", async () => {
    const { store } = fakeStore();
    const previewTickets = createPreviewTickets({ store });
    const origin = originWith(
      { previewOriginTemplate: TEMPLATE },
      {},
      previewTickets,
    );
    const address = origin.originFor(SESSION_ID);
    const { ticket } = previewTickets.issuePreviewTicket({
      sessionId: SESSION_ID,
      userId: USER_ID,
      previewHost: new URL(address).host,
    });

    const redemption = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/?ticket=${encodeURIComponent(ticket)}`),
    );
    expect(redemption.status).toBe(302);
    const cookie = redemption.headers.get("set-cookie") ?? "";
    const planted = cookie
      .split(";")[0]
      ?.split("=")
      .slice(1)
      .join("=") ?? "";
    // The repair's core: the planted value is a deployment-signed pass bound
    // to (SESSION_ID, USER_ID) — not the raw session id the old code echoed.
    expect(planted).not.toBe(SESSION_ID);
    expect(passCodec.verify(SESSION_ID, planted)).toEqual({ userId: USER_ID });

    // And the planted pass opens the gate it was minted for.
    const { calls, servePreview } = recordingServe();
    const gated = originWith(
      { previewOriginTemplate: TEMPLATE },
      {},
      undefined,
      servePreview,
    );
    const gatedResponse = await gated.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/api/things`, {
        headers: { cookie: `${PREVIEW_SESSION_COOKIE}=${planted}` },
      }),
    );
    expect(gatedResponse.status).toBe(200);
    // The verified userId claim rides to the proxy — the ownership re-check's input.
    expect(calls).toEqual([
      { sessionId: SESSION_ID, userId: USER_ID, appPath: "/api/things" },
    ]);
  });

  test("Review Focus 2: a valid pass with one flipped MAC byte is 401 on the HTTP gate and verifyPass both", async () => {
    const { calls, servePreview } = recordingServe();
    const origin = originWith(
      { previewOriginTemplate: TEMPLATE },
      {},
      undefined,
      servePreview,
    );
    const address = origin.originFor(SESSION_ID);

    const parts = passFor(SESSION_ID).split(".");
    const mac = parts[2] ?? "";
    const flipped = `${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
    const tampered = `${parts[0]}.${parts[1]}.${flipped}`;

    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/`, {
        headers: { cookie: `${PREVIEW_SESSION_COOKIE}=${tampered}` },
      }),
    );
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
    // The same judgment the HMR twin consumes (#363's seam): one verifyPass,
    // both surfaces.
    expect(
      origin.verifyPass(
        SESSION_ID,
        new Request(`${address}/`, {
          headers: { cookie: `${PREVIEW_SESSION_COOKIE}=${tampered}` },
        }),
      ),
    ).toBeNull();
  });

  test("Review Focus 2: a pass minted under another deployment key is 401 (cross-key replay)", async () => {
    const { calls, servePreview } = recordingServe();
    const origin = originWith(
      { previewOriginTemplate: TEMPLATE },
      {},
      undefined,
      servePreview,
    );
    const address = origin.originFor(SESSION_ID);
    const foreign = createPreviewPassCodec("another-deployment-key").issue(
      SESSION_ID,
      USER_ID,
    );

    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/`, {
        headers: { cookie: `${PREVIEW_SESSION_COOKIE}=${foreign}` },
      }),
    );
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("Review Focus 3: the verified userId rides to the seam — ownership is the SEAM's re-check, and its refusal propagates", async () => {
    // Where the owner re-check lives is the seam contract: the origin's gate
    // verifies the signature and hands the verified claim to servePreview
    // (the real one is createPreviewProxy, whose findSession(sessionId,
    // userId) miss is a 404 — pinned at the proxy seam in the rejection
    // suite). This test pins the GLUE: a seam doing the real seam's re-check
    // answers 404 through the origin, for a pass whose signature is still
    // perfectly valid.
    const owners = new Map([[SESSION_ID, USER_ID]]);
    const calls: { sessionId: string; userId: string; status: number }[] = [];
    const servePreview: ServePreview = async ({ sessionId, userId }) => {
      const status = owners.get(sessionId) === userId ? 200 : 404;
      calls.push({ sessionId, userId, status });
      return new Response(
        JSON.stringify({ error: "This preview session no longer exists." }),
        { status },
      );
    };
    const origin = originWith(
      { previewOriginTemplate: TEMPLATE },
      {},
      undefined,
      servePreview,
    );
    const address = origin.originFor(SESSION_ID);

    const before = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/`, { headers: { cookie: passCookie(SESSION_ID) } }),
    );
    expect(before.status).toBe(200);

    // Reassigned after issue: the signature still verifies, the owner does not.
    owners.set(SESSION_ID, "u2");
    const after = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/`, { headers: { cookie: passCookie(SESSION_ID) } }),
    );
    expect(after.status).toBe(404);
    // The verified claim (the ORIGINAL owner) is what the seam saw both times.
    expect(calls).toEqual([
      { sessionId: SESSION_ID, userId: USER_ID, status: 200 },
      { sessionId: SESSION_ID, userId: USER_ID, status: 404 },
    ]);
  });

  test("verifyPass accepts the valid candidate among same-named shadows and refuses a jar without one", () => {
    const origin = originWith({ previewOriginTemplate: TEMPLATE });
    const address = origin.originFor(SESSION_ID);
    const withShadow = new Request(`${address}/`, {
      headers: {
        // RFC 6265 §5.4 wire order: the deep-path shadow rides FIRST — the
        // valid pass behind it must still be found (fix-ocr20 #3's jar rule,
        // now signature-shaped).
        cookie: `${PREVIEW_SESSION_COOKIE}=planted-shadow; ${passCookie(SESSION_ID)}`,
      },
    });
    expect(origin.verifyPass(SESSION_ID, withShadow)).toEqual({
      userId: USER_ID,
    });

    const shadowOnly = new Request(`${address}/`, {
      headers: { cookie: `${PREVIEW_SESSION_COOKIE}=planted-shadow` },
    });
    expect(origin.verifyPass(SESSION_ID, shadowOnly)).toBeNull();
  });

  test("Review Focus 4: two dev /<label> passes coexist — each serves its own session, and cross-session passes are refused", async () => {
    const { store } = {
      store: {
        async findSession(sessionId: string, userId: string) {
          return [SESSION_ID, OTHER_SESSION_ID].includes(sessionId) &&
            userId === USER_ID
            ? { id: sessionId, userId }
            : undefined;
        },
      } as unknown as CraftStore,
    };
    const calls: { sessionId: string; userId: string; appPath: string }[] = [];
    const servePreview: ServePreview = async ({
      sessionId,
      userId,
      appPath,
    }) => {
      calls.push({ sessionId, userId, appPath });
      return new Response("proxied-body", { status: 200 });
    };
    const origin = originWith({}, { PORT: "3001" }, undefined, servePreview);
    const addressA = origin.originFor(SESSION_ID);
    const addressB = origin.originFor(OTHER_SESSION_ID);
    const labelA = new URL(addressA).pathname;
    const labelB = new URL(addressB).pathname;

    // Both jars ride together (the dev form's scoped-path coexistence, R-9).
    const bothCookies = `${passCookie(SESSION_ID)}; ${passCookie(OTHER_SESSION_ID)}`;
    const okA = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`http://127.0.0.1:3001${labelA}/api/things`, {
        headers: { cookie: bothCookies },
      }),
    );
    const okB = await origin.handlePreviewRequest(
      OTHER_SESSION_ID,
      new Request(`http://127.0.0.1:3001${labelB}/api/things`, {
        headers: { cookie: bothCookies },
      }),
    );
    expect(okA.status).toBe(200);
    expect(okB.status).toBe(200);
    expect(calls).toEqual([
      { sessionId: SESSION_ID, userId: USER_ID, appPath: `${labelA}/api/things` },
      {
        sessionId: OTHER_SESSION_ID,
        userId: USER_ID,
        appPath: `${labelB}/api/things`,
      },
    ]);
  });
});

// ── #405: the cookie scope the origin derives for the serving seam ───────────
//
// The proxy rewrites what the app sets, but only the routing side knows the
// mount and the site relation — and the mount it names must be the SAME one the
// pass cookie rides (R-9), or two cookies the same browser treats as one jar
// would disagree about scope. These pin the seam's input, not the proxy's
// handling of it (craft-webapp-proxy.test.ts owns that half).

describe("#405: the cookie scope the preview origin derives", () => {
  function scopeServe() {
    const scopes: PreviewCookieScope[] = [];
    const servePreview: ServePreview = async ({ cookieScope }) => {
      scopes.push(cookieScope);
      return new Response("proxied", { status: 200 });
    };
    return { scopes, servePreview };
  }

  test("dev form: the app's cookies are scoped to the session's own label mount, on a cross-site host", async () => {
    const { scopes, servePreview } = scopeServe();
    const origin = originWith({}, { PORT: "3001" }, undefined, servePreview);
    const address = origin.originFor(SESSION_ID);
    const label = new URL(address).pathname;

    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/api/tasks`, {
        headers: { cookie: passCookie(SESSION_ID) },
      }),
    );

    expect(response.status).toBe(200);
    expect(scopes).toEqual([{ path: label, crossSite: true }]);
    // The one read discipline (fix-ocr23 #7): the scope's path IS the entry
    // root the pass's own Path was minted from.
    expect(label).toBe(origin.webappBasePathFor(SESSION_ID));
  });

  test("host form: the origin's root, and NOT cross-site — nothing gets loosened", async () => {
    const { scopes, servePreview } = scopeServe();
    const origin = originWith(
      { previewOriginTemplate: TEMPLATE },
      {},
      undefined,
      servePreview,
    );
    const address = origin.originFor(SESSION_ID);

    const response = await origin.handlePreviewRequest(
      SESSION_ID,
      new Request(`${address}/api/tasks`, {
        headers: { cookie: passCookie(SESSION_ID) },
      }),
    );

    expect(response.status).toBe(200);
    // One host per session (D3): the app's cookies are already isolated by the
    // hostname, and the main site shares its eTLD+1 — so Path=/ and the app's
    // own SameSite, exactly as the pass mint's null → "/" reads the same mount.
    expect(scopes).toEqual([{ path: "/", crossSite: false }]);
    expect(origin.webappBasePathFor(SESSION_ID)).toBeNull();
  });
});
