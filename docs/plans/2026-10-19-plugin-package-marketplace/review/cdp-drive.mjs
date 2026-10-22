// Throwaway CDP driver: real headless Chromium click-through of the grants page.
// No deps: Node 24 global WebSocket + fetch. Evidence: innerText dump + full-page PNG.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const EV = join(import.meta.dirname, "browser-clickthrough");
mkdirSync(EV, { recursive: true });

const base = join(process.env.HOME, "Library/Caches/ms-playwright");
let bin = null;
for (const d of readdirSync(base).filter((d) => /^chromium-/.test(d)).sort().reverse()) {
  const mac = join(base, d, "chrome-mac-arm64");
  if (!existsSync(mac)) continue;
  const app = readdirSync(mac).find((e) => e.endsWith(".app"));
  if (!app) continue;
  const macos = join(mac, app, "Contents", "MacOS");
  const exe = readdirSync(macos)[0];
  if (exe) { bin = join(macos, exe); break; }
}
if (!bin) { console.error("NO_CHROMIUM"); process.exit(1); }
const chrome = spawn(bin, [
  "--headless=new", "--remote-debugging-port=9333", "--user-data-dir=/tmp/pkg-cdp-chrome",
  "--no-first-run", "--disable-gpu", "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let info = null;
for (let i = 0; i < 40; i++) {
  try { info = await (await fetch("http://127.0.0.1:9333/json/version")).json(); break; } catch { await sleep(250); }
}
if (!info) { console.error("NO_DEVTOOLS"); process.exit(1); }

const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map(); const events = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
  else if (msg.method) events.push(msg);
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
});
const waitEvent = (method, ms = 15000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const i = events.findIndex((e) => e.method === method);
    if (i >= 0) { clearInterval(iv); res(events.splice(i, 1)[0]); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error("timeout " + method)); }
  }, 50);
});

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sessionId);
await send("Network.enable", {}, sessionId);
await send("Network.setCookie", {
  name: "better-auth.session_token",
  value: "Q43Nj75rZ6ypq4cRuz7Al9rD0aDl6sbu.A2ALBUf%2Fahep7ax0l7l%2Bhn1o9CB6MSpq%2FZeFBmbCZgQ%3D",
  domain: "localhost", path: "/", httpOnly: true, secure: false,
}, sessionId);

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description || "eval fail"));
  return r.result.value;
};

await send("Page.navigate", { url: "http://localhost:3320/packages" }, sessionId);
await waitEvent("Page.loadEventFired");
await sleep(1200);
await evaluate(`localStorage.setItem("openbot.workspace-scope.v1:Lq6dljvPkA9ZBhdu7cnWQHMPGxjMpwZj", JSON.stringify({tenantId:"pkg-acc-tenant",workspaceId:"pkg-acc-workspace-2"})); "seeded"`);
await send("Page.navigate", { url: "http://localhost:3320/packages" }, sessionId);
await waitEvent("Page.loadEventFired");
await sleep(2000);

const clickThroughFn = async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let card = null;
  for (let i = 0; i < 40 && !card; i++) {
    await sleep(250);
    const matches = [...document.querySelectorAll("button,[role=button],a,li")].filter(
      (b) => b.textContent.includes("Demo Skill") && b.offsetParent !== null && b.textContent.length < 400,
    );
    matches.sort((a, b) => a.textContent.length - b.textContent.length);
    card = matches[0] || null;
  }
  if (!card) return { step: "card", ok: false, text: document.body.innerText.slice(0, 800) };
  card.click();
  await sleep(1200);
  let opener = null;
  for (let i = 0; i < 20 && !opener; i++) {
    await sleep(250);
    opener = [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "从此模板创建专家" && b.offsetParent !== null,
    );
  }
  if (!opener) return { step: "opener", ok: false, text: document.body.innerText.slice(0, 2000) };
  opener.click();
  await sleep(600);
  const nameInput = [...document.querySelectorAll("input")].find(
    (i) => i.offsetParent !== null && !i.disabled && i.placeholder === "新 Bot 的显示名称",
  );
  if (!nameInput) return { step: "name-input", ok: false, text: document.body.innerText.slice(0, 2200) };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(nameInput, "Note Assistant 2");
  nameInput.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(300);
  const submit = [...document.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === "创建专家" && b.offsetParent !== null && !b.disabled,
  );
  if (!submit) return { step: "submit", ok: false, text: document.body.innerText.slice(0, 2200) };
  submit.click();
  let marker = null;
  for (let i = 0; i < 48; i++) {
    await sleep(250);
    const t = document.body.innerText;
    if (/agentId|已创建/.test(t)) { marker = t.slice(0, 2500); break; }
  }
  return { step: "created", ok: Boolean(marker), text: marker || document.body.innerText.slice(0, 2200) };
};
const out = await evaluate("(" + clickThroughFn.toString() + ")()");
writeFileSync(join(EV, "detail-innerText.txt"), out.text ?? "");
console.log("STEP:", out.step, "OK:", out.ok, "| listCard:", out.listState);

const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
writeFileSync(join(EV, "detail.png"), Buffer.from(shot.data, "base64"));
console.log("EVIDENCE:", join(EV, "detail.png"), "and detail-innerText.txt");
ws.close(); chrome.kill(); process.exit(0);
