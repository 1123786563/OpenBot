// T12 browser demo part 3 — fresh page per step: rollback, lifecycle, uninstall/reinstall, unknown ledger.
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
async function fresh() {
  await page.goto("http://localhost:3322/packages", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
}
async function openCard() {
  const card = page.getByRole("button", { name: /Demo Skill/ }).first();
  await card.click({ timeout: 20000 });
  await page.waitForTimeout(1800);
  return dlg();
}
async function step(name, fn) { try { await fn(); log("OK", name); } catch (e) { log("FAIL", name, e.message.slice(0, 200)); await shot(`${name}-FAILED`).catch(() => {}); } }

// ---- PKG06 rollback ----
await step("PKG06-rollback", async () => {
  await fresh();
  const d = await openCard();
  await shot("PKG06-detail-rollback-offer", d);
  const rb = d.getByRole("button", { name: /查看回滚/ }).first();
  await rb.click(); await page.waitForTimeout(1500);
  const p = dlg();
  await shot("PKG06-rollback-preview", p);
  log("rollback preview buttons:", JSON.stringify(await p.getByRole("button").allInnerTexts()));
  const go = p.getByRole("button", { name: /回滚到|确认回滚/ }).last();
  await go.click(); await page.waitForTimeout(3000);
  await shot("PKG06-rollback-applied");
});

// ---- PKG07 disable ----
await step("PKG07-disable", async () => {
  await fresh();
  const d = await openCard();
  await d.getByRole("button", { name: /^停用$/ }).first().click();
  await page.waitForTimeout(2500);
  const t = await shot("PKG07-disabled");
  log("disabled state:", t.slice(t.indexOf("Demo Skill"), t.indexOf("Demo Skill") + 300));
});
// ---- PKG07 enable (reinstall) ----
await step("PKG07-enable", async () => {
  await fresh();
  const d = await openCard();
  await shot("PKG07-detail-disabled", d);
  log("disabled-detail buttons:", JSON.stringify(await d.getByRole("button").allInnerTexts()).slice(0, 500));
  await d.getByRole("button", { name: /重新启用|^启用$/ }).first().click();
  await page.waitForTimeout(2500);
  const t = await shot("PKG07-reenabled");
  log("reenabled state:", t.slice(t.indexOf("Demo Skill"), t.indexOf("Demo Skill") + 300));
});
// ---- PKG07 uninstall ----
await step("PKG07-uninstall", async () => {
  await fresh();
  const d = await openCard();
  await d.getByRole("button", { name: /^卸载$/ }).first().click();
  await page.waitForTimeout(1500);
  const p = await page.getByRole("dialog").count() ? dlg() : d;
  await shot("PKG07-uninstall-confirm", p);
  log("uninstall confirm buttons:", JSON.stringify(await p.getByRole("button").allInnerTexts()));
  const yes = p.getByRole("button", { name: /确认卸载|卸载/ }).last();
  await yes.click(); await page.waitForTimeout(3000);
  await shot("PKG07-uninstalled");
});
// ---- PKG02 install through the UI ----
await step("PKG02-install-ui", async () => {
  await fresh();
  await shot("PKG02-catalogue-after-uninstall");
  const d = await openCard();
  await shot("PKG02-detail-uninstalled", d);
  log("uninstalled-detail buttons:", JSON.stringify(await d.getByRole("button").allInnerTexts()).slice(0, 600));
  const inst = d.getByRole("button", { name: /^安装$|预览安装|安装插件包/ }).first();
  await inst.click(); await page.waitForTimeout(2500);
  const p = dlg();
  await shot("PKG02-install-preview", p);
  log("install preview buttons:", JSON.stringify(await p.getByRole("button").allInnerTexts()));
  const go = p.getByRole("button", { name: /确认安装|安装/ }).last();
  await go.click(); await page.waitForTimeout(3500);
  await shot("PKG02-install-applied");
});
// ---- PKG10 unknown ledger + verify in UI ----
await step("PKG10", async () => {
  await fresh();
  const d = await openCard();
  await shot("PKG10-detail-ledger", d);
  const entry = d.getByRole("button", { name: /效果未确认/ }).first();
  await entry.click(); await page.waitForTimeout(2500);
  const p = await page.getByRole("dialog").count() ? dlg() : d;
  await shot("PKG10-dispatch-inspect", p);
  log("inspect buttons:", JSON.stringify(await p.getByRole("button").allInnerTexts()).slice(0, 600));
  const v = p.getByRole("button", { name: /核对|查询/ }).first();
  if (await v.count()) { await v.click(); await page.waitForTimeout(2500); await shot("PKG10-verify-result"); log("verify result:", (await (await dlg().count() ? dlg() : page.locator("body")).innerText()).slice(-400)); }
  else log("no verify button visible");
});
writeFileSync(`${OUT}/browser-demo3-summary.json`, JSON.stringify(summary, null, 2));
log("STEPS:", JSON.stringify(summary));
await browser.close();
