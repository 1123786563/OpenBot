import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { read } from "./browser-read";

/**
 * The device and credential pages read and take a keyboard, on this build.
 *
 * Every entry is mounted whole (the real route components; the fixture stands in for the server, the
 * Recorder and OpenBot Desktop), in both editions, then read in a real Chromium: the contrast of
 * every visible word against its backdrop (WCAG AA for text), the empty field's placeholder
 * included; and the block size of every button, at a desktop's width and at a phone's, in light and
 * in dark. That reading is taken in each state the map names: loaded, a first read that failed and
 * was recovered with Retry, a 403, and a confirmation dialog left open.
 *
 * The keyboard-only pass walks Connect then Disconnect, Stop then confirm, Review replacement then
 * Cancel, and Restart then Cancel with Tab and Enter alone, in both editions, and walks the
 * unconfirmed-outcome dialog after a lost write: every focused step shows a focus ring.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/device-pages-frame.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves each state as
 * device-<page>-<edition>-<state>-<theme>-<width>.png, and each keyboard step's focused element as
 * keyboard-<flow>-<edition>-<step>-<theme>-<width>.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";

type Edition = "personal" | "team";
type Theme = "light" | "dark";
type State = "ok" | "error" | "denied" | "changed";

/** The copy of the Recorder in the browser this page is open in. */
const LONG =
  "a notebook for the quarterly revenue reconciliation across every regional team";

/** Something the page shows only once its read succeeds, so recovery is not an empty page. */
type Ready =
  | { by: "text"; value: string }
  | { by: "heading"; value: string }
  | { by: "label"; value: string }
  | { by: "placeholder"; value: string };

type Entry = {
  page: string;
  edition: Edition;
  /** The Retry that recovers a first read that failed with 503. */
  retry: string;
  /** Shown only once the read succeeds (absent where the form is always there). */
  ready?: Ready;
  /** This page reads over OpenBot Desktop's IPC, so a server 403 has no state here. */
  ipc?: boolean;
  /** The confirmation this page opens; the dialog-open reading drives it. */
  dialog?: "disconnect" | "restart" | "stop" | "revoke" | "replace" | "delete";
};

const entries: Entry[] = [
  {
    page: "browser",
    edition: "personal",
    retry: "Retry browser status",
    ready: { by: "text", value: "Do it once, and your Bots learn it" },
  },
  {
    page: "browser",
    edition: "team",
    retry: "Retry browser status",
    ready: { by: "text", value: "Do it once, and your Bots learn it" },
  },
  {
    page: "browsers",
    edition: "personal",
    retry: "Retry connected browsers",
    ready: { by: "text", value: "Chrome on Mac" },
    dialog: "disconnect",
  },
  {
    page: "browsers",
    edition: "team",
    retry: "Retry connected browsers",
    ready: { by: "text", value: "Chrome on Mac" },
    dialog: "disconnect",
  },
  {
    page: "this-computer",
    edition: "personal",
    retry: "Retry",
    ready: { by: "heading", value: "App" },
    ipc: true,
    dialog: "restart",
  },
  {
    page: "this-computer",
    edition: "team",
    retry: "Retry",
    ready: { by: "heading", value: "App" },
    ipc: true,
    dialog: "restart",
  },
  {
    page: "computers-personal",
    edition: "personal",
    retry: "Retry loading devices",
    ready: { by: "label", value: "Search devices" },
    dialog: "stop",
  },
  {
    page: "computers-team",
    edition: "team",
    retry: "Retry loading devices",
    ready: { by: "label", value: "Search devices" },
    dialog: "stop",
  },
  {
    page: "credentials",
    edition: "personal",
    retry: "Retry",
    ready: { by: "placeholder", value: "Provider, type or key ID" },
    dialog: "revoke",
  },
  {
    page: "credentials",
    edition: "team",
    retry: "Retry",
    ready: { by: "placeholder", value: "Provider, type or key ID" },
    dialog: "revoke",
  },
  {
    page: "new-credential",
    edition: "personal",
    retry: "Retry",
    dialog: "replace",
  },
  {
    page: "new-credential",
    edition: "team",
    retry: "Retry",
    dialog: "replace",
  },
  {
    page: "passwords",
    edition: "personal",
    retry: "Retry",
    ready: { by: "placeholder", value: "Website or username" },
    dialog: "delete",
  },
  {
    page: "passwords",
    edition: "team",
    retry: "Retry",
    ready: { by: "placeholder", value: "Website or username" },
    dialog: "delete",
  },
];

