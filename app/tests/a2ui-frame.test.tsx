import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BACKGROUNDS,
  BORDER_COLORS,
  RADII,
} from "@copilotkit/shared/generative-ui";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * An interface a Bot draws inside a Card shows one frame in the conversation, not two.
 *
 * CopilotKit draws its own frame, a border and 12px of padding, around every interface in a chat.
 * The catalog's Card draws a border too, and a Bot puts most interfaces in one, so the trip budget
 * the starter task asks for showed a box inside a box with a gap between them. When the interface's
 * top component is a Card that draws a box, the frame gives up its border and padding and the Card
 * is the one frame, the way the app's other cards sit in a conversation. An interface without one
 * (a bare Column, or a Card drawn as a borderless section) keeps the frame, its only box.
 *
 * Rendered in a real Chromium, because whether two boxes are drawn is the cascade of CopilotKit's
 * stylesheet, the app's and the catalog's inline styles. The transcript is the real component, the
 * interfaces arrive as the runtime's activities and CopilotKit's renderer draws them; the
 * stylesheets are CopilotKit's and the app's own, in the order main.tsx imports them.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/a2ui-frame.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves each page, light and dark, at a chat's width and at a
 * phone's: the trip budget as budget-light.png, the controls at 320px as controls-light-320.png,
 * and the controls with the list and the calendar open as controls-light-320-list.png and so on.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";

const buildInput = {
  entrypoints: [join(import.meta.dir, "a2ui-frame.fixture.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  // The catalog's Map loads it on demand; OpenBot omits Map and does not ship it.
  external: ["maplibre-gl"],
  plugins: [
    {
      name: "omit-copilotkit-ui-styles",
      setup(build) {
        build.onLoad(
          { filter: /\/@copilotkit\/react-core\/dist\/v2\/index\.css$/ },
          () => ({ contents: "", loader: "css" }),
        );
      },
    },
    {
      name: "no-marks",
      setup(build) {
        // The marks module is not under test here.
        build.onResolve({ filter: /^@\/lib\/marks$/ }, () => ({
          path: "marks",
          namespace: "no-marks",
        }));
        build.onLoad({ filter: /.*/, namespace: "no-marks" }, () => ({
          contents: "export const markFor = () => null;",
          loader: "js",
        }));
        // The theme scope as the app sets it, without the brand colours it reads from Vite's env.
        build.onResolve(
          { filter: /^@\/components\/astryx-pilot\/theme$/ },
          () => ({
            path: "theme",
            namespace: "pilot-theme",
          }),
        );
        build.onLoad({ filter: /.*/, namespace: "pilot-theme" }, () => ({
          contents:
            'export const astryxScope = { "data-astryx-theme": "neutral", "data-astryx-pilot": "" };',
          loader: "js",
        }));
      },
    },
  ],
} satisfies Parameters<typeof Bun.build>[0];

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
async function stylesheet(classes: string[]): Promise<string> {
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
  return compiler.build(classes);
}

let script: string;
/** The stylesheet Bun.build makes of the CSS the fixture's components import. */
let styles: string;
/** The Chromium processes still open, closed at the end of the file. */
const browsers = new Set<Browser>();

beforeAll(async () => {
  if (!asked) return;
  const built = await Bun.build(buildInput);
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const entry = built.outputs.find((output) => output.kind === "entry-point");
  const sheet = built.outputs.find((output) => output.path.endsWith(".css"));
  if (!entry || !sheet) throw new Error("bundle has no script or stylesheet");
  script = await entry.text();
  styles = await sheet.text();
  expect(styles).not.toContain(".copilotKitChat");
});

/** Chromium for one page, closed with the page. Each attempt has its own: Bun runs a retry while the attempt it retries is still running. */
async function chromiumBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  const browser = await chromium.launch({ channel: "chromium" });
  browsers.add(browser);
  browser.on("disconnected", () => browsers.delete(browser));
  return browser;
}

afterAll(async () => {
  await Promise.all([...browsers].map((browser) => browser.close()));
});

/**
 * A page with the conversation. `deadline` is when Bun gives up on the attempt; see browserTest.
 */
async function open(
  query: string,
  deadline: number,
  theme: "light" | "dark" = "light",
  width = 680,
): Promise<Page> {
  return within(deadline, () => openPage(query, theme, width));
}

/**
 * The work's result, or its failure, while the attempt is still within Bun's deadline.
 *
 * After the deadline the attempt has already failed and Bun has moved on: it runs the retry while
 * this attempt is still running, and closes this attempt's Chromium. A failure from then on
 * belonged to an attempt that is over, but Bun reported it as the retry's, and the retry failed
 * too. So after the deadline nothing more is reported, and this never settles.
 */
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

/**
 * Runs the page's animations to their end. A turn fades in when it first draws, and what is read is
 * what stays.
 */
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

/** The conversation at a chat's width, styled once its interfaces have drawn. */
async function openPage(
  query = "",
  theme: "light" | "dark" = "light",
  width = 680,
): Promise<Page> {
  const browser = await chromiumBrowser();
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    deviceScaleFactor: 2,
  });
  page.on("close", () => void browser.close());
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/frame.js"></script></body></html>`,
      });
    if (path === "/frame.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    // Inter, which the app's stylesheet asks for at ./files/.
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    return route.fulfill({ status: 404 });
  });
  // The root's colour scheme as index.html sets it before paint: Astryx's palette resolves its
  // light and dark values from it, the app's tokens from the `dark` class.
  await page.goto(`${ORIGIN}/${query}`);
  // The first interface's surface, drawn: a page of Astryx controls alone has no catalog markup.
  await page
    .locator("[data-generative-ui-chat-surface] .a2ui-surface")
    .first()
    .waitFor({ timeout: 8000 });
  const classes = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll("[class]")].flatMap((element) => [
        ...element.classList,
      ]),
    ),
  ]);
  // Astryx's, CopilotKit's, then the app's, as main.tsx imports them. Astryx's are read from their
  // packages rather than bundled: Bun's CSS bundler rewrites light-dark(), and orders the layers.
  for (const sheet of [
    "@astryxdesign/core/reset.css",
    "@astryxdesign/core/astryx.css",
    "@astryxdesign/theme-neutral/theme.css",
  ])
    await page.addStyleTag({
      content: readFileSync(packageStylesheet(sheet), "utf8"),
    });
  await page.addStyleTag({ content: styles });
  await page.addStyleTag({ content: await stylesheet(classes) });
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
  return page;
}

