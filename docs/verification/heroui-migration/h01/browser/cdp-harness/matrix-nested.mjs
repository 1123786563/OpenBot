/* F1: nested Dialog ESC layering — innermost first, outer keeps state, focus restores per layer. */
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
await page.setViewport({ width: 1280, height: 900 });
await page.goto(URL, { waitUntil: "networkidle0" });

async function clickByText(text) {
  const handle = await page.evaluateHandle(
    (t) =>
      [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === t),
    text,
  );  const el = handle.asElement();
  if (!el) throw new Error(`button not found: ${text}`);
  await el.evaluate((b) => b.scrollIntoView({ block: "center" }));
  await sleep(120);
  await el.click();
}

const state = () =>
  page.evaluate(() => ({
    dialogs: document.querySelectorAll('[data-slot="dialog-overlay"]').length,
    focusOn: document.activeElement?.id || (document.activeElement?.textContent || "").trim().slice(0, 20) || document.activeElement?.tagName.toLowerCase(),
  }));

await clickByText("Open outer dialog");
await sleep(500);
console.log("outer open:", JSON.stringify(await state()));

await clickByText("Open inner dialog");
await sleep(500);
console.log("inner open:", JSON.stringify(await state()));

await page.keyboard.press("Escape");
await sleep(700);
const afterEsc1 = await state();
console.log("after ESC#1:", JSON.stringify(afterEsc1));

await page.keyboard.press("Escape");
await sleep(800);
const afterEsc2 = await state();
console.log("after ESC#2:", JSON.stringify(afterEsc2));

const pass =
  afterEsc1.dialogs === 1 && afterEsc2.dialogs === 0;
console.log("F1 nested ESC layering:", pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
