// Real-browser walkthrough for #149 / #156: the batch's paths, both languages, desktop and
// narrow widths, light and dark, driven with pointer and keyboard input.
//
//   scripts/browser-acceptance/start.sh        # in another shell; keeps the fixture running
//   bun scripts/browser-acceptance/matrix.mjs  # this script
//
// Writes run.json and screenshots under docs/acceptance/i18n-156/run (override with EVIDENCE_DIR).
// The browser is the same Chromium CI's real-browser job uses; the fixture API is the one start.sh
// runs, so no upstream is contacted and no account content is touched.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CONVERSATIONS } from "./conversations.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const APP = process.env.FIXTURE_APP_URL || "http://localhost:41849";
const API = process.env.FIXTURE_API_URL || "http://127.0.0.1:41850";
const OUT =
  process.env.EVIDENCE_DIR || join(root, "docs/acceptance/i18n-156/run");

const CATALOGS = {
  en: JSON.parse(
    readFileSync(join(root, "app/src/i18n/locales/en.json"), "utf8"),
  ),
  "zh-CN": JSON.parse(
    readFileSync(join(root, "app/src/i18n/locales/zh-CN.json"), "utf8"),
  ),
};
const PRODUCT = "OpenBot";
const LOCALE_NAME = { en: "English", "zh-CN": "简体中文" };
const OTHER = { en: "zh-CN", "zh-CN": "en" };

function say(locale, key, vars = {}) {
  const text = CATALOGS[locale][key];
  if (text === undefined) throw new Error(`catalog ${locale} lacks ${key}`);
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    name in vars ? String(vars[name]) : whole,
  );
}

const results = [];
const failures = [];
function check(cell, name, ok, detail) {
  results.push({ cell, name, ok: Boolean(ok), detail });
  if (!ok) failures.push({ cell, name, detail });
}

async function fixtureSignedIn(signedIn) {
  await fetch(`${API}/__fixture/session?signedIn=${signedIn}`, {
    redirect: "manual",
  });
}

/** One page's own audit: language, overflow, leaked ids, clipped text, unnamed controls. */
const auditFn = () => {
  /*
   * The two chevron rows on General (standing instructions, AI connection) state their answer in ItemDescription's
   * two-line clamp, and the dialog is where the whole text is read. A clamp cutting there is the design, not clipped
   * text; it is recorded as a designed summary instead of failing the audit. Only those two rows qualify: a button row
   * whose title names it (the catalog's own words in both languages; the provider name never translates), and whose
   * description carries the long fixture text.
   */
  const summaryRowTitles = new Set([
    "Standing instructions",
    "常设指令",
    "OpenAI-compatible",
  ]);
  const designedSummary = (el) => {
    if (el.getAttribute("data-slot") !== "item-description") return false;
    const row = el.closest('[data-slot="item"]');
    if (row?.tagName !== "BUTTON") return false;
    const title = row.querySelector('[data-slot="item-title"]');
    return Boolean(
      title &&
        summaryRowTitles.has(title.textContent.trim()) &&
        (el.textContent.includes(
          "Always preserve the complete evidence and explain every decision.",
        ) ||
          el.textContent.includes("acceptance-model-")),
    );
  };
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      !el.closest('[aria-hidden="true"], [inert], [data-state="closed"]')
    );
  };
  const ownText = (el) =>
    [...el.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent.trim())
      .filter(Boolean)
      .join(" ");
  const label = (el) =>
    (
      el.getAttribute("aria-label") ||
      (el.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ") ||
      el.labels?.[0]?.textContent ||
      el.textContent ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      ""
    )
      .trim()
      .replace(/\s+/g, " ");
  const nameSpaces =
    /(banner|frame|nav|relativeTime|settings|sign)\.[A-Za-z0-9_.]+/;
  const leaks = [];
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent.trim();
    if (text) texts.push(text);
    if (nameSpaces.test(text)) leaks.push(text.slice(0, 120));
  }
  for (const attr of [
    "aria-label",
    "title",
    "placeholder",
    "alt",
    "aria-description",
  ])
    for (const el of document.querySelectorAll(`[${attr}]`)) {
      const value = el.getAttribute(attr);
      if (nameSpaces.test(value)) leaks.push(`${attr}: ${value.slice(0, 120)}`);
    }
  const astryx = texts.filter((text) => /@astryx\./.test(text)).slice(0, 10);
  const clipped = [];
  const designedSummaries = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (style.display === "inline" || style.display === "contents") continue;
    // Visually hidden carriers: the skip link and Astryx's isLabelHidden field labels.
    if (el.className.toString().includes("sr-only")) continue;
    if (box.width <= 2 && /hidden|clip/.test(style.overflowX)) continue;
    if (!ownText(el) && style.textOverflow !== "ellipsis") continue;
    const clamped = style.webkitLineClamp && style.webkitLineClamp !== "none";
    if (clamped && el.scrollHeight > el.clientHeight + 1) {
      const entry = {
        slot: el.getAttribute("data-slot"),
        clamp: style.webkitLineClamp,
        textLength: el.textContent.length,
        text: label(el).slice(0, 80),
      };
      if (designedSummary(el)) designedSummaries.push(entry);
      else clipped.push({ why: `line-clamp ${entry.clamp}`, text: entry.text });
      continue;
    }
    const hidesX =
      /hidden|clip/.test(style.overflowX) || style.textOverflow === "ellipsis";
    const hidesY = /hidden|clip/.test(style.overflowY);
    const cutsX = hidesX && el.scrollWidth > el.clientWidth + 1;
    const cutsY = hidesY && el.scrollHeight > el.clientHeight + 1;
    if (cutsX || cutsY)
      clipped.push({
        why: cutsX ? "x" : "y",
        text: label(el).slice(0, 80),
        box: `${el.clientWidth}/${el.clientHeight} of ${el.scrollWidth}/${el.scrollHeight}`,
      });
  }
  const controlSelectors = [
    "button",
    "a[href]",
    "input:not([type=hidden])",
    "select",
    "textarea",
    '[role="button"]',
    '[role="combobox"]',
    '[role="switch"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="option"]',
  ];
  const unnamed = [];
  for (const el of document.querySelectorAll(controlSelectors.join(","))) {
    if (!visible(el)) continue;
    if (el.closest('[aria-hidden="true"], [inert]')) continue;
    if (!label(el))
      unnamed.push(
        `${el.tagName.toLowerCase()} ${el.className.toString().slice(0, 40)}`,
      );
  }
  const wide = [...document.querySelectorAll("body *")]
    .filter(visible)
    .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
    .slice(0, 5)
    .map((el) => `${el.tagName.toLowerCase()} ${label(el).slice(0, 50)}`);
  const regions = [
    ...document.querySelectorAll(
      '[role="region"], [role="dialog"], nav, main, [role="navigation"]',
    ),
  ]
    .filter(visible)
    .map(
      (el) =>
        `${el.getAttribute("role") || el.tagName.toLowerCase()}: ${el.getAttribute("aria-label") || label(el).slice(0, 40)}`,
    )
    .slice(0, 20);
  return {
    lang: document.documentElement.lang,
    title: document.title,
    url: location.pathname + location.search,
    overflowX:
      (document.scrollingElement?.scrollWidth ?? 0) > window.innerWidth + 1
        ? (document.scrollingElement?.scrollWidth ?? 0) - window.innerWidth
        : 0,
    wide,
    leaks: leaks.slice(0, 10),
    astryx,
    clipped,
    designedSummaries,
    unnamed,
    regions,
    dark: document.documentElement.classList.contains("dark"),
    text: document.body.innerText.replace(/\s+/g, " ").slice(0, 1200),
  };
};

