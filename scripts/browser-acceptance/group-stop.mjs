import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { salesBot } from "./governance-fixture.mjs";

const { EVIDENCE_DIR, BUILD_MANIFEST, FIXTURE_APP_URL, FIXTURE_API_URL } =
  process.env;
assert(EVIDENCE_DIR && BUILD_MANIFEST && FIXTURE_APP_URL && FIXTURE_API_URL);
for (const url of [FIXTURE_APP_URL, FIXTURE_API_URL])
  assert.equal(new URL(url).hostname, "127.0.0.1");

const build = JSON.parse(await readFile(BUILD_MANIFEST, "utf8"));
const index = await fetch(FIXTURE_APP_URL);
assert(index.ok);
assert.equal(
  createHash("sha256")
    .update(await index.text())
    .digest("hex"),
  build.indexSha256,
);
const setup = await fetch(`${FIXTURE_API_URL}/__fixture/governance`, {
  method: "PUT",
  body: JSON.stringify({ firstBatch: true, edition: "personal" }),
});
assert(setup.ok);
assert.equal(setup.headers.get("x-openbot-fixture"), "isolated");
const session = await fetch(
  `${FIXTURE_API_URL}/__fixture/session?signedIn=true`,
  { redirect: "manual" },
);
assert.equal(session.status, 302);
const { user } = await (await fetch(`${FIXTURE_API_URL}/api/me`)).json();
assert(user.id);

const channelId = "acceptance-plan";
const turnId = "verify-stop";
const groupApi = `/api/groups/${channelId}`;
const browser = await chromium.launch();
const cases = [];
try {
  for (const width of [1440, 390]) {
    for (const theme of ["light", "dark"]) {
      const height = width === 390 ? 844 : 900;
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: theme,
      });
      try {
        await context.addInitScript(
          (theme) => localStorage.setItem("openbot-theme", theme),
          theme,
        );
        await context.route("**/*", (route) =>
          new URL(route.request().url()).origin === FIXTURE_APP_URL
            ? route.continue()
            : route.abort(),
        );
        const page = await context.newPage();
        const errors = [];
        const stopRequests = [];
        const groupWrites = [];
        let stopped = false;
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route(`**${groupApi}`, async (route) => {
          const method = route.request().method();
          if (method !== "GET") {
            groupWrites.push(method);
            return route.fulfill({ status: 500 });
          }
          await route.fulfill({
            json: {
              bots: [salesBot],
              people: [
                {
                  userId: user.id,
                  email: user.email,
                  name: user.name,
                  creator: true,
                },
              ],
              backgroundRuns: [],
              stoppableTurnIds: stopped ? [] : [turnId],
              messages: [
                {
                  id: turnId,
                  channelId,
                  ownerUserId: user.id,
                  agentId: null,
                  text: "Check tomorrow's agenda",
                  status: stopped ? "failed" : "completed",
                  createdAt: new Date().toISOString(),
                  ...(stopped ? { stopReason: "stopped" } : {}),
                },
              ],
            },
          });
        });
        await page.route(
          `**${groupApi}/turns/${turnId}/stop`,
          async (route) => {
            stopRequests.push(route.request().method());
            stopped = stopRequests.length > 1;
            await route.fulfill({
              status: stopped ? 200 : 503,
              json: stopped ? { stopped: true } : { error: "Temporary outage" },
            });
          },
        );

        await page.goto(`${FIXTURE_APP_URL}/group/${channelId}`);
        const stop = page.getByRole("button", { name: "Stop this turn" });
        await stop.waitFor();
        let focused = false;
        for (let step = 0; step < 60 && !focused; step++) {
          await page.keyboard.press("Tab");
          focused = await stop.evaluate(
            (button) => button === document.activeElement,
          );
        }
        assert(focused, "Tab did not reach Stop this turn");
        await page.keyboard.press("Enter");
        await page
          .getByText("Couldn't stop this turn. Try again.", { exact: true })
          .waitFor();
        await stop.press("Enter");
        await page.getByText("The run was stopped.", { exact: true }).waitFor();
        assert.equal(await stop.count(), 0);
        assert.deepEqual(stopRequests, ["POST", "POST"]);
        assert.deepEqual(groupWrites, []);
        assert.deepEqual(errors, []);
        const layout = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth - innerWidth,
          theme: document.documentElement.classList.contains("dark")
            ? "dark"
            : "light",
        }));
        assert.deepEqual(layout, { overflow: 0, theme });
        const screenshot = `${width}-${theme}.png`;
        await page.screenshot({ path: join(EVIDENCE_DIR, screenshot) });
        cases.push({
          width,
          height,
          ...layout,
          stopRequests,
          groupWrites,
          screenshot,
        });
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
await writeFile(
  join(EVIDENCE_DIR, "run.json"),
  JSON.stringify({ ...build, cases }, null, 2),
);
