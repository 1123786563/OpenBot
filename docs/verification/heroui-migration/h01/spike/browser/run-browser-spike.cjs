const { chromium } = require("/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration/node_modules/playwright-core");

const OUT = "/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration/docs/verification/heroui-migration/h01/spike/browser";

(async () => {
  const browser = await chromium.launch({
    executablePath:
      "/Users/wuyongjun/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text()}`);
  });

  const results = {};
  const events = () => page.evaluate(() => window.__spike.events.slice());
  const active = () =>
    page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || null);
  const bodyLock = () =>
    page.evaluate(() => ({
      bodyOverflow: getComputedStyle(document.body).overflow,
      bodyStyleOverflow: document.body.style.overflow,
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      bodyPaddingRight: getComputedStyle(document.body).paddingRight,
      scrollHeight: document.documentElement.scrollHeight,
    }));

  await page.goto("http://localhost:3110/spike/heroui.html", { waitUntil: "networkidle" });
  await page.waitForSelector("text=HeroUI H01 browser spike");

  // --- token coexistence, light ---
  results.tokensLight = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const legacy = getComputedStyle(document.getElementById("legacy-primary"));
    const hero = getComputedStyle(document.getElementById("hero-primary"));
    const heroInput = getComputedStyle(document.getElementById("hero-input"));
    const legacyInput = getComputedStyle(document.getElementById("legacy-input"));
    return {
      accent: root.getPropertyValue("--accent").trim(),
      muted: root.getPropertyValue("--muted").trim(),
      primary: root.getPropertyValue("--primary").trim(),
      legacyButtonBg: legacy.backgroundColor,
      heroButtonBg: hero.backgroundColor,
      heroButtonFg: hero.color,
      legacyInputBorder: legacyInput.borderColor,
      heroInputBorder: heroInput.borderColor,
      heroInputBg: heroInput.backgroundColor,
    };
  });

  // --- modal + select inside + scroll lock + focus return ---
  results.scrollBefore = await bodyLock();
  await page.click("#open-modal");
  await page.waitForSelector('[role="dialog"]');
  results.scrollOpen = await bodyLock();
  await page.screenshot({ path: `${OUT}/modal-select-open.png` });
  await page.click("#modal-select-trigger");
  await page.waitForSelector('[role="listbox"]');
  results.selectOptions = await page.$$eval('[role="option"]', (els) =>
    els.map((e) => e.textContent?.trim()),
  );
  await page.screenshot({ path: `${OUT}/modal-select-listbox.png` });
  await page.click('[role="option"]:has-text("Alpha")');
  await page.waitForTimeout(150);
  results.selectValueAfter = await page.textContent("#modal-select-trigger");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  results.modalClosed = (await page.$('[role="dialog"]')) === null;
  results.focusAfterModal = await active();
  results.scrollAfter = await bodyLock();

  // --- nested modal ---
  await page.click("#open-outer");
  await page.click("#open-inner");
  results.nestedOpen = await page.$$eval('[role="dialog"]', (els) =>
    els.map((e) => e.getAttribute("aria-label")),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  results.afterFirstEscape = await page.$$eval('[role="dialog"]', (els) =>
    els.map((e) => e.getAttribute("aria-label")),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  results.afterSecondEscape = await page.$$eval('[role="dialog"]', (els) =>
    els.map((e) => e.getAttribute("aria-label")),
  );
  results.focusAfterNested = await active();

  // --- drawer ---
  await page.click("#open-drawer");
  await page.waitForSelector('[aria-label="Settings drawer"]');
  const drawerBox = await page.locator('[aria-label="Settings drawer"]').boundingBox();
  results.drawerBox = drawerBox;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  results.drawerClosed = (await page.$('[aria-label="Settings drawer"]')) === null;
  results.focusAfterDrawer = await active();

  // --- context menu: pointer position ---
  const targetBox = await page.locator("#ctx-target").boundingBox();
  const px = Math.round(targetBox.x + 120);
  const py = Math.round(targetBox.y + 40);
  await page.mouse.click(px, py, { button: "right" });
  await page.waitForSelector('[role="menu"]');
  results.contextMenuPointer = {
    requested: { x: px, y: py },
    menuBox: await page.locator('[role="menu"]').boundingBox(),
  };
  await page.screenshot({ path: `${OUT}/context-menu-pointer.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  results.contextMenuClosed = (await page.$('[role="menu"]')) === null;
  results.focusAfterContextMenu = await active();

  // --- context menu: Shift+F10 ---
  await page.focus("#ctx-target");
  const targetBox2 = await page.locator("#ctx-target").boundingBox();
  await page.keyboard.press("Shift+F10");
  await page.waitForSelector('[role="menu"]');
  results.contextMenuKeyboard = {
    targetBox: targetBox2,
    menuBox: await page.locator('[role="menu"]').boundingBox(),
  };
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  results.focusAfterKeyboardMenu = await active();

  // --- IME composition guard ---
  await page.focus('[data-testid="ime-input"]');
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="ime-input"]');
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }),
    );
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
  await page.waitForTimeout(100);
  results.imeEvents = (await events()).filter((e) => e.name.includes("composition") || e.name.includes("enter"));

  // --- dark: tokens + screenshot ---
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
  });
  await page.waitForTimeout(200);
  results.tokensDark = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const legacy = getComputedStyle(document.getElementById("legacy-primary"));
    const hero = getComputedStyle(document.getElementById("hero-primary"));
    return {
      bodyBg: getComputedStyle(document.body).backgroundColor,
      accent: root.getPropertyValue("--accent").trim(),
      muted: root.getPropertyValue("--muted").trim(),
      legacyButtonBg: legacy.backgroundColor,
      heroButtonBg: hero.backgroundColor,
      heroButtonFg: hero.color,
    };
  });
  await page.screenshot({ path: `${OUT}/spike-dark.png`, fullPage: true });

  results.events = await events();
  results.consoleErrors = consoleErrors;
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
})().catch((error) => {
  console.error("SPIKE_BROWSER_FAILED", error);
  process.exit(1);
});
