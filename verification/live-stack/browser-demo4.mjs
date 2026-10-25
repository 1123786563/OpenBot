// T12 browser demo part 4 — reinstall from the uninstalled tombstone, then disable/enable with their confirmations.
import { chromium } from "/Users/wuyongjun/orca/workspaces/OpenBot/t12-pkg12-acceptance/node_modules/playwright-core/index.mjs";
import { readFileSync, writeFileSync } from "node:fs";
const OUT = "verification/browser";
const auth = JSON.parse(readFileSync("/tmp/t12-auth.json", "utf8"));
const cookies = auth.cookie.split("; ").map((pair) => { const i = pair.indexOf("="); return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }; });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies(cookies);
await ctx.addInitScript(`localStorage.setItem("openbot.workspace-scope.v1:${auth.userId}", JSON.stringify({tenantId:"t12-tenant",workspaceId:"t12-team"}));`);
const page = await ctx.newPage();
const summary = [];
const log = (...a) => console.log(...a);
async function shot(step, scope) {
  const text = scope ? await scope.innerText().catch(() => "(scope unavailable)") : await page.locator("body").innerText();
  writeFileSync(`${OUT}/${step}.innerText.txt`, text + "\n");
  await page.screenshot({ path: `${OUT}/${step}.png`, fullPage: true });
  summary.push({ step, chars: text.length });
  return text;
}
const dlg = () => page.getByRole("dialog").last();
async function fresh() { await page.goto("http://localhost:3322/packages", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(3000); }
async function openCard() { await page.getByRole("button", { name: /Demo Skill/ }).first().click({ timeout: 20000 }); await page.waitForTimeout(1800); return dlg(); }
async function step(name, fn) { try { await fn(); log("OK", name); } catch (e) { log("FAIL", name, e.message.slice(0, 200)); await shot(`${name}-FAILED`).catch(() => {}); } }
async function handleConfirm(preferred) {
  // A confirm dialog may open stacked on the detail dialog; answer it when present.
  for (let i = 0; i < 2; i++) {
    if (!(await page.getByRole("dialog").count())) return;
    const d = dlg();
    const btn = d.getByRole("button", { name: preferred }).last();
    if (await btn.count()) { await btn.click(); await page.waitForTimeout(2500); return; }
    return;
  }
}

// ---- PKG07 reinstall: 重新安装 from the uninstalled tombstone ----
await step("PKG07-reinstall", async () => {
  await fresh();
  const d = await openCard();
  await d.getByRole("button", { name: /重新安装/ }).first().click();
  await page.waitForTimeout(2000);
  const p = dlg();
  await shot("PKG07-reinstall-preview", p);
  log("reinstall preview buttons:", JSON.stringify(await p.getByRole("button").allInnerTexts()));
  await p.getByRole("button", { name: /重新安装|确认|安装/ }).last().click();
  await page.waitForTimeout(3000);
  const t = await shot("PKG07-reinstalled");
  const i = t.indexOf("Demo Skill");
  log("reinstalled state:", t.slice(i, i + 260).replace(/\n/g, " | "));
});

// ---- PKG07 disable (with confirmation if any) ----
await step("PKG07-disable2", async () => {
  await fresh();
  const d = await openCard();
  await d.getByRole("button", { name: /^停用$/ }).first().click();
  await page.waitForTimeout(1200);
  // if a confirm dialog stacked, accept it
  const p = await page.getByRole("dialog").count() ? dlg() : d;
  const confirm = p.getByRole("button", { name: /停用|确认/ }).last();
  if (await confirm.count() && !(await confirm.innerText()).includes("停用")) await confirm.click().catch(() => {});
  else if (await confirm.count()) await confirm.click().catch(() => {});
  await page.waitForTimeout(2800);
  const t = await shot("PKG07-disabled-final");
  const i = t.indexOf("Demo Skill");
  log("disabled state:", t.slice(i, i + 240).replace(/\n/g, " | "));
});
// ---- PKG07 enable ----
await step("PKG07-enable2", async () => {
  await fresh();
  const d = await openCard();
  await shot("PKG07-detail-disabled-final", d);
  log("disabled-detail buttons:", JSON.stringify(await d.getByRole("button").allInnerTexts()).slice(0, 400));
  const en = d.getByRole("button", { name: /重新启用|^启用$/ }).first();
  await en.click();
  await page.waitForTimeout(2500);
  const p = await page.getByRole("dialog").count() ? dlg() : d;
  const btn = p.getByRole("button", { name: /启用|确认/ }).last();
  if (await btn.count()) { await btn.click().catch(() => {}); await page.waitForTimeout(2200); }
  const t = await shot("PKG07-enabled-final");
  const i = t.indexOf("Demo Skill");
  log("enabled state:", t.slice(i, i + 240).replace(/\n/g, " | "));
});
// ---- PKG10 recheck after reinstall: badge + inspect (install is live again) ----
await step("PKG10-recheck", async () => {
  await fresh();
  const d = await openCard();
  const t = await shot("PKG10-detail-after-lifecycle", d);
  log("unknown badge present:", t.includes("效果未确认"));
  const entry = d.getByRole("button", { name: /效果未确认/ }).first();
  if (await entry.count()) { await entry.click(); await page.waitForTimeout(2200); await shot("PKG10-inspect-after-lifecycle", dlg()); }
});
writeFileSync(`${OUT}/browser-demo4-summary.json`, JSON.stringify(summary, null, 2));
log("STEPS:", JSON.stringify(summary));
await browser.close();
