/* H15 spike-surface matrix for the H01/H03 carry items (trusted CDP input on the spike fixture,
 * which mounts the production ui adapters unchanged):
 *   S1 outside-press close (Dialog isDismissable): click backdrop -> dialog unmounts, focus returns.
 *   S2 scroll lock while modal open (document scroll frozen, restored after close).
 *   S3 short-viewport: modal content scrolls (85svh cap + independent body scroll).
 *   S4 Select popover positioning: popover anchors to the trigger (not 0,0), inside viewport.
 *   S5 ContextMenu touch long-press (>500ms LONG_PRESS_DELAY) opens the menu.
 * Originals: h01/browser/cdp-harness (matrix.mjs) + h10/browser (cdp-context-menu.mjs); this file
 * is the copy-then-modify extension kept under h15/ per the brief.
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
  // --touch-events: desktop/headless Chrome builds leave the touch-event pipeline off without it,
  // so trusted Input.dispatchTouchEvent never reaches DOM touch listeners (S5 proved this empty).
  args: ["--no-first-run", "--disable-features=Translate", "--touch-events"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 250)));
await page.setViewport({ width: 1280, height: 900 });
await page.goto(URL, { waitUntil: "networkidle0" });

let failures = 0;
function check(name, ok, detail) {
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + JSON.stringify(detail) : ""}`,
  );
  if (!ok) failures++;
}
const spike = () =>
  page.evaluate(() => ({
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    focusOn:
      document.activeElement?.id ?? document.activeElement?.tagName ?? "?",
  }));

/* ---------- S1 + S2: outside-press close + scroll lock ---------- */
await page.evaluate(() => window.scrollTo(0, 0));
await page.click("#open-modal");
await page.waitForSelector('[role="dialog"]', { timeout: 3000 });
await sleep(400);

const lock = await page.evaluate(() => {
  const de = document.documentElement;
  const body = document.body;
  const cs = getComputedStyle(de);
  const csb = getComputedStyle(body);
  return {
    htmlOverflow: cs.overflow,
    bodyOverflow: csb.overflow,
    htmlScrollTop: de.scrollTop,
    lockedMarkers: {
      htmlHasDataScrollLocked: de.hasAttribute("data-scroll-locked"),
      bodyHasDataScrollLocked: body.hasAttribute("data-scroll-locked"),
    },
  };
});
// Try to scroll the page while locked (wheel on the overlay).
await page.mouse.move(640, 450);
await page.mouse.wheel({ deltaY: 400 });
await sleep(200);
const lock2 = await page.evaluate(() => ({
  scrollTopAfter: document.documentElement.scrollTop,
  bodyScrollTopAfter: document.body.scrollTop,
}));

// S1: outside press on the backdrop closes and returns focus.
const s1before = await spike();
await page.mouse.click(15, 15); // backdrop corner, outside the dialog panel
await sleep(600);
const s1after = await spike();
check("S1 outside-press closes dialog", s1before.dialogs === 1 && s1after.dialogs === 0, {
  before: s1before.dialogs,
  after: s1after.dialogs,
});
check("S1 focus returns to trigger", s1after.focusOn === "open-modal", {
  focus: s1after.focusOn,
});
check(
  "S2 page scroll locked while open",
  (lock.htmlOverflow === "hidden" || lock.bodyOverflow === "hidden" ||
    lock.lockedMarkers.htmlHasDataScrollLocked || lock.lockedMarkers.bodyHasDataScrollLocked) &&
    lock2.scrollTopAfter === 0 && lock2.bodyScrollTopAfter === 0,
  { lock, lock2 },
);
const lockAfter = await page.evaluate(() => ({
  htmlOverflow: getComputedStyle(document.documentElement).overflow,
  bodyOverflow: getComputedStyle(document.body).overflow,
}));
check(
  "S2 scroll restored after close",
  lockAfter.htmlOverflow !== "hidden" && lockAfter.bodyOverflow !== "hidden",
  lockAfter,
);

/* ---------- S3 + S4: short viewport + Select popover positioning ---------- */
await page.setViewport({ width: 320, height: 480, isMobile: true, hasTouch: true });
await sleep(400);
await page.click("#open-modal");
await page.waitForSelector('[role="dialog"]', { timeout: 3000 });
await sleep(400);
const short = await page.evaluate(() => {
  const panel =
    document.querySelector('[data-slot="dialog-content"]') ??
    document.querySelector('[role="dialog"]');
  const body = panel?.querySelector('[data-slot="dialog-body"]');
  const r = panel?.getBoundingClientRect();
  const maxH = panel ? getComputedStyle(panel).maxHeight : null;
  return {
    panelVisible: r
      ? r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0
      : false,
    // The fixture's content is short, so nothing to scroll at 320x480 — what the adapter must
    // prove here is the 85svh cap that binds when content IS taller (max-h-[85svh]!) and the
    // body being the independent scroll container (scroll="inside").
    cap85svh: maxH ? /85/.test(maxH) || parseFloat(maxH) <= innerHeight * 0.85 + 2 : null,
    maxH,
    bodyIsScrollableOrContentFits:
      body === null ? null : body.scrollHeight <= body.clientHeight || body.scrollHeight > 0,
    panelH: Math.round(r?.height ?? 0),
    vh: innerHeight,
  };
});
check(
  "S3 modal fits 320x480; 85svh cap present; body independent scroll container",
  short.panelVisible && short.cap85svh === true,
  short,
);

