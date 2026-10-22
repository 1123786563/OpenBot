import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = "http://localhost:5199/spike.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Animations ON (no reduced-motion) to match the in-app browser environment where the
// leftovers were recorded.

async function sample(page) {
  return await page.evaluate(() => {
    const ae = document.activeElement;
    const describe = (el) =>
      !el || el === document.body
        ? "body"
        : el.id ||
          `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""}:${(el.textContent || "").trim().slice(0, 24)}`;
    return {
      dialogs: document.querySelectorAll('[data-slot="dialog-overlay"]').length,
      options: document.querySelectorAll('[role="option"]').length,
      focusOn: describe(ae),
      events: window.__spike.events.map((e) => e.name),
    };
  });
}

async function freshPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(URL, { waitUntil: "networkidle0" });
  return page;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--disable-features=Translate"],
});

const results = {};

/* A: trigger-focus ESC baseline — popover closes, modal stays; ESC#2 closes modal, focus restored. */
{
  const page = await freshPage(browser);
  await page.click("#open-modal");
  await sleep(450);
  await page.click("#modal-select-trigger");
  await sleep(450);
  await page.keyboard.press("Escape");
  await sleep(600);
  const a1 = await sample(page);
  await page.keyboard.press("Escape");
  await sleep(800);
  const a2 = await sample(page);
  results.A = { afterESC1: a1, afterESC2: a2 };
  await page.close();
}

/* B: option-focus ESC (leftover 1) — ArrowDown first, ESC should close popover only. */
{
  const page = await freshPage(browser);
  await page.click("#open-modal");
  await sleep(450);
  await page.click("#modal-select-trigger");
  await sleep(450);
  await page.keyboard.press("ArrowDown");
  await sleep(250);
  const focusBefore = (await sample(page)).focusOn;
  await page.keyboard.press("Escape");
  await sleep(600);
  const b1 = await sample(page);
  await page.keyboard.press("Escape");
  await sleep(800);
  const b2 = await sample(page);
  results.B = { focusBefore, afterESC1: b1, afterESC2: b2 };
  await page.close();
}

/* C: rapid double-ESC with popover open (guard must not over-defer) —
 * popover closes on #1, modal closes on #2 with no sleep between presses. */
{
  const page = await freshPage(browser);
  await page.click("#open-modal");
  await sleep(450);
  await page.click("#modal-select-trigger");
  await sleep(450);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await sleep(900);
  results.C = await sample(page);
  await page.close();
}

/* D: option-focus ESC then IMMEDIATE second ESC (worst case overlap). */
{
  const page = await freshPage(browser);
  await page.click("#open-modal");
  await sleep(450);
  await page.click("#modal-select-trigger");
  await sleep(450);
  await page.keyboard.press("ArrowDown");
  await sleep(150);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await sleep(1000);
  results.D = await sample(page);
  await page.close();
}

/* E: footer Close button — focus must restore to open-modal (leftover 2, render-prop trigger). */
{
  const page = await freshPage(browser);
  await page.click("#open-modal");
  await sleep(450);
  await page.click("#close-modal");
  await sleep(800);
  results.E = await sample(page);
  await page.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