async function audit(cell, label, locale, extra = {}) {
  const page = cell.page;
  const data = await page.evaluate(auditFn);
  check(
    cell.name,
    `${label}: document language`,
    data.lang === locale,
    data.lang,
  );
  check(
    cell.name,
    `${label}: title translated`,
    !/(banner|frame|nav|relativeTime|settings|sign)\.[A-Za-z]/.test(data.title),
    data.title,
  );
  check(
    cell.name,
    `${label}: no horizontal overflow`,
    data.overflowX === 0,
    data.overflowX ? `${data.overflowX}px` : "",
  );
  check(
    cell.name,
    `${label}: nothing outside the viewport`,
    data.wide.length === 0,
    data.wide.join("; "),
  );
  check(
    cell.name,
    `${label}: no message ids shown`,
    data.leaks.length === 0,
    data.leaks.join("; "),
  );
  check(
    cell.name,
    `${label}: no @astryx keys shown`,
    data.astryx.length === 0,
    data.astryx.join("; "),
  );
  check(
    cell.name,
    `${label}: no clipped text`,
    data.clipped.length === 0,
    data.clipped.map((c) => `${c.why} ${c.text}`).join(" | "),
  );
  if (data.designedSummaries.length)
    cell.notes.push({ [`${label} designedSummaries`]: data.designedSummaries });
  check(
    cell.name,
    `${label}: every control named`,
    data.unnamed.length === 0,
    data.unnamed.join("; "),
  );
  check(
    cell.name,
    `${label}: appearance is ${cell.scheme}`,
    data.dark === (cell.scheme === "dark"),
    data.dark ? "dark" : "light",
  );
  return { ...data, ...extra };
}

async function axAudit(cell, label) {
  const session = await cell.context.newCDPSession(cell.page);
  const { nodes } = await session.send("Accessibility.getFullAXTree");
  await session.detach();
  const interactive = new Set([
    "button",
    "link",
    "textbox",
    "combobox",
    "switch",
    "menuitem",
    "tab",
    "checkbox",
    "radio",
    "slider",
    "spinbutton",
    "searchbox",
    "option",
  ]);
  const named = [];
  const blank = [];
  const texts = [];
  let rootName = "";
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = node.role?.value || "";
    const name = (node.name?.value || "").trim();
    if (role === "RootWebArea") rootName = name;
    if (interactive.has(role)) {
      if (name) named.push(`${role}: ${name}`);
      else blank.push(role);
    }
    if (["heading", "paragraph", "StaticText", "text"].includes(role) && name)
      texts.push(name);
  }
  // Chromium's tree carries no lang property, so the document language is asserted from the DOM
  // above; the tree itself is asked to prove the translated title and control names arrive.
  check(
    cell.name,
    `${label}: AX root carries the translated title`,
    rootName === (await cell.page.title()),
    `${rootName} vs ${await cell.page.title()}`,
  );
  check(
    cell.name,
    `${label}: AX names present`,
    blank.length === 0,
    blank.join("; "),
  );
  check(
    cell.name,
    `${label}: AX names carry no message ids`,
    named.every(
      (entry) =>
        !/(banner|frame|nav|relativeTime|settings|sign)\.[A-Za-z]/.test(entry),
    ),
    named
      .filter((entry) =>
        /(banner|frame|nav|relativeTime|settings|sign)\.[A-Za-z]/.test(entry),
      )
      .join("; "),
  );
  return {
    rootName,
    named: named.slice(0, 60),
    blank,
    texts: texts.slice(0, 80),
  };
}

