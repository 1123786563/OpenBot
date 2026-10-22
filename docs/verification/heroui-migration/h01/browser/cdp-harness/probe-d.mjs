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
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") console.log("CONSOLE", m.type(), m.text().slice(0, 300));
});
await page.goto(URL, { waitUntil: "networkidle0" });

await page.evaluate(() => {
  window.__escLog = [];
  const origStop = Event.prototype.stopPropagation;
  const origStopImm = Event.prototype.stopImmediatePropagation;
  const mark = (e) => {
    if (e.key === "Escape") (e.__stops ||= []).push(new Error("stopper").stack?.split("\n")[2]?.trim());
  };
  Event.prototype.stopPropagation = function (...a) { mark(this); return origStop.apply(this, a); };
  Event.prototype.stopImmediatePropagation = function (...a) { mark(this); return origStopImm.apply(this, a); };
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const t = e.target;
    window.__escLog.push({
      at: performance.now(),
      target: t instanceof Element ? (t.id || `${t.tagName.toLowerCase()}[role=${t.getAttribute("role")}]`) : String(t),
      defaultPrevented: e.defaultPrevented,
      stops: e.__stops ?? null,
    });
  }, false); // bubble phase: after everything; if it fires, nothing stopped propagation at document level
});

await page.click("#open-modal");
await sleep(450);
await page.click("#modal-select-trigger");
await sleep(450);

await page.keyboard.press("Escape");
await sleep(250);
let s = await page.evaluate(() => ({
  dialogs: document.querySelectorAll('[data-slot="dialog-overlay"]').length,
  options: document.querySelectorAll('[role="option"]').length,
  focusOn: document.activeElement?.id || document.activeElement?.tagName.toLowerCase(),
}));
console.log("after ESC#1 +250ms:", JSON.stringify(s));

await page.keyboard.press("Escape");
await sleep(400);
s = await page.evaluate(() => ({
  dialogs: document.querySelectorAll('[data-slot="dialog-overlay"]').length,
  options: document.querySelectorAll('[role="option"]').length,
  focusOn: document.activeElement?.id || document.activeElement?.tagName.toLowerCase(),
  escLog: window.__escLog,
  spikeEvents: window.__spike.events.map((e) => e.name),
}));
console.log("after ESC#2 +400ms:", JSON.stringify(s, null, 2));

await page.keyboard.press("Escape");
await sleep(400);
s = await page.evaluate(() => ({
  dialogs: document.querySelectorAll('[data-slot="dialog-overlay"]').length,
  focusOn: document.activeElement?.id || document.activeElement?.tagName.toLowerCase(),
  escLog: window.__escLog,
}));
console.log("after ESC#3 +400ms:", JSON.stringify(s, null, 2));

await browser.close();
