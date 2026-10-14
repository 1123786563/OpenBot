/**
 * Throwaway live check of the craft preview through the REAL stack: a real browser,
 * a real Casdoor login, the real server on :3001, the real dev server in the sandbox.
 * Deleted after the run — this is evidence, not a suite member.
 */
import { chromium } from "playwright-core";

const EXECUTABLE =
  "/Users/wuyongjun/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const APP = "http://localhost:3010";
const SESSION = "cs-3707b9d485c72a85aa4a4877";

const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = "") {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const browser = await chromium.launch({ executablePath: EXECUTABLE });
// en-US, like e2e.config.ts's web target: the app's own labels ("Expand preview")
// are what the checks below reach for, and Casdoor follows the browser too.
const page = await browser
  .newContext({ locale: "en-US", viewport: { width: 1440, height: 900 } })
  .then((ctx) => ctx.newPage());
const consoleErrors: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160));
});

try {
  // ── login ────────────────────────────────────────────────────────────────
  await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 45_000 });
  // Casdoor's own form ids, not its labels: this build serves them translated
  // (用户名/密码) and the wording is not ours to pin.
  await page.waitForSelector("#username", { timeout: 30_000 });
  await page.fill("#username", "admin");
  await page.fill("#password", "123");
  await page.click("button[type=submit]");
  await page.waitForURL(/localhost:3010/, { timeout: 30_000 });
  await page.getByRole("link", { name: "Bots" }).waitFor({ timeout: 30_000 });
  check("Casdoor login lands back in the app", true);

  // ── the craft session ────────────────────────────────────────────────────
  await page.goto(`${APP}/craft/${SESSION}`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.getByRole("tab", { name: /Preview/i }).click().catch(() => {});

  const frame = page.frameLocator("iframe[title]").first();
  await page.waitForSelector("iframe", { timeout: 30_000 });
  const iframeEl = await page.$("iframe");
  const src = await iframeEl?.getAttribute("src");
  check("the pane renders an iframe", iframeEl !== null, `src=${src}`);

  // THE ORIGINAL BUG: the proxy's raw JSON body painted inside the frame.
  const paneText = await page.evaluate(() => document.body.innerText);
  check(
    'the raw proxy JSON is NOT what the person sees',
    !paneText.includes('"error":"The web app is not running'),
    paneText.includes("The web app is not running")
      ? `found: ${paneText.slice(0, 120)}`
      : "no error string in the pane",
  );

  // Wait for the app itself to paint inside the frame.
  await frame.locator("body").waitFor({ timeout: 60_000 });
  const appHtml = await frame.locator("body").innerHTML();
  check(
    "the generated app actually rendered inside the preview",
    appHtml.length > 200 && !appHtml.includes('"error"'),
    `${appHtml.length} bytes of body HTML`,
  );

  // ── webapp-info through the real server ──────────────────────────────────
  const info = await page.evaluate(
    async (sid) =>
      (await fetch(`/api/craft/sessions/${sid}/webapp-info`)).json(),
    SESSION,
  );
  check(
    "webapp-info says ready:true / status:running",
    info.ready === true && info.status === "running",
    JSON.stringify(info),
  );

  // ── the all-methods proxy, from the browser ──────────────────────────────
  const base = `/api/craft/sessions/${SESSION}/webapp`;
  const probe: Record<string, string> = {};
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const res = await page.evaluate(
      async ([url, m]) => {
        const r = await fetch(url, {
          method: m,
          headers: { "content-type": "application/json" },
          body: m === "DELETE" || m === "OPTIONS" ? undefined : '{"probe":1}',
        });
        return `${r.status}|${(await r.text()).slice(0, 40)}`;
      },
      [`${base}/api/probe-does-not-exist`, method] as [string, string],
    );
    probe[method] = res;
  }
  const refusedByProxy = Object.entries(probe).filter(([, v]) =>
    v.includes("404 Not Found"),
  );
  check(
    "no mutating verb is refused by the proxy (all reach the dev server)",
    refusedByProxy.length === 0,
    JSON.stringify(probe),
  );

  // ── expand ───────────────────────────────────────────────────────────────
  // A marker set INSIDE the frame: it survives only if the iframe is not
  // remounted, which is the whole point of the wrapper-grows design.
  await page.evaluate(() => {
    const f = document.querySelector("iframe") as HTMLIFrameElement | null;
    const w = f?.contentWindow as unknown as Record<string, unknown> | undefined;
    if (w) w.__expandProbe = "alive";
  });
  const markerBefore = await page.evaluate(() => {
    const f = document.querySelector("iframe") as HTMLIFrameElement | null;
    return String(
      (f?.contentWindow as unknown as Record<string, unknown> | undefined)
        ?.__expandProbe,
    );
  });
  check("marker set inside the frame before expanding", markerBefore === "alive");

  const expand = page.getByLabel("Expand preview");
  await expand.waitFor({ timeout: 15_000 });
  await expand.click();

  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 10_000 });
  check(
    "expanding produces a modal surface",
    (await dialog.getAttribute("aria-modal")) === "true",
    `aria-modal=${await dialog.getAttribute("aria-modal")}`,
  );

  const box = await page.locator('[role="dialog"]').boundingBox();
  check(
    "the expanded surface really is full-viewport",
    !!box && box.width > 1400 && box.height > 850,
    box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "no box",
  );

  const markerAfter = await page.evaluate(() => {
    const f = document.querySelector("iframe") as HTMLIFrameElement | null;
    return String(
      (f?.contentWindow as unknown as Record<string, unknown> | undefined)
        ?.__expandProbe,
    );
  });
  check(
    "THE IFRAME WAS NOT REMOUNTED — in-frame state survived the expand",
    markerAfter === "alive",
    `marker=${markerAfter}`,
  );

  await page.screenshot({ path: "/tmp/craft-preview-expanded.png" });

  // ── Escape ───────────────────────────────────────────────────────────────
  await page.keyboard.press("Escape");
  await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 10_000 });
  check("Escape collapses the full-viewport surface", true);
  const markerAfterEsc = await page.evaluate(() => {
    const f = document.querySelector("iframe") as HTMLIFrameElement | null;
    return String(
      (f?.contentWindow as unknown as Record<string, unknown> | undefined)
        ?.__expandProbe,
    );
  });
  check("state still intact after collapse", markerAfterEsc === "alive");
  await page.screenshot({ path: "/tmp/craft-preview-collapsed.png" });

  // ── interacting with the app inside the preview ──────────────────────────
  const clickable = await frame.locator("button, a, input").count();
  check(
    "the preview is interactive (form controls reachable inside the frame)",
    clickable > 0,
    `${clickable} buttons/links/inputs found`,
  );
} catch (error) {
  check("run completed", false, error instanceof Error ? error.message : String(error));
} finally {
  const relevant = consoleErrors.filter(
    (e) => !/favicon|Download the React|404 \(Not Found\)/i.test(e),
  );
  console.log(
    `\nconsole errors (filtered): ${relevant.length}${relevant.length ? `\n  ${relevant.slice(0, 4).join("\n  ")}` : ""}`,
  );
  const failed = results.filter(([, ok]) => !ok);
  console.log(
    `\n=== ${results.length - failed.length}/${results.length} checks passed ===`,
  );
  await browser.close();
  process.exit(failed.length > 0 ? 1 : 0);
}