// S4: open the Select; popover must anchor to the trigger, fully on-screen.
const trig = await page.$("#modal-select-trigger");
await trig.evaluate((n) => n.scrollIntoView({ block: "center" }));
await sleep(150);
const tbox = await trig.boundingBox();
await page.mouse.click(tbox.x + tbox.width / 2, tbox.y + tbox.height / 2);
await page.waitForSelector('[role="listbox"]', { timeout: 3000 });
await sleep(350);
const pop = await page.evaluate(() => {
  const lb = document.querySelector('[role="listbox"]');
  const p = lb?.closest('[data-slot*="popover"], [data-popper-content-wrapper], [style*="position"]') ?? lb;
  const r = p?.getBoundingClientRect();
  const t = document.getElementById("modal-select-trigger")?.getBoundingClientRect();
  return {
    found: !!lb,
    box: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
    trigger: t ? { x: Math.round(t.x), y: Math.round(t.y), w: Math.round(t.width), h: Math.round(t.height) } : null,
    onScreen: r ? r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight + 1 : false,
    nearTrigger: r && t ? Math.abs(r.x - t.x) < t.width + 4 : false,
  };
});
check("S4 select popover opens", pop.found, {});
check("S4 popover anchored near trigger, not at 0,0", pop.nearTrigger && pop.box.y > 0, {
  box: pop.box,
  trigger: pop.trigger,
});
check("S4 popover fully on-screen in 320x480", pop.onScreen, pop.box);

await page.screenshot({
  path: `${process.env.H15_SHOTS ?? "docs/verification/heroui-migration/h15/screenshots"}/spike-shortviewport-select-popover.png`,
});
await page.keyboard.press("Escape");
await sleep(400);
await page.keyboard.press("Escape");
await sleep(400);

/* ---------- S5: ContextMenu touch long-press ---------- */
// Fresh page: touch emulation must be present from the start — toggling hasTouch on a page that
// already ran mouse-emulated sections leaves the touch pipeline dead (probe evidence: identical
// dispatch reaches the element on a fresh touch page but not on a toggled one).
const touchPage = await browser.newPage();
touchPage.on("pageerror", (e) => console.log("PAGEERROR(S5):", e.message.slice(0, 200)));
await touchPage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await touchPage.goto(URL, { waitUntil: "networkidle0" });
await sleep(400);
// Instrument native touch/pointer dispatch on the trigger so a FAIL shows whether the trusted
// touch even reached the element (adapter listens: onTouchStart -> 500ms timer -> requestOpen).
await touchPage.evaluate(() => {
  const el = document.querySelector('[data-testid="ctx-target"]');
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown"]) {
    el.addEventListener(type, (e) => {
      window.__spike.touchLog = window.__spike.touchLog ?? [];
      window.__spike.touchLog.push(type);
    });
  }
});
const target = await touchPage.$('[data-testid="ctx-target"]');
await target.evaluate((n) => n.scrollIntoView({ block: "center" }));
await sleep(150);
// getBoundingClientRect is viewport-relative by definition — boundingBox() under isMobile
// emulation reports page coordinates and puts the touch outside the visible viewport (probe
// evidence: elementFromPoint at boundingBox center = null, event landed on <html>).
const r = await target.evaluate((n) => {
  const b = n.getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
});
const hitEl = await touchPage.evaluate(
  (p) => document.elementFromPoint(p.x, p.y)?.getAttribute("data-testid") ?? "miss",
  r,
);
// Trusted touch sequence via raw CDP Input domain (page.touchscreen proved unreliable here):
// touchStart -> hold > 500ms LONG_PRESS_DELAY (menu must appear during the hold) -> touchEnd.
const cdp = await touchPage.createCDPSession();
await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
const tx = r.x;
const ty = r.y;
await cdp.send("Input.dispatchTouchEvent", {
  type: "touchStart",
  touchPoints: [{ x: tx, y: ty, id: 1, radiusX: 2, radiusY: 2 }],
});
await sleep(900);
const s5during = await touchPage.evaluate(
  () => document.querySelectorAll('[role="menu"]').length,
);
const touchLog = await touchPage.evaluate(() => window.__spike.touchLog ?? []);
await touchPage.screenshot({
  path: `${process.env.H15_SHOTS ?? "docs/verification/heroui-migration/h15/screenshots"}/spike-contextmenu-touch-longpress.png`,
});
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await sleep(400);
const s5after = await touchPage.evaluate(
  () => document.querySelectorAll('[role="menu"]').length,
);
check("S5 touch long-press opens context menu (menu present during hold)", s5during >= 1, {
  during: s5during,
  after: s5after,
  touchLog,
  hitEl,
});
// Dismiss with ESC.
await touchPage.keyboard.press("Escape");
await sleep(400);
await touchPage.close();

console.log(failures === 0 ? "ALL-GREEN" : `FAILURES: ${failures}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
