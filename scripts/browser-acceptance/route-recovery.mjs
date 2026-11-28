import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright-core";

const { BUILD_DIR, BUILD_MANIFEST, EVIDENCE_DIR } = process.env;
assert(BUILD_DIR && BUILD_MANIFEST && EVIDENCE_DIR);
const build = JSON.parse(await readFile(BUILD_MANIFEST, "utf8"));
const index = Bun.file(join(BUILD_DIR, "index.html"));
assert.equal(
  createHash("sha256")
    .update(await index.bytes())
    .digest("hex"),
  build.indexSha256,
);
await mkdir(EVIDENCE_DIR, { recursive: true });

const fixture = Bun.spawn(
  ["bun", "--no-env-file", "scripts/browser-acceptance/api.mjs"],
  {
    env: { ...process.env, FIXTURE_API_PORT: "0" },
    stdout: "pipe",
    stderr: "inherit",
  },
);
const cases = [];

try {
  const reader = fixture.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const api = new TextDecoder()
    .decode(value)
    .match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert(api, "The isolated fixture did not announce its port");
  const setup = await fetch(`${api}/__fixture/governance`, {
    method: "PUT",
    body: JSON.stringify({ firstBatch: true, edition: "personal" }),
  });
  assert(setup.ok);
  assert.equal(setup.headers.get("x-openbot-fixture"), "isolated");
  assert.equal(
    (
      await fetch(`${api}/__fixture/session?signedIn=true`, {
        redirect: "manual",
      })
    ).status,
    302,
  );

  let unavailable = true;
  const moduleResponses = [];
  const headers = { "cache-control": "no-store" };
  const preview = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname, search } = new URL(request.url);
      if (pathname.startsWith("/api/"))
        return fetch(new Request(`${api}${pathname}${search}`, request));
      if (/^\/assets\/route-settings-[\w-]+\.js$/.test(pathname)) {
        moduleResponses.push(unavailable ? 503 : 200);
        if (unavailable)
          return new Response("Temporary route dependency outage", {
            status: 503,
            headers,
          });
      }
      if (!pathname.startsWith("/assets/"))
        return new Response(index, { headers });
      const asset = Bun.file(join(BUILD_DIR, pathname));
      return (await asset.exists())
        ? new Response(asset, { headers })
        : new Response(null, { status: 404, headers });
    },
  });

  try {
    for (const engine of [webkit, chromium]) {
      unavailable = true;
      moduleResponses.length = 0;
      const browser = await engine.launch();
      try {
        const page = await browser.newPage({
          locale: "en-US",
          viewport: { width: 390, height: 844 },
          colorScheme: "dark",
        });
        page.setDefaultTimeout(8000);
        const target = new URL(
          "/settings/notifications?via=bookmark#delivery",
          preview.url,
        ).href;
        await page.goto(target);
        const retry = page.getByRole("button", { name: "Try again" });
        await retry.waitFor();
        const failedRetry = page.waitForEvent("domcontentloaded");
        await retry.press("Enter");
        await failedRetry;
        await page
          .getByText(
            "The page still couldn’t load. You can try again or open your workspace.",
            { exact: true },
          )
          .first()
          .waitFor();
        assert(moduleResponses.includes(503));

        unavailable = false;
        await retry.press("Enter");
        await page
          .getByRole("heading", {
            name: "Notifications",
            level: 1,
            exact: true,
          })
          .waitFor();
        await page.waitForFunction(
          () => document.activeElement?.textContent?.trim() === "Notifications",
        );
        assert.equal(page.url(), target);
        assert(moduleResponses.includes(200));
        const screenshot = `${engine.name()}.png`;
        await page.screenshot({ path: join(EVIDENCE_DIR, screenshot) });
        cases.push({
          browser: engine.name(),
          path:
            new URL(target).pathname +
            new URL(target).search +
            new URL(target).hash,
          moduleResponses: [...moduleResponses],
          focus: "Notifications",
          screenshot,
        });
      } finally {
        await browser.close();
      }
    }
  } finally {
    preview.stop(true);
  }
} finally {
  fixture.kill();
  await fixture.exited;
  await writeFile(
    join(EVIDENCE_DIR, "run.json"),
    JSON.stringify({ build, cases }, null, 2),
  );
}
