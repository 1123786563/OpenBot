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

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const mode = process.env.SWEEP_MODE ?? "full";
assert(["full", "bookmarks", "shells", "playground"].includes(mode));
const views = (await readJson("docs/acceptance/web127-views.json")).flatMap(
  (view, i) => {
    if (mode === "bookmarks") return [];
    if (mode === "playground" && view.route !== "/admin/playground") return [];
    if (
      mode === "shells" &&
      ![
        "/",
        "/admin/people",
        "/settings/",
        "/onboarding",
        "/admin/playground",
        "shared recovery",
      ].includes(view.route)
    )
      return [];
    return [{ ...view, id: `view-${i + 1}` }];
  },
);
const bookmarks =
  mode === "shells" || mode === "playground"
    ? []
    : await readJson("docs/acceptance/web127-bookmarks.json");
const build = await readJson(BUILD_MANIFEST);
const response = await fetch(FIXTURE_APP_URL);
assert(response.ok);
const index = await response.text();
assert.equal(
  createHash("sha256").update(index).digest("hex"),
  build.indexSha256,
);
const assets = join(EVIDENCE_DIR, "captures");
await mkdir(assets, { recursive: true });
const records = [];
const save = () =>
  writeFile(
    join(EVIDENCE_DIR, "run.json"),
    JSON.stringify(
      { commit: build.commit, indexSha256: build.indexSha256, records },
      null,
      2,
    ),
  );

async function configure(role) {
  const response = await fetch(`${FIXTURE_API_URL}/__fixture/governance`, {
    method: "PUT",
    body: JSON.stringify({
      firstBatch: true,
      edition: role === "personal" ? "personal" : "team",
      role: role === "teamMember" ? "user" : "admin",
    }),
  });
  assert.equal(response.headers.get("x-openbot-fixture"), "isolated");
  assert(response.ok);
  const session = await fetch(
    `${FIXTURE_API_URL}/__fixture/session?signedIn=${role !== "signedOut"}`,
    { redirect: "manual" },
  );
  assert.equal(session.status, 302);
}

// Sample text against its nearest solid opaque background. Exclude layered
// surfaces so these ratios are evidence for the sampled elements only.
function sampleContrast() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  function rgba(color) {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  }
  function luminance([r, g, b]) {
    const channels = [r, g, b].map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }
  return [
    ...document.querySelectorAll('[role="alert"], [role="alert"] *, a[href]'),
  ].flatMap((element) => {
    const label = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join(" ")
      .trim();
    if (
      !label ||
      !element.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
      })
    )
      return [];
    const text = rgba(getComputedStyle(element).color);
    if (text[3] !== 255) return [];
    for (let parent = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.opacity !== "1" || style.backgroundImage !== "none") return [];
      const background = rgba(style.backgroundColor);
      if (background[3] === 0) continue;
      if (background[3] !== 255) return [];
      const first = luminance(text);
      const second = luminance(background);
      return [
        {
          label,
          kind: element.closest('[role="alert"]') ? "alert" : "link",
          ratio:
            (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
        },
      ];
    }
    return [];
  });
}

async function checkShell(page) {
  const opener = page.getByRole("button", { name: "Open navigation" });
  await opener.waitFor({ timeout: 2500 });
  for (let step = 0; step < 20; step++) {
    if (await opener.evaluate((element) => element === document.activeElement))
      break;
    await page.keyboard.press("Tab");
  }
  assert(
    await opener.evaluate((element) => element === document.activeElement),
  );
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 2500 });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: 2500 });
  return opener.evaluate((element) => element === document.activeElement);
}

