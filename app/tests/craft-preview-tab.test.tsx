import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import {
  cleanup,
  fireEvent,
  type RenderResult,
  render,
  waitFor,
} from "@testing-library/react";
import {
  PreviewTab,
  previewEntryUrl,
  previewOriginBlocked,
  previewPollInterval,
} from "@/components/craft/output-panel/preview-tab";
import i18n from "@/lib/i18n";
import { craftKeys } from "@/lib/craft/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * THE PREVIEW PANE NEVER RENDERS THE PROXY'S ERROR BODY.
 *
 * The bug this pins: `webapp-info` answers `has_webapp: true` as soon as the scaffold exists,
 * while `ready` is the honest "a dev server is serving on the reserved port" fact. The pane gated
 * the iframe on `has_webapp` alone, so a session whose server had died (a cancelled `webapp start`,
 * a recycled sandbox) pointed an iframe at the proxy — and the proxy's 503 JSON,
 * `{"error":"The web app is not running. Ask the agent to call the webapp tool with action
 * 'start'."}`, was what the person saw in the preview.
 *
 * `ready` is the gate now, the down state is a real pane, and the pane keeps polling while an app
 * exists but is not serving, so the preview comes alive on its own the moment the server does.
 */

beforeAll(() =>
  GlobalRegistrator.register({
    url: "http://localhost/",
    // fix-ocr5 M-2: a frame element replaced while the entry lives mounts
    // carrying the spent ticket's src for exactly one commit — the pane's
    // own re-render replaces it before a browser would paint, but happy-dom
    // kicks off the child-frame navigation synchronously and its ECONNREFUSED
    // surfaces as an unhandled error inside whichever test is running. No
    // test here asserts real navigation; disabling it keeps the suite
    // deterministic (and removes the pre-existing ECONNREFUSED noise).
    settings: { navigation: { disableChildFrameNavigation: true } },
  }),
);
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

type Info = {
  has_webapp: boolean | null;
  webapp_url: string | null;
  previewOrigin?: string | null;
  previewOriginClosedReason?: string | null;
  webappGeneration?: "legacy" | "current";
  status: string;
  ready: boolean;
};

/** D11 (#362): the preview address is ABSOLUTE — the preview origin's own host. */
const PREVIEW_ORIGIN = "http://127.0.0.1:3001/abc123label";

/** #367: the LEGACY session's preview address — the same-origin path, relative by purpose. */
const LEGACY_PATH = "/api/craft/sessions/cs-1/webapp";

/** The single-use pass the exchange answers with (D4/D9). */
const TICKET = "single-use-ticket-32-bytes";

/** Answer `/webapp-info` and `POST /preview-ticket`, recording the exchanges. */
function serving(info: Info, options: { ticketFails?: boolean } = {}) {
  const posts: string[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/webapp-info")) {
      return Response.json({
        previewOrigin: info.webapp_url,
        previewOriginClosedReason: null,
        ...info,
      });
    }
    if (url.includes("/preview-ticket")) {
      posts.push(`${init?.method ?? "GET"} ${url}`);
      if (options.ticketFails) {
        return Response.json(
          { error: "The sandbox is not available." },
          { status: 503 },
        );
      }
      return Response.json({
        ticket: TICKET,
        expiresAt: new Date().toISOString(),
        origin: PREVIEW_ORIGIN,
      });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  return { posts };
}

/**
 * The pane's own QueryClient can be handed in so a test can drive a refetch
 * (a turn's end or a webapp-info invalidation) without remounting the pane.
 */
function draw(client?: QueryClient): RenderResult {
  const queryClient =
    client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PreviewTab sessionId="cs-1" />
    </QueryClientProvider>,
  );
}

const URL = "/api/craft/sessions/cs-1/webapp";
void URL;

/**
 * The pane's own copy, read through i18n so the assertions follow the bundle instead of
 * pinning sentences. Constrained to the keys this pane uses: `t` is compile-time checked
 * against the en bundle (lib/i18n/i18next.d.ts), and a `string` parameter would fall off
 * that overload into `t(key, defaultValue)` and lose the check.
 */
function t(
  key:
    | "preview.title"
    | "preview.downTitle"
    | "preview.downHint"
    | "preview.emptyTitle"
    | "preview.expand"
    | "preview.collapse"
    | "preview.openInNewTab"
    | "preview.passTitle"
    | "preview.closedTitle"
    | "preview.sameOriginTitle"
    | "preview.sameOriginHint"
    | "preview.legacyNotice"
    | "preview.downRetry"
    | "preview.exchangeSameOrigin"
    | "preview.exchangeForeignOrigin"
    | "preview.exchangeNonHttp",
) {
  return i18n.t(key, { ns: "craft" });
}

/**
 * THE EXPAND, AND THE ONE PROPERTY THAT IS NOT COSMETIC.
 *
 * A 420px pane is too small to actually drive an app, so the serving state can go
 * full-viewport. The property worth pinning is that the iframe ELEMENT SURVIVES THE
 * CHANGE: an expand that remounted the frame would reload the app and throw away
 * whatever state the person was in the middle of testing — the exact thing they
 * expanded to do. One frame also means one HMR socket, not two racing the dev server.
 */
