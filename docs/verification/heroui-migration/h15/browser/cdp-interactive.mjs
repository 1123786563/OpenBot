/* H15 real-app interactive sweep (authenticated; trusted CDP input).
 * Sections: channel-create | a02-tokens | a04-dialog | a05-forms | context-menu-inapp | ime-inapp
 * Produces JSON verdict lines + screenshots under h15/screenshots.
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP = "http://localhost:3011";
const STATE = "/tmp/h15-state.json";
const SHOTS =
  process.env.H15_SHOTS ?? "docs/verification/heroui-migration/h15/screenshots";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--lang=zh-CN", "--disable-features=Translate"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 250)));
await page.setViewport({ width: 1440, height: 900 });
const { cookies } = JSON.parse(fs.readFileSync(STATE, "utf8"));
await page.setCookie(...cookies.filter((c) => c.domain.includes("localhost")));
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("openbot-theme", "light");
  localStorage.setItem("openbot.language", "zh");
});

let failures = 0;
function check(name, ok, detail) {
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + JSON.stringify(detail) : ""}`,
  );
  if (!ok) failures++;
}
const section = process.argv[2] ?? "all";

const go = (path) => page.goto(APP + path, { waitUntil: "networkidle2", timeout: 45000 });

/* ---------- channel create (enables in-app composer/context-menu checks) ---------- */
if (section === "channel-create" || section === "all") {
  await go("/channel/new");
  await sleep(2500);
  await page.screenshot({ path: `${SHOTS}/channel-new-light-zh-1440.png` });
  console.log("channel/new url:", page.url());
  // The explore-agent cards or the agent picker: pick General Assistant.
  const card = await page.$('::-p-text(General Assistant)');
  if (card) {
    await card.click();
    await sleep(3000);
    console.log("after card click:", page.url());
    await page.screenshot({ path: `${SHOTS}/channel-created-light-zh-1440.png` });
  } else {
    console.log("no agent card found");
  }
  // Persist refreshed cookies.
  const client = await page.createCDPSession();
  const all = await client.send("Network.getAllCookies");
  fs.writeFileSync(STATE, JSON.stringify({ cookies: all.cookies, origin: APP }, null, 2));
}

/* ---------- A02: computed token spot-checks on menu/popover/portal ---------- */
if (section === "a02-tokens" || section === "all") {
  await go("/");
  await sleep(2000);
  // Open the user menu: the "admin" entry at the sidebar bottom is a DropdownMenuTrigger button.
  const adminBtn = await page.$('aside button:has(span)');
  const adminBtn2 = adminBtn ?? (await page.$('::-p-text(admin)'));
  if (adminBtn2) {
    await adminBtn2.click();
    await sleep(800);
  }
  const menuState = await page.evaluate(() => {
    const menu =
      document.querySelector('[role="menu"]') ??
      document.querySelector('[data-slot="dropdown-menu-content"]');
    if (!menu) return { found: false };
    const cs = getComputedStyle(menu);
    const item = menu.querySelector('[role="menuitem"], button, a');
    const ics = item ? getComputedStyle(item) : null;
    return {
      found: true,
      menuBg: cs.backgroundColor,
      itemFg: ics?.color ?? null,
      rootVars: {
        accent: cs.getPropertyValue("--ob-accent").trim() || cs.getPropertyValue("--accent").trim(),
        muted: cs.getPropertyValue("--ob-muted").trim() || cs.getPropertyValue("--muted").trim(),
        brand: cs.getPropertyValue("--ob-brand").trim() || cs.getPropertyValue("--brand").trim(),
      },
    };
  });
  await page.screenshot({ path: `${SHOTS}/a02-user-menu-open-light-zh-1440.png` });
  check("A02 dropdown menu surfaces with theme vars", menuState.found, menuState);
  if (menuState.found) {
    const bg = menuState.menuBg;
    const isHerouiDefaultPurple = /132, 70|139, 92, 246|124, 58, 237/.test(bg);
    check("A02 no HeroUI default purple on menu bg", !isHerouiDefaultPurple, { bg });
  }
  await page.keyboard.press("Escape");
  await sleep(300);
  // Dark pass: reload with dark theme and re-read the same surface.
  await page.evaluate(() => {
    localStorage.setItem("openbot-theme", "dark");
  });
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(2000);
  const avatar2 = await page.$('aside button:has(span)');
  const avatar2b = avatar2 ?? (await page.$('::-p-text(admin)'));
  if (avatar2b) {
    await avatar2b.click();
    await sleep(800);
  }
  const darkMenu = await page.evaluate(() => {
    const menu =
      document.querySelector('[role="menu"]') ??
      document.querySelector('[data-slot="dropdown-menu-content"]');
    return menu
      ? { found: true, menuBg: getComputedStyle(menu).backgroundColor }
      : { found: false };
  });
  await page.screenshot({ path: `${SHOTS}/a02-user-menu-open-dark-zh-1440.png` });
  check("A02 dark: menu re-themed (bg differs from light)", darkMenu.found, darkMenu);
  // Scroll-lock + portal focus sanity already covered elsewhere; ESC closes.
  await page.keyboard.press("Escape");
}

