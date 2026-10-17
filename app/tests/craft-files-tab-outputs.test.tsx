import "./preload";
import { afterAll, afterEach, beforeAll, expect, test } from "../../tests/support/e2e-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, type RenderResult } from "@testing-library/react";
import { FilesTab } from "@/components/craft/output-panel/files-tab";
import { settleReactWork } from "./settle-react-work";

/**
 * THE FILES TAB'S ANCHOR IS outputs/ — the deliverables the agent writes. The workspace's
 * startup scaffolding (AGENTS.md, opencode.json, attachments/) never appears in the tree.
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

const calls: string[] = [];

function serving() {
  calls.length = 0;
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/files?path=outputs")) {
      return Response.json({
        entries: [
          {
            path: "outputs/report.md",
            name: "report.md",
            kind: "file",
            sizeBytes: 0,
            updatedAt: "",
          },
        ],
      });
    }
    return Response.json({ entries: [] });
  }) as unknown as typeof fetch;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FilesTab sessionId="s1" />
    </QueryClientProvider>,
  );
}

test("the file tree is rooted at outputs, and only outputs is ever listed", async () => {
  serving();
  const view: RenderResult = draw();

  // The outputs entry renders without any root-level fetch.
  await view.findByText("report.md", { exact: false });

  const listings = calls.filter((url) => url.includes("/files"));
  expect(listings.length).toBeGreaterThan(0);
  for (const url of listings) {
    expect(url).toContain("path=outputs");
  }
});