/** The locator for what a page shows once its read succeeds. */
function readyLocator(page: Page, ready: Ready) {
  if (ready.by === "text") return page.getByText(ready.value);
  if (ready.by === "heading")
    return page.getByRole("heading", { name: ready.value });
  if (ready.by === "label") return page.getByLabel(ready.value);
  return page.getByPlaceholder(ready.value);
}

type View = { theme: Theme; width: number; height: number };

/** The map's B1 reading: a desktop in light, a phone in dark, and the narrowest phone. */
const views: View[] = [
  { theme: "light", width: 1440, height: 900 },
  { theme: "dark", width: 1440, height: 900 },
  { theme: "dark", width: 390, height: 844 },
  { theme: "dark", width: 320, height: 844 },
];

/** The map's named viewports for the error, 403 and dialog-open readings. */
const evidenceViews = views.filter(
  (view) => view.width !== 1440 || view.theme === "light",
);

/** The keyboard pass reads a desktop in light and a phone in both themes. */
const walkViews: View[] = [
  { theme: "light", width: 1440, height: 900 },
  { theme: "dark", width: 1440, height: 900 },
  { theme: "light", width: 390, height: 844 },
  { theme: "dark", width: 390, height: 844 },
];

/** The first row with a running browser, per edition, and what its Stop is called. */
const stopTarget = (edition: Edition) =>
  edition === "personal"
    ? {
        title: "Personal Assistant",
        stop: "Stop browser: Personal Assistant",
        receipt: "Browser stopped for Personal Assistant.",
        audit: { label: "Open Activity", href: "/settings/activity" },
      }
    : {
        title: "person-1@acme-distribution.example.com's computer",
        stop: "Stop browser: person-1@acme-distribution.example.com's computer",
        receipt:
          "Browser stopped for person-1@acme-distribution.example.com's computer.",
        audit: { label: "Open Audit", href: "/admin/audit" },
      };

let script: string;
const classes: Set<string> = new Set();
let css: string | undefined;
/** The Chromium processes still open, closed at the end of the file. */
const browsers = new Set<Browser>();
let browser: Browser | undefined;