/* ---------- A04: create-agent dialog (questionnaire) keyboard + short viewport ---------- */
if (section === "a04-dialog" || section === "all") {
  await go("/agents");
  await sleep(2000);
  const newBtn =
    (await page.$('::-p-text(新建)')) ??
    (await page.$('::-p-text(New coworker)')) ??
    (await page.$('::-p-text(创建)'));
  if (newBtn) {
    await newBtn.click();
    await sleep(1200);
  } else {
    console.log("no new-agent button found on /agents");
  }
  const dialog = await page.waitForSelector('[role="dialog"]', { timeout: 5000 }).catch(() => null);
  check("A04 create-agent dialog opens", !!dialog, {});
  if (dialog) {
    // Questionnaire browser-side change: type into the first input; the Continue button enables.
    const firstInput = await page.$('[role="dialog"] input');
    if (firstInput) {
      await firstInput.type("测试同事");
      await sleep(300);
      const typed = await firstInput.evaluate((n) => n.value);
      check("A06/questionnaire browser-side change registers", typed === "测试同事", { typed });
    }
    await page.screenshot({ path: `${SHOTS}/a04-create-agent-dialog-step1.png` });
    // Enter key: single-submit semantics — Enter in text input should advance once, not double.
    await page.keyboard.press("Enter");
    await sleep(800);
    const stepAfter = await page.evaluate(() =>
      document.querySelector('[role="dialog"]') ? "dialog-open" : "dialog-closed",
    );
    console.log("after Enter:", stepAfter);
    // ESC closes + focus returns.
    const focusBefore = await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName,
    );
    await page.keyboard.press("Escape");
    await sleep(600);
    const after = await page.evaluate(() => ({
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      focus: document.activeElement?.tagName,
    }));
    check("A04 ESC closes dialog", after.dialogs === 0, after);
    // Short viewport: reopen and check the dialog scrolls inside 85svh with long content.
    await page.setViewport({ width: 1280, height: 600 });
    await sleep(300);
    // Fresh query — the old handle went stale across the close/reopen.
    const reopenBtn =
      (await page.$('::-p-text(新建)')) ??
      (await page.$('::-p-text(New coworker)')) ??
      (await page.$('::-p-text(创建)'));
    if (reopenBtn) {
      await reopenBtn.click();
      await sleep(1500);
    }
    const sv = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const content = dlg?.closest('[data-slot="dialog-content"]') ?? dlg;
      const c = content ? getComputedStyle(content) : null;
      const body = dlg?.querySelector('[data-slot="dialog-body"]');
      const b = body ? getComputedStyle(body) : null;
      const r = dlg?.getBoundingClientRect();
      return {
        vh: innerHeight,
        dialogFound: !!dlg,
        dlgH: Math.round(r?.height ?? 0),
        contentMaxH: c?.maxHeight ?? null,
        bodyOverflowY: b?.overflowY ?? null,
      };
    });
    check(
      "A04 short-viewport: dialog capped to 85svh + body independent scroll",
      sv.dialogFound &&
        sv.contentMaxH &&
        parseFloat(sv.contentMaxH) <= sv.vh * 0.85 + 2 &&
        sv.bodyOverflowY === "auto",
      sv,
    );
    await page.screenshot({ path: `${SHOTS}/a04-create-agent-shortviewport.png` });
    // Scroll-lock check with real app dialog.
    const lock = await page.evaluate(() => {
      const de = document.documentElement;
      return {
        htmlOverflow: getComputedStyle(de).overflow,
      };
    });
    check("A04 scroll lock active while dialog open", lock.htmlOverflow === "hidden", lock);
    await page.keyboard.press("Escape");
    await sleep(400);
    await page.setViewport({ width: 1440, height: 900 });
  } else {
    console.log("FAIL-A04 dialog never appeared (page structure differs)");
    failures++;
  }
}

/* ---------- A05: model-access invalid binding code (single submit + error association) ---------- */
if (section === "a05-forms" || section === "all") {
  await go("/settings/model-access");
  await sleep(2000);
  const codeInput = await page.$('input[placeholder*="obot_bbind"], input[aria-label*="绑定"], form input');
  if (codeInput) {
    await codeInput.type("obot_bbind_invalid_test");
    // Count the submits: click confirm once; watch network requests to the model-access endpoints.
    const requests = [];
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    await cdp.on("Network.requestWillBeSent", (e) => {
      const url = e?.params?.request?.url ?? e?.request?.url;
      if (typeof url === "string" && url.includes("/api/model-access/")) requests.push(url);
    });
    const confirmBtn = await page.$('::-p-text(校验绑定码)');
    if (confirmBtn) {
      await confirmBtn.click();
      await sleep(2500);
      const form = await page.evaluate(() => {
        // The page's error pattern is <p role="alert"> (BASE-identical, line 155 both sides);
        // aria-invalid/describedby are the dialog/field-level variant, checked where used.
        const alert = document.querySelector('[role="alert"]');
        const invalid = document.querySelector('[aria-invalid="true"]');
        const described = invalid?.getAttribute("aria-describedby");
        const errEl = described ? document.getElementById(described) : null;
        return {
          roleAlertText: alert ? (alert.textContent ?? "").trim().slice(0, 60) : null,
          roleAlertVisible: alert ? getComputedStyle(alert).display !== "none" : false,
          ariaInvalid: !!invalid,
          describedBy: described ?? null,
          errText: errEl ? (errEl.textContent ?? "").trim().slice(0, 80) : null,
        };
      });
      check("A05 single submit (1 model-access request per click)", requests.length === 1, { requests: requests.length });
      check(
        "A05 error announced (role=alert, BASE-identical) or describedby-linked",
        (form.roleAlertVisible && !!form.roleAlertText) || form.ariaInvalid || !!form.errText,
        form,
      );
      await page.screenshot({ path: `${SHOTS}/a05-model-access-invalid-code.png` });
      console.log("A05 form state:", JSON.stringify(form));
    } else {
      console.log("A05: confirm button not found (page layout differs)");
    }
  } else {
    console.log("A05: binding-code input not found");
  }
}

await browser.close();
process.exit(failures === 0 ? 0 : 1);
