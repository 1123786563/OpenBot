/* H15 A08/AC4 contrast samples: computed fg/bg pairs on representative elements, both themes.
 * Ratios computed per WCAG 2.x relative-luminance formula; thresholds 4.5:1 normal text,
 * 3:1 large text (>=24px or >=18.66px bold) and non-text UI.
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP = "http://localhost:3011";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--lang=zh-CN", "--disable-features=Translate"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const { cookies } = JSON.parse(fs.readFileSync("/tmp/h15-state.json", "utf8"));
await page.setCookie(...cookies.filter((c) => c.domain.includes("localhost")));

function lum(r, g, b) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(fg, bg) {
  const l1 = lum(...fg);
  const l2 = lum(...bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
const parse = (c) => {
  const m = c.match(/[\d.]+/g)?.map(Number) ?? [];
  if (c.startsWith("rgba") && m[3] === 0) return null; // transparent — caller composites
  return m.slice(0, 3);
};

for (const theme of ["light", "dark"]) {
  await page.evaluateOnNewDocument((t) => {
    localStorage.setItem("openbot-theme", t);
    localStorage.setItem("openbot.language", "zh");
  }, theme);
  await page.goto(APP + "/settings/model-access", { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(2200);
  const samples = await page.evaluate(() => {
    function bgOf(el) {
      let n = el;
      while (n && n !== document.documentElement) {
        const c = getComputedStyle(n).backgroundColor;
        const m = c.match(/[\d.]+/g)?.map(Number) ?? [];
        if (!(c.startsWith("rgba") && m[3] === 0)) return c;
        n = n.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    }
    function pick(label, el) {
      if (!el) return { label, missing: true };
      const cs = getComputedStyle(el);
      return {
        label,
        fg: cs.color,
        bg: bgOf(el),
        size: cs.fontSize,
        weight: cs.fontWeight,
      };
    }
    const bodyText = [...document.querySelectorAll("p, span, div")].find(
      (n) => (n.textContent ?? "").trim().length > 40 && n.children.length === 0,
    );
    return [
      pick("sidebar-nav-active", document.querySelector('aside [data-active="true"], aside a[aria-current="page"], aside .bg-foreground\\/5')),
      pick("sidebar-nav", document.querySelector("aside nav a, aside a")),
      pick("heading", document.querySelector("h1, h2, [data-slot=page-title], p:first-of-type")),
      pick("body-paragraph", bodyText),
      pick(
        "muted-placeholder",
        document.querySelector('input::placeholder') ? document.querySelector("input") : document.querySelector('[data-placeholder], ::-webkit-input-placeholder') ?? document.querySelector("input"),
      ),
      pick("input-text", document.querySelector("input")),
      pick("button-primary", document.querySelector('button:not([disabled])')),
      pick("error-alert", document.querySelector('[role="alert"]')),
      pick(
        "destructive-text",
        [...document.querySelectorAll("p, span, button")].find((n) => {
          const c = getComputedStyle(n).color;
          const m = c.match(/rgb\((\d+),/);
          return m && Number(m[1]) > 120 && Number(m[1]) < 220 && c.includes(",") && (n.textContent ?? "").trim().length > 0 && /无效|失败|错误|not available|error/i.test(n.textContent ?? "");
        }),
      ),
    ];
  });
  console.log(`\n===== ${theme} =====`);
  for (const s of samples) {
    if (s.missing) {
      console.log(`${theme} ${s.label}: element not found`);
      continue;
    }
    const fg = parse(s.fg);
    const bg = parse(s.bg);
    if (!fg || !bg) {
      console.log(`${theme} ${s.label}: composite needed (fg=${s.fg} bg=${s.bg})`);
      continue;
    }
    const r = ratio(fg, bg);
    const px = parseFloat(s.size);
    const bold = Number(s.weight) >= 700;
    const large = px >= 24 || (px >= 18.66 && bold);
    const threshold = large ? 3 : 4.5;
    console.log(
      `${theme} ${s.label}: ${r.toFixed(2)}:1 (threshold ${threshold}) fg=${s.fg} bg=${s.bg} ${px}px/${s.weight}`,
    );
  }
}
await browser.close();