async function capture(browser, cases, role, width, theme) {
  const height = width === 390 ? 844 : 900;
  // Playwright's Service Worker blocker reads navigator.serviceWorker in every
  // frame, which throws in the Playground's opaque sandbox.
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
  });
  try {
    await context.addInitScript((value) => {
      if (window.top !== window) return;
      localStorage.setItem("openbot-theme", value);
      window.fixtureHistory = [location.pathname + location.search];
      for (const method of ["pushState", "replaceState"]) {
        const original = history[method];
        history[method] = function (...args) {
          original.apply(this, args);
          window.fixtureHistory.push(location.pathname + location.search);
        };
      }
    }, theme);
    await context.route("**/*", (route) => {
      const { origin } = new URL(route.request().url());
      return origin === FIXTURE_APP_URL ? route.continue() : route.abort();
    });
    for (const entry of cases) {
      const id = `${entry.id}-${role}-${width}-${theme}`;
      const record = {
        ...entry,
        id,
        role,
        width,
        height,
        theme,
        errors: [],
        console: [],
        apiFailures: [],
      };
      records.push(record);
      const page = await context.newPage();
      page.on("pageerror", (error) => record.errors.push(error.message));
      page.on("console", (message) => {
        if (["warning", "error"].includes(message.type()))
          record.console.push([message.type(), message.text()]);
      });
      page.on("response", (response) => {
        const { pathname } = new URL(response.url());
        if (pathname.startsWith("/api/") && response.status() >= 400)
          record.apiFailures.push([pathname, response.status()]);
      });
      try {
        if (entry.path === "/onboarding") {
          await page.route("**/api/me", async (route) => {
            const response = await route.fetch();
            const body = await response.json();
            await route.fulfill({
              response,
              json: {
                ...body,
                user: {
                  ...body.user,
                  onboarding: { step: 0, completedAt: null },
                },
              },
            });
          });
        }
        const routeLoadFailure = entry.view === "Route load failure";
        let routeBlocked = routeLoadFailure;
        if (routeLoadFailure) {
          // The Settings route is lazy-loaded in this production build.
          await page.route("**/assets/route-settings-*.js", (route) =>
            routeBlocked ? route.abort() : route.continue(),
          );
        }
        await page.goto(new URL(entry.path, FIXTURE_APP_URL).href, {
          waitUntil: "domcontentloaded",
          timeout: 7000,
        });
        await page
          .locator("#root > *")
          .first()
          .waitFor({ state: "attached", timeout: 5000 });
        if (entry.heading) {
          await page
            .getByRole("heading", {
              name: entry.heading,
              level: 1,
              exact: true,
            })
            .waitFor({ timeout: 5000 });
        }
        if (entry.description) {
          await page
            .getByText(entry.description, { exact: true })
            .first()
            .waitFor({ timeout: 5000 });
        }
        if (entry.expected) {
          await page.waitForURL(
            (url) => url.pathname + url.search + url.hash === entry.expected,
            { timeout: 1500, waitUntil: "commit" },
          );
        }
        if (entry.path === "/admin/playground") {
          const preview = page.locator("iframe[sandbox]");
          await preview
            .contentFrame()
            .getByRole("heading", { name: "A worked example" })
            .waitFor({ timeout: 5000 });
          const permissions = (await preview.getAttribute("sandbox")).split(
            /\s+/,
          );
          assert(permissions.includes("allow-scripts"));
          assert(!permissions.includes("allow-same-origin"));
        }
        // This is an initial snapshot. Delayed requests can still be pending.
        await page
          .locator("body")
          .ariaSnapshot({ timeout: 3500 })
          .then((tree) => writeFile(join(assets, `${id}.yml`), tree));
        await page.keyboard.press("Tab");
        record.layout = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          focus:
            document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.textContent?.trim().slice(0, 100),
          theme: document.documentElement.classList.contains("dark")
            ? "dark"
            : "light",
        }));
        await page.screenshot({
          path: join(assets, `${id}.png`),
          timeout: 4000,
          animations: "disabled",
        });
        record.capture = `captures/${id}.png`;
        if (mode === "full" || mode === "shells") {
          record.contrast = await page.evaluate(sampleContrast);
        }
        if (mode === "shells") {
          if (
            width === 390 &&
            ["/", "/admin/people", "/settings/"].includes(entry.path)
          ) {
            try {
              record.drawerFocusReturned = await checkShell(page);
            } catch (error) {
              record.drawerFailure = String(error);
            }
          }
        }
        if (routeLoadFailure) {
          const retry = page.getByRole("button", { name: "Try again" });
          await retry.click();
          await page
            .getByText(
              "The page still couldn’t load. You can try again or open your workspace.",
              { exact: true },
            )
            .first()
            .waitFor({ timeout: 5000 });
          routeBlocked = false;
          await retry.click();
          await page
            .getByRole("heading", {
              name: "Notifications",
              level: 1,
              exact: true,
            })
            .waitFor({ timeout: 8000 });
          await page.waitForFunction(
            () =>
              document.activeElement?.matches("h1") &&
              document.activeElement.textContent?.trim() === "Notifications",
            {},
            { timeout: 3000 },
          );
          record.routeRetryRecovered = true;
        }
        assert.equal(context.serviceWorkers().length, 0);
      } catch (error) {
        record.failure = String(error);
      } finally {
        const { pathname, search, hash } = new URL(page.url());
        record.actual = pathname + search + hash;
        if (entry.expected) {
          record.destinationMatches = record.actual === entry.expected;
          if (entry.transient) {
            record.history = await page
              .evaluate(() => window.fixtureHistory)
              .catch(() => []);
            record.destinationMatches &&= record.history.includes(
              entry.transient,
            );
          }
        }
        await page.close();
      }
    }
  } finally {
    await context.close();
  }
}

