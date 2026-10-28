// T12 closing-wave browser demo (headless Chromium, real live server :3321 + vite app :3322).
// Same delivery version as the API demo: worktree HEAD, enterprise test DB, better-auth session.
import { chromium } from "/Users/wuyongjun/orca/workspaces/OpenBot/t12-pkg12-acceptance/node_modules/playwright-core/index.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const OUT = "verification/browser";
mkdirSync(OUT, { recursive: true });
const auth = JSON.parse(readFileSync("/tmp/t12-auth.json", "utf8"));
const cookies = auth.cookie.split("; ").map((pair) => { const i = pair.indexOf("="); return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }; });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies(cookies);
await ctx.addInitScript(`localStorage.setItem("openbot.workspace-scope.v1:${auth.userId}", JSON.stringify({tenantId:"t12-tenant",workspaceId:"t12-team"}));`);
const page = await ctx.newPage();
const summary = [];
async function shot(step, scope) {
  const text = scope ? await scope.innerText() : await page.locator("body").innerText();
  writeFileSync(`${OUT}/${step}.innerText.txt`, text + "\n");
  await page.screenshot({ path: `${OUT}/${step}.png`, fullPage: true });
  summary.push({ step, chars: text.length, url: page.url() });
  return text;
}
async function dialog() { return page.getByRole("dialog").last(); }
async function allButtons(scope) { return JSON.stringify(await (scope ?? page).getByRole("button").allInnerTexts()); }
const log = (...a) => console.log(...a);
try {
  // ---- PKG01: catalogue browse ----
  await page.goto("http://localhost:3322/packages", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  await shot("PKG01-packages-catalogue");
  log("PKG01 buttons:", (await allButtons()).slice(0, 400));

  // ---- PKG01/02 detail ----
  await page.getByRole("button", { name: /Demo Skill/ }).first().click();
  await page.waitForTimeout(2000);
  let d = await dialog();
  await shot("PKG02-package-detail-installed", d);
  log("detail buttons:", (await allButtons(d)).slice(0, 500));

  // ---- PKG06: upgrade diff preview → confirm ----
  await d.getByRole("button", { name: /查看升级/ }).first().click();
  await page.waitForTimeout(2000);
  let up = await dialog();
  await shot("PKG06-upgrade-preview", up);
  log("upgrade buttons:", (await allButtons(up)).slice(0, 500));
  const confirmUp = up.getByRole("button", { name: /确认升级|确认|升级/ }).first();
  if (await confirmUp.count()) { await confirmUp.click(); await page.waitForTimeout(2500); }
  await shot("PKG06-upgrade-applied");

  // ---- PKG04: expert template create ----
  await page.getByRole("button", { name: /Demo Skill/ }).first().click();
  await page.waitForTimeout(1800);
  d = await dialog();
  await shot("PKG04-detail-after-upgrade", d);
  log("detail-after-upgrade buttons:", (await allButtons(d)).slice(0, 600));
  const createBtn = d.getByRole("button", { name: /创建专家|创建 Bot|从模板创建/ }).first();
  if (await createBtn.count()) {
    await createBtn.click(); await page.waitForTimeout(1500);
    let ex = await dialog();
    await shot("PKG04-expert-form", ex);
    log("expert form buttons:", (await allButtons(ex)).slice(0, 400));
    const nameInput = ex.getByRole("textbox").first();
    if (await nameInput.count()) { await nameInput.fill("T12 Browser Note Assistant"); }
    const submit = ex.getByRole("button", { name: /创建|确认/ }).first();
    if (await submit.count()) { await submit.click(); await page.waitForTimeout(3000); }
    await shot("PKG04-expert-created");
    log("after create body:", (await page.locator("body").innerText()).slice(-600));
  } else {
    log("PKG04: create button NOT FOUND");
  }
} catch (e) {
  log("ERROR:", e.message.slice(0, 400));
  await shot("error-state").catch(() => {});
}
writeFileSync(`${OUT}/browser-demo-summary.json`, JSON.stringify({ summary, buttons: {} }, null, 2));
log("STEPS:", JSON.stringify(summary));
await browser.close();