async function shot(cell, label) {
  const file = join(
    OUT,
    "screenshots",
    `${cell.name}-${label}.png`.replace(/[^a-z0-9.-]+/gi, "-").toLowerCase(),
  );
  await cell.page.screenshot({ path: file, fullPage: true });
  return file;
}

/** The selector's own refocus runs after the locale update; give it a few frames before judging. */
async function selectorKeepsFocus(cell, selector) {
  try {
    await cell.page.waitForFunction(
      () =>
        document.activeElement?.matches?.(
          'button[role="combobox"]:not([data-slot="select-trigger"])',
        ) === true,
      null,
      { timeout: 5000 },
    );
    return await selector.evaluate((el) => el === document.activeElement);
  } catch {
    const where = await cell.page.evaluate(() => {
      const el = document.activeElement;
      return el
        ? `${el.tagName.toLowerCase()} ${el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 40) || ""}`
        : "nothing";
    });
    check(cell.name, "language: focus after switch", false, where);
    return false;
  }
}

async function tabOrder(cell, label, count) {
  const order = [];
  for (let i = 0; i < count; i += 1) {
    await cell.page.keyboard.press("Tab");
    order.push(
      await cell.page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "document";
        if (el.tagName === "STYLE" || el.tagName === "SCRIPT")
          return `${el.tagName.toLowerCase()}`;
        const name = (
          el.getAttribute("aria-label") ||
          (el.getAttribute("aria-labelledby") || "")
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent || "")
            .join(" ") ||
          el.labels?.[0]?.textContent ||
          el.textContent ||
          el.getAttribute("placeholder") ||
          ""
        )
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 60);
        return `${el.getAttribute("role") || el.tagName.toLowerCase()}: ${name}`;
      }),
    );
  }
  check(
    cell.name,
    `${label}: keyboard reaches ${count} controls`,
    order.every((entry) => !entry.endsWith(": ") && entry !== "none"),
    order.join(" | "),
  );
  return order;
}