beforeAll(async () => {
  if (!asked) return;
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "device-pages-frame.fixture.tsx")],
    target: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "pilot-theme",
        setup(build) {
          // The theme scope as the app sets it, without the brand colours it read from Vite's env.
          // Sibling modules import it as ./theme, aliases as @/components/astryx-pilot/theme.
          build.onResolve(
            { filter: /(astryx-pilot\/theme$|^\.\.?\/theme$)/ },
            () => ({ path: "theme", namespace: "pilot-theme" }),
          );
          build.onLoad({ filter: /.*/, namespace: "pilot-theme" }, () => ({
            // AstryxSurface renders its children inside the scope; here the fixture's own div is the
            // scope, so the stand-in passes them straight through.
            contents:
              'export const astryxScope = { "data-astryx-theme": "neutral" };\nexport function AstryxSurface(props) { return props.children; }',
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const entry = built.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new Error("bundle has no script");
  script = await entry.text();
  const { chromium } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell, so it launches that by channel.
  // A machine where the packaged Chrome for Testing is killed by the OS runs the bundled shell
  // (OPENBOT_APP_BROWSER_SHELL=1): the same Chromium, laid out the same way.
  browser = await chromium.launch(
    process.env.OPENBOT_APP_BROWSER_SHELL === "1"
      ? {}
      : { channel: "chromium" },
  );
  browsers.add(browser);
}, 300_000);

afterAll(async () => {
  await Promise.all([...browsers].map((each) => each.close()));
});

/** The directory of an installed package, from the app or the repository root. */
function packageDir(name: string): string {
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package ${name}`);
  return dir;
}

/** Where `@import "<package>[/<file>]"` lands, by the package's `style` export as Vite reads it. */
function packageStylesheet(id: string): string {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const dir = packageDir(name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const subpath = `.${id.slice(name.length)}`;
  const entry = pkg.exports?.[subpath];
  const file =
    typeof entry === "string"
      ? entry
      : (entry?.style ?? entry?.default ?? pkg.main ?? "index.css");
  return join(dir, file);
}

/** The app's stylesheet, built by Tailwind for these classes, as the app's build does. */
async function stylesheet(names: string[]): Promise<string> {
  const tailwind = dirname(Bun.resolveSync("tailwindcss/package.json", APP));
  const entry = join(APP, "src", "styles.css");
  const compiler = await compile(readFileSync(entry, "utf8"), {
    base: dirname(entry),
    loadStylesheet: async (id, base) => {
      const path =
        id === "tailwindcss"
          ? join(tailwind, "index.css")
          : id.startsWith(".")
            ? join(base, id)
            : packageStylesheet(id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  return compiler.build(names);
}

/** The work's result, or its failure, while the attempt is still within Bun's deadline. */
async function within<T>(deadline: number, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (performance.now() < deadline) throw error;
    console.error("After the test's deadline:", error);
    return new Promise<T>(() => {});
  }
}

/** A test in Chromium: each attempt has its own deadline, as Bun retries an attempt concurrently. */
function browserTest(
  name: string,
  timeout: number,
  body: (deadline: number) => Promise<void>,
) {
  test(
    name,
    () => {
      const deadline = performance.now() + timeout;
      return within(deadline, () => body(deadline));
    },
    timeout,
  );
}

/** The page's animations run to their end, so what is read is what stays. */
async function settle(page: Page) {
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      try {
        if (animation.effect?.getComputedTiming().endTime === Infinity)
          animation.cancel();
        else animation.finish();
      } catch {
        // One that cannot run to an end is not what anybody is waiting for.
      }
    }
  });
}

/** Compile the stylesheet for any classes the page has grown, and (re)apply it. */
async function dress(page: Page) {
  const grown = await page.evaluate(
    () =>
      (
        globalThis as unknown as { __drainClasses?: () => string[] }
      ).__drainClasses?.() ?? [],
  );
  const before = classes.size;
  for (const name of grown) classes.add(name);
  if (!css || classes.size !== before) css = await stylesheet([...classes]);
  await page.addStyleTag({ content: css as string });
}

/** The entry at a theme and width, in `state`, styled for what it wears so far. */
async function open(
  entry: { page: string; edition: Edition },
  view: View,
  state: State = "ok",
): Promise<Page> {
  if (!browser) throw new Error("no browser");
  const page = await browser.newPage({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (error) => console.error(error));
  page.on("console", (message) => console.log("console:", message.text()));
  page.on("crash", () => console.log("page crashed"));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en" class="${view.theme}" style="color-scheme: ${view.theme}"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/device.js"></script></body></html>`,
      });
    if (path === "/device.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    return route.fulfill({ status: 404 });
  });
  await page.goto(
    `${ORIGIN}/?page=${entry.page}&edition=${entry.edition}&state=${state}`,
  );
  await page.locator("h1").first().waitFor({ timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  // Astryx's own sheets, read from their packages rather than bundled: Bun's CSS bundler rewrites
  // light-dark(). Then the app's, as main.tsx loads them.
  for (const sheet of [
    "@astryxdesign/core/reset.css",
    "@astryxdesign/core/astryx.css",
    "@astryxdesign/theme-neutral/theme.css",
  ])
    await page.addStyleTag({
      content: readFileSync(packageStylesheet(sheet), "utf8"),
    });
  await dress(page);
  await settle(page);
  return page;
}

/** The accessible name of what is focused, and whether it shows a focus ring. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) return { name: "", ring: false };
    const labelled = (element as HTMLInputElement).labels?.[0]?.textContent;
    const ringOf = (node: HTMLElement) => {
      const style = getComputedStyle(node);
      return style.outlineStyle !== "none" || style.boxShadow !== "none";
    };
    // A field's ring is drawn on its wrapper, which fades it in over its own transition.
    const control = element.closest<HTMLElement>(".astryx-text-input");
    return {
      name:
        element.getAttribute("aria-label") ??
        labelled ??
        element.textContent?.trim() ??
        "",
      ring: ringOf(element) || (control ? ringOf(control) : false),
    };
  });

/** A wait the page settles within: a field's ring or a dialog's returned focus arrives after its transition. */
async function settling(check: () => Promise<boolean>, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Focus the page's top, then Tab to the control named `target`. */
async function tabTo(page: Page, target: string) {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    const heading = document.querySelector("h1");
    if (heading instanceof HTMLElement) heading.focus();
  });
  const seen: string[] = [];
  for (let step = 0; step < 60; step++) {
    await page.keyboard.press("Tab");
    const now = await focused(page);
    if (now.name === target) {
      await settling(async () => (await focused(page)).ring);
      expect((await focused(page)).ring, `"${target}" shows a focus ring`).toBe(
        true,
      );
      return;
    }
    seen.push(now.name);
  }
  throw new Error(
    `"${target}" is not reachable by Tab; saw ${JSON.stringify(seen)}`,
  );
}

