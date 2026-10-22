const { chromium } = require("playwright-core");

// Screenshots land next to this script, wherever the checkout lives.
const OUT = __dirname;

// PLAYWRIGHT_CHROMIUM wins, then the version playwright-core itself manages, then the path this
// script was originally recorded against.
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM ??
  chromium.executablePath() ??
  "/Users/wuyongjun/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

(async () => {
  const browser = await chromium.launch({
    executablePath,
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));

  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/capabilities")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          authProviders: ["google", "microsoft"],
          ssoConfigured: false,
          ssoRequired: false,
        }),
      });
    }
    if (url.includes("/api/me")) {
      return route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  async function shot(theme, lang) {
    await page.addInitScript(
      ([t, l]) => {
        try {
          localStorage.setItem("openbot-theme", t);
          localStorage.setItem("openbot.language", l);
        } catch {}
      },
      [theme, lang],
    );
    await page.goto("http://localhost:3110/sign", { waitUntil: "networkidle" });
    await page.waitForFunction(
      () => document.querySelectorAll("button").length >= 2,
      null,
      { timeout: 20000 },
    );
    await page.waitForTimeout(250);
    const info = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        dark: document.documentElement.classList.contains("dark"),
        colorScheme: document.documentElement.style.colorScheme,
        bg: getComputedStyle(document.body).backgroundColor,
        fg: getComputedStyle(document.body).color,
        accent: style.getPropertyValue("--accent").trim(),
        muted: style.getPropertyValue("--muted").trim(),
        title: document.title,
        buttons: Array.from(document.querySelectorAll("button")).map((b) =>
          b.textContent?.trim(),
        ),
      };
    });
    await page.screenshot({
      path: `${OUT}/sign-${theme}-${lang}-1440x900.png`,
      fullPage: false,
    });
    return info;
  }

  const lightEn = await shot("light", "en");
  const darkEn = await shot("dark", "en");
  const darkZh = await shot("dark", "zh-CN");
  console.log(
    JSON.stringify({ lightEn, darkEn, darkZh, errors: logs.filter((l) => l.startsWith("pageerror") || l.startsWith("error")) }, null, 2),
  );
  await browser.close();
})().catch((error) => {
  console.error("SCREENSHOT_FAILED", error);
  process.exit(1);
});