async function cellRun(browser, locale, width, scheme) {
  const context = await browser.newContext({
    viewport: { width, height: 800 },
    colorScheme: scheme,
    locale: locale === "zh-CN" ? "zh-CN" : "en-US",
    reducedMotion: "reduce",
  });
  await context.addInitScript(
    ({ locale, scheme }) => {
      localStorage.setItem("openbot-locale", locale);
      localStorage.setItem("openbot-theme", scheme);
    },
    { locale, scheme },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const cell = {
    name: `${locale}-${width}-${scheme}`,
    page,
    context,
    scheme,
    width,
    locale,
    shots: [],
    notes: [],
  };
  try {
    await fixtureSignedIn(false);

    // Sign-in page, first frame in the chosen language.
    await page.goto(`${APP}/sign`);
    await page
      .getByRole("heading", {
        name: say(locale, "sign.heading", { product: PRODUCT }),
      })
      .waitFor();
    check(cell.name, "sign: heading translated", true, "");
    for (const provider of ["Google", "Microsoft", "Okta"])
      check(
        cell.name,
        `sign: ${provider} button translated`,
        await page
          .getByRole("button", {
            name: say(locale, "sign.provider.continue", { provider }),
          })
          .isVisible(),
        "",
      );
    const email = page.getByRole("textbox", {
      name: new RegExp(say(locale, "sign.sso.label"), "i"),
    });
    check(
      cell.name,
      "sign: company email field translated",
      await email.isVisible(),
      "",
    );
    const emailLabel = await page
      .locator("label")
      .filter({ hasText: say(locale, "sign.sso.label") })
      .first()
      .innerText();
    check(
      cell.name,
      "sign: required marker translated",
      locale === "zh-CN"
        ? /必填/.test(emailLabel)
        : /Required/.test(emailLabel),
      emailLabel,
    );
    const submit = page.getByRole("button", {
      name: say(locale, "sign.sso.continue"),
    });
    check(
      cell.name,
      "sign: company submit disabled until typed",
      await submit.isDisabled(),
      "",
    );
    await email.fill("person@company.test");
    check(
      cell.name,
      "sign: company submit enabled after typing",
      await submit.isEnabled(),
      "",
    );
    check(
      cell.name,
      "sign: or separator translated",
      await page
        .getByText(say(locale, "sign.sso.or"), { exact: true })
        .isVisible(),
      "",
    );
    check(
      cell.name,
      "sign: email guidance translated",
      await page.getByText(say(locale, "sign.sso.description")).isVisible(),
      "",
    );
    const signAudit = await audit(cell, "sign", locale);
    await axAudit(cell, "sign");
    cell.shots.push(await shot(cell, "sign"));
    cell.notes.push({
      signTabOrder: await tabOrder(cell, "sign", 6),
      signText: signAudit.text,
    });

    // Sign in through the fixture provider; the app lands on General settings.
    await page
      .getByRole("button", {
        name: say(locale, "sign.provider.continue", { provider: "Google" }),
      })
      .click();
    await page.waitForURL("**/settings", { timeout: 30000 });
    await page
      .getByRole("heading", { level: 1, name: say(locale, "settings.title") })
      .waitFor();

    // General settings: sections, rows, the long desktop fixture, and the settings sidebar.
    for (const key of [
      "settings.aboutYou",
      "settings.appearance",
      "settings.shortcuts",
    ])
      check(
        cell.name,
        `settings: ${key} section link`,
        await page
          .getByRole("link", { name: say(locale, key) })
          .first()
          .isVisible(),
        "",
      );
    if (width > 400) {
      for (const key of [
        "settings.sidebar.notifications",
        "settings.sidebar.learning",
        "settings.sidebar.browsers",
        "settings.sidebar.setup",
        "settings.sidebar.componentsGallery",
      ])
        check(
          cell.name,
          `settings: ${key} sidebar link translated`,
          await page
            .getByRole("link", { name: new RegExp(say(locale, key)) })
            .first()
            .isVisible(),
          "",
        );
    }
    const instructionsButton = page.getByRole("button", {
      name: new RegExp(`^${say(locale, "settings.instructions")}`),
    });
    check(
      cell.name,
      "settings: standing instructions row",
      await instructionsButton.isVisible(),
      "",
    );
    const longInstruction =
      "Always preserve the complete evidence and explain every decision.";
    // The house settings row: a two-line summary on the row, and the whole text in the dialog it opens.
    const summaryShape = (el) => ({
      clamp: getComputedStyle(el).webkitLineClamp,
      sh: el.scrollHeight,
      ch: el.clientHeight,
      sw: el.scrollWidth,
      cw: el.clientWidth,
    });
    const isTwoLineSummary = (box) =>
      box.clamp === "2" && box.sh > box.ch + 1 && box.sw <= box.cw + 1;
    const preview = page
      .locator('[data-slot="item-description"]')
      .filter({ hasText: longInstruction })
      .first();
    const previewBox = await preview.evaluate(summaryShape);
    check(
      cell.name,
      "settings: standing instructions row is a two-line summary",
      isTwoLineSummary(previewBox),
      `${JSON.stringify(previewBox)}; the dialog's whole text: "dialog: instructions editor holds the full text"`,
    );
    const aiButton = page.getByRole("button", {
      name: new RegExp(
        `^${say(locale, "settings.ai.title")}|OpenAI-compatible`,
      ),
    });
    check(
      cell.name,
      "settings: AI model row",
      await aiButton.first().isVisible(),
      "",
    );
    const aiSummary = page
      .locator('[data-slot="item-description"]')
      .filter({ hasText: "acceptance-model-" })
      .first();
    const aiBox = await aiSummary.evaluate(summaryShape);
    // The model the row's summary carries, held whole in the element although only two lines show.
    const rowModel = (await aiSummary.textContent()).match(
      /acceptance-model-\S+/,
    )?.[0];
    check(
      cell.name,
      "settings: AI model row is a two-line summary",
      (await aiSummary.isVisible()) && isTwoLineSummary(aiBox),
      `${JSON.stringify(aiBox)}; the dialog's whole model and address: "dialog: AI model shows in full", "dialog: AI address wraps"`,
    );
    const privacy = page.getByRole("switch", {
      name: say(locale, "settings.privacy.share"),
    });
    check(
      cell.name,
      "settings: privacy switch translated",
      await privacy.isVisible(),
      "",
    );
    const language = page.getByRole("combobox", {
      name: say(locale, "settings.language.title"),
    });
    check(
      cell.name,
      "settings: language selector translated",
      (await language.isVisible()) &&
        (await language.innerText()).includes(LOCALE_NAME[locale]),
      await language.innerText(),
    );
    // The one combobox without the shadcn select trigger slot: its accessible name changes with the
    // language, so later focus checks locate it by shape instead of by name.
    const languageBox = page
      .locator('button[role="combobox"]:not([data-slot="select-trigger"])')
      .first();
    const messageList = page.getByRole("combobox", {
      name: say(locale, "settings.messageList.title"),
    });
    check(
      cell.name,
      "settings: message list selector translated",
      await messageList.isVisible(),
      "",
    );
    const settingsAudit = await audit(cell, "settings", locale);
    await axAudit(cell, "settings");
    cell.shots.push(await shot(cell, "settings"));
    cell.notes.push({ settingsText: settingsAudit.text });

    // Name dialog: pointer open, translated shell, Escape closes and returns focus.
    const nameRow = page.getByRole("button", {
      name: new RegExp(`^${say(locale, "settings.name")}`),
    });
    await nameRow.click();
    const nameDialog = page.getByRole("dialog", {
      name: say(locale, "settings.name.dialogTitle"),
    });
    await nameDialog.waitFor();
    check(cell.name, "dialog: name title translated", true, "");
    check(
      cell.name,
      "dialog: close control translated",
      await nameDialog
        .getByRole("button", { name: say(locale, "frame.close") })
        .first()
        .isVisible(),
      "",
    );
    check(
      cell.name,
      "dialog: name cancel translated",
      await nameDialog
        .getByRole("button", { name: say(locale, "frame.cancel") })
        .isVisible(),
      "",
    );
    check(
      cell.name,
      "dialog: name save translated",
      await nameDialog
        .getByRole("button", { name: say(locale, "settings.name.save") })
        .isVisible(),
      "",
    );
    await page.keyboard.press("Escape");
    await nameDialog.waitFor({ state: "hidden" });
    check(
      cell.name,
      "dialog: Escape returns focus to the row",
      await nameRow.evaluate(
        (el) =>
          el === document.activeElement || el.contains(document.activeElement),
      ),
      "",
    );
    await axAudit(cell, "after first dialog");

    // Standing instructions: full text in the editor, count translated, dirty Escape guard.
    await instructionsButton.focus();
    await page.keyboard.press("Enter");
    const instructionsDialog = page.getByRole("dialog", {
      name: say(locale, "settings.instructions"),
    });
    await instructionsDialog.waitFor();
    const editor = instructionsDialog.getByRole("textbox");
    const value = await editor.inputValue();
    check(
      cell.name,
      "dialog: instructions editor holds the full text",
      value.includes(longInstruction) && value.length > 3000,
      String(value.length),
    );
    const counter = instructionsDialog.getByText(
      locale === "zh-CN" ? /已用/ : /of .+ characters/,
    );
    check(
      cell.name,
      "dialog: character count translated",
      await counter.first().isVisible(),
      "",
    );
    await editor.fill(`${value}\nOne more line.`);
    await page.keyboard.press("Escape");
    const discard = page.getByRole("alertdialog", {
      name: say(locale, "frame.draft.discardTitle"),
    });
    await discard.waitFor();
    check(cell.name, "dialog: unsaved-changes guard translated", true, "");
    check(
      cell.name,
      "dialog: keep-editing translated",
      await discard
        .getByRole("button", { name: say(locale, "frame.draft.keepEditing") })
        .isVisible(),
      "",
    );
    await discard
      .getByRole("button", { name: say(locale, "frame.draft.keepEditing") })
      .click();
    check(
      cell.name,
      "dialog: keep editing keeps the editor",
      await instructionsDialog.isVisible(),
      "",
    );
    await instructionsDialog
      .getByRole("button", { name: say(locale, "frame.close") })
      .first()
      .click();
    await discard.waitFor();
    await discard
      .getByRole("button", { name: say(locale, "frame.draft.discard") })
      .click();
    await instructionsDialog.waitFor({ state: "hidden" });
    check(cell.name, "dialog: discard closes the editor", true, "");

    // Save path: the action labels, the saved status, and the row after a real save.
    await instructionsButton.focus();
    await page.keyboard.press("Enter");
    await instructionsDialog.waitFor();
    const saveEditor = instructionsDialog.getByRole("textbox");
    // Replace the previous run's marker so a shared fixture never grows past the limit.
    const base = (await saveEditor.inputValue()).replace(/\nSaved [^\n]*$/, "");
    const marker = `Saved ${Date.now()}.`;
    await saveEditor.fill(`${base}\n${marker}`);
    const saveAction = instructionsDialog.getByRole("button", {
      name: say(locale, "settings.instructions.save"),
    });
    check(
      cell.name,
      "dialog: instructions save translated",
      await saveAction.isVisible(),
      "",
    );
    check(
      cell.name,
      "dialog: instructions cancel translated",
      await instructionsDialog
        .getByRole("button", { name: say(locale, "frame.cancel") })
        .isVisible(),
      "",
    );
    await saveAction.click();
    const saved = instructionsDialog
      .getByRole("status")
      .filter({ hasText: say(locale, "settings.instructions.saved") });
    await saved.waitFor();
    check(cell.name, "dialog: saved status translated", true, "");
    await instructionsDialog
      .getByRole("button", { name: say(locale, "frame.close") })
      .first()
      .click();
    await instructionsDialog.waitFor({ state: "hidden" });
    check(
      cell.name,
      "dialog: a saved draft closes without the guard",
      await discard.isHidden(),
      "",
    );
    const savedRow = page.getByText(marker).first();
    await savedRow.waitFor({ timeout: 5000 }).catch(() => {});
    check(
      cell.name,
      "settings: the saved instructions reach the row",
      await savedRow.isVisible(),
      "",
    );
    cell.shots.push(await shot(cell, "after-dialogs"));

    // AI dialog: the long fixture address wraps, labels translated.
    await aiButton.first().click();
    const aiDialog = page.getByRole("dialog", {
      name: say(locale, "settings.ai.dialogTitle"),
    });
    await aiDialog.waitFor();
    check(
      cell.name,
      "dialog: AI model label translated",
      await aiDialog
        .getByText(say(locale, "settings.ai.detailModel"), { exact: true })
        .isVisible(),
      "",
    );
    check(
      cell.name,
      "dialog: AI address label translated",
      await aiDialog
        .getByText(say(locale, "settings.ai.detailAddress"), { exact: true })
        .isVisible(),
      "",
    );
    const address = aiDialog.getByText(/acceptance\.example\.test/).first();
    const addressBox = await address.evaluate((el) => ({
      sw: el.scrollWidth,
      cw: el.clientWidth,
    }));
    check(
      cell.name,
      "dialog: AI address wraps",
      (await address.isVisible()) && addressBox.sw <= addressBox.cw + 1,
      JSON.stringify(addressBox),
    );
    const model = aiDialog.getByText(/^acceptance-model-/).first();
    const modelBox = await model.evaluate(summaryShape);
    check(
      cell.name,
      "dialog: AI model shows in full",
      (await model.isVisible()) &&
        modelBox.sw <= modelBox.cw + 1 &&
        modelBox.sh <= modelBox.ch + 1 &&
        (await model.textContent()) === rowModel,
      JSON.stringify(modelBox),
    );
    await page.keyboard.press("Escape");
    await aiDialog.waitFor({ state: "hidden" });

    // Language switching: keyboard to the other catalog, pointer back. Focus stays on the selector.
    await languageBox.focus();
    await page.keyboard.press("Enter");
    // English sits above Simplified Chinese in the list; one arrow step toward the other language.
    await page.keyboard.press(locale === "en" ? "ArrowDown" : "ArrowUp");
    await page.keyboard.press("Enter");
    const other = OTHER[locale];
    await page.waitForFunction(
      (expected) => document.documentElement.lang === expected,
      other,
      { timeout: 30000 },
    );
    check(cell.name, `language: keyboard switch reaches ${other}`, true, "");
    check(
      cell.name,
      "language: focus stays on the selector after keyboard switch",
      await selectorKeepsFocus(cell, languageBox),
      "",
    );
    check(
      cell.name,
      `language: title follows to ${other}`,
      (await page.title()).includes(say(other, "settings.title")),
      await page.title(),
    );
    const afterSwitch = await audit(cell, "switched", other);
    cell.shots.push(await shot(cell, "switched"));
    const languageOther = page.getByRole("combobox", {
      name: say(other, "settings.language.title"),
    });
    await languageOther.click();
    await page.getByRole("option", { name: LOCALE_NAME[locale] }).click();
    await page.waitForFunction(
      (expected) => document.documentElement.lang === expected,
      locale,
      { timeout: 30000 },
    );
    check(cell.name, "language: pointer switch back", true, "");
    check(
      cell.name,
      "language: focus stays on the selector after pointer switch",
      await selectorKeepsFocus(cell, languageBox),
      "",
    );
    check(cell.name, "language: document language restored", true, "");
    cell.notes.push({ switchedText: afterSwitch.text });

    // Home: the app sidebar's destinations and the account menu, with the keyboard. At a narrow
    // width the sidebar starts closed behind the navigation toggle.
    await page.goto(`${APP}/`);
    if (width <= 400) {
      const openNav = page.getByRole("button", {
        name: say(locale, "nav.openNavigation"),
      });
      await openNav.waitFor();
      await openNav.click();
    }
    await page
      .getByRole("navigation", {
        name: locale === "zh-CN" ? "工作区" : "Workspace",
      })
      .waitFor();
    if (width <= 400) {
      check(
        cell.name,
        "narrow: navigation sheet close translated",
        await page
          .getByRole("button", { name: say(locale, "frame.close") })
          .first()
          .isVisible(),
        "",
      );
      check(
        cell.name,
        "narrow: navigation toggle now says close",
        await page
          .getByRole("button", { name: say(locale, "nav.closeNavigation") })
          .isVisible(),
        "",
      );
    }
    const destinations = await page.evaluate(() =>
      [...document.querySelectorAll('nav a[href], [role="navigation"] a[href]')]
        .filter((el) => el.closest('nav, [role="navigation"]'))
        .map((el) => ({
          text: el.textContent.trim().replace(/\d+$/, ""),
          href: el.getAttribute("href"),
        })),
    );
    const navNames = {
      "/bots": "nav.bots",
      "/routines": "nav.routines",
      "/responsibilities": "nav.goals",
      "/capabilities": "nav.capabilities",
      "/billing": "nav.credits",
      "/connections": "nav.connections",
      "/admin": "nav.admin",
      "/settings": "nav.settings",
    };
    const navProblems = destinations.filter((entry) => {
      const key = navNames[entry.href];
      return (
        key &&
        entry.text !== say(locale, key) &&
        !entry.text.startsWith(say(locale, key))
      );
    });
    check(
      cell.name,
      "nav: every destination translated",
      destinations.length > 0 && navProblems.length === 0,
      JSON.stringify(navProblems.length ? navProblems : destinations),
    );
    check(
      cell.name,
      "nav: Credits destination present",
      destinations.some((entry) => entry.href === "/billing"),
      "",
    );

    // The roster: the fixture's conversations, drawn at 1280 in the sidebar and at 360 in the navigation sheet this
    // cell has open. A row says its time the way the sidebar says it: the short relative time, "Working" while a Bot
    // works on it, nothing for a conversation nobody has used. The page audit below covers these rows like every other.
    await page
      .locator('a[href^="/channel/"]:not([href="/channel/new"])')
      .first()
      .waitFor();
    // At 360 the rows are in the navigation sheet, which takes about 300ms to arrive; measure it settled.
    if (width <= 400)
      await page
        .getByRole("dialog", { name: say(locale, "nav.navigation") })
        .evaluate((sheet) =>
          Promise.all(
            sheet
              .getAnimations()
              .map((animation) => animation.finished.catch(() => {})),
          ),
        );
    const roster = await page.evaluate(() => {
      // The header's New conversation button is a /channel/ link too; a roster row is not that one.
      const rows = document.querySelectorAll(
        'a[href^="/channel/"]:not([href="/channel/new"]), a[href^="/group/"]',
      );
      return [...rows].map((row) => {
        const time = row.querySelector("span.whitespace-nowrap");
        const box = time?.getBoundingClientRect();
        return {
          id: row.getAttribute("href").split("/").pop(),
          text: time?.textContent ?? null,
          width: box?.width ?? 0,
          sw: time?.scrollWidth ?? 0,
          cw: time?.clientWidth ?? 0,
          sh: time?.scrollHeight ?? 0,
          ch: time?.clientHeight ?? 0,
          // The time ends the row's first line: it must stay inside the row and the window.
          right: box?.right ?? 0,
          rowRight: row.getBoundingClientRect().right,
          windowWidth: window.innerWidth,
          clamp: time ? getComputedStyle(time).webkitLineClamp : null,
        };
      });
    });
    const rowFor = (seed) => roster.find((row) => row.id === seed.id);
    const expectedTime = (seed) =>
      seed.work
        ? say(locale, "nav.working")
        : seed.agoMs === null
          ? ""
          : seed.now
            ? say(locale, "relativeTime.now")
            : seed.time[locale];
    const absent = CONVERSATIONS.filter((seed) => !rowFor(seed)).map(
      (seed) => seed.id,
    );
    check(
      cell.name,
      "sidebar: the fixture's conversations are drawn",
      absent.length === 0 && roster.length >= 3,
      `${roster.length} rows${absent.length ? `, absent: ${absent.join(", ")}` : ""}`,
    );
    const read = CONVERSATIONS.map(
      (seed) => `${seed.id}=${JSON.stringify(rowFor(seed)?.text)}`,
    );
    check(
      cell.name,
      "sidebar: each conversation says its time in the interface language",
      CONVERSATIONS.every((seed) => rowFor(seed)?.text === expectedTime(seed)),
      read.join(" | "),
    );
    // A row with a time must have been laid out and show all of it, inside its row and the window; a row with no
    // time (a conversation nobody has used) has nothing to cut.
    const cut = roster.filter(
      (row) =>
        row.text &&
        (row.width <= 0 ||
          row.sw > row.cw + 1 ||
          row.sh > row.ch + 1 ||
          row.right > Math.min(row.rowRight, row.windowWidth) + 1 ||
          (row.clamp && row.clamp !== "none")),
    );
    check(
      cell.name,
      "sidebar: no conversation time is cut off",
      cut.length === 0,
      JSON.stringify(cut),
    );
    cell.shots.push(await shot(cell, "sidebar"));

    await audit(cell, "home", locale);
    cell.shots.push(await shot(cell, "home"));

    const account = page
      .getByRole("button", { name: /Acceptance Tester/ })
      .first();
    if (!(await account.isVisible())) {
      // At a narrow width the sidebar starts as a sheet; open it before asking for the account row.
      const navTrigger = page
        .getByRole("button", {
          name: new RegExp(say(locale, "nav.toggleSidebar")),
        })
        .first();
      if (await navTrigger.isVisible()) {
        await navTrigger.click();
        await page
          .getByRole("navigation", { name: say(locale, "nav.navigation") })
          .waitFor()
          .catch(() => {});
      }
    }
    if (await account.isVisible()) {
      await account.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu");
      await menu.waitFor();
      const signOutItem = page.getByRole("menuitem", {
        name: say(locale, "nav.signOut"),
      });
      check(
        cell.name,
        "account: sign out item translated",
        await signOutItem.isVisible(),
        "",
      );
      check(
        cell.name,
        "account: settings item translated",
        await page
          .getByRole("menuitem", { name: say(locale, "nav.settings") })
          .isVisible(),
        "",
      );
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
      check(
        cell.name,
        "account: Escape closes the menu and keeps focus",
        await account.evaluate(
          (el) =>
            el === document.activeElement ||
            el.contains(document.activeElement),
        ),
        "",
      );
    } else {
      check(
        cell.name,
        "account: menu trigger reachable",
        false,
        "trigger not visible on home",
      );
    }
    await axAudit(cell, "home");

    // At a narrow width the settings sidebar also starts as a sheet. Its close control is hidden on
    // mobile, so the check follows the translated Show Sidebar trigger, sheet shell, links and Escape.
    if (width <= 400) {
      await page.goto(`${APP}/settings`);
      await page
        .getByRole("heading", { level: 1, name: say(locale, "settings.title") })
        .waitFor();
      const trigger = page
        .getByRole("button", { name: say(locale, "nav.showSidebar") })
        .first();
      check(
        cell.name,
        "narrow: settings navigation trigger translated",
        await trigger.isVisible(),
        "",
      );
      await trigger.click();
      const sheet = page.getByRole("dialog", {
        name: say(locale, "nav.sidebar"),
      });
      await sheet.waitFor();
      check(cell.name, "narrow: settings sheet title translated", true, "");
      check(
        cell.name,
        "narrow: settings sheet description translated",
        (await sheet
          .getByText(say(locale, "nav.sidebarMobileDescription"))
          .count()) > 0,
        "Screen-reader-only description; its AX name is checked below",
      );
      const sheetText = await sheet.innerText();
      for (const key of [
        "settings.sidebar.notifications",
        "settings.sidebar.learning",
        "settings.sidebar.browsers",
        "settings.sidebar.setup",
        "settings.sidebar.componentsGallery",
      ])
        check(
          cell.name,
          `narrow: ${key} sheet link translated`,
          sheetText.includes(say(locale, key)),
          "",
        );
      await audit(cell, "narrow sheet", locale);
      const narrowAx = await axAudit(cell, "narrow sheet");
      check(
        cell.name,
        "narrow: settings sheet description in the accessibility tree",
        narrowAx.texts.includes(say(locale, "nav.sidebarMobileDescription")),
        "",
      );
      cell.shots.push(await shot(cell, "narrow-sheet"));
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "hidden" });
      check(
        cell.name,
        "narrow: Escape closes the sheet and returns focus",
        await trigger.evaluate(
          (el) =>
            el === document.activeElement ||
            el.contains(document.activeElement),
        ),
        "",
      );
    }

    // The recovery screen keeps its words, its description and its primary action in the interface
    // language. A hard load has no client-side history, so this variant offers the workspace link;
    // an in-app history would offer Go back instead, and both are asserted when either appears.
    await page.goto(`${APP}/no-such-page`);
    await page
      .getByRole("heading", { name: say(locale, "frame.pageNotFound") })
      .waitFor();
    check(cell.name, "recovery: page-not-found translated", true, "");
    check(
      cell.name,
      "recovery: description translated",
      await page
        .getByText(
          locale === "zh-CN" ? /请检查下方地址/ : /Check the address below/,
        )
        .first()
        .isVisible(),
      "",
    );
    const back = page.getByRole("button", {
      name: say(locale, "frame.goBack"),
    });
    const workspaceLink = page.getByRole("link", {
      name: say(locale, "frame.openWorkspace"),
    });
    const usesBack = await back.isVisible().catch(() => false);
    const primary = usesBack ? back : workspaceLink;
    check(
      cell.name,
      "recovery: primary action translated",
      await primary.isVisible(),
      usesBack ? "go back" : "open workspace",
    );
    await audit(cell, "recovery", locale);
    await axAudit(cell, "recovery");
    await primary.click();
    await page
      .waitForFunction(() => location.pathname !== "/no-such-page", null, {
        timeout: 30000,
      })
      .catch(() => {});
    check(
      cell.name,
      "recovery: primary action leaves the recovery screen",
      !page.url().includes("no-such-page"),
      page.url(),
    );
    cell.notes.push({ recoveryVariant: usesBack ? "back" : "workspace" });
    cell.shots.push(await shot(cell, "recovery"));
  } catch (error) {
    check(
      cell.name,
      "cell completed",
      false,
      String(error?.message ? error.message : error),
    );
  } finally {
    await context.close();
  }
  return cell;
}

