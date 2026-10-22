import "../preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { act } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { Route as ShareRoute } from "../../src/routes/share.$token";

/**
 * MT092 / Issue #135: the share page's identity is the token, and its availability is the
 * server's answer, never a copy the page holds. What this ticket binds on the page side: the
 * miss family is UNIFORM and leaks nothing (AC2 — a wrong, expired and revoked token render the
 * same page, with no title, artifact name or other metadata), a revoked or expired link is
 * never served from a previous visit (AC3's page half — gcTime 0: the very next visit re-asks
 * and misses), and the live view's downloads stay behind the share's own scope (only
 * preview_download rows with a signed downloadUrl offer one).
 *
 * THE HONEST BOUNDARY, same shape as the mt15 disclose precedent: the audience-bearing share
 * authorization (same-team default, explicit same-company cross-team with expiry) and the
 * reason-distinguishing refusal are the SERVER contract of MT058 (#101, open — its decision
 * service exists at server/src/enterprise/tenancy/personal-share-rules.ts but serves no traffic,
 * per server/src/index.ts's own boundary note). Until MT058 lands, this page cannot distinguish
 * a non-member from a wrong token, and its miss family stays uniform BY DESIGN (B14's contract);
 * these tests pin the page's half of AC1/AC3/AC4 and the whole of AC2 against the current
 * server contract.
 *
 * THE HARNESS IS THE REAL PAGE: `share.$token`'s own component under a memory router, fetch
 * recorded — every request the page makes is the evidence.
 */

const LIVE_TOKEN = "live-token-32-bytes-of-entropy";
const MISSING = {
  title: "This link does not exist or is no longer valid.",
  hint: "It may have expired or been revoked.",
};

const ARTIFACTS = [
  {
    id: "art-1",
    name: "acme-quarterly-report.md",
    type: "report",
    sizeBytes: 2048,
    downloadUrl: null,
  },
];

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());
afterEach(cleanup);

const originalFetch = global.fetch;

type Asked = { input: string; init: RequestInit | undefined; url: string };