describe("expanding the preview", () => {
  function drawServing() {
    serving({
      has_webapp: true,
      webapp_url: PREVIEW_ORIGIN,
      status: "running",
      ready: true,
    });
    return draw();
  }

  test("the serving state offers an expand control", async () => {
    const view = drawServing();
    await view.findByTitle(t("preview.title"));
    expect(view.getByLabelText(t("preview.expand"))).toBeTruthy();
  });

  test("no expand control while nothing is serving", async () => {
    serving({
      has_webapp: true,
      webapp_url: PREVIEW_ORIGIN,
      status: "stopped",
      ready: false,
    });
    const view = draw();
    await view.findByText(t("preview.downTitle"));
    expect(view.queryByLabelText(t("preview.expand"))).toBeNull();
  });

  test("expanding goes full-viewport as a modal, and collapse returns", async () => {
    const view = drawServing();
    await view.findByTitle(t("preview.title"));

    fireEvent.click(view.getByLabelText(t("preview.expand")));
    const dialog = view.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // The control becomes its own inverse, so the way out is where the way in was.
    expect(view.getByLabelText(t("preview.collapse"))).toBeTruthy();

    fireEvent.click(view.getByLabelText(t("preview.collapse")));
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.getByLabelText(t("preview.expand"))).toBeTruthy();
  });

  test("Escape collapses, and focus returns to the trigger", async () => {
    const view = drawServing();
    await view.findByTitle(t("preview.title"));
    const trigger = view.getByLabelText(t("preview.expand"));

    fireEvent.click(trigger);
    expect(view.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(view.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("THE IFRAME NODE SURVIVES THE EXPAND — no reload, one HMR socket", async () => {
    const view = drawServing();
    await view.findByTitle(t("preview.title"));
    const before = view.container.querySelector("iframe");
    expect(before).toBeTruthy();

    fireEvent.click(view.getByLabelText(t("preview.expand")));
    // Identity, not equality of attributes: a remount would produce a new node
    // and a fresh navigation of the same URL.
    expect(view.container.querySelector("iframe")).toBe(before);

    fireEvent.click(view.getByLabelText(t("preview.collapse")));
    expect(view.container.querySelector("iframe")).toBe(before);
  });

  test("a serving preview offers the preview origin in a new tab (the cookie is already planted)", async () => {
    const view = drawServing();
    await view.findByTitle(t("preview.title"));
    const link = view.getByLabelText(t("preview.openInNewTab"));
    // The PLAIN origin, never the entry URL: the pass is single-use and already
    // consumed by the 302; the new tab rides the preview domain's cookie.
    expect(link.getAttribute("href")).toBe(PREVIEW_ORIGIN);
    expect(link.getAttribute("href")).not.toContain("ticket=");
    expect(link.getAttribute("target")).toBe("_blank");
    // A new tab is a new browsing context: without this the opened app keeps a
    // handle on its opener, which is the coupling a separate tab exists to avoid.
    expect(link.getAttribute("rel")).toContain("noopener");
  });
});

test("a scaffold whose dev server is down renders the down state, never an iframe", async () => {
  serving({
    has_webapp: true,
    webapp_url: PREVIEW_ORIGIN,
    status: "stopped",
    ready: false,
  });
  const view = draw();

  await view.findByText(t("preview.downTitle"));
  expect(view.container.querySelector("iframe")).toBeNull();
  // The pane says what the server's 503 said, in the product's own voice.
  expect(view.getByText(t("preview.downHint"))).toBeTruthy();
});

// ── #362: the ticket exchange — one hop, one ticket, then a clean URL ─────────

test("a ready dev server exchanges a pass first; the iframe enters with the ticket exactly once", async () => {
  const { posts } = serving({
    has_webapp: true,
    webapp_url: PREVIEW_ORIGIN,
    status: "running",
    ready: true,
  });
  const view = draw();

  const frame = (await view.findByTitle(
    t("preview.title"),
  )) as HTMLIFrameElement;
  // The ONE appearance of the pass: the entry navigation. The preview origin's
  // 302 strips it from every URL that follows (D4).
  expect(frame.getAttribute("src")).toBe(
    `${PREVIEW_ORIGIN}?ticket=${encodeURIComponent(TICKET)}`,
  );
  expect(posts).toEqual(["POST /api/craft/sessions/cs-1/preview-ticket"]);
});

test("a fresh webapp-info answer never re-entries the frame — the src is stable across refetches", async () => {
  const { posts } = serving({
    has_webapp: true,
    webapp_url: PREVIEW_ORIGIN,
    status: "running",
    ready: true,
  });
  const view = draw();
  const frame = (await view.findByTitle(
    t("preview.title"),
  )) as HTMLIFrameElement;
  const src = frame.getAttribute("src");

  // A turn's end (or any invalidation) refetches webapp-info; the answer is
  // byte-identical. The exchange must NOT run again and the frame must NOT
  // navigate — a replaced src reloads the app mid-test.
  await settleReactWork();
  expect(frame.getAttribute("src")).toBe(src);
  expect(posts.length).toBe(1);
});

test("a failed exchange holds the pass state with a retry, never points a frame at the origin", async () => {
  const { posts } = serving(
    {
      has_webapp: true,
      webapp_url: PREVIEW_ORIGIN,
      status: "running",
      ready: true,
    },
    { ticketFails: true },
  );
  const view = draw();

  await view.findByText(t("preview.passTitle"));
  expect(view.container.querySelector("iframe")).toBeNull();
  // The serving app must not wear the "isn't running" sentence: the server is
  // up; only the pass is missing.
  expect(view.queryByText(t("preview.downTitle"))).toBeNull();
  // fix-ocr10 #1: the mutation settling through its own error transition must
  // not become a retry loop — a re-buy here would burn single-use tickets
  // unthrottled. The only legitimate retry is a fresh dataUpdatedAt (the pass
  // state's refetch), never the settling mutation re-running the decision.
  await settleReactWork();
  expect(posts.length).toBe(1);
});

test("a refused exchange surfaces the server's displayable reason under the pass hint (fix-ocr25 #2)", async () => {
  // 409 拒签（legacy 竞态等）：client() 抛出的 Error 的 message 正是服务端
  // 的可展示句子 —— catch 把它整个吞掉的话，人反复点「重试」也只会以同一
  // 理由静默失败，无从知晓原因。同文件 closedReason 已是「服务端句子直接
  // 渲染」的先例；句子不含票据，无泄露面。RED：现状只渲染通用 passHint。
  const refusal =
    "This session's preview pass predates the current preview origin; reopen the session to re-enter.";
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/webapp-info")) {
      return Response.json({
        has_webapp: true,
        webapp_url: PREVIEW_ORIGIN,
        previewOrigin: PREVIEW_ORIGIN,
        previewOriginClosedReason: null,
        webappGeneration: "current",
        status: "running",
        ready: true,
      });
    }
    if (url.includes("/preview-ticket")) {
      return Response.json({ error: refusal }, { status: 409 });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  const view = draw();

  await view.findByText(t("preview.passTitle"));
  // The server's sentence is the reason the retry keeps failing — it renders
  // under the pass hint, in the closed-reason precedent's shape.
  expect(view.getByText(refusal)).toBeTruthy();
  expect(view.container.querySelector("iframe")).toBeNull();
});

test("a closed preview origin surfaces its displayable reason (m-5), never an iframe", async () => {
  serving({
    has_webapp: true,
    webapp_url: null,
    previewOrigin: null,
    previewOriginClosedReason:
      "The preview origin is disabled on this deployment (OPENBOT_CRAFT_PREVIEW_ORIGIN_ENABLED is false).",
    status: "running",
    ready: true,
  });
  const view = draw();

  await view.findByText(t("preview.closedTitle"));
  expect(view.getByText(/OPENBOT_CRAFT_PREVIEW_ORIGIN_ENABLED/)).toBeTruthy();
  expect(view.container.querySelector("iframe")).toBeNull();
});

// ── fix-ocr26 #4: the entering effect honors the closed gate ──────────────
// The render branch and the effect judged different facts: a malformed (or
// drifted) answer carrying closedReason AND webapp_url rendered the closed
// form while the effect below happily exchanged a single-use ticket and hung
// a frame — the UI said "unavailable" while the pane bought passes for it.
// The effect's first gate is the same fact the render reads.
test("an answer carrying closedReason AND webapp_url never exchanges — the effect shares the render branch's verdict (fix-ocr26 #4)", async () => {
  const { posts } = serving({
    has_webapp: true,
    webapp_url: PREVIEW_ORIGIN,
    previewOrigin: PREVIEW_ORIGIN,
    previewOriginClosedReason:
      "The preview origin is disabled on this deployment (OPENBOT_CRAFT_PREVIEW_ORIGIN_ENABLED is false).",
    webappGeneration: "current",
    status: "running",
    ready: true,
  });
  const view = draw();

  // The closed form is the whole answer — and behind it, RED: the effect
  // exchanged and entered anyway (the frame node beat the closed branch to
  // the render).
  await view.findByText(t("preview.closedTitle"));
  expect(view.container.querySelector("iframe")).toBeNull();
  await settleReactWork();
  expect(posts).toEqual([]); // RED: the ticket was bought behind the closed form
});

// fix-ocr27 #11: the RENDER order catches up with the effect's (fix-ocr26
// #4). A malformed double answer carrying closedReason AND a same-origin
// webapp_url dropped its entry through the closed gate but then rendered the
// sameOrigin card first — copy whose recovery action ("open the platform from
// a different address") is useless: the origin is closed, no address helps.
// The closed judgment is the render's first pane-state card, the effect's
// own order.
test("an answer carrying closedReason AND a same-origin webapp_url shows the closed card — the render order matches the effect's (fix-ocr27 #11)", async () => {
  serving({
    has_webapp: true,
    // The page's own host: the sameOrigin judgment fires on this address.
    webapp_url: "http://localhost:3001/abc123label",
    previewOrigin: "http://localhost:3001/abc123label",
    previewOriginClosedReason:
      "The preview origin is disabled on this deployment (OPENBOT_CRAFT_PREVIEW_ORIGIN_ENABLED is false).",
    webappGeneration: "current",
    status: "running",
    ready: true,
  });
  const view = draw();

  // RED: the sameOrigin card won — its advice (change the address you access
  // the platform from) cannot heal a closed origin.
  await view.findByText(t("preview.closedTitle"));
  expect(view.queryByText(t("preview.sameOriginTitle"))).toBeNull();
  expect(
    view.getByText(/OPENBOT_CRAFT_PREVIEW_ORIGIN_ENABLED/),
  ).toBeTruthy();
  expect(view.container.querySelector("iframe")).toBeNull();
});

test("no scaffold at all renders the waiting state, not the down state", async () => {
  serving({
    has_webapp: false,
    webapp_url: PREVIEW_ORIGIN,
    status: "stopped",
    ready: false,
  });
  const view = draw();

  await view.findByText(t("preview.emptyTitle"));
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(view.queryByText(t("preview.downTitle"))).toBeNull();
});

test("an unavailable sandbox (has_webapp null) degrades to the waiting state", async () => {
  serving({
    has_webapp: null,
    webapp_url: null,
    status: "no_sandbox",
    ready: false,
  });
  const view = draw();

  await view.findByText(t("preview.emptyTitle"));
  expect(view.container.querySelector("iframe")).toBeNull();
});

test("the poll runs only while an app exists but is not serving", () => {
  // A down dev server is a transient the agent can end at any moment, so the pane
  // watches it and the preview comes alive unprompted. Every other state settles
  // and waits for a turn's end to invalidate it.
  const down = previewPollInterval({
    has_webapp: true,
    webapp_url: PREVIEW_ORIGIN,
    status: "stopped",
    ready: false,
    previewOrigin: PREVIEW_ORIGIN,
    previewOriginClosedReason: null,
  });
  expect(down).toBeGreaterThan(0);
  expect(
    previewPollInterval({
      has_webapp: true,
      webapp_url: PREVIEW_ORIGIN,
      status: "running",
      ready: true,
      previewOrigin: PREVIEW_ORIGIN,
      previewOriginClosedReason: null,
    }),
  ).toBe(false);
  expect(
    previewPollInterval({
      has_webapp: false,
      webapp_url: PREVIEW_ORIGIN,
      status: "stopped",
      ready: false,
      previewOrigin: PREVIEW_ORIGIN,
      previewOriginClosedReason: null,
    }),
  ).toBe(false);
  expect(
    previewPollInterval({
      has_webapp: null,
      webapp_url: null,
      status: "no_sandbox",
      ready: false,
      previewOrigin: null,
      previewOriginClosedReason: null,
    }),
  ).toBe(false);
  expect(previewPollInterval(undefined)).toBe(false);
});

// ── #367: the legacy session's preview — the old same-origin path, no pass ────
//
// D10: 存量不迁移。A pre-marker app is mounted at the old same-origin prefix and
// gets webapp-info's LEGACY answer (webapp_url = /api/craft/…/webapp). The pane
// must iframe that path directly — the platform's own cookies authenticate it,
// as they always did — and must NEVER run the ticket exchange (there is no
// preview origin in play). Pointing a legacy frame at the preview origin, or
// exchanging a pass for an address the app is not mounted on, is exactly the
// silent-404 middle state the ticket exists to prevent.

describe("a legacy session's preview (webappGeneration: legacy)", () => {
  function drawLegacy() {
    const { posts } = serving({
      has_webapp: true,
      webapp_url: LEGACY_PATH,
      previewOrigin: null,
      previewOriginClosedReason: null,
      webappGeneration: "legacy",
      status: "running",
      ready: true,
    });
    return { posts, view: draw() };
  }

  test("the serving app iframes the old path directly — no pass, no ticket hop", async () => {
    const { posts, view } = drawLegacy();
    const frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(LEGACY_PATH);
    // No exchange ran: there is no preview origin to buy a pass for.
    expect(posts).toEqual([]);
  });

  test("the pane says why the preview looks different (the doc-consistent hint)", async () => {
    const { view } = drawLegacy();
    await view.findByTitle(t("preview.title"));
    expect(view.getByText(t("preview.legacyNotice"))).toBeTruthy();
  });

  test("open-in-new-tab carries the old path", async () => {
    const { view } = drawLegacy();
    await view.findByTitle(t("preview.title"));
    const link = view.getByLabelText(t("preview.openInNewTab"));
    expect(link.getAttribute("href")).toBe(LEGACY_PATH);
  });

  // fix-ocr7 (M21): the notice strip overlays the iframe's bottom edge, and a
  // transparent div still participates in hit testing — without the class it
  // swallowed every click aimed at the app beneath it.
  test("the legacy notice strip lets clicks pass through to the frame below (pointer-events-none)", async () => {
    const { view } = drawLegacy();
    await view.findByTitle(t("preview.title"));
    const strip = view.getByText(t("preview.legacyNotice")).parentElement;
    expect(strip?.className).toContain("pointer-events-none");
  });

  test("a legacy app whose server is down renders the down state, never a frame at the new origin", async () => {
    serving({
      has_webapp: true,
      webapp_url: LEGACY_PATH,
      previewOrigin: null,
      previewOriginClosedReason: null,
      webappGeneration: "legacy",
      status: "stopped",
      ready: false,
    });
    const view = draw();
    await view.findByText(t("preview.downTitle"));
    expect(view.container.querySelector("iframe")).toBeNull();
  });

  // ── fix-ocr4 #2: the version-skew window ─────────────────────────────────
  // An older server answers webapp-info WITHOUT the generation field at all,
  // and its `webapp_url` is the RELATIVE same-origin path (the pre-D11
  // shape). Reading the missing field as "current" sends the pane to POST a
  // ticket exchange against an endpoint that does not exist there → 404 →
  // the permanent pass state — exactly the middle state #367 forbids.
  test("a missing generation field with a relative webapp_url degrades to the legacy direct iframe (version skew)", async () => {
    const { posts } = serving({
      has_webapp: true,
      webapp_url: LEGACY_PATH,
      previewOrigin: null,
      status: "running",
      ready: true,
      // webappGeneration deliberately ABSENT: an older server's answer.
    });
    const view = draw();
    const frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(LEGACY_PATH);
    // No exchange ran: there is no preview origin (and no endpoint) there.
    expect(posts).toEqual([]);
  });

  // ── fix-ocr4 #1: the same-origin last line of defense ───────────────────
  // The frame's `allow-same-origin` is safe only while the preview origin is
  // a DIFFERENT origin from the one this very page is served on. The server
  // never sees the accessing Host, so the pane checks: the dev form mints
  // http://127.0.0.1:<port>, and a platform accessed through that very origin
  // would hand the frame the platform's own cookies — the F1 sandbox escape
  // reopens. The pane refuses to enter and shows the closed form's shape.
  test("a preview origin equal to the page's own origin is refused — no frame, no exchange", async () => {
    const { posts } = serving({
      has_webapp: true,
      // http://localhost is exactly what the global registrator registered,
      // so this address's origin IS window.location.origin.
      webapp_url: "http://localhost/abc123label",
      status: "running",
      ready: true,
    });
    const view = draw();

    await view.findByText(t("preview.sameOriginTitle"));
    expect(view.getByText(t("preview.sameOriginHint"))).toBeTruthy();
    expect(view.container.querySelector("iframe")).toBeNull();
    // Refusal precedes the exchange: no pass is ever bought for an origin
    // the pane would not enter.
    expect(posts).toEqual([]);
  });

  // ── fix-ocr4 #3: the entry tracks the address it entered on ─────────────
  // A mid-session flip (repair/regenerate re-mints the absolute preview
  // address) must drop the entry and re-walk the entering decision: one frame
  // reload beats pointing the old frame at a dead address that 404s silently
  // until a full page reload. The flip is fed the way the harness feeds the
  // pane data — a prop change (rerender onto the new session's answer), no
  // query-refetch orchestration: the contract under test is "a live entry
  // whose entered-on address is no longer the latest webapp_url resets".
  test("a mid-session address flip re-enters the frame at the new address", async () => {
    const posts: string[] = [];
    const addresses: Record<string, string> = {
      "cs-1": PREVIEW_ORIGIN,
      "cs-2": "http://127.0.0.1:3001/newlabel",
    };
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const session = url.match(/sessions\/(cs-\d+)\//)?.[1] ?? "cs-1";
      if (url.includes("/webapp-info")) {
        const address = addresses[session];
        return Response.json({
          has_webapp: true,
          webapp_url: address,
          previewOrigin: address,
          previewOriginClosedReason: null,
          webappGeneration: "current",
          status: "running",
          ready: true,
        });
      }
      if (url.includes("/preview-ticket")) {
        posts.push(`POST ${url}`);
        return Response.json({
          ticket: `${posts.length}-ticket`,
          expiresAt: new Date().toISOString(),
          origin: addresses[session],
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = draw(client);
    const frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(
      `${PREVIEW_ORIGIN}?ticket=${encodeURIComponent("1-ticket")}`,
    );
    expect(posts.length).toBe(1);

    // The flip: the pane now answers for data whose webapp-info names a NEW
    // absolute address while the live entry was entered for the old one.
    view.rerender(
      <QueryClientProvider client={client}>
        <PreviewTab sessionId="cs-2" />
      </QueryClientProvider>,
    );
    const moved = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(
      (moved.getAttribute("src") ?? "").startsWith(addresses["cs-2"]),
    ).toBe(true);
    // The re-entry bought a fresh pass for the new address.
    expect(moved.getAttribute("src") ?? "").toContain("2-ticket");
    expect(posts.length).toBe(2);
  });
});

// ── fix-ocr5 M-2: the frame element replaced while the entry lives ──────────
// The entry's single-use ticket is spent by the frame's ONE navigation, but
// the src ATTRIBUTE keeps carrying it — so the entering guard (`entry !==
// null` returning early) can never be the whole story. If the iframe ELEMENT
// itself is replaced while the entry lives (an error boundary recovering the
// subtree, a structural key change), the new node re-navigates the spent
// ticket and the preview origin answers its 401 JSON as the app — with no
// path below a full pane unmount that ever heals it. The pane must notice
// the replacement and buy a fresh pass for the new node.
// ── fix-ocr6: the same-origin line compares HOSTNAMES; the entry re-verifies ─
//
// F1 established (and R-9's Path-scoped cookies rely on) that cookies isolate
// by HOST, never by port (RFC 6265 §5.1.3 — ports do not participate).
// fix-ocr4's line compared full ORIGINS, so a platform served through
// `localhost:5173` waving a `127.0.0.1:3001` preview through was "different
// origins" — while the browser, seeing the same two hosts, sent the platform's
// whole cookie jar into the frame: the F1 sandbox escape, reopened by a port.
// The line therefore compares HOSTNAMES. And because the frame ultimately
// navigates the EXCHANGE RESPONSE's origin — not the webapp_url the pre-check
// screened — the entry re-verifies, before any navigation, that the response's
// host is neither the page's own host nor a different host than the address
// the pane advertised (#367's no-silent-404 middle state).
describe("the same-origin line compares hostnames, and the entry re-verifies what it navigates (fix-ocr6)", () => {
  test("a preview address on the page's own HOST with a different PORT is refused — cookies ignore ports", async () => {
    const { posts } = serving({
      has_webapp: true,
      // The page is served at http://localhost (the registrator's url); this
      // address is the same HOST on another port. Origin equality waves it
      // through — but the cookie jar is shared per HOST, so the frame would
      // carry the platform's own session: refuse before any exchange.
      webapp_url: "http://localhost:3001/abc123label",
      status: "running",
      ready: true,
    });
    const view = draw();

    await view.findByText(t("preview.sameOriginTitle"));
    expect(view.getByText(t("preview.sameOriginHint"))).toBeTruthy();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(posts).toEqual([]);
  });

  /** webapp-info answers PREVIEW_ORIGIN while the exchange answers elsewhere. */
  function answeringElsewhere(origin: string) {
    const posts: string[] = [];
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/webapp-info")) {
        return Response.json({
          has_webapp: true,
          webapp_url: PREVIEW_ORIGIN,
          previewOrigin: PREVIEW_ORIGIN,
          previewOriginClosedReason: null,
          webappGeneration: "current",
          status: "running",
          ready: true,
        });
      }
      if (url.includes("/preview-ticket")) {
        posts.push(`${init?.method ?? "GET"} ${url}`);
        return Response.json({
          ticket: TICKET,
          expiresAt: new Date().toISOString(),
          origin,
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    return { posts };
  }

  test("an exchange answered from a DIFFERENT host than the webapp address stays entryless — no iframe", async () => {
    // The frame navigates the ticket response's origin, and only the server's
    // own discipline ties it to webapp_url today: a drifted config (or a
    // misrouted proxy) hands the pane an address the pane never screened.
    // #367's rule: never point the frame where the app is not mounted —
    // entryless (the pass state explains and offers the retry) beats a silent
    // 404 frame, and the ticket never appears in any copy.
    const { posts } = answeringElsewhere("http://evil.example:3001/abc123label");
    const view = draw();

    await view.findByText(t("preview.passTitle"));
    await settleReactWork();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(posts.length).toBe(1);
  });

  // ── fix-ocr26 #5: a validation refusal NAMES ITS REASON ─────────────────
  // The exchange's cross-check refusals used to return silently: the pane sat
  // in the pass state whose copy promises an in-flight exchange, and a person
  // hammering retry burned a single-use ticket per attempt with no sentence
  // ever changing. Every entryless refusal here now writes the displayable
  // reason (the fix-ocr25 #2 exchangeRefusal slot), i18n'd in the preview.*
  // key family.
  test("a cross-check mismatch renders its own refusal sentence under the pass hint (fix-ocr26 #5)", async () => {
    const { posts } = answeringElsewhere("http://evil.example:3001/abc123label");
    const view = draw();

    await view.findByText(t("preview.passTitle"));
    // RED: the mismatch refusal was silent — only the generic pass hint showed.
    expect(view.getByText(t("preview.exchangeForeignOrigin"))).toBeTruthy();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(posts.length).toBe(1);
  });

  test("an exchange answered on the page's own host names the same-origin refusal (fix-ocr26 #5)", async () => {
    const { posts } = answeringElsewhere("http://localhost:3001/abc123label");
    const view = draw();

    await view.findByText(t("preview.passTitle"));
    expect(view.getByText(t("preview.exchangeSameOrigin"))).toBeTruthy();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(posts.length).toBe(1);
  });

  // ── fix-ocr27 #10: the refusal state stores the JUDGMENT, not a sentence ──
  // The effect's `t` is not its dep (adding it would re-run the effect and
  // re-buy single-use tickets on every language flip), so an in-flight
  // exchange resolving after a language switch wrote the OLD language's
  // sentence into state — rendered verbatim forever. The state now holds the
  // refusal's kind (plus the server's own sentence, which is language-neutral
  // by construction) and the render translates.
  test("a cross-check refusal renders in the CURRENT language — a language switch re-translates it (fix-ocr27 #10)", async () => {
    answeringElsewhere("http://evil.example:3001/abc123label");
    const view = draw();

    await view.findByText(t("preview.passTitle"));
    const enSentence = t("preview.exchangeForeignOrigin");
    expect(view.getByText(enSentence)).toBeTruthy();

    await i18n.changeLanguage("zh-CN");
    const zhSentence = t("preview.exchangeForeignOrigin");
    expect(zhSentence).not.toBe(enSentence);
    // RED: the state held the en sentence baked at effect time; the switch
    // re-rendered the pane but the stale string rode along.
    await view.findByText(zhSentence);
    expect(view.queryByText(enSentence)).toBeNull();

    void i18n.changeLanguage("en");
  });

  test("a server-sourced refusal keeps the server's own sentence across a language switch (fix-ocr27 #10)", async () => {
    serving(
      {
        has_webapp: true,
        webapp_url: PREVIEW_ORIGIN,
        status: "running",
        ready: true,
      },
      { ticketFails: true },
    );
    const view = draw();

    // The server's sentence is language-neutral: it renders verbatim before
    // and after the switch — only the KIND arm translates.
    await view.findByText("The sandbox is not available.");
    await i18n.changeLanguage("zh-CN");
    await view.findByText("The sandbox is not available.");

    void i18n.changeLanguage("en");
  });

  test("an exchange answered on the PAGE'S OWN host never enters — the re-check runs on the navigated address", async () => {
    // webapp_url is 127.0.0.1 (a different host than the page, so the
    // pre-exchange screen passes); the RESPONSE comes back on localhost —
    // the page's own host, where entering would hand the frame the
    // platform's cookie jar. The hostname line must re-run on exactly the
    // address the frame is about to navigate, not on the one it screened.
    const { posts } = answeringElsewhere("http://localhost:3001/abc123label");
    const view = draw();

    await view.findByText(t("preview.passTitle"));
    await settleReactWork();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(posts.length).toBe(1);
  });
});

// ── fix-ocr9 #1: the legacy direct entry's shape gate ───────────────────────
// The legacy branch hangs `webapp_url` on the frame's src AND the new-tab
// link's href with NO shape check — and the explicit `webappGeneration:
// "legacy"` answer bypasses the `!http(s)` regex entirely, while the version-
// skew window (generation absent) classifies EVERY non-http(s) absolute scheme
// as legacy. A server-side regression (or an old server's mangled answer) can
// therefore hand `javascript:` or a foreign absolute address straight to
// `src`/`href`, and previewOriginBlocked cannot catch it (a `javascript:` URL
// parses with an empty hostname; `//evil.com` is unparsable without a base and
// not absolute-shaped). Every other path into the frame fails closed; the
// legacy direct connect is the last unchecked door. Only a SAME-ORIGIN
// RELATIVE path (`/`-rooted, not the `//host` protocol-relative form) may
// enter; anything else stays entryless in the pass state.
describe("the legacy direct entry only accepts a same-origin relative path (fix-ocr9 #1)", () => {
  /** Explicit generation "legacy": the branch a server regression would feed. */
  function drawLegacyShaped(webappUrl: string) {
    serving({
      has_webapp: true,
      webapp_url: webappUrl,
      previewOrigin: null,
      previewOriginClosedReason: null,
      webappGeneration: "legacy",
      status: "running",
      ready: true,
    });
    return draw();
  }

  test.each([
    ["javascript:alert(1)", "a script scheme"],
    ["//evil.com", "a protocol-relative form"],
    ["https://evil.com", "a foreign absolute address"],
    // fix-ocr24 #3: the bare root path. `address[1]` is undefined for "/", so
    // every prior condition held and the gate waved it through — a same-origin
    // frame at the platform's own root (allow-scripts + allow-same-origin can
    // reach parent.document), with previewOriginBlocked deliberately silent on
    // relative paths and this gate the only defense. Only a real path passes.
    ["/", "the bare root path"],
    // fix-ocr26 #1: the third spelling of the protocol-relative escape.
    // WHATWG strips ASCII tab/CR/LF from a URL BEFORE parsing, so the browser
    // sees `//evil.com` — a scheme-relative hop to a foreign origin, spelled
    // with a character the length/starts-with/not-slash checks never look at.
    ["/\t/evil.com", "an ASCII-tab scheme-relative escape (fix-ocr26 #1)"],
  ])("%s (%s) never reaches a frame — the pane stays in the pass state", async (
    webappUrl,
  ) => {
    const view = drawLegacyShaped(webappUrl);
    await view.findByText(t("preview.passTitle"));
    expect(view.container.querySelector("iframe")).toBeNull();
  });

  test("the version-skew window (no generation field) refuses a script scheme too", async () => {
    // An old server's answer is classified legacy by the `!http(s)` regex, so
    // `javascript:` lands in the same direct-connect branch with no explicit
    // marker — the gate must hold there as well.
    serving({
      has_webapp: true,
      webapp_url: "javascript:alert(1)",
      previewOrigin: null,
      status: "running",
      ready: true,
      // webappGeneration deliberately ABSENT: the version-skew window.
    });
    const view = draw();
    await view.findByText(t("preview.passTitle"));
    expect(view.container.querySelector("iframe")).toBeNull();
  });

  test("the normal same-origin legacy path still connects directly (the pass-through stays open)", async () => {
    const view = drawLegacyShaped(LEGACY_PATH);
    const frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(LEGACY_PATH);
  });
});

// ── fix-ocr24 #1: the CURRENT entry fails closed on non-http(s) schemes ─────
// The legacy branch has its shape gate (fix-ocr9 #1); the current branch was
// the one unchecked door. A `javascript:`/`data:` URL parses with an EMPTY
// hostname: previewOriginBlocked (empty ≠ the page's host) waves it through,
// and samePreviewHostname (two empty hostnames are equal) lets a malformed
// pair cross-check clean — so a server regression answering a non-http origin
// hung a script/data URL straight on the frame's src. The gate is the scheme
// itself, re-run on BOTH addresses the decision touches: the pre-exchange
// webapp_url (no pass is ever bought for an address that cannot be entered)
// and the exchange's navigated origin (the ticket response is untrusted, the
// same premise the hostname re-check rides).
describe("the current entry fails closed on non-http(s) schemes (fix-ocr24 #1)", () => {
  /** webapp-info answers `webappUrl`; the exchange answers `origin`. */
  function drawShaped(webappUrl: string, origin: string) {
    const posts: string[] = [];
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/webapp-info")) {
        return Response.json({
          has_webapp: true,
          webapp_url: webappUrl,
          previewOrigin: webappUrl,
          previewOriginClosedReason: null,
          // Explicitly CURRENT: the version-skew window routes to the legacy
          // branch (whose gate exists); this is the branch a current server
          // regression would feed.
          webappGeneration: "current",
          status: "running",
          ready: true,
        });
      }
      if (url.includes("/preview-ticket")) {
        posts.push(`${init?.method ?? "GET"} ${url}`);
        return Response.json({
          ticket: TICKET,
          expiresAt: new Date().toISOString(),
          origin,
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    return { posts };
  }

  test("an exchange origin that is not http(s) never reaches a frame — the scheme re-check runs on the navigated address", async () => {
    // A non-special scheme (httpx:) KEEPS its host under WHATWG parsing, so
    // the hostname cross-check passes against the honest webapp_url — the
    // pair checks alone cannot see this one; only the scheme gate can.
    const { posts } = drawShaped(
      PREVIEW_ORIGIN,
      "httpx://127.0.0.1:3001/abc123label",
    );
    const view = draw();

    await view.findByText(t("preview.passTitle"));
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(posts.length).toBe(1); // the exchange ran; the ENTRY is what refuses
  });

  test("a malformed-scheme webapp_url on a current answer stays entryless — no pass is ever bought", async () => {
    // The pre-exchange gate: a `javascript:` address can never be entered,
    // so the decision must refuse BEFORE spending a single-use ticket.
    const { posts } = drawShaped("javascript:alert(1)", PREVIEW_ORIGIN);
    const view = draw();

    await view.findByText(t("preview.passTitle"));
    await settleReactWork();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(posts).toEqual([]);
  });

  test("a malformed pair (both empty-hostname schemes) never enters — the HIGH chain stays closed", async () => {
    // The exact finding: both answers carry empty hostnames, so hostname
    // comparison (empty ≠ page host) AND the cross-check (empty = empty)
    // both pass, and the frame's src was written with a script URL. The
    // webapp_url gate refuses before any exchange; nothing burns.
    const { posts } = drawShaped("javascript:alert(1)", "javascript:alert(2)");
    const view = draw();

    await view.findByText(t("preview.passTitle"));
    await settleReactWork();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(posts).toEqual([]);
  });
});

// ── fix-ocr24 #2: the entry hop appends the ticket through the URL API ──────
// String concatenation only knew the already-has-query shape: an origin
// carrying a `#` fragment dropped the ticket INTO the fragment — the server's
// query parser never sees it, the single-use ticket silently burns, and the
// pane sits in the pass state whose every retry burns another. The URL API
// puts the parameter in the query whatever the fragment does; an origin so
// malformed that `new URL` throws rejects the entry hop and the chain's own
// .catch holds the entryless pass state (direction unchanged).
describe("previewEntryUrl appends the ticket in the query, never the fragment (fix-ocr24 #2)", () => {
  test("an origin with a #fragment keeps the ticket in the query", () => {
    const url = previewEntryUrl("http://127.0.0.1:3001/abc123label#f", TICKET);
    // Query BEFORE the fragment — the one shape the server's query parser
    // receives; the module-local `URL` shadow above pins these to string
    // assertions, the same convention the entry tests use.
    expect(url).toBe(
      "http://127.0.0.1:3001/abc123label?ticket=single-use-ticket-32-bytes#f",
    );
    expect(url.indexOf("ticket=")).toBeLessThan(url.indexOf("#"));
  });

  test("a plain origin still lands the ticket in the query (behavior unchanged)", () => {
    expect(previewEntryUrl(PREVIEW_ORIGIN, TICKET)).toBe(
      `${PREVIEW_ORIGIN}?ticket=${encodeURIComponent(TICKET)}`,
    );
  });
});

// ── fix-ocr6 C: the in-flight exchange guard ────────────────────────────────
// The effect re-runs for the SAME address on a StrictMode double effect, a
// refetchOnReconnect landing, or any other same-input replay: its cleanup
// cancels the FIRST response while the re-run buys a SECOND single-use pass.
// The guard keyed by the address (and its session) makes a re-entry reuse the
// in-flight exchange — and the landing entry still applies, because the live
// re-entry re-arms it (a guard that discarded the response would wedge the
// pane in the pass state on every replay).
test("concurrent effect re-entries for the same address exchange ONCE — and the pass still lands", async () => {
  let releaseTicket!: (response: Response) => void;
  const ticketResponse = new Promise<Response>((resolve) => {
    releaseTicket = resolve;
  });
  const posts: string[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/webapp-info")) {
      return Response.json({
        has_webapp: true,
        webapp_url: PREVIEW_ORIGIN,
        previewOrigin: PREVIEW_ORIGIN,
        previewOriginClosedReason: null,
        webappGeneration: "current",
        status: "running",
        ready: true,
      });
    }
    if (url.includes("/preview-ticket")) {
      posts.push(`${init?.method ?? "GET"} ${url}`);
      return ticketResponse;
    }
    return Response.json({});
  }) as unknown as typeof fetch;

  // The serving answer is ALREADY in the cache, so the pane's very first
  // render reaches the exchange — and StrictMode's double effect starts it
  // twice for the SAME address with the response still in flight.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(craftKeys.webapp("cs-1"), {
    has_webapp: true,
    webapp_url: PREVIEW_ORIGIN,
    previewOrigin: PREVIEW_ORIGIN,
    previewOriginClosedReason: null,
    webappGeneration: "current",
    status: "running",
    ready: true,
  });
  const view = render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <PreviewTab sessionId="cs-1" />
      </QueryClientProvider>
    </StrictMode>,
  );

  await view.findByText(t("preview.passTitle"));
  await settleReactWork();
  expect(posts.length).toBe(1);

  releaseTicket(
    Response.json({
      ticket: TICKET,
      expiresAt: new Date().toISOString(),
      origin: PREVIEW_ORIGIN,
    }),
  );
  const frame = (await view.findByTitle(
    t("preview.title"),
  )) as HTMLIFrameElement;
  expect(frame.getAttribute("src")).toBe(
    `${PREVIEW_ORIGIN}?ticket=${encodeURIComponent(TICKET)}`,
  );
});

// ── fix-ocr6 D/E: the entry belongs to the session that bought it ───────────
// The iframe's key is the session, so a panel re-pointed at another session
// ALWAYS replaces the frame node — and before D, the replacement's first
// commit carried the OLD entry's spent-ticket src (one commit, but the
// browser starts that navigation synchronously; the M-2 replacement drop
// heals it only after the wrong URL was handed to a node). The entry now
// records the session it was bought for, and the render gate treats any
// other session's entry as NO entry — the wrong commit never exists, and
// the re-walk buys the new session its own pass.
test("a session switch never sets the spent entry's src on the new session's frame node", async () => {
  const posts: string[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/webapp-info")) {
      return Response.json({
        has_webapp: true,
        webapp_url: PREVIEW_ORIGIN,
        previewOrigin: PREVIEW_ORIGIN,
        previewOriginClosedReason: null,
        webappGeneration: "current",
        status: "running",
        ready: true,
      });
    }
    if (url.includes("/preview-ticket")) {
      posts.push(`POST ${url}`);
      return Response.json({
        ticket: `${posts.length}-ticket`,
        expiresAt: new Date().toISOString(),
        origin: PREVIEW_ORIGIN,
      });
    }
    return Response.json({});
  }) as unknown as typeof fetch;

  // Every src the renderer ever set, with the node it was set on — the
  // transient wrong commit leaves no DOM trace after act flushes, but the
  // navigation it starts is real, so the test watches the writes themselves.
  const srcSets: Array<{ node: Element; src: string }> = [];
  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function setAttributeProbe(
    this: Element,
    name: string,
    value: string,
  ) {
    if (name === "src") srcSets.push({ node: this, src: String(value) });
    return originalSetAttribute.call(this, name, value);
  };
  try {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = draw(client);
    const first = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(first.getAttribute("src") ?? "").toContain("1-ticket");

    // The second session's answer is ALREADY cached, byte-identical: the
    // only thing the rerender changes is the session (and so the frame key).
    client.setQueryData(craftKeys.webapp("cs-2"), {
      has_webapp: true,
      webapp_url: PREVIEW_ORIGIN,
      previewOrigin: PREVIEW_ORIGIN,
      previewOriginClosedReason: null,
      webappGeneration: "current",
      status: "running",
      ready: true,
    });
    view.rerender(
      <QueryClientProvider client={client}>
        <PreviewTab sessionId="cs-2" />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(posts.length).toBe(2));
    const fresh = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(fresh.getAttribute("src") ?? "").toContain("2-ticket");
    expect(fresh).not.toBe(first);
    // The spent pass (1-ticket) was set on exactly ONE node — cs-1's own
    // frame. A second node carrying it is the re-navigation D removes.
    const spent = srcSets.filter((s) => s.src.includes("1-ticket"));
    expect(spent.length).toBe(1);
    expect(spent[0].node).toBe(first);
  } finally {
    Element.prototype.setAttribute = originalSetAttribute;
  }
});

describe("a replaced frame element re-enters with a fresh pass (fix-ocr5 M-2)", () => {
  test("switching sessions with the SAME cached address replaces the frame node — a new exchange, a fresh ticket in the new node's src", async () => {
    const posts: string[] = [];
    // cs-1 and cs-2 answer webapp-info BYTE-IDENTICALLY (the same preview
    // address): no staleness flip, no query pend — the only thing the
    // rerender changes is the frame element (one frame per session,
    // key={sessionId}).
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/webapp-info")) {
        return Response.json({
          has_webapp: true,
          webapp_url: PREVIEW_ORIGIN,
          previewOrigin: PREVIEW_ORIGIN,
          previewOriginClosedReason: null,
          webappGeneration: "current",
          status: "running",
          ready: true,
        });
      }
      if (url.includes("/preview-ticket")) {
        posts.push(`POST ${url}`);
        return Response.json({
          ticket: `${posts.length}-ticket`,
          expiresAt: new Date().toISOString(),
          origin: PREVIEW_ORIGIN,
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = draw(client);
    const first = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(first.getAttribute("src") ?? "").toContain("1-ticket");
    expect(posts.length).toBe(1);

    // The second session's answer is ALREADY in the cache, byte-identical:
    // the rerender changes no query state — only the frame's node identity.
    client.setQueryData(craftKeys.webapp("cs-2"), {
      has_webapp: true,
      webapp_url: PREVIEW_ORIGIN,
      previewOrigin: PREVIEW_ORIGIN,
      previewOriginClosedReason: null,
      webappGeneration: "current",
      status: "running",
      ready: true,
    });
    view.rerender(
      <QueryClientProvider client={client}>
        <PreviewTab sessionId="cs-2" />
      </QueryClientProvider>,
    );

    // The new node must not ride the spent ticket: a fresh exchange fires,
    // and the frame that lands carries the fresh pass.
    await waitFor(() => expect(posts.length).toBe(2));
    const fresh = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(fresh.getAttribute("src") ?? "").toContain("2-ticket");
    expect(fresh).not.toBe(first);
  });
});

// ── fix-ocr8 #5: the unparsable-address fail direction ──────────────────────
// previewOriginBlocked's catch used to return false for EVERY unparsable
// input — which is fail-OPEN on malformed absolute shapes: a scheme-less
// `127.0.0.1:3001` (what a server-side formatting regression would emit;
// WHATWG refuses a digit-leading scheme, so `new URL` throws) sailed past
// the pre-check, burned a single-use ticket per retry, and only died at the
// post-exchange cross-check. The catch's fail direction must match its
// structurally identical sibling samePreviewHostname ("unparsable input
// mismatches: fail closed") for everything absolute-SHAPED, while the one
// deliberate pass-through stays the scheme-less RELATIVE path — the legacy
// entry, which makes no origin claim at all.
describe("previewOriginBlocked fail direction on unparsable addresses (fix-ocr8 #5)", () => {
  test("a scheme-less host:port form is blocked — fail closed, not waved through", () => {
    // new URL throws (no digit-leading scheme): the catch must treat the
    // absolute-looking shape as a refusal, not a pass.
    expect(previewOriginBlocked("127.0.0.1:3001", "http://localhost:5173"))
      .toBe(true);
  });

  test("a scheme-shaped unparsable form (digit-leading is not the only case) is blocked", () => {
    // e.g. a hypothetical `1e3:preview` — anything carrying a scheme-shaped
    // prefix that new URL cannot resolve must not pass the defense.
    expect(previewOriginBlocked("1e3:preview", "http://localhost:5173"))
      .toBe(true);
  });

  test("a relative path (the legacy entry) still passes — the deliberate exception", () => {
    expect(
      previewOriginBlocked(
        "/api/craft/sessions/cs-1/webapp",
        "http://localhost:5173",
      ),
    ).toBe(false);
  });

  test("parsable addresses keep their pinned directions (same host blocked, other host allowed)", () => {
    expect(
      previewOriginBlocked("http://localhost/abc123label", "http://localhost:5173"),
    ).toBe(true);
    expect(
      previewOriginBlocked(
        "http://127.0.0.1:3001/abc123label",
        "http://localhost:5173",
      ),
    ).toBe(false);
  });
});

// ── fix-ocr10 #1: the exchange caller is not a dependency ───────────
// v5's `mutateAsync` is not an identity-stable value: the mutation observer
// re-derives its result on every state transition (idle→pending→settled each
// notify a re-render, and v5 builds have re-bound the method per update), so
// listing it in the entering effect's deps re-runs the whole decision on
// every transition of the very exchange it starts — in-flight guard churn,
// and a failed exchange re-buying single-use tickets in a loop. (On the
// currently pinned query-core the method happens to be bound once in the
// observer's constructor, so these pins hold already; they hold the behavior
// the ref stabilization exists to guarantee, on every v5 build.)
test("the exchange settling through its states never re-enters — posts stay at one (fix-ocr10 #1)", async () => {
  const { posts } = serving({
    has_webapp: true,
    webapp_url: PREVIEW_ORIGIN,
    status: "running",
    ready: true,
  });
  const view = draw();
  const frame = (await view.findByTitle(
    t("preview.title"),
  )) as HTMLIFrameElement;
  const src = frame.getAttribute("src");
  expect(posts.length).toBe(1);

  // The mutation is settling (pending→success re-renders the pane). Each
  // transition must not re-run the entering decision: the entry is live, the
  // exchange is spent, and posts must settle at exactly one.
  await settleReactWork();
  await settleReactWork();
  expect(posts.length).toBe(1);
  expect(view.getByTitle(t("preview.title")).getAttribute("src")).toBe(src);
});

// ── fix-ocr10 #2: the dead-entry recovery path ─────────────────────
// 兑换成功 ≠ 导航成功。The preview origin's ticket table and its
// label→session registry are IN-PROCESS server state (D4: tickets live 30
// seconds, single-use, nothing durable; M-2: the registry is a memory Map
// that a server restart clears — that wipe is the DESIGNED restart window,
// and the documented recovery is re-walking the exchange from the main
// site). A network hiccup mid-navigation loses the frame's one hop just the
// same. The entry is blind to all of it: it records only the address it
// entered on, so the effect early-returns on `enteredFor` forever and the
// pane used to stay dead until the session was reopened. The one signal the
// client gets is the frame's own error event — cross-origin frame content
// is unreadable, so there is no honest load-probe (a no-cors fetch is
// opaque; a 401-with-body page even "loads" cleanly) — and it is the
// trigger to drop the entry and let the entering decision buy a fresh pass.
// Re-entry, not ticket recovery: the spent ticket is never re-shown.
describe("a dead entry recovers through the frame's error event (fix-ocr10 #2)", () => {
  /** Serving answers; the FIRST exchange resolves at once, later ones are held. */
  function drawRecoverable() {
    const posts: string[] = [];
    let releaseHeld!: (response: Response) => void;
    const heldTicket = new Promise<Response>((resolve) => {
      releaseHeld = resolve;
    });
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/webapp-info")) {
        return Response.json({
          has_webapp: true,
          webapp_url: PREVIEW_ORIGIN,
          previewOrigin: PREVIEW_ORIGIN,
          previewOriginClosedReason: null,
          webappGeneration: "current",
          status: "running",
          ready: true,
        });
      }
      if (url.includes("/preview-ticket")) {
        posts.push(`${init?.method ?? "GET"} ${url}`);
        if (posts.length === 1) {
          return Response.json({
            ticket: "1-ticket",
            expiresAt: new Date().toISOString(),
            origin: PREVIEW_ORIGIN,
          });
        }
        return heldTicket;
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    return { posts, releaseHeld };
  }

  test("a frame that errors after entering drops the entry — the pass state returns and a fresh pass re-enters", async () => {
    const { posts, releaseHeld } = drawRecoverable();
    const view = draw();
    const frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toContain("1-ticket");
    expect(posts.length).toBe(1);

    // The frame's navigation dies AFTER entering: the server restarted and
    // its in-process ticket table / label registry are gone, so the proxy
    // answers nothing the frame can ride (transport-level failure — the one
    // shape that fires the frame's error event).
    fireEvent.error(frame);

    // The dead entry is dropped: the spent ticket's src is never shown again
    // (no iframe while the pane re-buys), the pass state explains the wait.
    await view.findByText(t("preview.passTitle"));
    expect(view.container.querySelector("iframe")).toBeNull();

    // The fresh pass lands through the SAME decision path: a second
    // exchange, a second ticket, the frame re-enters on its own.
    releaseHeld(
      Response.json({
        ticket: "2-ticket",
        expiresAt: new Date().toISOString(),
        origin: PREVIEW_ORIGIN,
      }),
    );
    const fresh = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(fresh.getAttribute("src")).toContain("2-ticket");
    expect(posts.length).toBe(2);
  });

  test("a late error from a replaced frame never clobbers the fresh entry", async () => {
    // The session-switch harness (fix-ocr6 D): cs-1 enters, the pane is
    // re-pointed at cs-2 (same cached address) → fresh node, fresh pass.
    // The OLD node then reports its death — a navigation that was in flight
    // when it was replaced. That event belongs to a frame the pane no
    // longer shows: it must not drop cs-2's live entry and buy a third
    // single-use ticket.
    const posts: string[] = [];
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/webapp-info")) {
        return Response.json({
          has_webapp: true,
          webapp_url: PREVIEW_ORIGIN,
          previewOrigin: PREVIEW_ORIGIN,
          previewOriginClosedReason: null,
          webappGeneration: "current",
          status: "running",
          ready: true,
        });
      }
      if (url.includes("/preview-ticket")) {
        posts.push(`POST ${url}`);
        return Response.json({
          ticket: `${posts.length}-ticket`,
          expiresAt: new Date().toISOString(),
          origin: PREVIEW_ORIGIN,
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = draw(client);
    const first = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(first.getAttribute("src")).toContain("1-ticket");

    client.setQueryData(craftKeys.webapp("cs-2"), {
      has_webapp: true,
      webapp_url: PREVIEW_ORIGIN,
      previewOrigin: PREVIEW_ORIGIN,
      previewOriginClosedReason: null,
      webappGeneration: "current",
      status: "running",
      ready: true,
    });
    view.rerender(
      <QueryClientProvider client={client}>
        <PreviewTab sessionId="cs-2" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(posts.length).toBe(2));
    const fresh = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(fresh.getAttribute("src")).toContain("2-ticket");

    // The replaced node's late error: no reset, no third exchange.
    fireEvent.error(first);
    await settleReactWork();
    expect(posts.length).toBe(2);
    expect(view.getByTitle(t("preview.title")).getAttribute("src")).toContain(
      "2-ticket",
    );
  });
});

// ── fix-ocr11: the frame-error recovery loop needs a brake ──────────────────
// 兑换成功 ≠ 导航成功 gave the pane its recovery: a frame error drops the
// entry, the entering effect buys a fresh pass, the frame re-enters. But when
// the origin itself is UNREACHABLE (a restarted server refusing connections,
// dead TLS), that recovery is a closed loop: enter → error → re-exchange →
// enter → error → … and nothing external can break it — `serving` is stale by
// construction (ready came from the last webapp-info answer) and a serving app
// STOPS POLLING, so no refetch ever lands to flip the gate. The pane must
// count consecutive frame errors per address and, at the limit, stop
// re-entering on its own — the pass state's own retry button becomes the
// manual way back, and a successful load clears the count.
//
// THE PHANTOM LOAD. This suite runs with `disableChildFrameNavigation` (see
// the registrator above), and happy-dom still reports every disabled child
// navigation as COMPLETED: `HTMLIFrameElement` chains
// `goto(...).then(() => dispatchEvent(new Event('load')))` and the navigation
// fallback resolves, so a phantom `load` lands on every frame mount — about
// two microtasks after it, always before any test-driven event. A real
// browser fires `load` only after an actual navigation; a frame pointed at an
// unreachable origin fires `error`, never `load`. The phantom would there-
// fore reset the error streak at every re-entry and the cap could never be
// observed — so these tests suppress it at dispatch (the suite-wide convention:
// no test asserts real navigation) and deliver the ONE load each scenario
// means to deliver, by hand, through the same suppression gate.
describe("consecutive frame errors stop the auto re-exchange (fix-ocr11)", () => {
  /*
   * The patch must land where the frames actually dispatch. happy-dom exposes
   * PER-WINDOW class clones as globals (WindowContextClassExtender re-extends
   * EventTarget per window), while its elements dispatch through the
   * MODULE-level EventTarget prototype — so the owner is found by walking the
   * iframe's real prototype chain, not by naming the global. Resolved lazily:
   * the constructors exist only after the registrator ran (beforeAll).
   */
  let frameDispatchOwner: {
    dispatchEvent: (this: EventTarget, event: Event) => boolean;
  } | null = null;
  let realDispatch: ((this: EventTarget, event: Event) => boolean) | undefined;
  let allowFrameLoad = false;

  beforeEach(() => {
    if (frameDispatchOwner === null) {
      let proto: object | null = HTMLIFrameElement.prototype;
      while (proto && !Object.prototype.hasOwnProperty.call(proto, "dispatchEvent")) {
        proto = Object.getPrototypeOf(proto);
      }
      frameDispatchOwner = proto as {
        dispatchEvent: (this: EventTarget, event: Event) => boolean;
      } | null;
      realDispatch = frameDispatchOwner?.dispatchEvent;
    }
    allowFrameLoad = false;
    frameDispatchOwner!.dispatchEvent = function (event: Event) {
      // Only iframe `load` events are gated; every other dispatch — clicks,
      // the error events these tests drive — passes through untouched.
      if (!allowFrameLoad && this instanceof HTMLIFrameElement && event.type === "load") {
        return true;
      }
      return realDispatch!.call(this, event);
    };
  });
  afterEach(() => {
    frameDispatchOwner!.dispatchEvent = realDispatch!;
  });

  /** The one load a scenario means to deliver (the phantom stays suppressed). */
  function loadFrame(frame: HTMLIFrameElement) {
    allowFrameLoad = true;
    try {
      fireEvent.load(frame);
    } finally {
      allowFrameLoad = false;
    }
  }

  /**
   * Serving answers; EVERY exchange resolves at once — the unreachable-origin
   * loop in its purest form: each re-entry re-enters, then errors again.
   */
  function drawErratic() {
    const posts: string[] = [];
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/webapp-info")) {
        return Response.json({
          has_webapp: true,
          webapp_url: PREVIEW_ORIGIN,
          previewOrigin: PREVIEW_ORIGIN,
          previewOriginClosedReason: null,
          webappGeneration: "current",
          status: "running",
          ready: true,
        });
      }
      if (url.includes("/preview-ticket")) {
        posts.push(`${init?.method ?? "GET"} ${url}`);
        return Response.json({
          ticket: `${posts.length}-ticket`,
          expiresAt: new Date().toISOString(),
          origin: PREVIEW_ORIGIN,
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    return { posts, view: draw() };
  }

  test("three consecutive frame errors cap the exchanges — the pass state waits for a manual retry", async () => {
    const { posts, view } = drawErratic();

    // Enter, die, auto-recover — twice. That recovery is the designed path
    // (fix-ocr10 #2) and stays: two failures may be a hiccup.
    let frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toContain("1-ticket");
    fireEvent.error(frame);
    frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toContain("2-ticket");
    fireEvent.error(frame);
    frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toContain("3-ticket");

    // The third consecutive death: no fourth exchange on its own. The pane
    // holds the pass state — its retry button is the way back — instead of
    // burning a single-use ticket per cycle forever.
    fireEvent.error(frame);
    await view.findByText(t("preview.passTitle"));
    await settleReactWork();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(posts.length).toBe(3);

    // The manual retry: the pass state's own button re-exchanges and re-enters.
    fireEvent.click(view.getByRole("button", { name: t("preview.downRetry") }));
    const fresh = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(fresh.getAttribute("src")).toContain("4-ticket");
    expect(posts.length).toBe(4);
  });

  test("a successful load clears the streak — three MORE errors are needed to reach the cap", async () => {
    const { posts, view } = drawErratic();

    let frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toContain("1-ticket");

    // Two consecutive deaths: the streak sits at two.
    fireEvent.error(frame);
    frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    fireEvent.error(frame);
    frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toContain("3-ticket");

    // The app actually loads: whatever broke is over, the streak clears. The
    // clearing signal is the load's liveness probe (fix-ocr12) answering 200
    // through the same mock — a clean load alone proves nothing (a
    // 401-with-body page loads cleanly too), so the reset waits for the
    // probe's confirmed-alive verdict. The flush below lets it land before
    // the further errors are counted.
    loadFrame(frame);
    await settleReactWork();

    // Three further deaths AFTER the clean load: each is auto-retried, and
    // only the third consecutive one reaches the cap.
    fireEvent.error(frame);
    frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toContain("4-ticket");
    fireEvent.error(frame);
    frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toContain("5-ticket");
    fireEvent.error(frame);
    await view.findByText(t("preview.passTitle"));
    expect(posts.length).toBe(5);
  });
});

// ── fix-ocr12 #2: the loaded frame's liveness probe ────────────────────────
// 兑换成功 ≠ 导航成功 ≠ 加载成功。fix-ocr10 #2 taught the pane to recover on
// the frame's error event — but a restart-killed entry almost never errors:
// the pass cookie's validation is STATELESS (the cookie names the session; a
// restart cannot invalidate the judgment) while the ticket table and the
// label→session registry are IN-PROCESS (D4/M-2) — so after a restart the
// frame's follow-up requests are ORDINARY HTTP responses (a 401 JSON on the
// host form, the main site's own fallback page on the dev form), the frame
// "loads" cleanly, and it sits there dead. The honest signal is a probe —
// and fix-ocr13 moved it SAME-ORIGIN: the cross-origin credentialed fetch of
// the preview address (round13 H) cannot read its own status without CORS
// headers (TypeError, indistinguishable from network death), and in the dev
// form a restart-empty registry drops the old address onto the MAIN site's
// no-CORS 200/404 — a clean misjudgment. The probe is now the same-origin
// `GET /api/craft/sessions/<id>/preview-origin-live`: 204 keeps the entry
// (and clears the streak), ANY non-ok is the restart verdict and drops the
// entry through the SAME counted brake a frame error uses; a network death
// (the server itself unreachable) takes no action — the error path stays
// responsible.
//
// The phantom-load gate below is the fix-ocr11 block's, unchanged: happy-dom
// reports every disabled child navigation as COMPLETED, so a phantom `load`
// lands on every frame mount — these tests deliver the ONE load each
// scenario means to deliver, by hand, through the same suppression gate.
describe("a loaded frame's liveness probe catches the restart-dead entry (fix-ocr12, same-origin probe per fix-ocr13)", () => {
  let frameDispatchOwner: {
    dispatchEvent: (this: EventTarget, event: Event) => boolean;
  } | null = null;
  let realDispatch: ((this: EventTarget, event: Event) => boolean) | undefined;
  let allowFrameLoad = false;

  beforeEach(() => {
    if (frameDispatchOwner === null) {
      let proto: object | null = HTMLIFrameElement.prototype;
      while (proto && !Object.prototype.hasOwnProperty.call(proto, "dispatchEvent")) {
        proto = Object.getPrototypeOf(proto);
      }
      frameDispatchOwner = proto as {
        dispatchEvent: (this: EventTarget, event: Event) => boolean;
      } | null;
      realDispatch = frameDispatchOwner?.dispatchEvent;
    }
    allowFrameLoad = false;
    frameDispatchOwner!.dispatchEvent = function (event: Event) {
      // `HTMLIFrameElement` is a per-window global the registrator tears
      // down; the window's own late `load` dispatch can land here after that
      // teardown, so the class is resolved defensively instead of assumed.
      if (
        !allowFrameLoad &&
        event.type === "load" &&
        typeof HTMLIFrameElement === "function" &&
        this instanceof HTMLIFrameElement
      ) {
        return true;
      }
      return realDispatch!.call(this, event);
    };
  });
  afterEach(() => {
    frameDispatchOwner!.dispatchEvent = realDispatch!;
  });

  /** The one load a scenario means to deliver (the phantom stays suppressed). */
  function loadFrame(frame: HTMLIFrameElement) {
    allowFrameLoad = true;
    try {
      fireEvent.load(frame);
    } finally {
      allowFrameLoad = false;
    }
  }

  /**
   * Serving answers; the FIRST exchange resolves at once, later ones are held
   * (so a dropped entry visibly sits in the pass state until the test
   * releases it). The probe rides the SAME-ORIGIN endpoint
   * `/api/craft/sessions/<id>/preview-origin-live` (fix-ocr13) and its answer
   * is the scenario under test.
   */
  function drawProbed(probe: () => Response | Promise<Response>) {
    const posts: string[] = [];
    let releaseHeld!: (response: Response) => void;
    const heldTicket = new Promise<Response>((resolve) => {
      releaseHeld = resolve;
    });
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/webapp-info")) {
        return Response.json({
          has_webapp: true,
          webapp_url: PREVIEW_ORIGIN,
          previewOrigin: PREVIEW_ORIGIN,
          previewOriginClosedReason: null,
          webappGeneration: "current",
          status: "running",
          ready: true,
        });
      }
      if (url.includes("/preview-ticket")) {
        posts.push(`${init?.method ?? "GET"} ${url}`);
        if (posts.length === 1) {
          return Response.json({
            ticket: "1-ticket",
            expiresAt: new Date().toISOString(),
            origin: PREVIEW_ORIGIN,
          });
        }
        return heldTicket;
      }
      if (url.includes("/preview-origin-live")) return probe();
      return Response.json({});
    }) as unknown as typeof fetch;
    return { posts, releaseHeld, view: draw() };
  }

  /** Every exchange resolves at once — the restart-dead loop in its purest form. */
  function drawProbedEager(probe: () => Response | Promise<Response>) {
    const posts: string[] = [];
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/webapp-info")) {
        return Response.json({
          has_webapp: true,
          webapp_url: PREVIEW_ORIGIN,
          previewOrigin: PREVIEW_ORIGIN,
          previewOriginClosedReason: null,
          webappGeneration: "current",
          status: "running",
          ready: true,
        });
      }
      if (url.includes("/preview-ticket")) {
        posts.push(`${init?.method ?? "GET"} ${url}`);
        return Response.json({
          ticket: `${posts.length}-ticket`,
          expiresAt: new Date().toISOString(),
          origin: PREVIEW_ORIGIN,
        });
      }
      if (url.includes("/preview-origin-live")) return probe();
      return Response.json({});
    }) as unknown as typeof fetch;
    return { posts, view: draw() };
  }

  test("a load whose probe answers 503 drops the entry — the pass state returns and a fresh pass re-enters", async () => {
    const { posts, releaseHeld, view } = drawProbed(() =>
      Response.json(
        { error: "The preview origin restarted; re-enter the preview." },
        { status: 503 },
      ),
    );
    const frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toContain("1-ticket");

    // The frame loads cleanly (a 401-with-body page does), then the probe
    // delivers the verdict the load event could not: the origin restarted,
    // the entry is dead.
    loadFrame(frame);
    await view.findByText(t("preview.passTitle"));
    expect(view.container.querySelector("iframe")).toBeNull();

    // The recovery is the designed one: a fresh exchange, a fresh ticket,
    // the frame re-enters on its own.
    releaseHeld(
      Response.json({
        ticket: "2-ticket",
        expiresAt: new Date().toISOString(),
        origin: PREVIEW_ORIGIN,
      }),
    );
    const fresh = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(fresh.getAttribute("src")).toContain("2-ticket");
    expect(posts.length).toBe(2);
  });

  test("any other non-ok probe shape (404) drops the entry too", async () => {
    const { posts, releaseHeld, view } = drawProbed(() =>
      Response.json({}, { status: 404 }),
    );
    const frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    loadFrame(frame);
    await view.findByText(t("preview.passTitle"));
    expect(view.container.querySelector("iframe")).toBeNull();
    releaseHeld(
      Response.json({
        ticket: "2-ticket",
        expiresAt: new Date().toISOString(),
        origin: PREVIEW_ORIGIN,
      }),
    );
    await view.findByTitle(t("preview.title"));
    expect(posts.length).toBe(2);
  });

  test("a probe that answers 204 keeps the entry — no re-exchange, no reload", async () => {
    const { posts, view } = drawProbed(() => new Response(null, { status: 204 }));
    const frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    const src = frame.getAttribute("src");

    loadFrame(frame);
    await settleReactWork();
    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(frame.getAttribute("src")).toBe(src);
    expect(posts.length).toBe(1);
  });

  test("a probe that dies on the network takes no action — the error path stays responsible", async () => {
    const { posts, view } = drawProbed(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    const frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    const src = frame.getAttribute("src");

    loadFrame(frame);
    await settleReactWork();
    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(frame.getAttribute("src")).toBe(src);
    expect(posts.length).toBe(1);
  });

  test("repeated probe deaths ride the same brake — the third consecutive one caps the re-exchanges", async () => {
    const { posts, view } = drawProbedEager(() =>
      Response.json(
        { error: "The preview origin restarted; re-enter the preview." },
        { status: 503 },
      ),
    );

    // Two probe-verified deaths auto-recover, exactly like frame errors do.
    let frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toContain("1-ticket");
    loadFrame(frame);
    await waitFor(() => expect(posts.length).toBe(2));
    frame = view.getByTitle(t("preview.title")) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toContain("2-ticket");
    loadFrame(frame);
    await waitFor(() => expect(posts.length).toBe(3));
    frame = view.getByTitle(t("preview.title")) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toContain("3-ticket");

    // The third consecutive probe death: no fourth exchange on its own —
    // the pass state waits for the manual retry, the single-use tickets
    // stop burning.
    loadFrame(frame);
    await view.findByText(t("preview.passTitle"));
    await settleReactWork();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(posts.length).toBe(3);

    fireEvent.click(view.getByRole("button", { name: t("preview.downRetry") }));
    const fresh = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(fresh.getAttribute("src")).toContain("4-ticket");
    expect(posts.length).toBe(4);
  });

  // ── fix-ocr25 #1: 两级探测的第二级 ────────────────────────────────────────
  //
  // 204 只证明主站视角健康（registry 有该 label），而预览源可以独立宕机
  // （仅预览域 TLS 失效/端口死亡、主站存活）：帧导航失败照样派发 load，
  // 探针 204 → 清零 + 保 entry → 死帧骑到整页刷新，fix-ocr12 在该形态
  // 失效。第二级：探针 ok 后对 entered.plain 追加 no-cors credentials
  // fetch —— reject（TypeError）即预览源网络死亡，走与帧错误同一条计数
  // 退避；opaque resolve 即可达。
  describe("fix-ocr25 #1: the 204 probe reads the main site — the preview source gets its own no-cors verdict", () => {
    /**
     * 204 probe + 可控的预览源行为。预览源地址（entered.plain）不落在任何
     * mock 分支里，由 plainSource 决定 reject（网络死亡）还是 resolve（可达）。
     */
    function drawTwoLevel(
      plainSource: () => Promise<Response>,
      recorded?: Array<{ url: string; init?: RequestInit }>,
    ) {
      const posts: string[] = [];
      let releaseHeld!: (response: Response) => void;
      const heldTicket = new Promise<Response>((resolve) => {
        releaseHeld = resolve;
      });
      global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/webapp-info")) {
          return Response.json({
            has_webapp: true,
            webapp_url: PREVIEW_ORIGIN,
            previewOrigin: PREVIEW_ORIGIN,
            previewOriginClosedReason: null,
            webappGeneration: "current",
            status: "running",
            ready: true,
          });
        }
        if (url.includes("/preview-ticket")) {
          posts.push(`${init?.method ?? "GET"} ${url}`);
          if (posts.length === 1) {
            return Response.json({
              ticket: "1-ticket",
              expiresAt: new Date().toISOString(),
              origin: PREVIEW_ORIGIN,
            });
          }
          return heldTicket;
        }
        if (url.includes("/preview-origin-live")) {
          return new Response(null, { status: 204 });
        }
        // 预览源本身（entered.plain）：不属主站 API，由场景决定生死。
        recorded?.push({ url, init });
        return plainSource();
      }) as unknown as typeof fetch;
      return { posts, releaseHeld, view: draw() };
    }

    test("a 204 probe over a dead preview source drops the entry — the no-cors reject rides the counted brake (fix-ocr25 #1)", async () => {
      const plainFetches: Array<{ url: string; init?: RequestInit }> = [];
      const { posts, releaseHeld, view } = drawTwoLevel(
        () => Promise.reject(new TypeError("Failed to fetch")),
        plainFetches,
      );
      const frame = (await view.findByTitle(
        t("preview.title"),
      )) as HTMLIFrameElement;
      expect(frame.getAttribute("src")).toContain("1-ticket");

      // load fires（导航失败也派发 load）→ 探针 204 → 第二级 no-cors fetch
      // reject → 预览源网络死亡 → countFrameDeath：entry 重置，退回 pass
      // 态。RED：现状 204 即清零 + 保 entry，死帧骑到整页刷新。
      loadFrame(frame);
      await view.findByText(t("preview.passTitle"));
      expect(view.container.querySelector("iframe")).toBeNull();

      // 既有退避不变：释放-held 票据后重新换票进入。
      releaseHeld(
        Response.json({
          ticket: "2-ticket",
          expiresAt: new Date().toISOString(),
          origin: PREVIEW_ORIGIN,
        }),
      );
      const fresh = (await view.findByTitle(
        t("preview.title"),
      )) as HTMLIFrameElement;
      expect(fresh.getAttribute("src")).toContain("2-ticket");
      expect(posts.length).toBe(2);

      // 第二级探测的形状：打在 entered.plain 上，no-cors + credentials，
      // 生命期归探针的 AbortController（随 pane/node teardown 中止）。
      expect(plainFetches.length).toBe(1);
      expect(plainFetches[0]?.url).toBe(PREVIEW_ORIGIN);
      expect(plainFetches[0]?.init?.mode).toBe("no-cors");
      expect(plainFetches[0]?.init?.credentials).toBe("include");
      expect(plainFetches[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    });

    test("a 204 probe over a reachable preview source keeps the entry — the opaque resolve is the alive verdict (fix-ocr25 #1)", async () => {
      const plainFetches: Array<{ url: string; init?: RequestInit }> = [];
      const { posts, view } = drawTwoLevel(
        () => Promise.resolve(new Response(null, { status: 200 })),
        plainFetches,
      );
      const frame = (await view.findByTitle(
        t("preview.title"),
      )) as HTMLIFrameElement;
      const src = frame.getAttribute("src");

      loadFrame(frame);
      await settleReactWork();
      // 回归钉：两级都活着 → 保 entry、不重换票、不重载。
      expect(view.container.querySelector("iframe")).toBe(frame);
      expect(frame.getAttribute("src")).toBe(src);
      expect(posts.length).toBe(1);
      expect(plainFetches.length).toBe(1);
    });
  });
});

// ── fix-ocr15: the load handler's entry-shape gate; the frame wiring's ──────
// idempotence against a StrictMode same-node re-attach ──────────────────────
//
// #1: handleFrameLoad probes `/preview-origin-live` on EVERY load — but a
// LEGACY session (D10) never registers with the preview origin's label
// registry, so its probe can only ever answer 503: frame load → 503 → entry
// dropped → the effect re-enters → 503 again — three counted deaths and the
// circuit breaker seals a perfectly working legacy preview shut. A legacy
// entry rides no preview source at all (its src is the same-origin relative
// path; the registry has no row for it), so the load handler must not probe
// for it. Only a PREVIEW-SOURCE entry — an entry whose `src` is an absolute
// http(s) address — has a registry line to lose.
//
// #2: React's StrictMode simulates an unmount/remount when the frame's
// subtree mounts (the frame appears only after the entry lands), and the
// simulation re-invokes the ref callback with the SAME node: attach →
// detach(null) → attach. handleFrameRef wires one anonymous error/load pair
// per invocation and nothing removes them, so a re-attach leaves TWO pairs
// on the node — one load event fired the probe twice and one frame error
// counted twice (the streak limit of 3 tripping after 1.5 real deaths). A
// node that is already wired must wire nothing again.
describe("fix-ocr15: the load handler and the frame wiring", () => {
  // The phantom-load gate, as in the fix-ocr11/12 blocks above: happy-dom
  // reports every disabled child navigation as COMPLETED, so a phantom load
  // lands on every frame mount. These scenarios need the ONE load they mean
  // to deliver to be the only load, delivered by hand.
  let frameDispatchOwner: {
    dispatchEvent: (this: EventTarget, event: Event) => boolean;
  } | null = null;
  let realDispatch: ((this: EventTarget, event: Event) => boolean) | undefined;
  let allowFrameLoad = false;

  beforeEach(() => {
    if (frameDispatchOwner === null) {
      let proto: object | null = HTMLIFrameElement.prototype;
      while (
        proto &&
        !Object.prototype.hasOwnProperty.call(proto, "dispatchEvent")
      ) {
        proto = Object.getPrototypeOf(proto);
      }
      frameDispatchOwner = proto as {
        dispatchEvent: (this: EventTarget, event: Event) => boolean;
      } | null;
      realDispatch = frameDispatchOwner?.dispatchEvent;
    }
    allowFrameLoad = false;
    frameDispatchOwner!.dispatchEvent = function (event: Event) {
      if (
        !allowFrameLoad &&
        event.type === "load" &&
        typeof HTMLIFrameElement === "function" &&
        this instanceof HTMLIFrameElement
      ) {
        return true;
      }
      return realDispatch!.call(this, event);
    };
  });
  afterEach(() => {
    frameDispatchOwner!.dispatchEvent = realDispatch!;
  });

  function loadFrame(frame: HTMLIFrameElement) {
    allowFrameLoad = true;
    try {
      fireEvent.load(frame);
    } finally {
      allowFrameLoad = false;
    }
  }

  test("a legacy frame's load never walks the preview-origin probe — the entry survives (fix-ocr15 #1)", async () => {
    // The real server's answer for a legacy session: 503 — the label registry
    // has no row for it and never will. Probing it at all is the bug.
    const probeCalls: string[] = [];
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/preview-origin-live")) {
        probeCalls.push(url);
        return Response.json(
          { error: "The preview origin restarted; re-enter the preview." },
          { status: 503 },
        );
      }
      if (url.includes("/webapp-info")) {
        return Response.json({
          has_webapp: true,
          webapp_url: LEGACY_PATH,
          previewOrigin: null,
          previewOriginClosedReason: null,
          webappGeneration: "legacy",
          status: "running",
          ready: true,
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    const view = draw();

    const frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    const src = frame.getAttribute("src");
    expect(src).toBe(LEGACY_PATH);

    // The frame completes its load — a perfectly healthy legacy app. No probe
    // may fire: a legacy entry is not a preview-source entry, and the 503 the
    // registry would answer used to drop the entry and spiral to the breaker.
    loadFrame(frame);
    await settleReactWork();

    expect(probeCalls).toEqual([]);
    // The entry was never dropped: the frame is the same node, riding the
    // same (relative) src it entered on.
    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(frame.getAttribute("src")).toBe(src);
  });

  test("a legacy frame's load CLEARS the error streak — the breaker cannot seal a healthy legacy preview (fix-ocr18 #6)", async () => {
    // The streak's comment promises "the count clears when the frame actually
    // LOADS". For a preview-source entry the clearing signal is the probe's
    // confirmed-alive verdict — but the legacy branch early-returns BEFORE
    // any of that, the one load path that never cleared. A legacy preview
    // that hiccups twice, loads fine, then hiccups once more would ride a
    // streak of three and the breaker would seal a perfectly working app.
    // The legacy load IS its own success signal: it must zero the streak
    // (same shape the probe's ok-verdict uses).
    const servingLegacy = {
      has_webapp: true,
      webapp_url: LEGACY_PATH,
      previewOrigin: null,
      previewOriginClosedReason: null,
      webappGeneration: "legacy",
      status: "running",
      ready: true,
    };
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/webapp-info")) {
        return Response.json(servingLegacy);
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    const view = draw();

    // Two consecutive legacy frame errors: the streak sits at two. Each
    // error drops the entry and the effect re-enters directly (no pass, no
    // ticket — the legacy path needs none).
    let frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(LEGACY_PATH);
    fireEvent.error(frame);
    frame = (await view.findByTitle(t("preview.title"))) as HTMLIFrameElement;
    fireEvent.error(frame);
    frame = (await view.findByTitle(t("preview.title"))) as HTMLIFrameElement;

    // The app actually loads — the deliberate, hand-delivered load (the
    // phantom-load gate holds every other one back, so THIS event is the
    // only success signal the pane can see).
    loadFrame(frame);
    await settleReactWork();

    // A third death AFTER the healthy load: with the streak cleared at the
    // load, this is streak one of a fresh count — the pane re-enters and
    // the frame is still here. RED (fix-ocr18 #6): the load never cleared,
    // so this death hit the cap and the pass state sealed the preview.
    fireEvent.error(frame);
    await settleReactWork();
    expect(view.queryByText(t("preview.passTitle"))).toBeNull();
    const still = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(still.getAttribute("src")).toBe(LEGACY_PATH);
  });

  test("a StrictMode re-attach of the same node wires the listeners once — one load, one probe (fix-ocr15 #2)", async () => {
    const probeCalls: string[] = [];
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/preview-origin-live")) {
        probeCalls.push(url);
        return new Response(null, { status: 204 });
      }
      if (url.includes("/webapp-info")) {
        return Response.json({
          has_webapp: true,
          webapp_url: PREVIEW_ORIGIN,
          previewOrigin: PREVIEW_ORIGIN,
          previewOriginClosedReason: null,
          webappGeneration: "current",
          status: "running",
          ready: true,
        });
      }
      if (url.includes("/preview-ticket")) {
        return Response.json({
          ticket: TICKET,
          expiresAt: new Date().toISOString(),
          origin: PREVIEW_ORIGIN,
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    // StrictMode is the point of this test: its mount simulation is what
    // re-invokes the frame's ref with the same node. The serving answer is
    // cached so the pane's first commit reaches the exchange at once and the
    // frame mounts (post-entry — the shape the simulation covers).
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(craftKeys.webapp("cs-1"), {
      has_webapp: true,
      webapp_url: PREVIEW_ORIGIN,
      previewOrigin: PREVIEW_ORIGIN,
      previewOriginClosedReason: null,
      webappGeneration: "current",
      status: "running",
      ready: true,
    });
    const view = render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <PreviewTab sessionId="cs-1" />
        </QueryClientProvider>
      </StrictMode>,
    );

    const frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toContain(TICKET);

    // ONE load event — however many times StrictMode re-attached this node's
    // ref, the node must carry exactly one liveness probe, not a pair.
    loadFrame(frame);
    await settleReactWork();
    expect(probeCalls.length).toBe(1);
    // And the 204 keeps the entry, as designed.
    expect(view.container.querySelector("iframe")).toBe(frame);
  });
});

// ── fix-ocr16: the probe's URL belongs to the craft client, and the probe's ──
// lifetime belongs to the pane ────────────────────────────────────────────────
//
// The probe URL was hand-spliced inside the component while client.ts already
// owns every other `/api/craft/sessions/<id>/…` path through its private
// `sessionPath` — two spellings of one route drift apart silently, and a
// drifted probe URL 404s into "non-ok" → a counted death → the third one
// seals a healthy preview behind the breaker. The path now comes from
// client.ts's `previewOriginLive` (same URL at the mock layer — behavior
// equivalence is the point, not a new address). And the probe's GET now dies
// with the pane: an AbortController is aborted on unmount/node teardown —
// today a load event landing on a detached frame still mints a GET for a pane
// that no longer exists.
//
// The phantom-load gate below is the fix-ocr11/12/15 blocks', unchanged.
describe("the liveness probe rides the craft client, and dies with the pane (fix-ocr16)", () => {
  let frameDispatchOwner: {
    dispatchEvent: (this: EventTarget, event: Event) => boolean;
  } | null = null;
  let realDispatch: ((this: EventTarget, event: Event) => boolean) | undefined;
  let allowFrameLoad = false;

  beforeEach(() => {
    if (frameDispatchOwner === null) {
      let proto: object | null = HTMLIFrameElement.prototype;
      while (
        proto &&
        !Object.prototype.hasOwnProperty.call(proto, "dispatchEvent")
      ) {
        proto = Object.getPrototypeOf(proto);
      }
      frameDispatchOwner = proto as {
        dispatchEvent: (this: EventTarget, event: Event) => boolean;
      } | null;
      realDispatch = frameDispatchOwner?.dispatchEvent;
    }
    allowFrameLoad = false;
    frameDispatchOwner!.dispatchEvent = function (event: Event) {
      if (
        !allowFrameLoad &&
        event.type === "load" &&
        typeof HTMLIFrameElement === "function" &&
        this instanceof HTMLIFrameElement
      ) {
        return true;
      }
      return realDispatch!.call(this, event);
    };
  });
  afterEach(() => {
    frameDispatchOwner!.dispatchEvent = realDispatch!;
  });

  function loadFrame(frame: HTMLIFrameElement) {
    allowFrameLoad = true;
    try {
      fireEvent.load(frame);
    } finally {
      allowFrameLoad = false;
    }
  }

  /** Serving answers; the exchange resolves at once; probes are recorded. */
  function drawProbing(
    webappUrl: string = PREVIEW_ORIGIN,
    generation: "current" | "legacy" = "current",
  ) {
    const probeCalls: Array<{ url: string; signal?: AbortSignal }> = [];
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/preview-origin-live")) {
        // `init.signal` types as `| null` (DOM lib); normalize so the recorded
        // shape matches what the assertions judge.
        probeCalls.push({ url, signal: init?.signal ?? undefined });
        return new Response(null, { status: 204 });
      }
      if (url.includes("/webapp-info")) {
        return Response.json({
          has_webapp: true,
          webapp_url: webappUrl,
          previewOrigin: generation === "legacy" ? null : webappUrl,
          previewOriginClosedReason: null,
          webappGeneration: generation,
          status: "running",
          ready: true,
        });
      }
      if (url.includes("/preview-ticket")) {
        return Response.json({
          ticket: TICKET,
          expiresAt: new Date().toISOString(),
          origin: PREVIEW_ORIGIN,
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    return { probeCalls, view: draw() };
  }

  test("the craft client owns the probe path — previewOriginLive speaks the exact same-origin URL and carries the abort signal", async () => {
    const calls: Array<{ url: string; signal?: AbortSignal }> = [];
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), signal: init?.signal ?? undefined });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    // Dynamic import so a missing export fails THIS assertion, not the whole
    // file's module graph.
    const craftClient = await import("@/lib/craft/client");
    expect(typeof craftClient.previewOriginLive).toBe("function");

    const controller = new AbortController();
    await craftClient.previewOriginLive("cs-1", controller.signal);
    // Byte-identical to the path the component used to hand-splice.
    expect(calls.map((c) => c.url)).toEqual([
      "/api/craft/sessions/cs-1/preview-origin-live",
    ]);
    // The caller's abort signal rides through — the probe's lifetime is the
    // pane's to end.
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  test("a preview-source frame's load still probes the same URL it always did (behavior unchanged)", async () => {
    const { probeCalls, view } = drawProbing();
    const frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;

    loadFrame(frame);
    await settleReactWork();
    expect(probeCalls.map((c) => c.url)).toEqual([
      "/api/craft/sessions/cs-1/preview-origin-live",
    ]);
  });

  test("a legacy frame's load probes nothing (behavior unchanged)", async () => {
    const { probeCalls, view } = drawProbing(LEGACY_PATH, "legacy");
    const frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(LEGACY_PATH);

    loadFrame(frame);
    await settleReactWork();
    expect(probeCalls).toEqual([]);
  });

  test("unmounting aborts the in-flight probe, and a late load on the detached frame fires nothing", async () => {
    const { probeCalls, view } = drawProbing();
    const frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    loadFrame(frame);
    await settleReactWork();
    expect(probeCalls.length).toBe(1);
    // In flight: the probe carries a live abort signal — RED sees `undefined`
    // (the old fetch passed no signal at all).
    const signal = probeCalls[0]?.signal;
    expect(signal?.aborted).toBe(false);

    // The pane goes away mid-probe: the GET must not outlive it.
    view.unmount();
    expect(signal?.aborted).toBe(true);

    // And a late load event on the now-detached node mints NO new GET —
    // RED: the old handler fetched for a pane that no longer exists.
    loadFrame(frame);
    await settleReactWork();
    expect(probeCalls.length).toBe(1);
  });

  test("a probe resolving into the unmount race delivers no verdict (fix-ocr18 #7)", async () => {
    // The mirror of the check above: dispose is checked BEFORE the GET is
    // minted, but the VERDICT runs on a later tick — once the response has
    // settled, the .then continuation is already queued and the teardown's
    // abort cannot retract it. A resolution racing the unmount used to
    // deliver its setState to a pane that no longer exists. This test
    // replays that race with a deferred probe (the abort fires; the mock's
    // resolution lands anyway — exactly the already-queued microtask).
    let release: ((response: Response) => void) | undefined;
    let probeGets = 0;
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/preview-origin-live")) {
        probeGets += 1;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      if (url.includes("/webapp-info")) {
        return Response.json({
          has_webapp: true,
          webapp_url: PREVIEW_ORIGIN,
          previewOrigin: PREVIEW_ORIGIN,
          previewOriginClosedReason: null,
          webappGeneration: "current",
          status: "running",
          ready: true,
        });
      }
      if (url.includes("/preview-ticket")) {
        return Response.json({
          ticket: TICKET,
          expiresAt: new Date().toISOString(),
          origin: PREVIEW_ORIGIN,
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    const view = draw();
    const frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    loadFrame(frame);
    await settleReactWork();
    expect(probeGets).toBe(1);

    // Unmount first, THEN resolve: the race order that used to reach the
    // verdict. React 19 silences post-unmount updates, so the DOM cannot
    // observe the difference — the guard's presence is pinned at source
    // level in the test below; this race stays the behavioral proof that
    // the fixed handler leaves nothing behind (no second GET, no rejection,
    // no stray work after the pane is gone).
    view.unmount();
    release!(new Response(null, { status: 503 }));
    await settleReactWork();
    expect(probeGets).toBe(1);
  });

  test("the probe verdict rechecks disposal at the .then head (fix-ocr18 #7 — source pin; fix-ocr27 #9 extraction)", () => {
    // The pre-mint disposed check and the verdict's live-pair checks guard
    // different ticks; the disposed recheck must be the verdict's FIRST
    // judgment, symmetric with the one before the GET. Post-unmount
    // updates are silent in React 19 (no DOM/console trace to assert on),
    // so the shape is pinned at source level — the
    // plugin-mutation-refresh precedent for a guard no outside eye can see.
    // fix-ocr27 #9 extracted the trio into isLiveFramePair, whose FIRST
    // check is still disposal — the guard moved into the helper, not
    // loosened.
    const source = readFileSync(
      join(
        import.meta.dir,
        "../src/components/craft/output-panel/preview-tab.tsx",
      ),
      "utf8",
    );
    const verdictHead = source.match(
      /\.then\(\(response\) => \{(?:\s*\/\/[^\n]*)*\s*\n\s*const live = isLiveFramePair\(node, entered\);/,
    );
    expect(verdictHead).not.toBeNull();
    // The helper's own head: disposal first, then node, then entry — the
    // exact order the inlined trio used to spell. Stable identity (stable
    // refs only), so the consumers' callbacks never churn per render.
    const helperStart = source.indexOf("const isLiveFramePair = useCallback(");
    expect(helperStart).toBeGreaterThan(-1);
    const helper = source.slice(
      helperStart,
      source.indexOf("const countFrameDeath"),
    );
    expect(helper).toContain("if (disposedRef.current) return null;");
    expect(helper).toContain("return live;");
    expect(helper.indexOf("disposedRef")).toBeLessThan(
      helper.indexOf("frameNodeRef"),
    );
  });

  test("all three verdict continuations judge the live pair through the ONE helper (fix-ocr27 #9 — source pin)", () => {
    // The disposed/node/entry trio used to be spelled out verbatim in three
    // continuations (the probe verdict, the no-cors alive verdict, the
    // no-cors death verdict); fix-ocr18 #6/#7's rework was exactly such a
    // guard drifting out of sync between the copies. One helper, three
    // call sites: the count pins both that the helper exists and that no
    // continuation kept a private copy of the trio.
    const source = readFileSync(
      join(
        import.meta.dir,
        "../src/components/craft/output-panel/preview-tab.tsx",
      ),
      "utf8",
    );
    const callSites = source.match(/isLiveFramePair\(node, entered\)/g) ?? [];
    // RED: the helper does not exist yet — the trio is still inlined.
    expect(callSites.length).toBe(3);
  });
});

// ── fix-ocr19: a disposed pane's late events write NOTHING ───────────────────
// React 19 silences post-unmount updates (no DOM or console trace to assert
// on), so — same shape as the fix-ocr18 #7 source pin above — these two guards
// are pinned at source level. The probe path got its guards in fix-ocr16/#7;
// fix-ocr19 closes the two remaining asymmetries: the LEGACY load branch's
// streak zeroing ran BEFORE the disposed check (a detached node's late load
// still called setFrameErrorStreak), and handleFrameError had no disposed
// guard at all (a late error on a detached node still counted a death).
describe("a disposed pane's late frame events write nothing (fix-ocr19 #3/#4 — source pins)", () => {
  const source = readFileSync(
    join(
      import.meta.dir,
      "../src/components/craft/output-panel/preview-tab.tsx",
    ),
    "utf8",
  );

  test("the legacy zeroing sits AFTER the disposed check in handleFrameLoad (fix-ocr19 #3)", () => {
    // fix-ocr18 #6/#7's ordering gap: the legacy branch zeroed the streak
    // before the pane's disposal was consulted — the one verdict path whose
    // write preceded the guard. The disposed early-exit must come first,
    // symmetric with every other path (the probe's pre-mint check, the
    // verdict's recheck, and the frame-error guard below).
    const load = source.slice(
      source.indexOf("const handleFrameLoad"),
      source.indexOf("const handleFrameRef"),
    );
    const disposedAt = load.indexOf("if (disposedRef.current) return;");
    // fix-ocr21 #4: the http(s) literal became the module-level HTTP_ABSOLUTE.
    const legacyAt = load.indexOf("if (!HTTP_ABSOLUTE.test(entered.src))");
    expect(disposedAt).toBeGreaterThan(-1);
    expect(legacyAt).toBeGreaterThan(-1);
    expect(disposedAt).toBeLessThan(legacyAt);
  });

  test("handleFrameError exits on disposal before anything else (fix-ocr19 #4)", () => {
    // The frame-error path counted deaths (and dropped entries) for a pane
    // that no longer exists — the probe path's disposal symmetry, missing
    // on the transport signal. The callback's FIRST statement is the guard.
    const handleErrorHead = source.match(
      /const handleFrameError = useCallback\(\s*\(node: HTMLIFrameElement\) => \{(?:\s*\/\/[^\n]*)*\s*\n\s*if \(disposedRef\.current\) return;/,
    );
    expect(handleErrorHead).not.toBeNull();
  });
});

describe("the load-path streak zeroing preserves the zero reference (fix-ocr24 #4 — source pin)", () => {
  const source = readFileSync(
    join(
      import.meta.dir,
      "../src/components/craft/output-panel/preview-tab.tsx",
    ),
    "utf8",
  );

  test("both zeroing sites in handleFrameLoad ride the functional update that returns prev at zero", () => {
    // A preview app's own internal navigation fires load on EVERY hop; the
    // unconditional fresh object re-rendered the pane and re-walked the
    // entering effect (frameErrorStreak is its dep) even when the streak was
    // already zero. The functional form keeps the reference identical at
    // zero — React bails out, nothing re-renders. Property is invisible to
    // the DOM (behavior is equivalent), so it pins the source, the same way
    // the fix-ocr19 ordering pins above do.
    const load = source.slice(
      source.indexOf("const handleFrameLoad"),
      source.indexOf("const handleFrameRef"),
    );
    const functionalZeros = [
      ...load.matchAll(
        /setFrameErrorStreak\(\s*\(\s*prev\s*\)\s*=>/g,
      ),
    ];
    expect(functionalZeros.length).toBe(2);
    // Neither site keeps the bare-object form that allocates per load.
    expect(
      load.includes('setFrameErrorStreak({ address: "", count: 0 })'),
    ).toBe(false);
  });
});

// ── fix-ocr26 #2: the second-level probe's abort is not a death verdict ─────
// A full-page navigation of the preview app ITSELF (meta refresh, a redirect,
// a manual reload) fires load again on the SAME node; the handler's
// `probeAbortRef.current?.abort()` then kills the PREVIOUS probe's in-flight
// no-cors fetch — whose catch used to run all three guards (pane mounted,
// node live, entry unchanged all hold) and count a DEATH: entry dropped, a
// fresh single-use ticket burned, per navigation. An AbortError is the abort
// path (teardown and a newer probe share it), never the network-death signal
// the catch exists to judge.
describe("fix-ocr26 #2: the second-level probe's abort is not a death", () => {
  let frameDispatchOwner: {
    dispatchEvent: (this: EventTarget, event: Event) => boolean;
  } | null = null;
  let realDispatch: ((this: EventTarget, event: Event) => boolean) | undefined;
  let allowFrameLoad = false;

  beforeEach(() => {
    if (frameDispatchOwner === null) {
      let proto: object | null = HTMLIFrameElement.prototype;
      while (
        proto &&
        !Object.prototype.hasOwnProperty.call(proto, "dispatchEvent")
      ) {
        proto = Object.getPrototypeOf(proto);
      }
      frameDispatchOwner = proto as {
        dispatchEvent: (this: EventTarget, event: Event) => boolean;
      } | null;
      realDispatch = frameDispatchOwner?.dispatchEvent;
    }
    allowFrameLoad = false;
    frameDispatchOwner!.dispatchEvent = function (event: Event) {
      if (
        !allowFrameLoad &&
        event.type === "load" &&
        typeof HTMLIFrameElement === "function" &&
        this instanceof HTMLIFrameElement
      ) {
        return true;
      }
      return realDispatch!.call(this, event);
    };
  });
  afterEach(() => {
    frameDispatchOwner!.dispatchEvent = realDispatch!;
  });

  function loadFrame(frame: HTMLIFrameElement) {
    allowFrameLoad = true;
    try {
      fireEvent.load(frame);
    } finally {
      allowFrameLoad = false;
    }
  }

  test("a second load on the same frame aborts the first probe's no-cors fetch — no death counted, no ticket burned", async () => {
    const posts: string[] = [];
    const plainFetches: Array<AbortSignal | null | undefined> = [];
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/preview-origin-live")) {
        return new Response(null, { status: 204 });
      }
      if (url.includes("/webapp-info")) {
        return Response.json({
          has_webapp: true,
          webapp_url: PREVIEW_ORIGIN,
          previewOrigin: PREVIEW_ORIGIN,
          previewOriginClosedReason: null,
          webappGeneration: "current",
          status: "running",
          ready: true,
        });
      }
      if (url.includes("/preview-ticket")) {
        posts.push(`${init?.method ?? "GET"} ${url}`);
        return Response.json({
          ticket: `${posts.length}-ticket`,
          expiresAt: new Date().toISOString(),
          origin: PREVIEW_ORIGIN,
        });
      }
      // The preview source itself (entered.plain): hang until aborted, then
      // reject the way a real aborted fetch does — an AbortError.
      plainFetches.push(init?.signal);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted.");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as unknown as typeof fetch;

    const view = draw();
    const frame = (await view.findByTitle(
      t("preview.title"),
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toContain("1-ticket");

    // First load: probe 204 → the second-level no-cors fetch hangs.
    loadFrame(frame);
    await waitFor(() => expect(plainFetches.length).toBe(1));

    // The app's own full-page navigation: the SAME node fires load again —
    // the handler aborts the first probe (and its in-flight no-cors fetch).
    loadFrame(frame);
    await settleReactWork();

    // RED: the abort surfaced as network death — the entry was dropped, a
    // second ticket bought, the frame replaced. The navigation cost nothing
    // but a probe.
    expect(posts.length).toBe(1);
    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(frame.getAttribute("src")).toContain("1-ticket");
  });
});

// ── fix-ocr26 #3: a cancelled exchange's late rejection writes nothing ──────
// The .then head guards with `if (guard.cancelled) return;` — the .catch did
// not: a stale run's rejection (a session switch cancelled the guard, the
// response arrived anyway) overwrote exchangeRefusal for a run that is no
// longer the pane's answer — a post-cancel setState of exactly the shape the
// then-side guards against.
describe("fix-ocr26 #3: the cancelled exchange's catch holds the guard too", () => {
  test("a rejection from a cancelled run never renders its refusal over the new run's state", async () => {
    const posts: string[] = [];
    const pending: Array<(response: Response) => void> = [];
    const infoBody = {
      has_webapp: true,
      webapp_url: PREVIEW_ORIGIN,
      previewOrigin: PREVIEW_ORIGIN,
      previewOriginClosedReason: null,
      webappGeneration: "current",
      status: "running",
      ready: true,
    };
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/webapp-info")) return Response.json(infoBody);
      if (url.includes("/preview-ticket")) {
        posts.push(`${init?.method ?? "GET"} ${url}`);
        return new Promise<Response>((resolve) => {
          pending.push(resolve);
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = draw(client);
    await waitFor(() => expect(posts.length).toBe(1)); // cs-1's exchange in flight

    // The session switch cancels cs-1's guard (the effect cleanup) and buys
    // cs-2 its own pass — the cached answer is byte-identical, so only the
    // session (and the frame key) changes.
    client.setQueryData(craftKeys.webapp("cs-2"), infoBody);
    view.rerender(
      <QueryClientProvider client={client}>
        <PreviewTab sessionId="cs-2" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(posts.length).toBe(2));

    // cs-1's response lands AFTER the cancellation — as a refusal.
    pending[0](
      Response.json(
        { error: "stale-run refusal sentence" },
        { status: 409 },
      ),
    );
    await settleReactWork();

    // The refusal belongs to a dead run: it must not render under cs-2's
    // pass state. RED: the unguarded catch wrote it.
    expect(view.queryByText("stale-run refusal sentence")).toBeNull();
  });
});
