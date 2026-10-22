/* Combobox-in-Dialog ESC layering (guard v3 × combo-in-popover) + F2 (Select dying popup inside
 * the innermost of nested dialogs). Real CDP keyboard/mouse input only.
 * Locator note: HeroUI Button does not forward `id` as a DOM id — locate by text/selector scoped
 * to the innermost open dialog.
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
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 300)));
await page.setViewport({ width: 1280, height: 900 });
await page.goto(URL, { waitUntil: "networkidle0" });

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failures++;
}

const state = () =>
  page.evaluate(() => ({
    dialogs: document.querySelectorAll('[data-slot="dialog-overlay"]').length,
    listOpen: !!document.querySelector('[data-slot="combobox-list"]'),
    picked: window.__spike.dialogPicked,
    focusOn:
      document.activeElement?.id ||
      document.activeElement?.getAttribute("data-slot") ||
      document.activeElement?.tagName.toLowerCase(),
    focusText: (document.activeElement?.textContent || "").trim().slice(0, 30),
  }));

/* Click inside the innermost open dialog (or the document) by selector + optional text. */
async function clickInDialog(selector, text) {
  const box = await page.evaluate(
    ({ selector, text }) => {
      const overlays = [...document.querySelectorAll('[data-slot="dialog-overlay"]')];
      const scope = overlays.at(-1) ?? document;
      const nodes = [...scope.querySelectorAll(selector)];
      const el = text
        ? nodes.find((n) => (n.textContent || "").includes(text))
        : nodes[0];
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    { selector, text: text ?? null },
  );
  if (!box) throw new Error(`not found in dialog: ${selector} "${text ?? ""}"`);
  await sleep(120);
  await page.mouse.click(box.x, box.y);
  await sleep(400);
}

// G1 open combobox dialog
await clickInDialog("button", "Open combobox dialog");
let s = await state();
check("G1 dialog open", s.dialogs === 1, s);

// G2 open popover, filter, pick Beta
await clickInDialog('[data-slot="combobox-trigger"]');
await page.keyboard.type("be");
await sleep(300);
const betaBox = await page.evaluate(() => {
  const el = [...document.querySelectorAll('[data-slot="combobox-item"]')].find((n) =>
    (n.textContent || "").includes("Beta"),
  );
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (!betaBox) throw new Error("Beta option not visible after filter");
await page.mouse.click(betaBox.x, betaBox.y);
await sleep(300);
s = await state();
check("G2 pick Beta in dialog", JSON.stringify(s.picked) === '["b2"]' && s.listOpen, s);

// G3 single ESC: popover closes, dialog survives, selection kept, focus back on trigger
await page.keyboard.press("Escape");
await sleep(500);
s = await state();
check("G3 ESC closes popover only",
  !s.listOpen && s.dialogs === 1 && JSON.stringify(s.picked) === '["b2"]' && s.focusOn === "combobox-trigger",
  s);

// G4 second ESC closes the dialog, focus restored to the opener
await page.keyboard.press("Escape");
await sleep(700);
s = await state();
check("G4 ESC closes dialog", s.dialogs === 0 && s.focusText.includes("Open combobox dialog"), s);

// G5 fast double ESC: popover then dialog
await clickInDialog("button", "Open combobox dialog");
await sleep(300);
await clickInDialog('[data-slot="combobox-trigger"]');
await sleep(400);
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await sleep(900);
s = await state();
check("G5 fast double ESC layers", s.dialogs === 0 && JSON.stringify(s.picked) === '["b2"]', s);

// G6 reopen: chips kept in the popover; footer close still works
await clickInDialog("button", "Open combobox dialog");
await sleep(300);
await clickInDialog('[data-slot="combobox-trigger"]');
await sleep(400);
s = await state();
check("G6 reopen keeps chips", s.dialogs === 1 && s.listOpen && JSON.stringify(s.picked) === '["b2"]', s);
await page.keyboard.press("Escape");
await sleep(400);
await clickInDialog("button", "Close");
await sleep(700);
s = await state();
check("G6b footer close", s.dialogs === 0, s);

// F2: nested dialogs, Select in INNER dialog; ESC on a focused option closes the Select, a fast
// second ESC closes the INNER dialog only (dying-popup branch), outer survives.
await clickInDialog("button", "Open outer dialog");
await sleep(600);
await clickInDialog("button", "Open inner dialog");
await sleep(600);
s = await state();
check("F2 setup nested", s.dialogs === 2, s);

await clickInDialog('[aria-haspopup="listbox"]');
await sleep(500);
const optFocused = await page.evaluate(() => ({
  role: document.activeElement?.getAttribute("role"),
  expanded: document.querySelector('[aria-haspopup="listbox"][aria-expanded="true"]') !== null,
}));
check("F2 option focus", optFocused.role === "option" && optFocused.expanded, optFocused);

await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await sleep(900);
s = await state();
check("F2 inner closes, outer survives", s.dialogs === 1, s);

await page.keyboard.press("Escape");
await sleep(800);
s = await state();
check("F2 outer closes last", s.dialogs === 0, s);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await browser.close();
process.exitCode = failures === 0 ? 0 : 1;
