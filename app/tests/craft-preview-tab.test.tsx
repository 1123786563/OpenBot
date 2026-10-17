import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  type RenderResult,
  render,
} from "@testing-library/react";
import {
  PreviewTab,
  previewPollInterval,
} from "@/components/craft/output-panel/preview-tab";
import i18n from "@/lib/i18n";
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

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
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
  status: string;
  ready: boolean;
};

/** D11 (#362): the preview address is ABSOLUTE — the preview origin's own host. */
const PREVIEW_ORIGIN = "http://127.0.0.1:3001/abc123label";

/** The single-use pass the exchange answers with (D4/D9). */
const TICKET = "single-use-ticket-32-bytes";

/** Answer `/webapp-info` and `POST /preview-ticket`, recording the exchanges. */
function serving(
  info: Info,
  options: { ticketFails?: boolean } = {},
) {
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

function draw(): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
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
    | "preview.closedTitle",
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

  await view.findByText(t("preview.passTitle"));
  expect(view.container.querySelector("iframe")).toBeNull();
  // The serving app must not wear the "isn't running" sentence: the server is
  // up; only the pass is missing.
  expect(view.queryByText(t("preview.downTitle"))).toBeNull();
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