/** The element a closing dialog hands focus to, once its exit transition has finished. */
async function focusSettles(page: Page, name: string) {
  await settling(async () => (await focused(page)).name === name);
  expect((await focused(page)).name).toBe(name);
}

/** The block size of every visible button, and of links that act as one, inside the theme scope. */
const sizes = (page: Page) =>
  page.evaluate(() => {
    const targets: { name: string; size: number }[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(
      "[data-astryx-theme] button, [data-astryx-theme] a[href]",
    )) {
      if (!element.checkVisibility()) continue;
      // A link inside a sentence is prose, not an action.
      if (element.tagName === "A" && element.closest("p")) continue;
      // A dialog's dismissal X is not a device action, and its Cancel beside it is the same
      // function at 44px, so the 44px rule judges the actions, not the shortcut (WCAG 2.5.5).
      if (element.closest('[data-slot="dialog-close"]')) continue;
      targets.push({
        name:
          element.getAttribute("aria-label") ??
          element.textContent?.trim() ??
          "",
        size: Math.round(element.getBoundingClientRect().height),
      });
    }
    return targets;
  });

/**
 * Everything a person must read or press on the page as it stands, dialog included: every word is
 * at least 4.5:1 against its backdrop, and every button is at least 44px.
 */
async function measure(
  page: Page,
  label: string,
  failed: string[] = [],
): Promise<string[]> {
  const of = await read(page, {
    scope: "[data-astryx-theme]",
    placeholders: true,
  });
  for (const word of of.words)
    if (word.contrast < 4.5)
      failed.push(
        `${label}: "${word.text}" reads ${word.contrast.toFixed(2)}:1`,
      );
  for (const target of await sizes(page))
    if (target.size < 44)
      failed.push(`${label}: "${target.name}" is ${target.size}px`);
  return failed;
}

/** Write a keyboard step's focus ring where OPENBOT_APP_SHOTS asks for it. */
async function shotFocus(
  page: Page,
  flow: string,
  edition: Edition,
  step: string,
  view: View,
) {
  if (!shots) return;
  const handle = await page.locator(":focus").elementHandle();
  await handle?.screenshot({
    path: join(
      shots,
      `keyboard-${flow}-${edition}-${step}-${view.theme}-${view.width}.png`,
    ),
  });
}

/** The page, clipped to its content, saved where OPENBOT_APP_SHOTS asks. */
async function shotPage(
  page: Page,
  name: string,
  view: View,
  state: string = "ok",
) {
  if (!shots) return;
  await page.screenshot({
    path: join(
      shots,
      `device-${name}-${state}-${view.theme}-${view.width}.png`,
    ),
    fullPage: true,
  });
}

