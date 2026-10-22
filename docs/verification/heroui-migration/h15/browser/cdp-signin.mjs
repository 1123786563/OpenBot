/* H15 real-app sign-in + session bootstrap (trusted CDP input).
 * Flow: app :3011 -> /sign (login page) -> Casdoor OAuth -> casdoor login form
 * (admin / pw from env CASDOOR_PW, default "123") -> callback -> app session.
 * Saves cookies to /tmp/h15-state.json for reuse by the sweep scripts.
 * Screenshots: sign-light-zh-1440.png (login page), casdoor-login.png.
 * Method note: typing via page.type (CDP Input domain, isTrusted=true).
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP = "http://localhost:3011";
const SHOTS =
  process.env.H15_SHOTS ?? "docs/verification/heroui-migration/h15/screenshots";
const PW = process.env.CASDOOR_PW ?? "123";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--lang=zh-CN", "--disable-features=Translate"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));
await page.setViewport({ width: 1440, height: 900 });

await page.goto(APP, { waitUntil: "networkidle2", timeout: 30000 });
await sleep(1500);
console.log("after goto:", page.url());
// Single-provider deployments auto-redirect to the IdP; /sign is only shown for >1 provider
// or when the auto-redirect is bounced back with an error.
if (!/localhost:8000/.test(page.url())) {
  const btn = await page.waitForSelector("::-p-text(Casdoor)", { timeout: 5000 });
  await btn.click();
  await sleep(2500);
}
await page.waitForSelector("input#username", { timeout: 10000 });
await page.screenshot({ path: `${SHOTS}/sign-light-zh-1440.png` });
console.log("login page shot saved (casdoor authorize/login page)");

if (/localhost:8000/.test(page.url())) {
  const user = await page.$("input#username");
  await user.type("admin");
  const pass = await page.$("input#password");
  await pass.type(PW);
  await page.screenshot({ path: `${SHOTS}/casdoor-login.png` });
  const submit =
    (await page.$('button[type="submit"]')) ?? (await page.$("::-p-text(登录)"));
  console.log("submit selector found:", !!submit);
  await submit.click();
  await sleep(4000);
  console.log("after submit:", page.url());
}

await sleep(2000);
const me = await page.evaluate(async () => {
  const r = await fetch("/api/me");
  return { status: r.status, body: await r.text() };
});
console.log("ME:", me.status, me.body.slice(0, 200));

const client = await page.createCDPSession();
const { cookies } = await client.send("Network.getAllCookies");
fs.writeFileSync(
  "/tmp/h15-state.json",
  JSON.stringify({ cookies, origin: APP }, null, 2),
);
console.log("state saved; cookies:", cookies.length);
await browser.close();
