import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright-core";

const { BUILD_MANIFEST, EVIDENCE_DIR, FIXTURE_APP_URL, FIXTURE_API_URL } =
  process.env;
assert(BUILD_MANIFEST && EVIDENCE_DIR && FIXTURE_APP_URL && FIXTURE_API_URL);
for (const url of [FIXTURE_APP_URL, FIXTURE_API_URL]) {
  assert.equal(new URL(url).hostname, "127.0.0.1");
}
const build = JSON.parse(await readFile(BUILD_MANIFEST, "utf8"));
const index = await fetch(FIXTURE_APP_URL);
assert(index.ok);
assert.equal(
  createHash("sha256")
    .update(await index.text())
    .digest("hex"),
  build.indexSha256,
);
const setup = await fetch(new URL("/__fixture/governance", FIXTURE_API_URL), {
  method: "PUT",
  body: JSON.stringify({
    firstBatch: true,
    edition: "personal",
    role: "admin",
  }),
});
assert.equal(setup.headers.get("x-openbot-fixture"), "isolated");
assert(setup.ok);
const session = await fetch(
  new URL("/__fixture/session?signedIn=true", FIXTURE_API_URL),
  {
    redirect: "manual",
  },
);
assert.equal(session.status, 302);
await mkdir(EVIDENCE_DIR, { recursive: true });

const records = [];
const title = "Review meeting notes";
for (const engine of [chromium, webkit]) {
  for (const width of [390, 1440]) {
    for (const theme of ["light", "dark"]) {
      await checkHandoff(engine, width, theme);
    }
  }
}

async function checkHandoff(engine, width, theme) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      locale: "en-US",
      colorScheme: theme,
      viewport: { width, height: width === 390 ? 844 : 900 },
    });
    page.setDefaultTimeout(8000);
    await page.addInitScript(
      (value) => localStorage.setItem("openbot-theme", value),
      theme,
    );
    let writes = 0;
    let open = true;
    await page.route(
      (url) => url.pathname === "/api/proactive/suggestions",
      (route) =>
        route.fulfill({
          json: {
            suggestions: open
              ? [
                  {
                    id: "notes",
                    agentId: "whatif-sales",
                    title,
                    detail: "Calendar has new notes.",
                    createdAt: new Date().toISOString(),
                  },
                ]
              : [],
          },
        }),
    );
    const task = {
      id: "work-notes",
      agentId: "whatif-sales",
      channelId: "acceptance-plan",
      threadId: null,
      title,
      origin: "check_in",
      status: "working",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resolvedAt: null,
    };
    const responseGate = Promise.withResolvers();
    await page.route(
      (url) => url.pathname === "/api/tasks",
      (route) => route.fulfill({ json: { tasks: open ? [] : [task] } }),
    );
    await page.route(
      "**/api/proactive/suggestions/notes/start",
      async (route) => {
        writes++;
        await responseGate.promise;
        open = false;
        return route.fulfill({
          json: {
            suggestion: { id: "notes", status: "started" },
            task: { id: task.id, channelId: task.channelId },
          },
        });
      },
    );
    await page.goto(new URL("/ideas?agent=whatif-sales", FIXTURE_APP_URL).href);
    const start = page.getByRole("button", { name: "Work on it", exact: true });
    await start.press("Enter");
    const pending = page.getByRole("button", {
      name: "Starting…",
      exact: true,
    });
    await pending.waitFor();
    assert(await pending.isDisabled());
    try {
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
    } finally {
      responseGate.resolve();
    }
    await pending.waitFor({ state: "hidden" });
    await start.waitFor({ state: "hidden" });
    assert.equal(writes, 1);
    await page
      .getByRole("status")
      .filter({ hasText: "Started a task for Review meeting notes." })
      .waitFor();
    const handoff = page.getByRole("link", { name: "Open task", exact: true });
    await handoff.waitFor();
    await page.waitForFunction(
      () => document.activeElement?.textContent?.trim() === "Open task",
    );
    assert.equal(
      await handoff.getAttribute("href"),
      "/channel/acceptance-plan",
    );
    await page.screenshot({
      path: join(
        EVIDENCE_DIR,
        `${engine.name()}-${width}-${theme}-handoff.png`,
      ),
    });
    await page.keyboard.press("Enter");
    await page.waitForURL("**/channel/acceptance-plan");
    await page.goto(new URL("/tasks", FIXTURE_APP_URL).href);
    const heading = page.getByRole("heading", { name: "Working", exact: true });
    await heading.waitFor();
    await page.getByText(title, { exact: true }).waitFor();
    const source = page.getByRole("link", { name: "Open", exact: true });
    assert.equal(await source.getAttribute("href"), "/channel/acceptance-plan");
    await source.press("Enter");
    await page.waitForURL("**/channel/acceptance-plan");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
      0,
    );
    records.push({
      browser: engine.name(),
      width,
      theme,
      pendingBlockedRepeat: true,
      taskVisible: true,
      openedSourceThread: true,
      focusedHandoff: true,
      writes,
    });
  } catch (error) {
    console.log(
      await browser.contexts()[0]?.pages()[0]?.locator("body").innerText(),
    );
    throw error;
  } finally {
    await browser.close();
  }
}
await writeFile(
  join(EVIDENCE_DIR, "run.json"),
  JSON.stringify({ build, records }, null, 2),
);