/** First visit with a browser language and no stored choice follows the browser like the spec says. */
async function browserLanguageCases(browser) {
  for (const [browserLocale, expected, name] of [
    ["zh-CN", "zh-CN", "browser-zh-CN-first-visit"],
    ["zh-TW", "en", "browser-zh-TW-falls-back-to-english"],
  ]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: browserLocale,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    try {
      await fixtureSignedIn(false);
      await page.goto(`${APP}/sign`);
      await page
        .getByRole("heading", {
          name: say(expected, "sign.heading", { product: PRODUCT }),
        })
        .waitFor();
      check(
        name,
        "first visit follows the browser language",
        (await page.evaluate(() => document.documentElement.lang)) === expected,
        "",
      );
    } catch (error) {
      check(
        name,
        "first visit follows the browser language",
        false,
        String(error.message || error),
      );
    } finally {
      await context.close();
    }
  }
}

/** Missing translation falls back to English in the real page, then is restored. */
async function missingKeyCase(browser) {
  const localeFile = join(root, "app/src/i18n/locales/zh-CN.json");
  const original = readFileSync(localeFile, "utf8");
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "zh-CN",
  });
  await context.addInitScript(() =>
    localStorage.setItem("openbot-locale", "zh-CN"),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  try {
    const catalog = JSON.parse(original);
    delete catalog["settings.darkTheme"];
    writeFileSync(localeFile, `${JSON.stringify(catalog, null, 2)}\n`);
    await fixtureSignedIn(true);
    await page.goto(`${APP}/settings`);
    await page
      .getByRole("heading", { level: 1, name: say("zh-CN", "settings.title") })
      .waitFor();
    const english = page.getByText(say("en", "settings.darkTheme"), {
      exact: true,
    });
    await english.first().waitFor();
    check("fallback", "missing key shows the English source", true, "");
    const neighbour = page.getByText(say("zh-CN", "settings.appearance"), {
      exact: true,
    });
    check(
      "fallback",
      "neighbouring copy stays Chinese",
      await neighbour.first().isVisible(),
      "",
    );
    const body = await page.evaluate(() => document.body.innerText);
    check(
      "fallback",
      "missing key shows no message id",
      !/settings\.darkTheme/.test(body),
      "",
    );
  } catch (error) {
    check(
      "fallback",
      "missing key shows the English source",
      false,
      String(error.message || error),
    );
  } finally {
    writeFileSync(localeFile, original);
    await context.close();
  }
  const restored = readFileSync(localeFile, "utf8");
  check(
    "fallback",
    "catalog restored byte for byte",
    restored === original,
    "",
  );
}

