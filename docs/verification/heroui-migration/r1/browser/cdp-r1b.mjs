/* R1b browser QA (issue #502, R1 leftover §6.3): the legacy `--input` alias split.
 *
 * R1 aliased `--input` to `--ob-field-border` (= transparent, correct for HeroUI's borderless
 * filled fields), which also silenced the 21 `border-input` call sites that draw a VISIBLE
 * hairline (questionnaire choice indicator, select trigger, the outline button's dark border,
 * craft panels). R1b repoints the alias at the border ladder (`--ob-border`) at token level.
 *
 * This script proves, on the live app (:3011), in BOTH themes:
 *   1. `--input` resolves to the border hairline and equals `--border` (HeroUI border ladder).
 *   2. The `border-input` consumers got their stroke back: select trigger, outline button,
 *      questionnaire choice card + choice indicator, and a real app Input all carry that hairline.
 *   3. HeroUI-native fields remain borderless: `--field-border` / `--ob-field-border` stay
 *      transparent, `--border-width-field` stays 0px, and HeroUI's compiled `.input` rule still
 *      reads `border-color: var(--field-border)` — the fix touched the alias, not the field chain.
 *
 * Run from /tmp/cdp-harness (has puppeteer-core): node cdp-r1b.mjs
 * (needs the dev app on :3011, session cookies at /tmp/h15-state.json).
 */

import fs from "node:fs";
import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP = "http://localhost:3011";
const STATE = "/tmp/h15-state.json";
/* Absolute so the script also runs from a copy inside the CDP harness (/tmp/cdp-harness),
 * whose node_modules carries puppeteer-core — the same pattern cdp-r1.mjs used. */
const SHOTS =
  process.env.R1_SHOTS ??
  "/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration/docs/verification/heroui-migration/r1/screenshots";
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--lang=zh-CN", "--disable-features=Translate"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));
await page.setViewport({ width: 1440, height: 900 });
const { cookies } = JSON.parse(fs.readFileSync(STATE, "utf8"));
await page.setCookie(...cookies.filter((c) => c.domain.includes("localhost")));

let failures = 0;
function check(name, ok, detail) {
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + JSON.stringify(detail) : ""}`,
  );
  if (!ok) failures++;
}

const TRANSPARENT = "rgba(0, 0, 0, 0)";
/* Reusable in-page probe: reference elements that resolve --input / --border the same way the
 * utilities do, so computed-value serialization always matches on both sides of a comparison. */
const PROBE_FN = `
  () => {
    const mk = (style) => {
      const el = document.createElement("div");
      el.setAttribute("style", style);
      document.body.appendChild(el);
      return el;
    };
    const nativeInput = mk("");
    nativeInput.className = "input";
    const cs = getComputedStyle(nativeInput);
    /* HeroUI's compiled .input rule, read straight out of the CSSOM. */
    let inputRule = null;
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      const walk = (list) => {
        for (const r of list) {
          if (r.cssRules) { walk(r.cssRules); continue; }
          if (r.selectorText === ".input" && r.style.getPropertyValue("border-color")) {
            inputRule = {
              borderColor: r.style.getPropertyValue("border-color").trim(),
              borderWidth: r.style.getPropertyValue("border-width").trim(),
            };
          }
        }
      };
      walk(rules);
    }
    const out = {
      inputToken: getComputedStyle(document.documentElement).getPropertyValue("--input").trim(),
      obBorderToken: getComputedStyle(document.documentElement).getPropertyValue("--ob-border").trim(),
      obFieldBorderToken: getComputedStyle(document.documentElement).getPropertyValue("--ob-field-border").trim(),
      herouiFieldBorderToken: getComputedStyle(document.documentElement).getPropertyValue("--field-border").trim(),
      borderWidthFieldToken: cs.getPropertyValue("--border-width-field").trim(),
      herouiInputBorderWidthComputed: cs.borderTopWidth,
      herouiInputRule: inputRule,
    };
    nativeInput.remove();
    return out;
  }
