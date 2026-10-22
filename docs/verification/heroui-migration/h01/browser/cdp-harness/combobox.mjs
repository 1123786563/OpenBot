/* Multi-select combobox adapter verification (trusted CDP input), combo-in-popover structure:
 * open(trigger) -> pick Alpha -> pick Beta (order) -> filter "gam" -> pick Gamma -> clear filter
 * -> remove chip Beta -> empty-state "zzz" -> ESC keeps selection, closes list, focus -> trigger
 * -> reopen keeps chips, query reset. All pointer input is real CDP Input (isTrusted=true).
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
const consoleLog = [];
page.on("console", (m) => consoleLog.push(m.text()));

await page.setViewport({ width: 1280, height: 900 });
await page.goto(URL, { waitUntil: "networkidle0" });

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failures++;
}

const state = () =>
  page.evaluate(() => ({
    picked: window.__spike.pickedOrder ?? null,
    chips: [...document.querySelectorAll('[data-slot="combobox-chip"]')].map(
      (c) => (c.textContent || "").replace(/Remove.*/, "").trim(),
    ),
    options: document.querySelectorAll('[data-slot="combobox-item"]').length,
    listOpen: !!document.querySelector('[data-slot="combobox-list"]'),
    empty: document.querySelector('[data-slot="combobox-empty"]')?.textContent ?? null,
    inputValue: document.querySelector('[data-slot="combobox-chip-input"]')?.value ?? null,
    focusOn:
      document.activeElement?.getAttribute("data-slot") ??
      document.activeElement?.id ??
      document.activeElement?.tagName,
    trigger: (() => {
      const t = document.querySelector('[data-slot="combobox-trigger"]');
      return t
        ? { text: t.textContent?.trim(), expanded: t.getAttribute("aria-expanded"), haspopup: t.getAttribute("aria-haspopup") }
        : null;
    })(),
  }));

async function realClick(selector, label) {
  const handle = await page.evaluateHandle((s, t) => {
    const nodes = [...document.querySelectorAll(s)];
    return t ? nodes.find((n) => (n.textContent || "").includes(t)) : nodes[0];
  }, selector, label ?? null);
  const el = handle.asElement();
  if (!el) throw new Error(`not found: ${selector} "${label ?? ""}"`);
  await el.evaluate((n) => n.scrollIntoView({ block: "center" }));
  await sleep(80);
  const box = await el.boundingBox();
  if (!box) throw new Error(`no box: ${selector} "${label ?? ""}"`);
  const covered = await page.evaluate(
    ({ x, y }) => {
      const top = document.elementFromPoint(x, y);
      return top?.getAttribute("data-slot") || top?.tagName;
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(300);
  return covered;
}

// S1 open via trigger
let covered = await realClick('[data-slot="combobox-trigger"]');
let s = await state();
check("S1 open", s.listOpen && s.options === 4 && s.focusOn === "combobox-chip-input" && s.trigger?.expanded === "true",
  { covered, ...s });

// S2 pick Alpha (real pointer)
covered = await realClick('[data-slot="combobox-item"]', "Alpha");
s = await state();
check("S2 pick Alpha", JSON.stringify(s.picked) === '["b1"]' && s.chips.length === 1 && s.listOpen,
  { covered, picked: s.picked, chips: s.chips, focusOn: s.focusOn });

// S3 pick Beta -> order [b1,b2]
covered = await realClick('[data-slot="combobox-item"]', "Beta");
s = await state();
check("S3 pick Beta (order)", JSON.stringify(s.picked) === '["b1","b2"]', { covered, picked: s.picked });

// S4 type to filter
await page.keyboard.type("gam");
await sleep(350);
s = await state();
check("S4 filter 'gam'", s.inputValue === "gam" && s.options === 1 && s.focusOn === "combobox-chip-input",
  { value: s.inputValue, options: s.options, focusOn: s.focusOn });

// S5 pick Gamma while filtered
covered = await realClick('[data-slot="combobox-item"]', "Gamma");
s = await state();
check("S5 pick Gamma (filtered)", JSON.stringify(s.picked) === '["b1","b2","b3"]',
  { covered, picked: s.picked, focusOn: s.focusOn });

// S6 clear filter
await page.keyboard.press("Backspace");
await page.keyboard.press("Backspace");
await page.keyboard.press("Backspace");
await sleep(300);
s = await state();
check("S6 filter cleared", s.inputValue === "" && s.options === 4, { value: s.inputValue, options: s.options });

// S7 remove chip Beta via real pointer
covered = await realClick('[data-slot="combobox-chip"]', "Beta").then(async (c) => {
  const handle = await page.evaluateHandle(() =>
    [...document.querySelectorAll('[data-slot="combobox-chip"]')]
      .find((n) => (n.textContent || "").includes("Beta"))
      ?.querySelector('[data-slot="combobox-chip-remove"]'),
  );
  const el = handle.asElement();
  if (!el) throw new Error("Beta chip remove not found");
  await el.evaluate((n) => n.scrollIntoView({ block: "center" }));
  const box = await el.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(300);
  return c;
});
s = await state();
check("S7 remove first chip (Beta)", JSON.stringify(s.picked) === '["b1","b3"]' && s.focusOn === "combobox-chip-input",
  { covered, picked: s.picked, chips: s.chips, focusOn: s.focusOn });

// S8 empty state
await page.keyboard.type("zzz");
await sleep(300);
s = await state();
check("S8 empty state", s.options === 0 && s.empty === "No Bots found.",
  { options: s.options, empty: s.empty, triggerText: s.trigger?.text });

// S9 ESC keeps selection, closes list, focus to trigger
await page.keyboard.press("Escape");
await sleep(500);
s = await state();
check("S9 ESC layering", !s.listOpen && JSON.stringify(s.picked) === '["b1","b3"]' &&
    s.focusOn === "combobox-trigger" && s.trigger?.expanded === "false",
  { listOpen: s.listOpen, picked: s.picked, focusOn: s.focusOn, trigger: s.trigger });

// S10 reopen: chips kept, query reset
await realClick('[data-slot="combobox-trigger"]');
s = await state();
check("S10 reopen", s.listOpen && s.options === 4 && JSON.stringify(s.picked) === '["b1","b3"]' &&
    s.chips.length === 2 && s.inputValue === "" && s.focusOn === "combobox-chip-input",
  { ...s });

const debugLeak = consoleLog.filter((t) => t.includes("cb-debug"));
check("no debug stubs", debugLeak.length === 0, { leaked: debugLeak.length });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await browser.close();
process.exitCode = failures === 0 ? 0 : 1;
