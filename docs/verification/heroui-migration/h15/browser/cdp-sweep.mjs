/* H15 real-app sweep (authenticated). Reuses /tmp/h15-state.json cookies from cdp-signin.mjs.
 * Env controls:
 *   SWEEP_VIEWPORT, SWEEP_THEME, SWEEP_LOCALE, SWEEP_ZOOM, SWEEP_REDUCED
 * Sections (argv[2]): onboarding | shot <name> <path> | nav-check
 * Theme/locale via the app's own UI toggles (sign page header icons / app sidebar), persisted by
 * the app in localStorage — so a fresh context with cookies also needs the LS values; we set
 * them directly via the app's documented storage keys (theme: ob-theme / dataset.theme boot).
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP = "http://localhost:3011";
const STATE = "/tmp/h15-state.json";
const SHOTS =
  process.env.H15_SHOTS ?? "docs/verification/heroui-migration/h15/screenshots";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--lang=" + (process.env.SWEEP_LOCALE ?? "zh-CN"), "--disable-features=Translate"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 250)));
const { width, height } = JSON.parse(process.env.SWEEP_VIEWPORT ?? '{"width":1440,"height":900}');
await page.setViewport({ width, height });

// Restore cookies.
const { cookies } = JSON.parse(fs.readFileSync(STATE, "utf8"));
await page.setCookie(...cookies.filter((c) => c.domain.includes("localhost")));
// Theme + locale straight through the app's own boot contract (index.html reads dataset.theme;
// lib/theme.ts persists under these keys).
const theme = process.env.SWEEP_THEME ?? "light";
const locale = process.env.SWEEP_LOCALE ?? "zh";
await page.evaluateOnNewDocument((t, l) => {
  localStorage.setItem("openbot-theme", t);
  ;
  localStorage.setItem("openbot.language", l);
  ;
  // dataset.theme is set after DOM exists — index.html's boot script reads the storage keys.
}, theme, locale);

const section = process.argv[2] ?? "nav-check";
const arg3 = process.argv[3];
const arg4 = process.argv[4];

if (section === "shot") {
  await page.goto(APP + arg3, { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(2500);
  if (process.env.SWEEP_ZOOM) {
    const cdp = await page.createCDPSession();
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: Number(process.env.SWEEP_ZOOM) });
    await sleep(600);
  }
  if (process.env.SWEEP_REDUCED === "1") {
    const cdp = await page.createCDPSession();
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await sleep(400);
  }
  await page.screenshot({ path: `${SHOTS}/${arg4}` });
  console.log("shot saved:", arg4, "url:", page.url());
} else if (section === "onboarding") {
  await page.goto(APP + "/onboarding", { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(1500);
  await page.screenshot({ path: `${SHOTS}/onboarding-light-zh-1440.png` });
  // Complete every step the app shows: click the primary/next button until the app leaves /onboarding.
  for (let i = 0; i < 8; i++) {
    if (!/onboarding/.test(page.url())) break;
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button:not([disabled])')];
      const next =
        btns.find((b) => /继续|下一步|Continue|Next|完成|开始|Finish|Start/.test(b.textContent ?? "")) ??
        btns.at(-1);
      if (next) {
        next.click();
        return next.textContent.trim().slice(0, 20);
      }
      return null;
    });
    console.log("onboarding click:", clicked, "url:", page.url());
    await sleep(1800);
  }
  await page.screenshot({ path: `${SHOTS}/after-onboarding.png` });
  console.log("final url:", page.url());
  // Persist the updated cookies.
  const client = await page.createCDPSession();
  const all = await client.send("Network.getAllCookies");
  fs.writeFileSync(STATE, JSON.stringify({ cookies: all.cookies, origin: APP }, null, 2));
  console.log("cookies refreshed:", all.cookies.length);
} else if (section === "nav-check") {
  await page.goto(APP + "/", { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(2000);
  const state = await page.evaluate(() => ({
    url: location.pathname,
    title: document.title,
    sidebarLinks: [...document.querySelectorAll("nav a, aside a")].slice(0, 40).map((a) => ({
      href: a.getAttribute("href"),
      text: (a.textContent ?? "").trim().slice(0, 18),
    })),
    dark: document.documentElement.classList.contains("dark") || document.documentElement.dataset.theme === "dark",
  }));
  console.log(JSON.stringify(state, null, 1));
}
await browser.close();
