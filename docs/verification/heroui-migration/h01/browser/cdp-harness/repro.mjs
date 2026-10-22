import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = "http://localhost:5199/spike.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      selectValue: window.__spike.selectValue,
    };
  });
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--disable-features=Translate", "--force-prefers-reduced-motion"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto(URL, { waitUntil: "networkidle0" });
await page.evaluate(() => { window.__spike.events.length = 0; });

await page.click("#open-modal");
await sleep(400);
console.log("after open modal:", JSON.stringify(await sample(page)));

await page.click("#modal-select-trigger");
await sleep(400);
console.log("after open select:", JSON.stringify(await sample(page)));

await page.keyboard.press("ArrowDown");
await sleep(200);
console.log("after ArrowDown:", JSON.stringify(await sample(page)));

await page.keyboard.press("Escape");
await sleep(500);
console.log("after ESC#1:", JSON.stringify(await sample(page)));

await page.keyboard.press("Escape");
await sleep(700);
console.log("after ESC#2:", JSON.stringify(await sample(page)));

await browser.close();