/**
 * For each interface: which of the boxes around the whole of it draw a border (CopilotKit's frame,
 * and the interface's own top component), how far the interface sits inside the frame, and the
 * frame's padding.
 */
function frames(page: Page) {
  return page.$$eval("[data-generative-ui-chat-surface]", (all) =>
    all.map((frame) => {
      const surface = frame.querySelector(":scope > .a2ui-surface");
      let top = [...(surface?.children ?? [])].find(
        (child) => child.tagName !== "STYLE",
      );
      // A component with an accessible name the catalog does not apply itself is wrapped in a
      // `display: contents` span.
      if (top?.matches("[data-a2ui-accessibility]"))
        top = top.firstElementChild ?? undefined;
      if (!top) throw new Error("an interface drew nothing");
      const boxed = (element: Element) => {
        const style = getComputedStyle(element);
        return (["Top", "Right", "Bottom", "Left"] as const).every(
          (side) =>
            Number.parseFloat(style[`border${side}Width`]) > 0 &&
            style[`border${side}Style`] !== "none",
        );
      };
      const outer = frame.getBoundingClientRect();
      const inner = top.getBoundingClientRect();
      return {
        surface: frame.getAttribute("data-generative-ui-chat-surface"),
        bordered: [
          ...(boxed(frame) ? ["frame"] : []),
          ...(boxed(top) ? ["interface"] : []),
        ],
        inset: Math.round(inner.left - outer.left),
        padding: getComputedStyle(frame).paddingTop,
      };
    }),
  );
}

