// T12 closing-wave browser demo part 2 — continues from the applied UI upgrade (v1.1.0 r4).
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
async function closeAll() { for (let i = 0; i < 4; i++) { if (!(await page.getByRole("dialog").count())) return; await page.keyboard.press("Escape"); await page.waitForTimeout(600); } }
async function openCard() {
  for (let i = 0; i < 3; i++) {
    const card = page.getByRole("button", { name: /Demo Skill/ }).first();
    await card.click({ timeout: 15000 }).catch(async () => { await closeAll(); await card.click({ timeout: 15000 }); });
    await page.waitForTimeout(1800);
    if (await page.getByRole("dialog").count()) return dlg();
  }
  throw new Error("detail dialog did not open");
}
async function step(name, fn) { try { await fn(); log("OK", name); } catch (e) { log("FAIL", name, e.message.slice(0, 300)); await shot(`${name}-FAILED`).catch(() => {}); await closeAll(); } }
await page.goto("http://localhost:3322/packages", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);

// ---- PKG04: expert template create from the 1.1.0 install ----
await step("PKG04", async () => {
  const d = await openCard();
  await shot("PKG04-detail-after-upgrade", d);
  log("detail buttons:", JSON.stringify(await d.getByRole("button").allInnerTexts()).slice(0, 700));
  const create = d.getByRole("button", { name: /创建专家|创建|使用模板/ }).first();
  if (!(await create.count())) throw new Error("no create affordance: " + JSON.stringify(await d.getByRole("button").allInnerTexts()).slice(0, 400));
  await create.click(); await page.waitForTimeout(1500);
  const ex = dlg();
  await shot("PKG04-expert-form", ex);
  log("form buttons:", JSON.stringify(await ex.getByRole("button").allInnerTexts()));
  const name = ex.getByRole("textbox").first();
  if (await name.count()) await name.fill("T12 Browser Note Assistant");
  const submit = ex.getByRole("button", { name: /创建|确认|下一步/ }).last();
  await submit.click(); await page.waitForTimeout(2500);
  const done = await page.getByRole("dialog").count() ? await dlg().innerText() : await page.locator("body").innerText();
  writeFileSync(`${OUT}/PKG04-expert-created.innerText.txt`, done + "\n");
  await page.screenshot({ path: `${OUT}/PKG04-expert-created.png`, fullPage: true });
  summary.push({ step: "PKG04-expert-created", chars: done.length });
  log("created dialog:", done.slice(-500));
});
await closeAll();

// ---- PKG06 rollback through the UI ----
await step("PKG06-rollback", async () => {
  const d = await openCard();
  await shot("PKG06-detail-before-rollback", d);
  log("before-rollback buttons:", JSON.stringify(await d.getByRole("button").allInnerTexts()).slice(0, 700));
  const rollback = d.getByRole("button", { name: /回滚|查看回滚|降级/ }).first();
  if (!(await rollback.count())) throw new Error("no rollback affordance");
  await rollback.click(); await page.waitForTimeout(1500);
  const rb = dlg();
  await shot("PKG06-rollback-preview", rb);
  log("rollback buttons:", JSON.stringify(await rb.getByRole("button").allInnerTexts()));
  const confirm = rb.getByRole("button", { name: /回滚到|确认回滚|回滚/ }).last();
  await confirm.click(); await page.waitForTimeout(2500);
  await shot("PKG06-rollback-applied");
});
await closeAll();

// ---- PKG07: disable → enable (reinstall) ----
await step("PKG07", async () => {
  let d = await openCard();
  const disable = d.getByRole("button", { name: /^停用$/ }).first();
  await disable.click(); await page.waitForTimeout(2000);
  await shot("PKG07-disabled");
  await closeAll();
  d = await openCard();
  await shot("PKG07-detail-disabled", d);
  log("disabled buttons:", JSON.stringify(await d.getByRole("button").allInnerTexts()).slice(0, 500));
  const enable = d.getByRole("button", { name: /启用|重新启用|重装/ }).first();
  await enable.click(); await page.waitForTimeout(2000);
  await shot("PKG07-reenabled");
});
await closeAll();

// ---- PKG07 uninstall + PKG02 install through the UI ----
await step("PKG07-uninstall", async () => {
  const d = await openCard();
  const uninstall = d.getByRole("button", { name: /^卸载$/ }).first();
  await uninstall.click(); await page.waitForTimeout(1200);
  const confirm = (await page.getByRole("dialog").count()) ? dlg() : d;
  const yes = confirm.getByRole("button", { name: /确认|卸载/ }).last();
  if (await yes.count()) { await yes.click(); await page.waitForTimeout(2500); }
  await shot("PKG07-uninstalled");
});
await closeAll();
await step("PKG02-install-ui", async () => {
  await shot("PKG02-catalogue-uninstalled");
  const card = page.getByRole("button", { name: /Demo Skill/ }).first();
  await card.click(); await page.waitForTimeout(1800);
  const d = dlg();
  await shot("PKG02-detail-uninstalled", d);
  log("uninstalled detail buttons:", JSON.stringify(await d.getByRole("button").allInnerTexts()).slice(0, 700));
  const install = d.getByRole("button", { name: /安装|预览安装/ }).first();
  await install.click(); await page.waitForTimeout(2200);
  const plan = dlg();
  await shot("PKG02-install-preview", plan);
  log("install preview buttons:", JSON.stringify(await plan.getByRole("button").allInnerTexts()));
  const confirm = plan.getByRole("button", { name: /确认安装|安装|应用/ }).last();
  await confirm.click(); await page.waitForTimeout(3000);
  await shot("PKG02-installed-status");
  // idempotent replay: press the confirming control again if the dialog still shows it
  const again = (await page.getByRole("dialog").count()) ? dlg().getByRole("button", { name: /确认安装|安装|应用/ }).last() : null;
  if (again && (await again.count()) && (await again.isEnabled().catch(() => false))) { await again.click(); await page.waitForTimeout(2000); }
  await shot("PKG02-install-replay-state");
});
await closeAll();

// ---- PKG10: unknown dispatch ledger entry + verification refusal in the UI ----
await step("PKG10", async () => {
  const d = await openCard();
  await shot("PKG10-detail-ledger", d);
  const entry = d.getByRole("button", { name: /效果未确认/ }).first();
  if (!(await entry.count())) throw new Error("no unknown dispatch entry");
  await entry.click(); await page.waitForTimeout(2000);
  const panel = (await page.getByRole("dialog").count()) ? dlg() : d;
  await shot("PKG10-dispatch-inspect", panel);
  log("inspect buttons:", JSON.stringify(await panel.getByRole("button").allInnerTexts()).slice(0, 500));
  const verify = panel.getByRole("button", { name: /核对|查询|验证/ }).first();
  if (await verify.count()) {
    await verify.click(); await page.waitForTimeout(2200);
    await shot("PKG10-verify-refusal");
    log("after verify:", (await (await dlg()).innerText()).slice(-500));
  } else log("no verify button");
});
writeFileSync(`${OUT}/browser-demo2-summary.json`, JSON.stringify(summary, null, 2));
log("STEPS:", JSON.stringify(summary));
await browser.close();
