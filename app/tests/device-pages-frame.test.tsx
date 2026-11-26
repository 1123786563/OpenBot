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
 * Recorder and OpenBot Desktop), then read in a real Chromium: the contrast of every visible word
 * against its backdrop (WCAG AA for text), the empty field's placeholder included; and the block
 * size of every button, at a desktop's width and at a phone's, in light and in dark. The
 * keyboard-only pass walks Connect then Disconnect, Stop then confirm, Review replacement then
 * Cancel, and Restart then Cancel with Tab and Enter alone, and every focused step shows a focus
 * ring.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/device-pages-frame.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves each page at 1440 and 320, light and dark, as
 * device-<page>-<theme>-<width>.png, and each keyboard step's focused element as
 * keyboard-<flow>-<step>-<theme>-<width>.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";

const entries = [
  { page: "browser", edition: "personal" },
  { page: "browsers", edition: "personal" },
  { page: "this-computer", edition: "personal" },
  { page: "computers-personal", edition: "personal" },
  { page: "computers-team", edition: "team" },
  { page: "credentials", edition: "team" },
  { page: "credentials", edition: "personal" },
  { page: "new-credential", edition: "team" },
  { page: "new-credential", edition: "personal" },
  { page: "passwords", edition: "personal" },
] as const;

type Theme = "light" | "dark";

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

/** The page at `page`/`edition`, theme and width, styled for what it wears so far. */
async function open(
  name: string,
  edition: string,
  theme: Theme,
  width: number,
): Promise<Page> {
  if (!browser) throw new Error("no browser");
  const page = await browser.newPage({
    viewport: { width, height: 900 },
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
        body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/device.js"></script></body></html>`,
      });
    if (path === "/device.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/?page=${name}&edition=${edition}`);
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

/** Write a keyboard step's focus ring where OPENBOT_APP_SHOTS asks for it. */
async function shotFocus(
  page: Page,
  flow: string,
  step: string,
  theme: Theme,
  width: number,
) {
  if (!shots) return;
  const handle = await page.locator(":focus").elementHandle();
  await handle?.screenshot({
    path: join(shots, `keyboard-${flow}-${step}-${theme}-${width}.png`),
  });
}

/** The page, clipped to its content, saved where OPENBOT_APP_SHOTS asks. */
async function shotPage(page: Page, name: string, theme: Theme, width: number) {
  if (!shots) return;
  await page.screenshot({
    path: join(shots, `device-${name}-${theme}-${width}.png`),
    fullPage: true,
  });
}
describe.skipIf(!asked)(
  "the device and credential pages, on this build",
  () => {
    browserTest(
      "every word reads against its backdrop and every button is big enough to press, in light and in dark",
      900_000,
      async () => {
        const failed: string[] = [];
        for (const entry of entries) {
          for (const theme of ["light", "dark"] as const) {
            for (const width of [1440, 320]) {
              const page = await open(entry.page, entry.edition, theme, width);
              try {
                const of = await read(page, {
                  scope: "[data-astryx-theme]",
                  placeholders: true,
                });
                const unreadable = of.words.filter(
                  (word) => word.contrast < 4.5,
                );
                if (unreadable.length > 0)
                  failed.push(
                    `${entry.page} (${entry.edition}) ${theme} ${width}: ${JSON.stringify(unreadable.slice(0, 8))}`,
                  );
                for (const target of await sizes(page)) {
                  if (target.size < 44)
                    failed.push(
                      `${entry.page} (${entry.edition}) ${theme} ${width}: "${target.name}" is ${target.size}px`,
                    );
                }
                await shotPage(page, entry.page, theme, width);
              } finally {
                await page.close();
              }
            }
          }
        }
        expect(failed).toEqual([]);
      },
    );

    /** One flow, walked with Tab and Enter alone, in one theme and width. */
    async function walk(
      flow: "recorder" | "computer" | "credential" | "this-computer",
      theme: Theme,
      width: number,
    ) {
      const page =
        flow === "recorder"
          ? await open("browsers", "personal", theme, width)
          : flow === "computer"
            ? await open("computers-personal", "personal", theme, width)
            : flow === "credential"
              ? await open("new-credential", "team", theme, width)
              : await open("this-computer", "personal", theme, width);
      const shot = (step: string) => shotFocus(page, flow, step, theme, width);
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
          const stop = "Stop browser: Personal Assistant";
          // A phone has no room for the row's buttons: its actions live behind the row's one menu button,
          // which is where Stop is reached there, and where the focus goes back after the dialog.
          const menu = "Device actions for Personal Assistant";
          const inMenu = width < 640;
          const back = inMenu ? menu : stop;
          /** Open the Stop dialog: from the row's button, or from its menu on a phone. */
          const askStop = async () => {
            await tabTo(page, back);
            await page.keyboard.press("Enter");
            if (inMenu) {
              await page
                .getByRole("menuitem", { name: "Stop browser" })
                .waitFor();
              // The menu highlights its first item when it opens from the row, but a reopen leaves
              // the trigger focused, so step in where it did not.
              if ((await focused(page)).name !== "Stop browser") {
                await page.keyboard.press("ArrowDown");
                await focusSettles(page, "Stop browser");
              }
              await page.keyboard.press("Enter");
            }
            await page.getByRole("alertdialog").waitFor({ timeout: 5_000 });
            await dress(page);
          };
          await askStop();
          expect((await focused(page)).name).toBe("Cancel");
          await shot("stop-asked");
          await page.keyboard.press("Enter");
          await page.getByRole("alertdialog").waitFor({ state: "hidden" });
          await dress(page);
          // Cancel gives the Stop that opened it its focus back.
          await focusSettles(page, back);
          await shot("stop-cancelled");
          await askStop();
          await page.keyboard.press("Tab");
          expect((await focused(page)).name).toBe("Stop browser");
          await shot("stop-confirm");
          await page.keyboard.press("Enter");
          await page
            .getByText("Browser stopped for Personal Assistant.")
            .waitFor({ timeout: 10_000 });
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
        `the ${flow} flow is taken with the keyboard alone, in light and in dark`,
        300_000,
        async () => {
          for (const theme of ["light", "dark"] as const)
            for (const width of [1440, 390]) await walk(flow, theme, width);
        },
      );
    }
  },
);
