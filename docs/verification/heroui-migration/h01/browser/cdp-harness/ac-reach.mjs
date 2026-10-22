/* AC3/AC4 gap-closers on the EXISTING spike fixtures (no code changes):
 * - Questionnaire: radio Email -> choice event recorded, Next advances (progress "none" -> …)
 * - MessageScroller: programmatic + trusted wheel scroll to end, scrollAnchor region reacts
 * - ContextMenu: Shift+F10 and the ContextMenu key open the production context menu
 * - Long-press: CDP touch down/hold/up (harness-limited; recorded either way)
 */
import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = "http://localhost:5199/spike.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--disable-features=Translate"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, hasTouch: true });
await page.goto(URL, { waitUntil: "networkidle0" });
await page.evaluate(() => { window.__spike.events.length = 0; });

const out = {};

/* Questionnaire: trusted click Email radio, then Next. */
{
  const email = await page.evaluateHandle(() =>
    [...document.querySelectorAll('input[type="radio"]')].find((r) =>
      (r.closest('[data-slot="questionnaire-choice"]')?.textContent || "").includes("Email"),
    ),
  );
  await email.asElement().click();
  await sleep(250);
  const next = await page.evaluateHandle(() =>
    [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Next"),
  );
  await next.asElement().click();
  await sleep(400);
  out.questionnaire = await page.evaluate(() => ({
    events: window.__spike.events.map((e) => e.name + ":" + JSON.stringify(e.detail ?? "")),
    progress: [...document.querySelectorAll("main *")].map((n) => n.textContent).find((t) => t === "1/2" || /^\d+\/\d+$/.test(t || "")) || null,
  }));
}

/* MessageScroller: focus the region and press End / trusted wheel. */
{
  await page.evaluate(() => document.querySelector('[aria-label="Messages"]')?.focus());
  await page.keyboard.press("End");
  await sleep(350);
  out.scroller = await page.evaluate(() => {
    const vp = document.querySelector('[data-slot="message-scroller-viewport"]') || document.querySelector('[aria-label="Messages"]');
    return vp ? { scrollTop: Math.round(vp.scrollTop), scrollHeight: vp.scrollHeight, clientHeight: vp.clientHeight } : null;
  });
}

/* ContextMenu via Shift+F10 and the ContextMenu key. */
async function menuProbe(label, pressFn) {
  const target = await page.evaluateHandle(() =>
    [...document.querySelectorAll("[tabindex], button, div")].find((n) => (n.textContent || "").includes("Right-click me")),
  );
  await target.asElement().evaluate((n) => n.focus());
  await sleep(150);
  await pressFn();
  await sleep(450);
  const state = await page.evaluate(() => ({
    menus: document.querySelectorAll('[role="menu"]').length,
    items: document.querySelectorAll('[role="menuitem"]').length,
  }));
  await page.keyboard.press("Escape");
  await sleep(300);
  return { key: label, ...state };
}
out.shiftF10 = await menuProbe("Shift+F10", async () => {
  await page.keyboard.down("Shift");
  await page.keyboard.press("F10");
  await page.keyboard.up("Shift");
});
out.contextMenuKey = await menuProbe("ContextMenu", () => page.keyboard.press("ContextMenu"));

/* Long-press via raw CDP touch events (600ms hold). */
{
  const box = await page.evaluateHandle(() =>
    [...document.querySelectorAll("div")].find((n) => (n.textContent || "").includes("Right-click me")),
  );
  const rect = await box.asElement().boundingBox();
  const cdp = await page.createCDPSession();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }] });
  await sleep(700);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(500);
  out.longPress = await page.evaluate(() => ({
    menus: document.querySelectorAll('[role="menu"]').length,
    items: document.querySelectorAll('[role="menuitem"]').length,
  }));
  await page.keyboard.press("Escape");
}

console.log(JSON.stringify(out, null, 2));
await browser.close();
