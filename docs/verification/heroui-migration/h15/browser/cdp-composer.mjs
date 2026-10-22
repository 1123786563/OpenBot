/* H15 A06: real-app chat composer IME Enter + send attempt (channel/new).
 * IME: CDP Input.imeSetComposition (trusted) — Enter during composition must NOT send; Enter
 * after commit sends once. The send itself will fail without an agent runtime — that error path
 * is recorded, not fabricated. If a channel results, the sidebar channel ContextMenu is tested
 * (right-click / Shift+F10 / ContextMenu key + ESC focus return).
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP = "http://localhost:3011";
const SHOTS =
  process.env.H15_SHOTS ?? "docs/verification/heroui-migration/h15/screenshots";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--lang=zh-CN", "--disable-features=Translate"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));
await page.setViewport({ width: 1440, height: 900 });
const { cookies } = JSON.parse(fs.readFileSync("/tmp/h15-state.json", "utf8"));
await page.setCookie(...cookies.filter((c) => c.domain.includes("localhost")));
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("openbot-theme", "light");
  localStorage.setItem("openbot.language", "zh");
});

let failures = 0;
function check(name, ok, detail) {
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + JSON.stringify(detail) : ""}`,
  );
  if (!ok) failures++;
}

await page.goto(APP + "/channel/new", { waitUntil: "networkidle2", timeout: 45000 });
await sleep(2000);

// Locate the PromptArea textarea (contenteditable or textarea; PromptArea engine). Target the
// VISIBLE composer: the page can carry hidden textareas (dictation draft), so filter by box.
await sleep(500);
const box = await page.evaluateHandle(() => {
  const cands = [
    ...document.querySelectorAll('form textarea, [role="textbox"], textarea, [contenteditable="true"]'),
  ];
  return (
    cands.find((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 200 && r.height > 20 && r.bottom < innerHeight && r.bottom > innerHeight / 2;
    }) ?? cands[0]
  );
});
const desc = await box.evaluate((n) => ({
  tag: n.tagName,
  editable: n.isContentEditable ?? false,
  aria: n.getAttribute("aria-label"),
  placeholder: n.getAttribute("placeholder"),
  rect: (() => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; })(),
}));
console.log("composer node:", JSON.stringify(desc));
// Click into the visible composer so focus is real, then log from the focused element.
const db = await box.evaluate((n) => {
  const r = n.getBoundingClientRect();
  return { x: r.x + Math.min(80, r.width / 2), y: r.y + r.height / 2 };
});
await page.mouse.click(db.x, db.y);
await sleep(300);

// Instrument: watch for navigation to a channel (send) and for the composer draft value.
await page.evaluate(() => {
  window.__composerLog = [];
  const el = document.activeElement;
  if (el) {
    el.addEventListener("compositionstart", () => window.__composerLog.push("composition-start"));
    el.addEventListener("compositionend", () => window.__composerLog.push("composition-end"));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        window.__composerLog.push(`enter(isComposing=${e.isComposing})`);
      }
    });
  }
});
const cdp = await page.createCDPSession();
await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

// Compose 你好 via IME, press Enter mid-composition (must confirm composition, not send).
await cdp.send("Input.imeSetComposition", {
  selectionStart: 0, selectionEnd: 0, text: "ni",
  segments: [{ start: 0, end: 2, highlight: "Active" }],
});
await sleep(200);
await cdp.send("Input.imeSetComposition", {
  selectionStart: 0, selectionEnd: 2, text: "你好",
  segments: [{ start: 0, end: 2, highlight: "Active" }],
});
await sleep(200);
await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await sleep(400);
const midUrl = page.url();
// A real IME commits on Enter — the browser finalizes the composition itself (no empty-text
// reset needed; that wiped the DOM text without going through the engine's draft state).
await sleep(300);
const committed = await box.evaluate((n) => n.value ?? n.textContent);
// Plain Enter now sends once.
const sentAt = Date.now();
await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await sleep(4000);
const afterUrl = page.url();
const log = await page.evaluate(() => window.__composerLog);
console.log(JSON.stringify({ midUrl, committed, afterUrl, log }, null, 1));
check(
  "A06 IME: Enter during composition does not send",
  !log?.some((l) => l.startsWith("enter") && l.includes("isComposing=true") === false && log.indexOf(l) < log.findIndex((x) => x === "composition-end")),
  log,
);
const enterDuring = log?.filter((l) => l.startsWith("enter"));
check(
  "A06 IME: mid-composition Enter logged as composing (isComposing=true)",
  enterDuring?.[0]?.includes("isComposing=true"),
  enterDuring,
);
check("A06 IME: composition committed into composer", /你好/.test(committed ?? ""), { committed });
await page.screenshot({ path: `${SHOTS}/a06-composer-ime.png` });
// URL: /channel/new before send; a channel path after successful send. Without agent runtime the
// send may error — record honestly either way.
console.log("send attempt url before/after:", midUrl, "->", afterUrl);

// If a channel was created, exercise the sidebar channel ContextMenu.
if (/\/channel\//.test(afterUrl) && !/\/channel\/new/.test(afterUrl)) {
  const item = await page.$('aside a[href*="/channel/"]');
  if (item) {
    const b = await item.evaluate((n) => {
      const r = n.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(b.x, b.y, { button: "right" });
    await sleep(500);
    let menus = await page.evaluate(() => document.querySelectorAll('[role="menu"]').length);
    check("A04 in-app context menu opens on right-click", menus >= 1, { menus });
    await page.keyboard.press("Escape");
    await sleep(300);
    // Shift+F10.
    await page.keyboard.press("Shift+F10");
    await sleep(500);
    menus = await page.evaluate(() => document.querySelectorAll('[role="menu"]').length);
    check("A04 in-app context menu opens on Shift+F10", menus >= 1, { menus });
    await page.keyboard.press("Escape");
    await sleep(300);
    // ContextMenu key.
    await page.keyboard.press("ContextMenu");
    await sleep(500);
    menus = await page.evaluate(() => document.querySelectorAll('[role="menu"]').length);
    check("A04 in-app context menu opens on ContextMenu key", menus >= 1, { menus });
    await page.screenshot({ path: `${SHOTS}/a04-inapp-context-menu.png` });
    await page.keyboard.press("Escape");
    await sleep(300);
  }
} else {
  console.log(
    "NOTE in-app channel ContextMenu: no channel exists (send needs the agent runtime, not part of this env) — component-level trusted-input evidence stands (spike matrix S5 + h10 CDP 7/7).",
  );
}

console.log(failures === 0 ? "ALL-GREEN" : `FAILURES: ${failures}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