/** The Stop that opens a computer's confirmation: the row's button, or the menu a phone shows. */
async function askStop(page: Page, edition: Edition, width: number) {
  const { title, stop } = stopTarget(edition);
  const menu = `Device actions for ${title}`;
  await tabTo(page, width < 640 ? menu : stop);
  await page.keyboard.press("Enter");
  if (width < 640) {
    await page.getByRole("menuitem", { name: "Stop browser" }).waitFor();
    // The menu's first item is Update when the computer has one, and the keys step through the
    // items; a reopen starts on the first item, a first open on the row's trigger.
    for (let step = 0; step < 4; step++) {
      if ((await focused(page)).name === "Stop browser") break;
      await page.keyboard.press("ArrowDown");
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await focusSettles(page, "Stop browser");
    await page.keyboard.press("Enter");
  }
  await page.getByRole("alertdialog").waitFor({ timeout: 5_000 });
  await dress(page);
}

/**
 * Drive the entry into the confirmation it opens, the way a person would, and leave it open.
 * The computer pages' confirmation is the unconfirmed-outcome one: the write is lost and the
 * dialog reports the latest status.
 */
async function showDialog(page: Page, entry: Entry, width: number) {
  if (entry.dialog === "disconnect") {
    await page
      .getByRole("button", { name: `Disconnect Chrome on Mac · ${LONG}` })
      .click();
    return page.getByRole("dialog");
  }
  if (entry.dialog === "restart") {
    await page
      .getByRole("button", { name: "Restart OpenBot services" })
      .click();
    return page.getByRole("alertdialog");
  }
  if (entry.dialog === "stop") {
    const { title, stop } = stopTarget(entry.edition);
    if (width < 640) {
      await page
        .getByRole("button", { name: `Device actions for ${title}` })
        .click();
      await page.getByRole("menuitem", { name: "Stop browser" }).click();
    } else {
      await page.getByRole("button", { name: stop }).click();
    }
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.getByRole("button", { name: "Stop browser" }).click();
    await dialog.getByText(/Latest device status:/).waitFor({
      timeout: 10_000,
    });
    return dialog;
  }
  if (entry.dialog === "revoke") {
    await page
      .getByRole("button", { name: "Revoke sk-live-1 for openai" })
      .click();
    return page.getByRole("alertdialog");
  }
  if (entry.dialog === "replace") {
    await tabTo(page, "Provider");
    await page.keyboard.type("openai");
    await tabTo(page, "Key ID");
    await page.keyboard.type("sk-live-1");
    await tabTo(page, "Secret");
    await page.keyboard.type("not-the-live-secret");
    await tabTo(page, "Review replacement");
    await page.keyboard.press("Enter");
    return page.getByRole("alertdialog");
  }
  await page
    .getByRole("button", {
      name: "Delete saved login for marguerite.oyelaran-abernathy@acme-distribution.example.com at accounts.revenue-operations.example.com",
    })
    .click();
  return page.getByRole("alertdialog");
}

describe.skipIf(!asked)(
  "the device and credential pages, on this build",
  () => {
    browserTest(
      "every word reads against its backdrop and every button is big enough to press, in both editions, light and dark",
      900_000,
      async () => {
        const failed: string[] = [];
        for (const entry of entries) {
          for (const view of views) {
            const page = await open(entry, view);
            try {
              await measure(
                page,
                `${entry.page} (${entry.edition}) ${view.theme} ${view.width}`,
                failed,
              );
              await shotPage(page, `${entry.page}-${entry.edition}`, view);
            } finally {
              await page.close();
            }
          }
        }
        expect(failed).toEqual([]);
      },
    );

    browserTest(
      "a first read that fails is measured in its error state, then Retry recovers it",
      900_000,
      async () => {
        const failed: string[] = [];
        for (const entry of entries) {
          for (const view of evidenceViews) {
            const label = `${entry.page} (${entry.edition}) ${view.theme} ${view.width} error`;
            const page = await open(entry, view, "error");
            try {
              await page.locator('[role="alert"]').first().waitFor({
                timeout: 10_000,
              });
              await measure(page, label, failed);
              await shotPage(
                page,
                `${entry.page}-${entry.edition}`,
                view,
                "error",
              );
              // The service comes back; the person presses the page's own Retry.
              await page.evaluate(() =>
                (
                  globalThis as unknown as { __recover?: () => void }
                ).__recover?.(),
              );
              const retry = page.getByRole("button", {
                name: entry.retry,
                exact: true,
              });
              await retry.first().click();
              if (entry.ready)
                await readyLocator(page, entry.ready)
                  .first()
                  .waitFor({ timeout: 15_000 });
              await retry
                .first()
                .waitFor({ state: "detached", timeout: 15_000 });
            } catch (error) {
              failed.push(`${label}: retry — ${(error as Error).message}`);
            } finally {
              await page.close();
            }
          }
        }
        expect(failed).toEqual([]);
      },
    );

    browserTest(
      "a 403 is measured in its denial state, on every page the server authorizes",
      600_000,
      async () => {
        const failed: string[] = [];
        for (const entry of entries.filter((each) => !each.ipc)) {
          for (const view of evidenceViews) {
            const label = `${entry.page} (${entry.edition}) ${view.theme} ${view.width} denied`;
            const page = await open(entry, view, "denied");
            try {
              await page.locator('[role="alert"]').first().waitFor({
                timeout: 10_000,
              });
              await measure(page, label, failed);
              await shotPage(
                page,
                `${entry.page}-${entry.edition}`,
                view,
                "denied",
              );
            } catch (error) {
              failed.push(`${label}: ${(error as Error).message}`);
            } finally {
              await page.close();
            }
          }
        }
        expect(failed).toEqual([]);
      },
    );

    browserTest(
      "an open confirmation reads and its actions are big enough to press",
      900_000,
      async () => {
        const failed: string[] = [];
        for (const entry of entries.filter((each) => each.dialog)) {
          for (const view of evidenceViews) {
            const label = `${entry.page} (${entry.edition}) ${view.theme} ${view.width} dialog`;
            const page = await open(
              entry,
              view,
              entry.dialog === "stop" ? "changed" : "ok",
            );
            try {
              const dialog = await showDialog(page, entry, view.width);
              await dress(page);
              await settle(page);
              expect(await dialog.count()).toBeGreaterThan(0);
              await measure(page, label, failed);
              await shotPage(
                page,
                `${entry.page}-${entry.edition}`,
                view,
                "dialog",
              );
            } catch (error) {
              failed.push(`${label}: ${(error as Error).message}`);
            } finally {
              await page.close();
            }
          }
        }
        expect(failed).toEqual([]);
      },
    );

    /** One flow, walked with Tab and Enter alone, in one edition, theme and width. */
    async function walk(
      flow: "recorder" | "computer" | "credential" | "this-computer",
      edition: Edition,
      view: View,
    ) {
      const page = await open(
        {
          page:
            flow === "recorder"
              ? "browsers"
              : flow === "computer"
                ? edition === "personal"
                  ? "computers-personal"
                  : "computers-team"
                : flow === "credential"
                  ? "new-credential"
                  : "this-computer",
          edition,
        },
        view,
      );
      const shot = (step: string) => shotFocus(page, flow, edition, step, view);
      try {
        if (flow === "recorder") {
          await tabTo(page, "Connect this browser");
          await page.keyboard.press("Enter");
          // Connected: the fixture's Recorder connects with no Connect page, the list re-reads, and
          // the row is named for the copy in this browser.
          await page
            .getByText("Connected", { exact: true })
            .first()
            .waitFor({ timeout: 10_000 });
          await dress(page);
          await shot("connected");
          const row = "Disconnect Chrome in this browser · This browser";
          await tabTo(page, row);
          await page.keyboard.press("Enter");
          await page.getByRole("dialog").waitFor({ timeout: 5_000 });
          await dress(page);
          expect((await focused(page)).name).toBe("Cancel");
          await shot("disconnect-asked");
          await page.keyboard.press("Enter");
          await page.getByRole("dialog").waitFor({ state: "hidden" });
          await dress(page);
          // Cancel gives the row's own Disconnect back its focus.
          await focusSettles(page, row);
          await shot("disconnect-cancelled");
          await page.keyboard.press("Enter");
          await page.getByRole("dialog").waitFor({ timeout: 5_000 });
          await dress(page);
          // The confirm waits for the list's own check; it is reachable once that settles.
          await page.waitForFunction(
            () =>
              [
                ...document.querySelectorAll<HTMLButtonElement>(
                  '[role="dialog"] button',
                ),
              ].some(
                (button) =>
                  button.textContent?.trim() === "Disconnect" &&
                  !button.disabled,
              ),
            undefined,
            { timeout: 10_000 },
          );
          await page.keyboard.press("Tab");
          expect((await focused(page)).name).toBe("Disconnect");
          await shot("disconnect-confirm");
          await page.keyboard.press("Enter");
          await page
            .getByText("Disconnected Chrome in this browser.")
            .waitFor({ timeout: 10_000 });
          await dress(page);
          // The row is gone, so the receipt is what takes the focus.
          await focusSettles(page, "Disconnected Chrome in this browser.");
          await shot("disconnected");
        } else if (flow === "computer") {
          const { stop, receipt } = stopTarget(edition);
          const menu = `Device actions for ${stopTarget(edition).title}`;
          const back = view.width < 640 ? menu : stop;
          await askStop(page, edition, view.width);
          expect((await focused(page)).name).toBe("Cancel");
          await shot("stop-asked");
          await page.keyboard.press("Enter");
          await page.getByRole("alertdialog").waitFor({ state: "hidden" });
          await dress(page);
          // Cancel gives the Stop that opened it its focus back.
          await focusSettles(page, back);
          await shot("stop-cancelled");
          await askStop(page, edition, view.width);
          await page.keyboard.press("Tab");
          expect((await focused(page)).name).toBe("Stop browser");
          await shot("stop-confirm");
          await page.keyboard.press("Enter");
          await page.getByText(receipt).waitFor({ timeout: 10_000 });
          await dress(page);
          // The row is still there, so its action takes the focus back after the receipt is said.
          await focusSettles(page, back);
          await shot("stopped");
        } else if (flow === "credential") {
          await tabTo(page, "Provider");
          await page.keyboard.type("openai");
          await tabTo(page, "Key ID");
          await page.keyboard.type("sk-live-1");
          await tabTo(page, "Secret");
          await page.keyboard.type("not-the-live-secret");
          // The live credential matches this kind, provider and ID, so the submit reviews a replacement.
          await tabTo(page, "Review replacement");
          await shot("ready");
          await page.keyboard.press("Enter");
          await page.getByRole("alertdialog").waitFor({ timeout: 5_000 });
          await dress(page);
          expect((await focused(page)).name).toBe("Cancel");
          await shot("replace-asked");
          await page.keyboard.press("Enter");
          await page.getByRole("alertdialog").waitFor({ state: "hidden" });
          await dress(page);
          // Cancel gives the Review replacement that opened it its focus back.
          await focusSettles(page, "Review replacement");
          await shot("replace-cancelled");
        } else {
          await tabTo(page, "Restart OpenBot services");
          await page.keyboard.press("Enter");
          await page.getByRole("alertdialog").waitFor({ timeout: 5_000 });
          await dress(page);
          expect((await focused(page)).name).toBe("Cancel");
          await shot("restart-asked");
          await page.keyboard.press("Enter");
          await page.getByRole("alertdialog").waitFor({ state: "hidden" });
          await dress(page);
          // Cancel gives the Restart services that opened it its focus back.
          await focusSettles(page, "Restart OpenBot services");
          await shot("restart-cancelled");
        }
      } finally {
        await page.close();
      }
    }

    for (const flow of [
      "recorder",
      "computer",
      "credential",
      "this-computer",
    ] as const) {
      browserTest(
        `the ${flow} flow is taken with the keyboard alone, in both editions, light and dark`,
        600_000,
        async () => {
          for (const edition of ["personal", "team"] as const)
            for (const view of walkViews) await walk(flow, edition, view);
        },
      );
    }

    browserTest(
      "the unconfirmed-outcome dialog is walked with the keyboard, in both editions",
      600_000,
      async () => {
        for (const edition of ["personal", "team"] as const) {
          const { audit } = stopTarget(edition);
          for (const view of evidenceViews) {
            const page = await open(
              {
                page:
                  edition === "personal"
                    ? "computers-personal"
                    : "computers-team",
                edition,
              },
              view,
              "changed",
            );
            const shot = (step: string) =>
              shotFocus(page, "unconfirmed", edition, step, view);
            try {
              await askStop(page, edition, view.width);
              expect((await focused(page)).name).toBe("Cancel");
              await shot("asked");
              await page.keyboard.press("Tab");
              expect((await focused(page)).name).toBe("Stop browser");
              await page.keyboard.press("Enter");
              // The write is lost; the dialog reports the latest status and the audit trail.
              await page
                .getByText(/Latest device status: No browser running/)
                .waitFor({ timeout: 10_000 });
              await dress(page);
              // The dialog comes back as an unavailable one, its Close focused.
              await focusSettles(page, "Close");
              await shot("unconfirmed");
              const link = page.getByRole("link", { name: audit.label });
              expect(await link.getAttribute("href")).toBe(audit.href);
              await shotPage(
                page,
                `unconfirmed-${edition}`,
                view,
                "unconfirmed",
              );
              await page.keyboard.press("Enter");
              await page.getByRole("alertdialog").waitFor({ state: "hidden" });
              await dress(page);
              // The dialog returns focus to what opened it: the row's now-disabled Stop falls back to the
              // page heading, while the row's menu trigger on a phone is still the opener.
              await focusSettles(
                page,
                view.width < 640
                  ? `Device actions for ${stopTarget(edition).title}`
                  : edition === "personal"
                    ? "Your Bots' browsers"
                    : "Computers in this deployment",
              );
            } finally {
              await page.close();
            }
          }
        }
      },
    );
  },
);