const schemeWidths = [
  [1280, "light"],
  [1280, "dark"],
  [360, "light"],
  [360, "dark"],
];

/** One Chromium per unit of work: a crash costs one cell, not the rest of the matrix. */
async function withBrowser(run) {
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    return await run(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

mkdirSync(join(OUT, "screenshots"), { recursive: true });
const only = (process.env.CELLS || "").split(",").filter(Boolean);
const extrasOnly = process.env.ONLY_EXTRAS === "1";
const cells = [];
function savePartial() {
  const summary = {
    ranAt: new Date().toISOString(),
    app: APP,
    api: API,
    checks: results.length,
    failing: failures.length,
    cells,
    results,
    failures,
  };
  writeFileSync(join(OUT, "run.json"), `${JSON.stringify(summary, null, 2)}\n`);
}
function clearCell(name) {
  for (let i = results.length - 1; i >= 0; i -= 1)
    if (results[i].cell === name) results.splice(i, 1);
  for (let i = failures.length - 1; i >= 0; i -= 1)
    if (failures[i].cell === name) failures.splice(i, 1);
}
try {
  for (const locale of ["en", "zh-CN"])
    for (const [width, scheme] of schemeWidths) {
      const name = `${locale}-${width}-${scheme}`;
      if (extrasOnly || (only.length && !only.includes(name))) continue;
      let attempt = 0;
      let complete = false;
      while (!complete && attempt < 2) {
        attempt += 1;
        clearCell(name);
        const cell = await withBrowser((browser) =>
          cellRun(browser, locale, width, scheme),
        ).catch((error) => {
          check(name, "cell completed", false, String(error?.message || error));
          return null;
        });
        complete = !failures.some(
          (f) => f.cell === name && f.name === "cell completed",
        );
        if (complete && cell)
          cells.push({ name: cell.name, shots: cell.shots, notes: cell.notes });
      }
      console.log(
        `cell ${name} (attempt ${attempt}): ${failures.filter((f) => f.cell === name).length} failing checks`,
      );
      savePartial();
    }
  if (!only.length || extrasOnly) {
    await withBrowser((browser) => browserLanguageCases(browser)).catch(
      (error) =>
        check(
          "browser-language",
          "cases completed",
          false,
          String(error?.message || error),
        ),
    );
    await withBrowser((browser) => missingKeyCase(browser)).catch((error) =>
      check(
        "fallback",
        "case completed",
        false,
        String(error?.message || error),
      ),
    );
  }
} finally {
  savePartial();
}

const failedNames = [
  ...new Set(results.filter((r) => !r.ok).map((r) => r.cell)),
];
console.log(
  `checks ${results.length}, failing ${failures.length}${failedNames.length ? ` (${failedNames.join(", ")})` : ""}`,
);
if (failures.length) {
  for (const failure of failures)
    console.log(`FAIL ${failure.cell} :: ${failure.name} :: ${failure.detail}`);
  process.exitCode = 1;
}
