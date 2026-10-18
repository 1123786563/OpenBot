// Capture + run the probe actions in a REAL browser, and persist the exact bytes
// of one real Next-Action request so replay.ts can re-send them under every
// header variant without guessing action ids.
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";

const PREVIEW = process.env.PREVIEW ?? "http://127.0.0.1:3399/abc123";
const OUT = process.env.OUT ?? "/Users/wuyongjun/.cache/craft414-harness/out/drive.json";
const MODE = process.env.MODE ?? "direct";

async function launchBrowser(): Promise<Browser> {
  for (const candidate of [
    { channel: "chrome" as const },
    { channel: "chrome-canary" as const },
    { channel: "microsoft-edge" as const },
  ]) {
    try {
      return await chromium.launch({ ...candidate, headless: true });
    } catch {
      /* next */
    }
  }
  const paths = [
    `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const executablePath of paths) {
    if (existsSync(executablePath))
      return await chromium.launch({ executablePath, headless: true });
  }
  throw new Error("no chromium available");
}

const browser = await launchBrowser();
const context = await browser.newContext({ locale: "en-US" });
// A platform-auth-shaped HttpOnly cookie on the SAME host the dev-form preview
// rides (cookies ignore ports) — this is what "preview must not carry/leak
// platform cookies" must be measured against in the dev shape.
await context.addCookies([
  {
    name: "openbot_platform_session",
    value: "PLATFORM-SECRET-DO-NOT-LEAK",
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  },
]);

const page = await context.newPage();
const captures: Record<string, unknown>[] = [];
const consoleErrors: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 240));
});
page.on("request", async (r) => {
  if (r.method() === "GET") return;
  const h = r.headers();
  captures.push({
    method: r.method(),
    url: r.url(),
    headers: h,
    post_data: r.postData() ?? null,
    is_action: h["next-action"] !== undefined,
  });
});
const responses: Record<string, unknown>[] = [];
page.on("response", (r) => {
  const req = r.request();
  const h = req.headers();
  if (h["next-action"] === undefined) return;
  responses.push({
    url: req.url(),
    action_id: h["next-action"],
    browser_sent_origin: h["origin"] ?? "ABSENT",
    browser_sent_platform_cookie: (h["cookie"] ?? "").includes("PLATFORM-SECRET"),
    status: r.status(),
    response_set_cookie: r.headers()["set-cookie"] ?? null,
    response_headers: r.headers(),
  });
});

await page.goto(PREVIEW, { waitUntil: "domcontentloaded" });
await page.getByTestId("run-ping").waitFor({ timeout: 120_000 });
const hydrated = await page
  .waitForSelector('[data-testid="probe-hydrated"]:has-text("true")', {
    timeout: 20_000,
  })
  .then(() => "true")
  .catch(() => "false");

const results: Record<string, string> = {};
async function overlayText() {
  return page
    .evaluate(() => {
      const el = document.querySelector("nextjs-portal");
      const root = (el as any)?.shadowRoot;
      return root?.textContent ? String(root.textContent).slice(0, 400) : "";
    })
    .catch(() => "");
}

const overlays: Record<string, string> = {};

async function runOne(name: string) {
  // The dev overlay portal intercepts pointer events once an error is on
  // screen, so dispatch the click from JS: the measurement is the action
  // round-trip, not Playwright's hit-testing.
  await page
    .getByTestId(`run-${name}`)
    .evaluate((el: any) => el.click());
  const el = page.getByTestId(`result-${name}`);
  for (let i = 0; i < 40; i++) {
    const text = ((await el.textContent()) ?? "").trim();
    if (text && text !== "pending" && text !== "idle") return text;
    await page.waitForTimeout(500);
  }
  return "TIMEOUT(no resolution)";
}

for (const name of ["ping", "stamp", "boom"]) {
  results[name] = await runOne(name);
  const o = await overlayText();
  if (o) overlays[name] = o;
  await page.waitForTimeout(300);
}
try {
  await page.getByTestId("run-go").evaluate((el: any) => el.click());
  await page.waitForSelector('[data-testid="done-page"]', { timeout: 20_000 });
  results.go = `navigated=${page.url()}`;
} catch (error) {
  results.go = `FAILED(${error instanceof Error ? error.message.split("\n")[0].slice(0, 120) : "?"}) url=${page.url()}`;
}

const evidence = {
  mode: MODE,
  preview_url: PREVIEW,
  hydrated,
  results,
  document_cookie: await page.evaluate(() => document.cookie).catch(() => "n/a"),
  jar: (await context.cookies("http://127.0.0.1")).map((c) => ({
    name: c.name,
    value: c.value.slice(0, 24),
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
  })),
  action_responses: responses,
  dev_overlay: overlays,
  action_requests_captured: captures.filter((c) => c.is_action),
  console_errors: consoleErrors.slice(0, 12),
  at: new Date().toISOString(),
};
await Bun.write(OUT, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
await browser.close();
