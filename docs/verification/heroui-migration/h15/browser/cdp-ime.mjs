/* H15 IME composition Enter check (trusted CDP Input.imeSetComposition).
 * Runs against a target textarea (default: spike ImeSpike fixture id=ime-input; override with
 * IME_TARGET_SELECTOR / IME_URL for the real-app chat composer). Sequence:
 *   1. imeSetComposition inserts composition text ("ni" -> "你好" commit style: two sets).
 *   2. While composing, press Enter -> the guard must NOT send (composition is being consumed).
 *   3. imeSetComposition with empty string commits; then a plain Enter -> guard sends.
 * The composer's guard: onKeyDown checks composing.current || nativeEvent.isComposing.
 */
import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = process.env.IME_URL ?? "http://localhost:5199/spike.html";
const SEL = process.env.IME_TARGET_SELECTOR ?? "#ime-input";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--lang=zh-CN", "--disable-features=Translate"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));
await page.setViewport({ width: 1280, height: 900 });
await page.goto(URL, { waitUntil: "networkidle0", timeout: 45000 });
await sleep(500);
await page.focus(SEL);
const cdp = await page.createCDPSession();
await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

// Start composition: insert "ni".
await cdp.send("Input.imeSetComposition", {
  selectionStart: 0,
  selectionEnd: 0,
  text: "ni",
  segments: [{ start: 0, end: 2, highlight: "Active" }],
});
await sleep(250);
// Convert to "你好" (still composing).
await cdp.send("Input.imeSetComposition", {
  selectionStart: 0,
  selectionEnd: 2,
  text: "你好",
  segments: [{ start: 0, end: 2, highlight: "Active" }],
});
await sleep(250);

// Enter while composing — must be consumed by the IME (confirm composition), not sent.
await cdp.send("Input.dispatchKeyEvent", {
  type: "keyDown",
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
});
await cdp.send("Input.dispatchKeyEvent", {
  type: "keyUp",
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
});
await sleep(300);

// Commit the composition (empty string ends composition).
await cdp.send("Input.imeSetComposition", {
  selectionStart: 2,
  selectionEnd: 2,
  text: "",
});
await sleep(250);
const afterCommit = await page.evaluate((sel) => {
  const el = document.querySelector(sel);
  return el ? el.value : null;
}, SEL);

// Plain Enter after composition ended — guard must SEND.
await cdp.send("Input.dispatchKeyEvent", {
  type: "keyDown",
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
});
await cdp.send("Input.dispatchKeyEvent", {
  type: "keyUp",
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
});
await sleep(300);

const spikeEvents = await page.evaluate(
  () => window.__spike?.events?.map((e) => e.name) ?? null,
);
const guardLog = await page.evaluate(() => window.__imeLog ?? null);
console.log(
  JSON.stringify({ afterCommit, spikeEvents, guardLog }, null, 1),
);
const composingEnterGuarded =
  (spikeEvents ?? guardLog ?? []).includes("enter-while-composing");
const sentAfterCommit = (spikeEvents ?? guardLog ?? []).includes("enter-sent");
console.log(
  composingEnterGuarded && sentAfterCommit
    ? "IME-GREEN: Enter during composition guarded; Enter after commit sent"
    : "IME-FAIL",
);
await browser.close();
process.exit(composingEnterGuarded && sentAfterCommit ? 0 : 1);
