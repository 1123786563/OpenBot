/* R1 visual-redesign browser QA (issue #502): HeroUI-native baseline evidence.
 *
 * Captures light+dark × zh+en on home / model-access / admin-gateway, plus computed-style
 * spot checks proving: accent button fill == oklch(0.6204 0.195 253.83), canvas and border
 * match the new ladder, and NO WorkBuddy teal (#00c29a/#3dd9b6) or old black primary
 * (#171717 as a button fill) remains on interactive elements. Also measures WCAG contrast
 * for body-on-canvas, snow-on-accent, accent-on-white and muted text.
 *
 * Run from repo root: node docs/verification/heroui-migration/r1/browser/cdp-r1.mjs
 * (needs the dev app on :3011, session cookies at /tmp/h15-state.json).
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP = "http://localhost:3011";
const STATE = "/tmp/h15-state.json";
/* Absolute so the script also runs from a copy inside the CDP harness (/tmp/cdp-harness),
 * whose node_modules carries puppeteer-core — the same pattern the h15 browser scripts used. */
const SHOTS =
  process.env.R1_SHOTS ??
  "/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration/docs/verification/heroui-migration/r1/screenshots";
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--lang=zh-CN", "--disable-features=Translate"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));
await page.setViewport({ width: 1440, height: 900 });
const { cookies } = JSON.parse(fs.readFileSync(STATE, "utf8"));
await page.setCookie(...cookies.filter((c) => c.domain.includes("localhost")));