describe.skipIf(!asked)("the frame around an interface a Bot draws", () => {
  browserTest(
    "a Card on top is the one frame; without one, the frame stays",
    60_000,
    async (deadline) => {
      const page = await open("", deadline);
      try {
        expect(await frames(page)).toEqual([
          // The trip budget: the Card's border alone, edge to edge with where the frame was.
          {
            surface: "budget",
            bordered: ["interface"],
            inset: 0,
            padding: "0px",
          },
          {
            surface: "labelled",
            bordered: ["interface"],
            inset: 0,
            padding: "0px",
          },
          // Nothing else draws a box, so the frame keeps its border and padding.
          { surface: "plain", bordered: ["frame"], inset: 13, padding: "12px" },
          {
            surface: "section",
            bordered: ["frame"],
            inset: 13,
            padding: "12px",
          },
        ]);
        // The budget is the whole interface, drawn: the total adds the three amounts.
        await page.getByText("Total $430").waitFor({ timeout: 4000 });
      } finally {
        await page.close();
      }
    },
  );

  /**
   * How the controls read in a page: the ink of a field and of its label against the Astryx palette
   * (`--color-*` resolved at the theme scope), the contrast of every visible word inside an interface
   * against what is behind it, and the ink of each error node the SDK drew itself. A word inside a
   * disabled control, and anything hidden, is left out.
   */
  async function read(page: Page) {
    return page.evaluate(() => {
      const scope = document.querySelector("[data-astryx-theme]");
      if (!scope) throw new Error("the page has no Astryx theme scope");
      const probe = document.createElement("span");
      scope.append(probe);
      const palette = new Set<string>();
      for (const name of getComputedStyle(scope)) {
        if (!name.startsWith("--color-")) continue;
        probe.style.color = `var(${name})`;
        palette.add(getComputedStyle(probe).color);
      }
      probe.remove();

      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("no canvas");
      // A canvas reads any CSS colour as sRGB, but flattens a translucent one against black, so
      // the alpha is read from the text and the colour measured opaque.
      const rgba = (colour: string): number[] => {
        // Computed colours come as rgb(), rgba(r, g, b, a) or as `<space>(... / a)`.
        const a = colour.startsWith("rgba(")
          ? Number(/,\s*([\d.]+)\)$/.exec(colour)?.[1])
          : Number(/\/\s*([\d.]+)\s*\)$/.exec(colour)?.[1] ?? 1);
        const opaque =
          a === 1
            ? colour
            : colour.startsWith("rgba(")
              ? colour.replace(/,\s*[\d.]+\)$/, ")").replace("rgba(", "rgb(")
              : colour.replace(/\/\s*[\d.]+\s*\)$/, ")");
        context.fillStyle = "#000000";
        context.fillStyle = opaque;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a];
      };
      const over = ([tr, tg, tb, ta]: number[], [br, bg, bb]: number[]) => [
        tr * ta + br * (1 - ta),
        tg * ta + bg * (1 - ta),
        tb * ta + bb * (1 - ta),
        1,
      ];
      /** What is behind an element: its own and its ancestors' fills, composited over the page. */
      const behind = (element: Element): number[] => {
        const layers: number[][] = [];
        for (let at: Element | null = element; at; at = at.parentElement) {
          const fill = rgba(getComputedStyle(at).backgroundColor);
          if (fill[3] === 0) continue;
          layers.push(fill);
          if (fill[3] === 1) break;
        }
        return layers
          .reverse()
          .reduce((page, layer) => over(layer, page), [255, 255, 255, 1]);
      };
      const luminance = ([r, g, b]: number[]) => {
        const channel = (value: number) => {
          const s = value / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const contrast = (a: number[], b: number[]) => {
        const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (high + 0.05) / (low + 0.05);
      };

      const words: { text: string; contrast: number }[] = [];
      for (const element of document.querySelectorAll<HTMLElement>(
        "[data-generative-ui-chat-surface] *",
      )) {
        if (!element.checkVisibility()) continue;
        if (element.closest('[aria-disabled="true"]')) continue;
        const text = [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent?.trim())
          .join("");
        if (!text) continue;
        const style = getComputedStyle(element);
        words.push({
          text,
          contrast: contrast(
            over(rgba(style.color), behind(element)),
            behind(element),
          ),
        });
      }
      const errorInks = [
        ...document.querySelectorAll<HTMLElement>(
          "[data-generative-ui-chat-surface] [data-generative-ui-error]",
        ),
      ]
        .filter((node) => node.checkVisibility())
        .map((node) => getComputedStyle(node).color);
      const input = document.querySelector<HTMLElement>(
        "[data-generative-ui-chat-surface] .astryx-text-input input",
      );
      const label = document.querySelector<HTMLElement>(
        "[data-generative-ui-chat-surface] .astryx-field-label",
      );
      if (!input || !label)
        throw new Error("the form has no labelled text field");
      return {
        ink: {
          field: getComputedStyle(input).color,
          label: getComputedStyle(label).color,
        },
        palette: [...palette],
        words,
        errorInks,
      };
    });
  }

  /** The card CopilotKit draws around one interface, by the id of its surface. */
  const card = (page: Page, surface: string) =>
    page.locator(`[data-generative-ui-chat-surface="${surface}"]`);
  /** The line the card draws for an update that could not be shown. */
  const line = (surface: ReturnType<typeof card>) =>
    surface.locator(':scope > [role="alert"]');

  browserTest(
    "a form with a part that cannot be drawn shows an Astryx error and sends nothing; the form beside it works",
    60_000,
    async (deadline) => {
      const page = await open("?only=forms", deadline);
      const sent = () => page.evaluate(() => window.__sent);
      try {
        const surface = page.locator("[data-generative-ui-chat-surface]");
        // Only the part that cannot be drawn is replaced, by an Astryx error state.
        const alert = surface.locator('[role="alert"]');
        // The alert itself lays out its text (display: contents), so its frame is what is visible.
        await alert.waitFor({ state: "attached", timeout: 8000 });
        await surface.locator(".astryx-banner").waitFor({ timeout: 8000 });
        expect(await alert.innerText()).toContain(
          "Couldn't show this part of the reply.",
        );
        // The alert is inside an Astryx Banner's error status surface.
        expect(
          await alert.evaluate((node) =>
            node.parentElement?.getAttribute("data-status"),
          ),
        ).toBe("error");
        // The rest of the interface, and the turn's other messages, are as they were.
        await surface.getByText("Two forms follow.").waitFor();
        await surface.getByText("This line is still readable.").waitFor();
        await page
          .getByText("Build an interactive weekend trip budget")
          .waitFor();
        expect(await surface.locator("form").count()).toBe(2);

        // The form that is missing a part still takes what is typed, but its button is disabled,
        // and neither a click nor Enter in a field sends it.
        const who = page.getByLabel("Who");
        await who.fill("Ada");
        expect(await who.inputValue()).toBe("Ada");
        const sendBroken = page.getByRole("button", { name: "Send broken" });
        expect(await sendBroken.getAttribute("aria-disabled")).toBe("true");
        await sendBroken.click({ force: true });
        await who.press("Enter");
        await page.waitForTimeout(500);
        expect(await sent()).toEqual([]);

        // The whole form sends what its fields hold, by Enter in a field.
        await page.getByLabel("What").fill("Tea");
        await page.getByLabel("What").press("Enter");
        await page.waitForFunction(() => window.__sent.length === 1);
        expect(await sent()).toEqual([
          "What\n\nwhat: Tea\nwindow: false\nclass: economy\nguests: 2\ndeck: lower",
        ]);

        // The list opens by pointer, and what is picked is sent.
        await page.getByRole("combobox", { name: "Deck" }).click();
        await page.getByRole("option", { name: "upper" }).click();

        // By keyboard: Tab reaches each control in turn, Space and the arrows work them, and Enter
        // on the button at the end of the form sends.
        await page.getByLabel("What").focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Space");
        await page.keyboard.press("Tab");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Tab");
        await page.keyboard.press("ArrowRight");
        for (let step = 0; step < 8; step++) {
          await page.keyboard.press("Tab");
          const focused = await page.evaluate(
            () => document.activeElement?.textContent?.trim() ?? "",
          );
          if (focused === "Send good") break;
          expect(step).toBeLessThan(7);
        }
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => window.__sent.length === 2);
        expect((await sent())[1]).toBe(
          "What\n\nwhat: Tea\nwindow: true\nclass: business\nguests: 3\ndeck: upper",
        );
      } finally {
        await page.close();
      }
    },
  );

  browserTest(
    "a form stored before the A2UI version upgrade draws and submits in the browser",
    60_000,
    async (deadline) => {
      const page = await open("?only=legacy", deadline);
      try {
        // The fixture stores the version CopilotKit 1.83 wrote and reads it the way the app does
        // on reopening: withCurrentA2uiVersions, as /bot and Conversation both do.
        const destination = page.getByLabel("Destination");
        await destination.waitFor({ timeout: 8000 });
        expect(await destination.inputValue()).toBe("Paris");
        expect(
          await destination.evaluate(
            (node) => node.closest(".astryx-text-input") !== null,
          ),
        ).toBe(true);

        await destination.fill("Rome");
        await destination.press("Enter");
        await page.waitForFunction(() => window.__sent.length === 1);
        expect(await page.evaluate(() => window.__sent)).toEqual([
          "Destination\n\ndestination: Rome",
        ]);
      } finally {
        await page.close();
      }
    },
  );

  browserTest(
    "a part the SDK could not draw is an Astryx error and sends nothing, in a form or beside one",
    90_000,
    async (deadline) => {
      const page = await open("?only=refused", deadline);
      const sent = () => page.evaluate(() => window.__sent);
      try {
        // In a form: the SDK's own node is hidden, an Astryx error stands in the form, and the form
        // sends nothing, by its button or by Enter in a field.
        const bound = card(page, "bound");
        await bound.locator(".astryx-banner").waitFor({ timeout: 8000 });
        expect(
          await bound.locator('.astryx-banner [role="alert"]').innerText(),
        ).toContain("Couldn't show this part of the reply.");
        expect(
          await bound.locator('[data-generative-ui-error="named"]').isVisible(),
        ).toBe(false);
        await bound.getByText("This line is still readable.").waitFor();
        await page
          .getByText("Build an interactive weekend trip budget")
          .waitFor();
        const who = page.getByLabel("Who");
        await who.fill("Ada");
        const sendBad = page.getByRole("button", { name: "Send bad" });
        expect(await sendBad.getAttribute("aria-disabled")).toBe("true");
        await sendBad.click({ force: true });
        await who.press("Enter");
        await page.waitForTimeout(500);
        expect(await sent()).toEqual([]);
        // The form beside it, in the same interface, sends.
        await page.getByLabel("What").fill("Tea");
        await page.getByLabel("What").press("Enter");
        await page.waitForFunction(() => window.__sent.length === 1);
        expect(await sent()).toEqual(["What\n\nwhat: Tea"]);

        // Outside a form the SDK's node stays, and says what happened.
        expect(
          await bound.locator('[data-generative-ui-error="stray"]').innerText(),
        ).toContain("Couldn’t display this part: invalid props");

        // An update the runtime refused: the card says so, and the form that is missing a field
        // shows the same error and sends nothing.
        const refused = card(page, "refused");
        expect(await line(refused).innerText()).toBe(
          "Part of this UI couldn't be shown.",
        );
        expect(
          await refused.locator('.astryx-banner [role="alert"]').innerText(),
        ).toContain("Couldn't show this part of the reply.");
        const sendRefused = page.getByRole("button", { name: "Send refused" });
        expect(await sendRefused.getAttribute("aria-disabled")).toBe("true");
        const name = page.getByLabel("Name");
        await name.fill("Ada");
        await name.press("Enter");
        await page.waitForTimeout(500);
        expect(await sent()).toHaveLength(1);

        // A surface that could not be built is an empty frame that says so: nothing there to send.
        const unbuilt = card(page, "unbuilt");
        expect(await line(unbuilt).innerText()).toBe(
          "Part of this UI couldn't be shown.",
        );
        expect(await unbuilt.locator("form").count()).toBe(0);

        // A surface that threw is the SDK's error node alone, still an alert.
        const thrown = card(page, "thrown");
        const node = thrown.locator('[data-generative-ui-error="surface"]');
        expect(await node.getAttribute("role")).toBe("alert");
        expect(await node.isVisible()).toBe(true);
        expect(await thrown.locator("form").count()).toBe(0);
      } finally {
        await page.close();
      }
    },
  );

  browserTest(
    "the controls read Astryx theme colours and stay legible, in light and in dark",
    180_000,
    async (deadline) => {
      // One page at a time, as each has its own Chromium.
      const readIn = async (only: string, theme: "light" | "dark") => {
        const page = await open(`?only=${only}`, deadline, theme);
        try {
          return await read(page);
        } finally {
          await page.close();
        }
      };
      for (const only of ["forms", "refused"]) {
        const light = await readIn(only, "light");
        const dark = await readIn(only, "dark");
        // The ink of a field, of its label and of an error node is a colour of the Astryx theme,
        // and it changes with it.
        for (const [mode, of] of [
          ["light", light],
          ["dark", dark],
        ] as const) {
          expect(
            of.palette.includes(of.ink.field),
            `${only} ${mode} field ink`,
          ).toBe(true);
          expect(
            of.palette.includes(of.ink.label),
            `${only} ${mode} label ink`,
          ).toBe(true);
          for (const ink of of.errorInks)
            expect(of.palette.includes(ink), `${only} ${mode} error ink`).toBe(
              true,
            );
        }
        expect(dark.ink).not.toEqual(light.ink);
        // Every visible word in an interface is readable against what is behind it (WCAG AA for
        // text).
        for (const [mode, of] of [
          ["light", light],
          ["dark", dark],
        ] as const)
          expect(
            of.words.filter((word) => word.contrast < 4.5),
            `${only} ${mode}`,
          ).toEqual([]);
      }
    },
  );

  /**
   * What the browser paints around the parts of the `tokens` interface: the form and the pressable
   * with known values, then every part of one kind, in the order the SDK's list names them.
   */
  function paintOf(page: Page) {
    return card(page, "tokens").evaluate((frame) => {
      const part = (selector: string) => {
        const element = frame.querySelector(selector);
        if (!element) throw new Error(`no part for ${selector}`);
        return element;
      };
      const computed = (element: Element) => getComputedStyle(element);
      const paint = (element: Element) => {
        const style = computed(element);
        return {
          border: [
            style.borderTopWidth,
            style.borderTopStyle,
            style.borderTopColor,
          ],
          background: style.backgroundColor,
          corner: style.borderTopLeftRadius,
        };
      };
      const outlined = [...frame.querySelectorAll('[role="button"]')].find(
        (node) => node.textContent?.trim() === "Outlined",
      );
      if (!outlined) throw new Error("no outlined pressable");
      // The theme's default border colour, resolved where the pressable is.
      const probe = document.createElement("span");
      outlined.append(probe);
      probe.style.color = "var(--a2ui-color-border-default)";
      const themeBorder = getComputedStyle(probe).color;
      probe.remove();
      return {
        tinted: paint(part('form[aria-label="Tinted"]')),
        framed: paint(part('[role="button"]')),
        outlined: { border: paint(outlined).border, themeBorder },
        backgrounds: [
          ...frame.querySelectorAll('form[aria-label^="Background "]'),
        ].map((form) => computed(form).backgroundColor),
        borders: [...frame.querySelectorAll('[role="button"]')]
          .filter((node) => node.textContent?.startsWith("Border "))
          .map((node) => computed(node).borderTopWidth),
        corners: [...frame.querySelectorAll('form[aria-label^="Radius "]')].map(
          (form) => computed(form).borderTopLeftRadius,
        ),
      };
    });
  }

  browserTest(
    "every colour and corner radius the catalog allows draws, with the SDK's values where the theme names none, in light and in dark",
    180_000,
    async (deadline) => {
      // The SDK's values for the two named parts: its light ones are the literals behind the
      // variables, and its dark ones are the variables it sets under the `dark` class.
      for (const [theme, border, background] of [
        ["light", "rgb(156, 196, 234)", "rgba(0, 128, 93, 0.08)"],
        ["dark", "rgb(47, 95, 143)", "rgba(60, 200, 150, 0.14)"],
      ] as const) {
        const page = await open("?only=tokens", deadline, theme);
        try {
          const paint = await paintOf(page);
          // A border in a colour the theme does not name is a border, one pixel wide.
          expect(paint.framed.border, theme).toEqual(["1px", "solid", border]);
          expect(paint.tinted.background, theme).toBe(background);
          // The catalog's two smallest corners, as the SDK names them in pixels.
          expect(paint.tinted.corner, theme).toBe("2px");
          expect(paint.framed.corner, theme).toBe("4px");
          // A border with no colour named is a border, in the theme's own colour.
          expect(paint.outlined.border, theme).toEqual([
            "1px",
            "solid",
            paint.outlined.themeBorder,
          ]);

          // No value in the SDK's lists is dropped: each background is painted, each border is a
          // pixel wide, and each corner is round.
          expect(paint.backgrounds, `${theme}: backgrounds`).toHaveLength(
            BACKGROUNDS.length,
          );
          for (const [index, token] of BACKGROUNDS.entries())
            expect(
              paint.backgrounds[index],
              `${theme}: background ${token}`,
            ).not.toBe("rgba(0, 0, 0, 0)");
          expect(paint.borders, `${theme}: borders`).toHaveLength(
            BORDER_COLORS.length,
          );
          for (const [index, token] of BORDER_COLORS.entries())
            expect(paint.borders[index], `${theme}: border ${token}`).toBe(
              "1px",
            );
          expect(paint.corners, `${theme}: corners`).toHaveLength(RADII.length);
          for (const [index, token] of RADII.entries())
            expect(paint.corners[index], `${theme}: radius ${token}`).not.toBe(
              "0px",
            );
        } finally {
          await page.close();
        }
      }
    },
  );

  /**
   * One form with every control the catalog has, as a chat shows them: a field with typed text, a
   * list and a calendar open, buttons in each state. In each theme, at a chat's width and at a
   * phone's: the inks are the theme's, every visible word reads against what is behind it, each Tab
   * stop shows a focus ring, a disabled button says so, the form sends what every control holds,
   * and nothing runs past the page.
   */
  browserTest(
    "every control reads, shows a focus ring and fits a phone's width, in light and in dark",
    300_000,
    async (deadline) => {
      const inks: Record<string, { field: string; label: string }> = {};
      const fills: Record<string, string[]> = {};
      // One page at a time, as each has its own Chromium.
      for (const theme of ["light", "dark"] as const)
        for (const width of [680, 320]) {
          const page = await open("?only=controls", deadline, theme, width);
          const at = `${theme}, ${width}px`;
          const readNow = async (state: string) => {
            // A list or a calendar animates open in the same way.
            await settle(page);
            const of = await read(page);
            inks[theme] = of.ink;
            expect(of.palette.includes(of.ink.field), `${at}: field ink`).toBe(
              true,
            );
            expect(of.palette.includes(of.ink.label), `${at}: label ink`).toBe(
              true,
            );
            // WCAG AA for text.
            expect(
              of.words.filter((word) => word.contrast < 4.5),
              `${at}, ${state}`,
            ).toEqual([]);
          };
          const surface = card(page, "controls");
          try {
            await readNow("closed");

            // Every button is drawn as Astryx writes it, from the theme's colours and with room
            // around its label. Tailwind's preflight is in a later cascade layer, and left them all
            // bare text with no inset: the picked chip without a fill, the destructive button not
            // red, and two chips touching.
            const painted = await surface.evaluate((root) => {
              const probe = document.createElement("span");
              /** A theme colour, resolved where the button is. */
              const colour = (at: Element, name: string) => {
                probe.style.color = `var(${name})`;
                at.append(probe);
                return getComputedStyle(probe).color;
              };
              return [...root.querySelectorAll("button[data-variant]")].map(
                (button) => {
                  const style = getComputedStyle(button);
                  const read = (name: string) => colour(button, name);
                  return {
                    label: button.textContent?.trim(),
                    variant: button.getAttribute("data-variant"),
                    fill: style.backgroundColor,
                    ink: style.color,
                    // Inset on each side, so a label never touches the edge of its button.
                    inset: [
                      style.paddingTop,
                      style.paddingRight,
                      style.paddingBottom,
                      style.paddingLeft,
                    ].map(Number.parseFloat),
                    accent: read("--color-accent"),
                    onAccent: read("--color-on-accent"),
                    neutral: read("--color-neutral"),
                    errorMuted: read("--color-error-muted"),
                    onErrorMuted: read("--color-on-error-muted"),
                    inkOfTheme: read("--color-text-primary"),
                  };
                },
              );
            });
            // All four variants are on the page, so the comparison below is not an empty one.
            expect(new Set(painted.map((button) => button.variant))).toEqual(
              new Set(["secondary", "primary", "destructive", "ghost"]),
            );
            /** A variant's fill and ink, by the names the theme gives them. The neutral theme
             * draws a destructive button as a tint, not as a red block. */
            const paintOf = (
              button: (typeof painted)[number],
            ): [string, string] => {
              switch (button.variant) {
                case "primary":
                  return [button.accent, button.onAccent];
                case "destructive":
                  return [button.errorMuted, button.onErrorMuted];
                case "ghost":
                  return ["rgba(0, 0, 0, 0)", button.inkOfTheme];
                // `secondary`, the one variant left: the set above is checked.
                default:
                  return [button.neutral, button.inkOfTheme];
              }
            };
            for (const button of painted) {
              const [fill, ink] = paintOf(button);
              expect(
                [button.fill, button.ink],
                `${at}: ${button.variant} "${button.label}"`,
              ).toEqual([fill, ink]);
              for (const side of button.inset)
                expect(
                  side,
                  `${at}: ${button.variant} "${button.label}"`,
                ).toBeGreaterThan(0);
            }
            // A field's box has room around its text, as Astryx draws it.
            const inset = (at: ReturnType<typeof card>) =>
              at.evaluate((box) => {
                const style = getComputedStyle(box);
                return [
                  style.paddingTop,
                  style.paddingRight,
                  style.paddingBottom,
                  style.paddingLeft,
                ].map(Number.parseFloat);
              });
            const field = inset(surface.locator(".astryx-text-input").first());
            for (const side of await field)
              expect(side, `${at}: the text field's inset`).toBeGreaterThan(0);

            fills[theme] = painted.map((button) => button.fill);

            // The list and the calendar are drawn inside the interface, and read the same way.
            await surface.locator('[aria-haspopup="listbox"]').click();
            await page.getByRole("option", { name: "upper" }).waitFor();
            await readNow("the list open");
            // So does each option of the open list.
            const option = await inset(
              page.getByRole("option", { name: "upper" }),
            );
            for (const side of option)
              expect(side, `${at}: an option's inset`).toBeGreaterThan(0);
            await page.keyboard.press("Escape");
            const calendars = surface.getByRole("button", {
              name: "Open calendar",
            });
            // The date field, then the date and time field. A time alone has no calendar.
            for (const calendar of await calendars.all()) {
              await calendar.click();
              await page.getByRole("dialog").waitFor();
              await readNow("the calendar open");
              // The selected day is the theme's accent, as Astryx paints it.
              const day = page
                .getByRole("dialog")
                .locator('[role="gridcell"][aria-selected="true"] button');
              const selected = await day.evaluate((button) => {
                const probe = document.createElement("span");
                button.append(probe);
                const colour = (name: string) => {
                  probe.style.color = `var(${name})`;
                  return getComputedStyle(probe).color;
                };
                const style = getComputedStyle(button);
                return {
                  paint: [style.backgroundColor, style.color],
                  theme: [
                    colour("--color-accent"),
                    colour("--color-on-accent"),
                  ],
                };
              });
              expect(selected.paint, `${at}: the selected day`).toEqual(
                selected.theme,
              );
              await page.keyboard.press("Escape");
              await page.getByRole("dialog").waitFor({ state: "hidden" });
            }

            // By keyboard: every Tab stop in the interface shows a focus ring.
            await page.getByLabel("Name").focus();
            const stops: string[] = [];
            for (let step = 0; step < 60; step++) {
              await page.keyboard.press("Tab");
              const stop = await page.evaluate(() => {
                const element = document.activeElement as HTMLElement | null;
                if (!element?.closest("[data-generative-ui-chat-surface]"))
                  return null;
                // What the stop is called, by its label or by its text.
                const label = [...((element as HTMLInputElement).labels ?? [])]
                  .map((item) => item.textContent)
                  .join("");
                const labelledBy = (
                  element.getAttribute("aria-labelledby") ?? ""
                )
                  .split(/\s+/)
                  .map((id) => document.getElementById(id)?.textContent ?? "")
                  .join("");
                const name =
                  element.getAttribute("aria-label") ??
                  (label ||
                    labelledBy ||
                    element.textContent ||
                    element.tagName.toLowerCase());
                return {
                  name: name.trim(),
                  outline: getComputedStyle(element).outlineStyle,
                };
              });
              // Tab has left the interface.
              if (!stop) break;
              stops.push(stop.name);
              expect(stop.outline, `${at}: ${stop.name}`).not.toBe("none");
            }
            // The walk reached the end of the form.
            expect(stops.at(-1), `${at}: last Tab stop`).toBe("Send");
            // Astryx keeps a disabled button a Tab stop, so it can say why it is disabled.
            expect(
              await surface
                .getByRole("button", { name: "Still here" })
                .getAttribute("aria-disabled"),
              `${at}: disabled button`,
            ).toBe("true");

            // The form sends what every control holds.
            await surface
              .getByRole("button", { name: "Send", exact: true })
              .press("Enter");
            await page.waitForFunction(() => window.__sent.length === 1);
            expect(
              await page.evaluate(() => window.__sent),
              `${at}: sent`,
            ).toEqual([
              [
                "Name",
                "",
                "name: Ada",
                "note: Window seat, please",
                'extras: ["bag"]',
                'seat: ["window"]',
                "alone: []",
                "trip: economy",
                "agree: false",
                "day: 2026-10-23",
                "at: 09:30",
                "slot: 2026-10-23T09:30",
                "rating: 10",
                "deck: lower",
                'split: [{"label":"Transport","amount":100},{"label":"Lodging","amount":250}]',
              ].join("\n"),
            ]);
            // Nothing runs past the page.
            const [scroll, client] = await page.evaluate(() => [
              document.documentElement.scrollWidth,
              document.documentElement.clientWidth,
            ]);
            expect(scroll, `${at}: page width`).toBe(client);
          } finally {
            await page.close();
          }
        }
      // The ink of a field and of its label, and the fill of a button, change with the theme.
      expect(inks.dark).not.toEqual(inks.light);
      expect(fills.dark).not.toEqual(fills.light);
    },
  );

  if (shots)
    browserTest(
      "screenshots at a chat's width and at a phone's",
      600_000,
      async (deadline) => {
        mkdirSync(shots, { recursive: true });
        /** The conversation from its top to the end of its last interface. */
        const shot = async (
          page: Page,
          only: string,
          theme: string,
          width: number,
          state = "",
        ) => {
          // A form taller than the window is cut off by the transcript's scroll area, so the window
          // is made as tall as the conversation first.
          const tall = await page.evaluate(() => {
            const frame = document.querySelector(
              "[data-generative-ui-chat-surface]",
            );
            for (let at = frame?.parentElement; at; at = at.parentElement)
              if (at.scrollHeight > at.clientHeight + 1)
                return at.scrollHeight + 48;
            return 0;
          });
          if (tall) await page.setViewportSize({ width, height: tall });
          const bottom = await page.$eval(
            "[data-generative-ui-chat-surface]",
            (frame) => frame.getBoundingClientRect().bottom,
          );
          await page.screenshot({
            path: join(
              shots,
              `${only}-${theme}${width === 680 ? "" : `-${width}`}${state}.png`,
            ),
            fullPage: true,
            clip: { x: 0, y: 0, width, height: Math.ceil(bottom) + 32 },
          });
        };
        for (const theme of ["light", "dark"] as const)
          for (const width of [680, 320])
            for (const only of ["budget", "plain", "forms", "controls"]) {
              const page = await open(`?only=${only}`, deadline, theme, width);
              try {
                await shot(page, only, theme, width);
                if (only !== "controls") continue;
                // Every control, with the list and the calendar open.
                const surface = card(page, only);
                await surface.locator('[aria-haspopup="listbox"]').click();
                await page.getByRole("option", { name: "upper" }).waitFor();
                await settle(page);
                await shot(page, only, theme, width, "-list");
                await page.keyboard.press("Escape");
                await surface
                  .getByRole("button", { name: "Open calendar" })
                  .first()
                  .click();
                await page.getByRole("dialog").waitFor();
                await settle(page);
                await shot(page, only, theme, width, "-calendar");
              } finally {
                await page.close();
              }
            }
        // One Chromium per page, sixteen pages, on a machine that may be busy.
      },
    );
});
