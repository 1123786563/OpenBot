import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = "http://localhost:5199/spike.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(page) {
  return await page.evaluate(() => {
    const ae = document.activeElement;
    const trig = document.getElementById("modal-select-trigger");
    return {
      dialogs: document.querySelectorAll('[data-slot="dialog-overlay"]').length,
      options: document.querySelectorAll('[role="option"]').length,
      expanded: trig?.getAttribute("aria-expanded"),
      haspopup: trig?.getAttribute("aria-haspopup"),
      focusOn: ae?.id || ae?.tagName.toLowerCase(),
      anyExpanded: [...document.querySelectorAll('[aria-haspopup="listbox"][aria-expanded="true"],[aria-haspopup="menu"][aria-expanded="true"]')].length,
    };
  });
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--disable-features=Translate"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto(URL, { waitUntil: "networkidle0" });

await page.click("#open-modal");
await sleep(450);
await page.click("#modal-select-trigger");
await sleep(450);
console.log("t0 open:", JSON.stringify(await probe(page)));

await page.keyboard.press("Escape");
console.log("t1 right after ESC#1:", JSON.stringify(await probe(page)));
await sleep(50);
console.log("t2 50ms later:", JSON.stringify(await probe(page)));
await sleep(150);
console.log("t3 200ms later:", JSON.stringify(await probe(page)));
await page.keyboard.press("Escape");
console.log("t4 after ESC#2:", JSON.stringify(await probe(page)));
await browser.close();