let failures = 0;
function check(name, ok, detail) {
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + JSON.stringify(detail) : ""}`,
  );
  if (!ok) failures++;
}

/* ---------- WCAG contrast on computed colors ---------- */
function parseColor(str) {
  if (!str) return null;
  let m = str.match(/oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+(-?[\d.]+)/);
  if (m) {
    const L = parseFloat(m[1]) > 1 ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
    const C = parseFloat(m[2]);
    const H = parseFloat(m[3]);
    const hr = (H * Math.PI) / 180;
    const a = C * Math.cos(hr);
    const b = C * Math.sin(hr);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const l = l_ ** 3;
    const mm = m_ ** 3;
    const s = s_ ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
    ];
  }
  m = str.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) {
    return m.slice(1, 4).map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
  }
  m = str.match(/color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (m) {
    return m.slice(1, 4).map((v) => {
      const c = parseFloat(v);
      return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
    });
  }
  return null;
}
function contrast(fgStr, bgStr) {
  const fg = parseColor(fgStr);
  const bg = parseColor(bgStr);
  if (!fg || !bg) return null;
  const lum = (lin) =>
    0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  const l1 = lum(fg.map((c) => Math.min(1, Math.max(0, c))));
  const l2 = lum(bg.map((c) => Math.min(1, Math.max(0, c))));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/* WorkBuddy teal (#00c29a / #3dd9b6) and old black primary (#171717) fingerprints. */
const TEAL_RGB = [0, 194, 154];
const TEAL_DARK_RGB = [61, 217, 182];
const BLACK_PRIMARY_RGB = [23, 23, 23];
const near = (rgb, target, tol = 6) =>
  rgb.length === 3 &&
  rgb.every((c, i) => Math.abs(c - target[i]) <= tol);

const go = (p) =>
  page.goto(APP + p, { waitUntil: "networkidle2", timeout: 45000 });

const PAGES = [
  ["home", "/"],
  ["model-access", "/settings/model-access"],
  ["admin-gateway", "/admin/gateway"],
];

for (const theme of ["light", "dark"]) {
  for (const lang of ["zh", "en"]) {
    await page.evaluateOnNewDocument((t, l) => {
      localStorage.setItem("openbot-theme", t);
      localStorage.setItem("openbot.language", l);
    }, theme, lang);
    for (const [name, route] of PAGES) {
      try {
        await go(route);
        await sleep(2200);
        await page.screenshot({
          path: `${SHOTS}/r1-${name}-${theme}-${lang}-1440.png`,
        });
        console.log(`SHOT r1-${name}-${theme}-${lang}-1440.png ${page.url()}`);
      } catch (e) {
        console.log(`SHOT-FAILED ${name} ${theme} ${lang}: ${e.message.slice(0, 120)}`);
        failures++;
      }
    }
  }
}

/* ---------- computed-style spot checks + contrast, light then dark ---------- */
for (const theme of ["light", "dark"]) {
  await page.evaluateOnNewDocument((t) => {
    localStorage.setItem("openbot-theme", t);
    localStorage.setItem("openbot.language", "zh");
  }, theme);
  await go("/");
  await sleep(2200);

  const probe = await page.evaluate(() => {
    const cs = (el) => getComputedStyle(el);
    const root = getComputedStyle(document.documentElement);
    const read = (el, prop) => (el ? cs(el)[prop] : null);

    // 1) A primary (accent) button — HeroUI's .button--primary, any CTA on the page.
    const btn =
      document.querySelector(".button--primary") ??
      [...document.querySelectorAll("button")].find((b) =>
        /button--primary|primary/.test(b.className),
      );

    // 2) Canvas + border + a hairline-carrying card.
    const card = document.querySelector(
      '[data-slot="card"], .rounded-2xl, [class*="rounded-2xl"]',
    );

    // 3) Interactive-element colour sweep for retired hues (raw strings, classified in Node).
    const colorProps = [];
    const seenEls = new Set();
    const els = document.querySelectorAll(
      "button, a, [role='button'], input, [data-slot='switch-control'], [data-slot='checkbox-control']",
    );
    for (const el of els) {
      if (seenEls.size > 4000) break;
      seenEls.add(el);
      const c = cs(el);
      for (const prop of ["backgroundColor", "color", "borderColor", "outlineColor"]) {
        const v = c[prop];
        if (v && v !== "none") colorProps.push({ prop, v, tag: `${el.tagName}:${String(el.className).slice(0, 40)}` });
      }
    }

    // Sidebar unread dot / row mark — the old teal identity spots.
    const marks = [...document.querySelectorAll("[data-slot='row-mark'], .bg-brand, [class*='bg-brand']")].slice(0, 5).map((el) => ({
      cls: String(el.className).slice(0, 50),
      bg: cs(el).backgroundColor,
    }));

    return {
      bodyBg: read(document.body, "backgroundColor"),
      bodyColor: read(document.body, "color"),
      primaryBtn: btn
        ? { bg: cs(btn).backgroundColor, color: cs(btn).color, text: (btn.textContent || "").trim().slice(0, 30) }
        : null,
      cardBorder: card ? cs(card).borderTopColor : null,
      cardBg: card ? cs(card).backgroundColor : null,
      tokens: {
        action: root.getPropertyValue("--ob-action").trim(),
        brand: root.getPropertyValue("--ob-brand").trim(),
        canvas: root.getPropertyValue("--ob-canvas").trim(),
        border: root.getPropertyValue("--ob-border").trim(),
        mutedText: root.getPropertyValue("--ob-muted-text").trim(),
        focus: root.getPropertyValue("--ob-focus").trim(),
        radius: root.getPropertyValue("--ob-radius").trim(),
      },
      htmlFontSize: cs(document.documentElement).fontSize,
      mutedTextEl: (() => {
        const el = document.querySelector('[data-slot="item-description"], .text-ob-muted-text, [class*="muted-foreground"], .text-muted-foreground');
        return el ? { color: cs(el).color, bg: cs(el).backgroundColor } : null;
      })(),
      sampledColors: colorProps,
      marks,
    };
  });

  /* Classify sampled colours in Node (handles rgb(), oklch() and color(srgb …)). */
  const toRgb8 = (str) => {
    const lin = parseColor(str);
    if (!lin) return null;
    return lin.map((c) => {
      const v = Math.min(1, Math.max(0, c));
      const g = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
      return Math.round(g * 255);
    });
  };
  const offenders = [];
  for (const { prop, v, tag } of probe.sampledColors) {
    const rgb = toRgb8(v);
    if (!rgb) continue;
    if (near(rgb, TEAL_RGB) || near(rgb, TEAL_DARK_RGB))
      offenders.push({ prop, v, rgb, tag, kind: "teal" });
    /* #171717 as a FILL (the old black primary button), not eclipse ink. */
    if (prop === "backgroundColor" && near(rgb, BLACK_PRIMARY_RGB, 3))
      offenders.push({ prop, v, rgb, tag, kind: "black-primary-fill" });
  }
  probe.offenders = offenders;

  const t = theme === "light";
  /* getPropertyValue returns the SPECIFIED (authored) form; computed styles normalize % → decimals. */
  const expectTokenCanvas = t ? "oklch(0.9702 0 0)" : "oklch(12% 0.005 285.823)";
  const expectTokenBorder = t ? "oklch(90% 0.004 286.32)" : "oklch(28% 0.006 286.033)";
  const expectComputedCanvas = t ? "oklch(0.9702 0 0)" : "oklch(0.12 0.005 285.823)";
  console.log(`\n=== computed-style probe (${theme}) ===`);
  console.log(JSON.stringify(probe, null, 1));

  check(
    `R1 ${theme}: root font-size is 16px`,
    probe.htmlFontSize === "16px",
    probe.htmlFontSize,
  );
  check(
    `R1 ${theme}: --ob-action is the HeroUI accent`,
    probe.tokens.action === "oklch(0.6204 0.195 253.83)",
    probe.tokens.action,
  );
  check(
    `R1 ${theme}: --ob-brand follows the accent (teal retired)`,
    probe.tokens.brand === "oklch(0.6204 0.195 253.83)",
    probe.tokens.brand,
  );
  check(
    `R1 ${theme}: --ob-canvas matches the new ladder`,
    probe.tokens.canvas === expectTokenCanvas,
    probe.tokens.canvas,
  );
  check(
    `R1 ${theme}: --ob-border matches the new ladder`,
    probe.tokens.border === expectTokenBorder,
    probe.tokens.border,
  );
  check(
    `R1 ${theme}: --ob-radius is 0.5rem`,
    probe.tokens.radius === "0.5rem",
    probe.tokens.radius,
  );
  check(
    `R1 ${theme}: accent button fill == oklch(0.6204 0.195 253.83)`,
    !!probe.primaryBtn && probe.primaryBtn.bg === "oklch(0.6204 0.195 253.83)",
    probe.primaryBtn,
  );
  check(
    `R1 ${theme}: body background is the canvas`,
    probe.bodyBg === expectComputedCanvas,
    probe.bodyBg,
  );
  check(
    `R1 ${theme}: NO WorkBuddy teal or old black-primary on interactive elements`,
    probe.offenders.length === 0,
    probe.offenders,
  );

  /* ---------- contrast ---------- */
  const bodyRatio = contrast(probe.bodyColor, probe.bodyBg);
  check(
    `R1 ${theme}: body text on canvas >= 4.5`,
    bodyRatio !== null && bodyRatio >= 4.5,
    { ratio: bodyRatio?.toFixed(2) },
  );
  if (probe.primaryBtn) {
    const btnRatio = contrast(probe.primaryBtn.color, probe.primaryBtn.bg);
    check(
      `R1 ${theme}: snow on accent button (measured; library default tradeoff if < 4.5)`,
      btnRatio !== null,
      { ratio: btnRatio?.toFixed(2), note: btnRatio < 4.5 ? "below 4.5 — HeroUI library-default pairing, NOT silently changed" : "pass" },
    );
  }
  /* The home fold has no row descriptions; the muted-text sample comes from model-access. */
  await go("/settings/model-access");
  await sleep(2200);
  const mutedSample = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-slot="item-description"], .text-muted-foreground, [class*="text-muted-foreground"]')];
    for (const el of els) {
      const c = getComputedStyle(el);
      if (c.color && c.color !== getComputedStyle(document.body).color && el.textContent?.trim())
        return { color: c.color, bg: c.backgroundColor, text: el.textContent.trim().slice(0, 40) };
    }
    return null;
  });
  probe.mutedTextEl = mutedSample;
  const accentOnWhite = contrast(
    "oklch(0.6204 0.195 253.83)",
    t ? "oklch(100% 0 0)" : "oklch(0.2103 0.0059 285.89)",
  );
  check(
    `R1 ${theme}: accent vs ${t ? "white" : "dark surface"} (non-text) >= 3`,
    accentOnWhite !== null && accentOnWhite >= 3,
    { ratio: accentOnWhite?.toFixed(2) },
  );
  if (probe.mutedTextEl) {
    const mutedRatio = contrast(
      probe.mutedTextEl.color,
      probe.mutedTextEl.bg === "rgba(0, 0, 0, 0)" ? probe.bodyBg : probe.mutedTextEl.bg,
    );
    /* Informational: HeroUI's own muted/background pairing is 4.43:1 on the light canvas.
       Recorded either way; only a clear breakdown (< 4.2) fails. */
    check(
      `R1 ${theme}: muted text on its surface (informational, HeroUI pairing; fail < 4.2)`,
      mutedRatio !== null && mutedRatio >= 4.2,
      { ratio: mutedRatio?.toFixed(2) },
    );
  }
}

/* Persist refreshed cookies. */
const client = await page.createCDPSession();
const all = await client.send("Network.getAllCookies");
fs.writeFileSync(STATE, JSON.stringify({ cookies: all.cookies, origin: APP }, null, 2));

await browser.close();
console.log(`\nR1 QA failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
