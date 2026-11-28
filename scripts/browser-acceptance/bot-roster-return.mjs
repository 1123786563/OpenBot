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
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const [width, theme] of [
      [390, "light"],
      [390, "dark"],
      [1440, "light"],
      [1440, "dark"],
    ]) {
      const page = await browser.newPage({
        locale: "en-US",
        colorScheme: theme,
        viewport: { width, height: width === 390 ? 844 : 900 },
      });
      await page.addInitScript(
        (theme) => localStorage.setItem("openbot-theme", theme),
        theme,
      );
      for (const via of ["history", "page"]) {
        await page.goto(new URL("/bots?q=Sal", FIXTURE_APP_URL).href);
        const row = page
          .getByRole("region", { name: "Bot directory" })
          .getByRole("link", { name: "Sales", exact: true })
          .first();
        await row.press("Enter", { timeout: 7000 });
        await page.waitForURL("**/bots/whatif-sales");
        await page
          .getByRole("heading", { name: "Sales", exact: true })
          .waitFor();
        if (via === "history") await page.goBack();
        else
          await page
            .getByRole("link", { name: "Bots", exact: true })
            .filter({ has: page.locator("svg.tabler-icon-chevron-left") })
            .press("Enter", { timeout: 7000 });
        await page.waitForURL((url) => url.pathname === "/bots");
        await row.waitFor();
        const q = new URL(page.url()).searchParams.get("q");
        const focus = await row.evaluate((el) => document.activeElement === el);
        records.push({ browser: engine.name(), width, theme, via, q, focus });
      }
      await page.goto(new URL("/bots/whatif-sales", FIXTURE_APP_URL).href);
      const direct = page
        .getByRole("link", { name: "Bots", exact: true })
        .filter({ has: page.locator("svg.tabler-icon-chevron-left") });
      assert.equal(await direct.getAttribute("href"), "/bots");
      await direct.press("Enter");
      await page.waitForURL("**/bots");
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
await writeFile(
  join(EVIDENCE_DIR, "run.json"),
  JSON.stringify({ build, records }, null, 2),
);
assert(records.every((r) => r.q === "Sal" && r.focus));