for (const role of ["teamMember", "signedOut", "personal", "teamAdmin"]) {
  await configure(role);
  const viewCases = views.filter((view) => view.role === role);
  const bookmarkCases = bookmarks.flatMap(
    ({ source, destinations, consumedQueryFinalPath }, i) =>
      destinations[role]
        ? [
            {
              path: source,
              expected: consumedQueryFinalPath ?? destinations[role],
              ...(consumedQueryFinalPath
                ? { transient: destinations[role] }
                : {}),
              id: `bookmark-${i + 1}`,
            },
          ]
        : [],
  );
  const configurations = [
    [1440, "light"],
    [390, "dark"],
    [1440, "dark"],
    [390, "light"],
  ];
  for (const [width, theme] of configurations) {
    const cases =
      width === 1440 && theme === "light"
        ? [...bookmarkCases, ...viewCases]
        : viewCases;
    for (let start = 0; start < cases.length; start += 10) {
      const batch = cases.slice(start, start + 10);
      const browser = await chromium.launch();
      try {
        await capture(browser, batch, role, width, theme);
      } catch (error) {
        console.error(role, width, theme, start, String(error));
      } finally {
        await browser.close();
        await save();
      }
    }
  }
}

assert.equal(records.length, 4 * views.length + 3 * bookmarks.length);
assert(
  records.every(
    (record) =>
      record.capture && !record.failure && record.destinationMatches !== false,
  ),
);
assert.deepEqual(
  records
    .filter((record) => record.path === "/admin/playground")
    .flatMap((record) => record.errors),
  [],
);
if (mode === "full") {
  const renderFailures = records.flatMap(({ id, console }) =>
    console.flatMap(([level, message]) => {
      if (level !== "error" || !/^\w*Error:/.test(message)) return [];
      // The recovery view deliberately aborts a route chunk.
      if (
        views.some(
          ({ id: viewId, view }) =>
            view === "Route load failure" && id.startsWith(`${viewId}-`),
        ) &&
        message.startsWith(
          "TypeError: Failed to fetch dynamically imported module:",
        )
      )
        return [];
      return [`${id}: ${message.split("\n", 1)[0]}`];
    }),
  );
  assert.deepEqual(renderFailures, [], "Unexpected rendered page exceptions");
  const unimplemented = new Set(
    records.flatMap((record) =>
      record.apiFailures
        .filter(([, status]) => status === 501)
        .map(([path]) => path),
    ),
  );
  assert.equal(
    unimplemented.size,
    0,
    `Unimplemented fixture endpoints: ${[...unimplemented].sort().join(", ")}`,
  );
}