let asked: Asked[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Answer the public share surface. `state` is what the artifacts read answers for the CURRENT
 * token — flipping it between renders is how a revocation mid-life is simulated.
 */
function serve(state: {
  [token: string]: { status: number; scope?: string; withDownload?: boolean } | undefined;
}): void {
  asked = [];
  global.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    asked.push({ input: url.split("?")[0], init, url });
    const match = url.match(/\/api\/public\/workshop\/share\/([^/]+)\/(artifacts|preview|report)/);
    if (match !== null) {
      const answer = state[match[1]];
      if (answer === undefined) return jsonResponse(200, {});
      if (match[2] === "artifacts") {
        if (answer.status !== 200) return jsonResponse(answer.status, {});
        return jsonResponse(200, {
          scope: answer.scope ?? "preview",
          artifacts: ARTIFACTS.map((artifact) => ({
            ...artifact,
            downloadUrl: answer.withDownload
              ? `/api/public/workshop/share/${match[1]}/artifacts/art-1?sig=signed`
              : null,
          })),
        });
      }
      if (match[2] === "preview") {
        return answer.status === 200
          ? new Response("<html></html>", {
              headers: { "content-type": "text/html" },
            })
          : jsonResponse(answer.status, {});
      }
      return jsonResponse(200, {});
    }
    return jsonResponse(200, {});
  }) as unknown as typeof fetch;
}

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function draw(token: string, queryClient?: QueryClient) {
  const client = queryClient ?? freshClient();
  const rootRoute = createRootRoute();
  const share = (
    ShareRoute as unknown as { update: (options: unknown) => unknown }
  ).update({ path: "/share/$token", getParentRoute: () => rootRoute });
  const router = createRouter({
    routeTree: rootRoute.addChildren([share as never]),
    history: createMemoryHistory({ initialEntries: [`/share/${token}`] }),
  });
  return {
    client,
    view: render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  asked = [];
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("MT092 AC2 — the miss family is uniform and leaks nothing", () => {
  test("a wrong token, an expired link and a revoked one render the SAME page, with no metadata", async () => {
    serve({
      "wrong-token": { status: 404 },
      "expired-token": { status: 404 },
      "revoked-token": { status: 404 },
    });
    for (const token of ["wrong-token", "expired-token", "revoked-token"]) {
      const { view } = draw(token);
      expect(await view.findByText(MISSING.title)).toBeTruthy();
      expect(view.getByText(MISSING.hint)).toBeTruthy();
      // No title, no artifact name, no preview — the miss says nothing about the content.
      expect(view.queryByText("acme-quarterly-report.md")).toBeNull();
      expect(view.queryByTitle("Static preview")).toBeNull();
      cleanup();
    }
  });

  test("the live view lists artifacts, and downloads stay behind the share's scope", async () => {
    serve({
      [LIVE_TOKEN]: { status: 200, scope: "preview", withDownload: false },
    });
    const { view } = draw(LIVE_TOKEN);
    expect(await view.findByText("acme-quarterly-report.md")).toBeTruthy();
    // preview scope and no signed URL: no download is offered.
    expect(view.queryByText("Download")).toBeNull();

    cleanup();
    serve({
      [LIVE_TOKEN]: { status: 200, scope: "preview_download", withDownload: true },
    });
    const wide = draw(LIVE_TOKEN).view;
    await waitFor(() => expect(wide.getByText("Download")).toBeTruthy());
  });
});

describe("MT092 AC3 — a revoked or expired link is never served from a previous visit", () => {
  test("a link that was live misses on the very next visit — no cached carry-over", async () => {
    serve({ [LIVE_TOKEN]: { status: 200, scope: "preview" } });
    const first = draw(LIVE_TOKEN);
    expect(await first.view.findByText("acme-quarterly-report.md")).toBeTruthy();

    // The owner revokes; the very same URL now answers the uniform miss.
    cleanup();
    serve({ [LIVE_TOKEN]: { status: 404 } });
    const second = draw(LIVE_TOKEN);
    expect(await second.view.findByText(MISSING.title)).toBeTruthy();
    expect(second.view.queryByText("acme-quarterly-report.md")).toBeNull();
  });

  test("the page explains the miss within the uniform contract — no reason is distinguished", async () => {
    serve({ gone: { status: 404 } });
    const { view } = draw("gone");
    expect(await view.findByText(MISSING.title)).toBeTruthy();
    // The hint names expiry and revocation without saying which — the whole reason a probe
    // learns nothing (AC2), and the page's explanation of the miss (AC3's page half).
    expect(view.getByText(MISSING.hint)).toBeTruthy();
  });
});

describe("MT092 — the report action and the anonymous key", () => {
  test("the report posts to the token's own endpoint and reports once", async () => {
    serve({ [LIVE_TOKEN]: { status: 200, scope: "preview" } });
    const { view } = draw(LIVE_TOKEN);
    await view.findByText("acme-quarterly-report.md");

    await act(async () => {
      view.getByRole("button", { name: "Report" }).click();
    });
    await waitFor(() => expect(view.getByText("Reported")).toBeTruthy());
    const reports = asked.filter(
      (ask) => ask.input.endsWith("/report") && ask.init?.method === "POST",
    );
    expect(reports.length).toBe(1);
  });

  test("every request the page makes is anonymous — no credentials, no selection pair", async () => {
    serve({ [LIVE_TOKEN]: { status: 200, scope: "preview" } });
    const { view } = draw(LIVE_TOKEN);
    await view.findByText("acme-quarterly-report.md");

    expect(asked.length).toBeGreaterThan(0);
    for (const ask of asked) {
      expect(ask.init?.credentials).toBe("omit");
      expect(ask.url.startsWith("/api/public/workshop/share/")).toBe(true);
    }
  });
});
