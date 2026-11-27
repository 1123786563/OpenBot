import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const { EVIDENCE_DIR, BUILD_MANIFEST, FIXTURE_APP_URL, FIXTURE_API_URL } =
  process.env;
assert(EVIDENCE_DIR && BUILD_MANIFEST && FIXTURE_APP_URL && FIXTURE_API_URL);
for (const origin of [FIXTURE_APP_URL, FIXTURE_API_URL]) {
  assert.equal(new URL(origin).hostname, "127.0.0.1");
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
const screenshots = join(EVIDENCE_DIR, "screenshots");
await mkdir(screenshots, { recursive: true });
const control = `${FIXTURE_API_URL}/__fixture/governance`;
const member = "member@example.test";
const views = [
  "/",
  "/channel/new",
  "/start/fixture-start",
  "/channel/acceptance-plan",
  "/group/acceptance-plan",
  "/bot",
  "/capabilities/skills",
  "/capabilities/memory",
  "/bots/whatif-sales/memory",
  "/admin/people",
  "/admin/identity-providers",
  "/admin/credentials",
  "/admin/credentials/new",
  "/settings/credentials",
  "/settings/credentials/new",
  "/settings/passwords",
  "/admin/skills",
  "/settings/skills",
  "/admin/skills/fixture-skill",
  "/settings/skills/fixture-skill",
  "/admin/permissions",
  "/admin/audit",
  "/admin/components/chat",
];

async function configure(method, body) {
  const response = await fetch(control, { method, body: JSON.stringify(body) });
  assert.equal(response.headers.get("x-openbot-fixture"), "isolated");
  assert(response.ok);
}

async function tabTo(page, target) {
  for (let step = 0; step < 120; step++) {
    if (await target.evaluate((element) => element === document.activeElement))
      return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Could not reach ${target}`);
}

async function keyboard(page, width, record) {
  const dialog = page.getByRole("alertdialog");
  const rowMenu = page.getByRole("button", { name: `Actions for ${member}` });
  const capture = (name) =>
    page.screenshot({
      path: join(screenshots, `${record.id}-${name}.png`),
    });
  async function open(label) {
    const narrow = width < 768;
    const button = narrow
      ? rowMenu
      : page.getByRole("button", { name: `${label} for ${member}` });
    await tabTo(page, button);
    await page.keyboard.press("Enter");
    if (narrow) {
      const item = page.getByRole("menuitem", { name: label });
      await item.waitFor();
      await page.waitForFunction(() =>
        Boolean(document.activeElement?.closest('[role="menu"]')),
      );
      for (let step = 0; step < 6; step++) {
        if (
          await item.evaluate((element) => element === document.activeElement)
        )
          break;
        await page.keyboard.press("ArrowDown");
      }
      assert(
        await item.evaluate((element) => element === document.activeElement),
        `Keyboard did not reach ${label} in the People menu`,
      );
      await page.keyboard.press("Enter");
    }
    await dialog.waitFor();
    const tree = await dialog.ariaSnapshot();
    record.steps.push({ label, tree });
    assert(tree.includes(`${label} for ${member}`));
    return button;
  }
  async function writes() {
    const response = await fetch(control);
    return (await response.json()).requests.filter(
      ({ method, path }) =>
        method === "POST" &&
        (path.startsWith("/api/admin/people/") ||
          path.startsWith("/api/admin/enterprise/people/")),
    );
  }
  async function press(label) {
    await tabTo(page, dialog.getByRole("button", { name: label, exact: true }));
    await page.keyboard.press("Enter");
  }
  const stop = await open("Stop computers");
  assert.match(await dialog.innerText(), /Disks are kept/);
  await capture("stop-preview");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(
    (label) => document.activeElement?.getAttribute("aria-label") === label,
    await stop.getAttribute("aria-label"),
  );
  assert.equal((await writes()).length, 0);
  record.steps.push({
    cancelled: true,
    focused: await stop.getAttribute("aria-label"),
    writes: 0,
  });

  await open("Grant admin");
  await press("Grant admin");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.getByText(`Admin role granted to ${member}.`).waitFor();
  await capture("grant-success");
  assert.equal(
    (await writes()).filter(({ path }) => path.endsWith("/role")).length,
    1,
  );
  record.steps.push({ granted: true, writes: await writes() });

  await open("Remove access");
  await press("Remove access");
  await dialog
    .getByText("Access was removed. Credential retirement failed.")
    .waitFor();
  await capture("access-partial");
  record.steps.push({ partial: await dialog.ariaSnapshot() });
  await configure("PATCH", { accessConflict: true });
  await press("Try again");
  await dialog.getByRole("button", { name: "Close", exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button").count(), 1);
  assert.match(await dialog.innerText(), /current state no longer matches/);
  await capture("access-conflict");
  const submitted = await writes();
  assert.equal(
    submitted.filter(({ path }) => path.endsWith("/access")).length,
    2,
  );
  record.steps.push({
    conflict: await dialog.ariaSnapshot(),
    writes: submitted,
  });
  await press("Close");
  await dialog.waitFor({ state: "hidden" });
}

const records = [];
const browser = await chromium.launch();
try {
  for (const width of [1440, 390]) {
    for (const theme of ["light", "dark"]) {
      for (const identity of ["team-admin", "personal", "team-member"]) {
        if (identity === "team-member" && (width !== 390 || theme !== "dark"))
          continue;
        await configure("PUT", {
          firstBatch: true,
          edition: identity === "personal" ? "personal" : "team",
          role: identity === "team-member" ? "user" : "admin",
          people: identity === "team-member" ? "denied" : undefined,
        });
        await fetch(`${FIXTURE_API_URL}/__fixture/session?signedIn=true`, {
          redirect: "manual",
        });
        const context = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 900 },
          colorScheme: theme,
          serviceWorkers: "block",
        });
        await context.route("**/*", (route) => {
          const origin = new URL(route.request().url()).origin;
          return origin === FIXTURE_APP_URL ? route.continue() : route.abort();
        });
        await context.addInitScript((value) => {
          localStorage.setItem("openbot-theme", value);
        }, theme);
        const page = await context.newPage();
        page.setDefaultTimeout(3500);
        let current;
        page.on("pageerror", (error) => current?.errors.push(error.message));
        page.on("response", (response) => {
          const url = new URL(response.url());
          if (url.pathname.startsWith("/api/") && response.status() >= 400) {
            current?.apiFailures.push([
              response.request().method(),
              url.pathname,
              response.status(),
            ]);
          }
        });
        const routes =
          identity === "team-member"
            ? ["/admin/people"]
            : views.filter(
                (path) =>
                  !(identity === "personal" && path.startsWith("/admin/")) &&
                  !(identity === "team-admin" && path.startsWith("/settings/")),
              );
        for (const path of routes) {
          const id = [
            identity,
            width,
            theme,
            path.slice(1).replaceAll("/", "-") || "home",
          ].join("-");
          current = {
            id,
            identity,
            width,
            theme,
            path,
            errors: [],
            apiFailures: [],
            steps: [],
          };
          records.push(current);
          try {
            await page.goto(FIXTURE_APP_URL + path, {
              waitUntil: "networkidle",
            });
            current.finalPath = new URL(page.url()).pathname;
            if (identity === "team-member")
              assert.equal(current.finalPath, "/");
            current.layout = await page.evaluate(() => ({
              title: document.title,
              width: document.documentElement.scrollWidth,
              theme: document.documentElement.className,
            }));
            await writeFile(
              join(EVIDENCE_DIR, `${id}.aria.yml`),
              await page.locator("body").ariaSnapshot(),
            );
            await page.screenshot({ path: join(screenshots, `${id}.png`) });
            if (path === "/admin/people" && identity === "team-admin")
              await keyboard(page, width, current);
          } catch (error) {
            current.errors.push(error.stack ?? error.message);
          }
        }
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  await writeFile(
    join(EVIDENCE_DIR, "run.json"),
    JSON.stringify({ build, records }, null, 2),
  );
}
if (records.some(({ errors }) => errors.length)) process.exitCode = 1;