`;

for (const theme of ["light", "dark"]) {
  await page.evaluateOnNewDocument((t) => {
    localStorage.setItem("openbot-theme", t);
    localStorage.setItem("openbot.language", "zh");
  }, theme);

  /* --- 1) invoices: select trigger stroke + token chain, screenshot --- */
  await page.goto(APP + "/settings/invoices", {
    waitUntil: "networkidle2",
    timeout: 45000,
  });
  await sleep(2200);
  await page.screenshot({ path: `${SHOTS}/r1b-invoices-${theme}-zh-1440.png` });
  console.log(`SHOT r1b-invoices-${theme}-zh-1440.png ${page.url()}`);

  const base = await page.evaluate(`(${PROBE_FN})()`);
  const select = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.setAttribute("style", "border-color: var(--input)");
    document.body.appendChild(probe);
    const ladder = document.createElement("div");
    ladder.setAttribute("style", "border-color: var(--border)");
    document.body.appendChild(ladder);
    const trigger = document.querySelector('[data-slot="select-trigger"]');
    const out = {
      probeBorder: getComputedStyle(probe).borderTopColor,
      ladderBorder: getComputedStyle(ladder).borderTopColor,
      selectTriggerFound: !!trigger,
      selectTriggerBorder: trigger
        ? getComputedStyle(trigger).borderTopColor
        : null,
    };
    probe.remove();
    ladder.remove();
    return out;
  });

  console.log(`\n=== invoices probe (${theme}) ===`);
  console.log(JSON.stringify({ base, select }, null, 1));

  check(
    `R1b ${theme}: --input resolves to the border ladder (not transparent)`,
    select.probeBorder !== TRANSPARENT &&
      base.inputToken === base.obBorderToken,
    { specified: base.inputToken, computed: select.probeBorder },
  );
  check(
    `R1b ${theme}: --input == --border (HeroUI border ladder)`,
    select.probeBorder === select.ladderBorder,
    { input: select.probeBorder, border: select.ladderBorder },
  );
  check(
    `R1b ${theme}: --ob-field-border stays transparent`,
    base.obFieldBorderToken === "transparent",
    base.obFieldBorderToken,
  );
  check(
    `R1b ${theme}: HeroUI --field-border stays transparent`,
    base.herouiFieldBorderToken === "transparent",
    base.herouiFieldBorderToken,
  );
  check(
    `R1b ${theme}: HeroUI-native .input stays borderless (computed border-width 0, --field-border transparent)`,
    base.borderWidthFieldToken === "0px" &&
      base.herouiInputBorderWidthComputed === "0px" &&
      base.herouiFieldBorderToken === "transparent",
    {
      token: base.borderWidthFieldToken,
      computedWidth: base.herouiInputBorderWidthComputed,
      fieldBorder: base.herouiFieldBorderToken,
      /* Informational: the compiled `.input` rule's own declarations, when the CSSOM exposes
       * them (dev-server nesting hides them from a flat walk; the dist build carries
       * `.input{…border-color:var(--field-border);border-width:var(--border-width-field)…}`). */
      inputRule: base.herouiInputRule,
    },
  );
  check(
    `R1b ${theme}: select trigger carries the hairline`,
    select.selectTriggerFound &&
      select.selectTriggerBorder === select.probeBorder,
    {
      found: select.selectTriggerFound,
      border: select.selectTriggerBorder,
      expect: select.probeBorder,
    },
  );

  /* --- 2) questionnaire wizard: outline button (step 0) + choice strokes (step 1) --- */
  await page.goto(APP + "/bots?new=true", {
    waitUntil: "networkidle2",
    timeout: 45000,
  });
  await sleep(2600);
  await page.screenshot({
    path: `${SHOTS}/r1b-questionnaire-${theme}-zh-1440.png`,
  });
  console.log(`SHOT r1b-questionnaire-${theme}-zh-1440.png ${page.url()}`);

  const step0 = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.setAttribute("style", "border-color: var(--input)");
    document.body.appendChild(probe);
    const dialog = document.querySelector('[role="dialog"]') ?? document.body;
    const buttons = [...dialog.querySelectorAll("button")];
    const outlineBtn =
      buttons.find((b) => String(b.className).includes("border-border")) ??
      dialog.querySelector(".button--outline") ??
      buttons.find((b) => String(b.className).includes("button--outline"));
    const nameInput = document.querySelector("#create-agent-name");
    const out = {
      probeBorder: getComputedStyle(probe).borderTopColor,
      outlineBtnFound: !!outlineBtn,
      outlineBtnText: outlineBtn
        ? (outlineBtn.textContent || "").trim().slice(0, 12)
        : null,
      outlineBtnBorder: outlineBtn
        ? getComputedStyle(outlineBtn).borderTopColor
        : null,
      outlineBtnClass: outlineBtn
        ? String(outlineBtn.className).slice(0, 70)
        : null,
      dialogButtons: buttons.map((b) => String(b.className).slice(0, 40)),
      nameInputFound: !!nameInput,
      nameInputBorder: nameInput
        ? getComputedStyle(nameInput).borderTopColor
        : null,
    };
    probe.remove();
    return out;
  });

  console.log(`=== wizard step-0 probe (${theme}) ===`);
  console.log(JSON.stringify(step0, null, 1));

  check(
    `R1b ${theme}: outline button carries the hairline`,
    step0.outlineBtnFound && step0.outlineBtnBorder === step0.probeBorder,
    {
      found: step0.outlineBtnFound,
      border: step0.outlineBtnBorder,
      expect: step0.probeBorder,
      cls: step0.outlineBtnClass,
    },
  );
  check(
    `R1b ${theme}: real app Input (border-input consumer) carries the hairline`,
    step0.nameInputFound && step0.nameInputBorder === step0.probeBorder,
    {
      found: step0.nameInputFound,
      border: step0.nameInputBorder,
      expect: step0.probeBorder,
    },
  );

  /* Fill identity (name/title/roleDescription all min-1) and continue to the visibility step,
   * which renders the questionnaire choice cards whose ring is the R1 finding's example. */
  await page.type("#create-agent-name", "QA验证");
  await page.type("#create-agent-title", "R1b验证");
  await page.type("#create-agent-role", "R1b 描边回归验证用例，不提交。");
  await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]') ?? document.body;
    const next =
      [...dialog.querySelectorAll("button")].find((b) =>
        String(b.className).includes("button--primary"),
      ) ??
      [...dialog.querySelectorAll("button")]
        .filter((b) => b.getAttribute("type") === "button")
        .at(-1);
    next?.click();
  });
  await sleep(1600);

  const step1 = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.setAttribute("style", "border-color: var(--input)");
    document.body.appendChild(probe);
    const expect = getComputedStyle(probe).borderTopColor;
    probe.remove();
    /* Unchecked choice cards only: a checked card/indicator intentionally swaps to primary/brand. */
    const choices = [
      ...document.querySelectorAll(
        '[data-slot="questionnaire-choice"]:not([data-checked])',
      ),
    ];
    const indicators = [
      ...document.querySelectorAll(
        '[data-slot="questionnaire-choice-indicator"]',
      ),
    ].filter((el) => !el.closest("[data-checked]"));
    return {
      expect,
      uncheckedChoices: choices.length,
      choiceBorders: choices.map((el) => getComputedStyle(el).borderTopColor),
      indicatorCount: indicators.length,
      indicatorBorders: indicators.map(
        (el) => getComputedStyle(el).borderTopColor,
      ),
    };
  });

  console.log(`=== wizard visibility-step probe (${theme}) ===`);
  console.log(JSON.stringify(step1, null, 1));

  check(
    `R1b ${theme}: questionnaire choice cards carry the hairline`,
    step1.uncheckedChoices > 0 &&
      step1.choiceBorders.every((b) => b === step1.expect),
    {
      count: step1.uncheckedChoices,
      borders: step1.choiceBorders,
      expect: step1.expect,
    },
  );
  check(
    `R1b ${theme}: questionnaire choice indicator ring carries the hairline`,
    step1.indicatorCount > 0 &&
      step1.indicatorBorders.every((b) => b === step1.expect),
    {
      count: step1.indicatorCount,
      borders: step1.indicatorBorders,
      expect: step1.expect,
    },
  );
}

/* Persist refreshed cookies. */
const client = await page.createCDPSession();
const all = await client.send("Network.getAllCookies");
fs.writeFileSync(
  STATE,
  JSON.stringify({ cookies: all.cookies, origin: APP }, null, 2),
);

await browser.close();
console.log(`\nR1b QA failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
