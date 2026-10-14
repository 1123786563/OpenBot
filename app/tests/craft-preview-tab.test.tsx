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
  status: string;
  ready: boolean;
};

/** Answer `/webapp-info` with a fixed shape. */
function serving(info: Info) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/webapp-info")) {
      return Response.json(info);
    }
    return Response.json({});
  }) as unknown as typeof fetch;
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
    | "preview.openInNewTab",
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
      webapp_url: URL,
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
      webapp_url: URL,
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

  test("a serving preview also offers the proxy URL in a new tab", async () => {
    const view = drawServing();
    await view.findByTitle(t("preview.title"));
    const link = view.getByLabelText(t("preview.openInNewTab"));
    expect(link.getAttribute("href")).toBe(URL);
    expect(link.getAttribute("target")).toBe("_blank");
    // A new tab is a new browsing context: without this the opened app keeps a
    // handle on its opener, which is the coupling a separate tab exists to avoid.
    expect(link.getAttribute("rel")).toContain("noopener");
  });
});

test("a scaffold whose dev server is down renders the down state, never an iframe", async () => {
  serving({
    has_webapp: true,
    webapp_url: URL,
    status: "stopped",
    ready: false,
  });
  const view = draw();

  await view.findByText(t("preview.downTitle"));
  expect(view.container.querySelector("iframe")).toBeNull();
  // The pane says what the server's 503 said, in the product's own voice.
  expect(view.getByText(t("preview.downHint"))).toBeTruthy();
});

test("a ready dev server renders the iframe pointed at the proxy URL", async () => {
  serving({
    has_webapp: true,
    webapp_url: URL,
    status: "running",
    ready: true,
  });
  const view = draw();

  const frame = (await view.findByTitle(
    t("preview.title"),
  )) as HTMLIFrameElement;
  expect(frame.getAttribute("src")).toBe(URL);
});

test("no scaffold at all renders the waiting state, not the down state", async () => {
  serving({
    has_webapp: false,
    webapp_url: URL,
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
    webapp_url: URL,
    status: "stopped",
    ready: false,
  });
  expect(down).toBeGreaterThan(0);
  expect(
    previewPollInterval({
      has_webapp: true,
      webapp_url: URL,
      status: "running",
      ready: true,
    }),
  ).toBe(false);
  expect(
    previewPollInterval({
      has_webapp: false,
      webapp_url: URL,
      status: "stopped",
      ready: false,
    }),
  ).toBe(false);
  expect(
    previewPollInterval({
      has_webapp: null,
      webapp_url: null,
      status: "no_sandbox",
      ready: false,
    }),
  ).toBe(false);
  expect(previewPollInterval(undefined)).toBe(false);
});
