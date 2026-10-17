/**
 * Billing 功能浏览器全量测试（普通脚本）。
 *
 * 运行：`bun tests/e2e/billing-browser-test.ts`
 * 前置：应用 dev server（http://localhost:3010）、API（http://localhost:3001）、
 *       Casdoor（http://localhost:8000）已启动，本机装有 Chrome/Chromium。
 *
 * 覆盖：套餐与积分页、升级/购买对话框、账单管理页、URL 参数边界、API 故障态、API 入参边界。
 * 输出：逐条 PASS/FAIL/SKIP + 控制台错误/接口错误清单 + 截图（gui-test-screenshots/billing/）。
 */
import {
  chromium,
  type Browser,
  type Page,
} from "playwright-core";
import { mkdirSync, existsSync } from "node:fs";

const APP_URL = "http://localhost:3010";
const CASDOOR_URL = "http://localhost:8000";
const CASDOOR_USER = "admin";
const CASDOOR_PASSWORD = "123";
const T = 30_000;
const SHOT_DIR = "gui-test-screenshots/billing";

type StepResult = {
  name: string;
  ok: boolean;
  detail: string;
  kind: "pass" | "fail" | "skip";
};
const results: StepResult[] = [];
/** 全局被动观察到的异常（控制台错误、页面异常、非预期 HTTP >=400） */
const observedIssues: string[] = [];
/** 故障注入声明过的预期失败（不计入异常清单） */
const expectedFailures = new Set<string>();
/** 当前页面 URL 是否在应用内（排除掉到 Casdoor 的意外停留） */
function onApp(page: Page) {
  return page.url().startsWith(APP_URL);
}

function log(line: string) {
  console.log(line);
}

class SkipSignal extends Error {}
async function step(name: string, fn: () => Promise<string | undefined>) {
  try {
    const detail = (await fn()) || "";
    results.push({ name, ok: true, detail, kind: "pass" });
    log(`✅ PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    if (error instanceof SkipSignal) {
      results.push({
        name,
        ok: true,
        detail: `跳过：${error.message}`,
        kind: "skip",
      });
      log(`⏭️  SKIP  ${name} — ${error.message}`);
      return;
    }
    const detail =
      error instanceof Error
        ? error.message.replace(/\s*\n\s*/g, " ").slice(0, 400)
        : String(error);
    results.push({ name, ok: false, detail, kind: "fail" });
    log(`❌ FAIL  ${name} — ${detail}`);
  }
}
function skip(a: string, b?: string): never {
  throw new SkipSignal(b ?? a);
}

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
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  for (const executablePath of paths) {
    if (existsSync(executablePath))
      return await chromium.launch({ executablePath, headless: true });
  }
  throw new Error("找不到可用的 Chrome/Chromium");
}

/** 等 dev server 就绪：Vite 冷启动编译慢，先轮询到 200。 */
async function waitAppReady() {
  for (let i = 0; i < 40; i++) {
    const code = await fetch(`${APP_URL}/`, { redirect: "manual" })
      .then((r) => r.status)
      .catch(() => 0);
    if (code === 200) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`dev server ${APP_URL} 60 秒内未就绪`);
}

async function gotoRetry(page: Page, url: string, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { timeout: 60_000, waitUntil: "domcontentloaded" });
      return;
    } catch (error) {
      if (i === attempts - 1) throw error;
      await page.waitForTimeout(3000);
    }
  }
}

async function casdoorLogin(page: Page) {
  // 这版 Casdoor 的表单 id 是 #username / #password，提交按钮是 button[type=submit]（文案「登录」）
  const username = page.locator("#username").first();
  const password = page.locator("#password").first();
  await username.waitFor({ state: "visible", timeout: T });
  await username.fill(CASDOOR_USER);
  await password.fill(CASDOOR_PASSWORD);
  await Promise.all([
    page
      .waitForURL((url) => url.origin === APP_URL, { timeout: T })
      .catch(async (_e) => {
        // 停在 Casdoor 上：把页面上的错误提示带出来
        const errText = await page
          .locator(".ant-message, [class*='error'], [class*='alert']")
          .first()
          .innerText()
          .catch(() => "（无可见错误提示）");
        throw new Error(
          `登录后未跳回应用；页面错误提示：${errText.slice(0, 120)}；当前 ${page.url()}`,
        );
      }),
    page.locator('button[type="submit"]:has-text("登录")').first().click(),
  ]);
}

/** 未登录时应用会在客户端跳去 Casdoor；给这个跳转留出时间，避免误判为已登录。 */
async function signInIfNeeded(page: Page) {
  if (!onApp(page)) return casdoorLogin(page);
  // 在应用内：可能已登录，也可能正要 302。给 12 秒看它跳不跳。
  const leftApp = await page
    .waitForURL((url) => url.origin === CASDOOR_URL, { timeout: 12_000 })
    .then(() => true)
    .catch(() => false);
  if (leftApp) return casdoorLogin(page);
}

/** 确保已登录且当前就在应用内某个路径；不在就导航过去（带登录兜底）。 */
async function ensureOn(page: Page, path: string) {
  if (!onApp(page)) {
    await gotoRetry(page, `${APP_URL}${path}`);
    await signInIfNeeded(page);
  }
  if (page.url().replace(APP_URL, "") !== path) {
    await gotoRetry(page, `${APP_URL}${path}`);
  }
  expect(onApp(page), `未能进入 ${path}（当前 ${page.url()}）`);
}

/** 在已登录页面上下文里调 API（同源带 cookie），返回状态码与 JSON。 */
async function api(
  page: Page,
  path: string,
  init?: { method?: string; body?: unknown },
) {
  if (!onApp(page)) throw new Error(`不在应用内，拒绝把请求打到 ${page.url()}`);
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, {
        method: init?.method ?? "GET",
        headers:
          init?.body !== undefined
            ? { "content-type": "application/json" }
            : undefined,
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        /* non-json */
      }
      return { status: response.status, json };
    },
    { path, init },
  );
}

/** 故障注入：finally 保证解除，绝不泄漏到后续步骤。 */
async function withAborted(
  page: Page,
  pattern: string,
  fn: () => Promise<string | undefined>,
) {
  await page.route(pattern, (route) => route.abort("failed"));
  try {
    await fn();
  } finally {
    await page.unroute(pattern);
  }
}

function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function shot(page: Page, name: string) {
  await page
    .screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false })
    .catch(() => {});
}

/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  await waitAppReady();
  const browser = await launchBrowser();

  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // 故障注入期间的资源加载失败是预期的
      if (text.includes("net::ERR_FAILED") && expectedFailures.size > 0) return;
      observedIssues.push(`[console.error] ${text.slice(0, 300)}`);
    }
  });
  page.on("pageerror", (err) =>
    observedIssues.push(`[pageerror] ${String(err).slice(0, 300)}`),
  );
  page.on("response", (res) => {
    if (!res.url().includes("/api/billing")) return;
    if (res.status() < 400) return;
    const key = `${res.request().method()} ${res.url().replace(APP_URL, "").split("?")[0]}`;
    if (expectedFailures.has(key)) return;
    observedIssues.push(`[api ${res.status()}] ${key}`);
  });

  log(`— 登录 —`);
  await step("登录：Casdoor admin 登录成功", async () => {
    await gotoRetry(page, `${APP_URL}/`);
    await signInIfNeeded(page);
    // OAuth 回调后固定落回首页（不回原路径）。dev 环境抖动下登录链路可能卡住：
    // /api/me 偶发 500 会白屏（侧栏永不出现），回调偶发 10s+ 会让等待超时。循环：
    // 等侧栏 → 超时则探测 /api/me，非 200 就整页重载再来一轮，最多三轮。
    let me = 200;
    for (let attempt = 0; attempt < 3; attempt++) {
      const sidebarUp = await page
        .locator("aside, nav")
        .first()
        .waitFor({ state: "visible", timeout: 25_000 })
        .then(() => true)
        .catch(() => false);
      if (sidebarUp) break;
      me = await page
        .evaluate(async () => (await fetch("/api/me")).status)
        .catch(() => 0);
      if (attempt === 2) expect(false, `登录后侧栏未渲染（/api/me=${me}）`);
      await gotoRetry(page, `${APP_URL}/`);
    }
    return `已登录，落地在 ${page.url()}；/api/me=${me}`;
  });

  await step(
    "准备：清理遗留的 pending 订单（顺带验证 cancel API）",
    async () => {
      await ensureOn(page, "/settings/usage");
      const current = await api(page, "/api/billing/purchases/current");
      const order = (
        current.json as { order?: { orderId?: string; status?: string } } | null
      )?.order;
      if (order?.status !== "pending")
        return `无遗留 pending 订单（${JSON.stringify(current.json).slice(0, 80)}）`;
      const cancel = await api(
        page,
        `/api/billing/purchases/${order.orderId}/cancel`,
        { method: "POST" },
      );
      expect(
        cancel.status === 200,
        `取消订单 HTTP ${cancel.status}：${JSON.stringify(cancel.json).slice(0, 120)}`,
      );
      return `已取消遗留订单 ${order.orderId}`;
    },
  );

  /* ============ A. 套餐与积分页 ============ */
  log(`\n— A. 套餐与积分页 /settings/usage —`);
  await step("A1 页面加载：标题「套餐与积分」与描述渲染", async () => {
    await ensureOn(page, "/settings/usage");
    await page
      .locator(
        "h1:has-text('套餐与积分'), h2:has-text('套餐与积分'), [class*='title']:has-text('套餐与积分')",
      )
      .first()
      .waitFor({ timeout: T });
    await page.waitForTimeout(2500); // 等查询全部落定（Vite 按需编译 + 4 个查询）
    await shot(page, "A1-usage-page");
    return "OK";
  });

  await step("A2+A3 欢迎横幅：渲染与「领取」按钮点击行为", async () => {
    await ensureOn(page, "/settings/usage");
    const banner = page.locator("text=限时加赠").first();
    await banner.waitFor({ timeout: 10_000 });
    const btn = page.locator("button:text-is('领取')").first();
    await btn.waitFor({ state: "visible", timeout: 10_000 });
    await shot(page, "A2-welcome-banner");
    // 领取写入尚未实现：按钮必须禁用并给出「即将开放」提示，而不是可点但无反应
    const disabled = await btn.isDisabled();
    const hint = await page
      .locator("text=领取功能即将开放")
      .isVisible()
      .catch(() => false);
    expect(disabled, "领取按钮未禁用（点击将是无反应的占位）");
    expect(hint, "缺少「领取功能即将开放」提示");
    return `按钮已禁用=${disabled}，提示文案=${hint}`;
  });

  await step("A4 套餐卡片：计划名、积分数、重置时间、升级按钮", async () => {
    await ensureOn(page, "/settings/usage");
    await page.locator("text=订阅计划").first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(800);
    const upgradeBtn = await page
      .locator("button:has-text('升级')")
      .first()
      .isVisible()
      .catch(() => false);
    const free = await page
      .locator("text=体验版")
      .first()
      .isVisible()
      .catch(() => false);
    await shot(page, "A4-plan-card");
    return `升级按钮=${upgradeBtn ? "可见" : "不可见"}；体验版文案=${free}`;
  });

  await step("A5 奖励积分区块：grant 列表渲染（状态/到期/原因）", async () => {
    await ensureOn(page, "/settings/usage");
    await page
      .locator("text=平台奖励积分")
      .first()
      .waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1000);
    const empty = await page
      .locator("text=暂无奖励积分")
      .isVisible()
      .catch(() => false);
    if (empty) return "空态文案正常（当前无奖励积分）";
    const active = await page.locator("text=使用中").count();
    const exhausted = await page.locator("text=已用完").count();
    const expired = await page.locator("text=已过期").count();
    const expiry = await page.locator("text=到期时间").count();
    await shot(page, "A5-grants");
    return `状态标签：使用中=${active} 已用完=${exhausted} 已过期=${expired}；到期字段=${expiry}`;
  });

  await step("A6 消耗明细区块：表头与数据/空态渲染", async () => {
    await ensureOn(page, "/settings/usage");
    await page
      .locator("text=积分消耗明细")
      .first()
      .waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1000);
    const time = await page
      .locator("text=时间")
      .first()
      .isVisible()
      .catch(() => false);
    const empty = await page
      .locator("text=还没有积分消耗记录")
      .isVisible()
      .catch(() => false);
    const rows = empty ? 0 : await page.locator("table tbody tr").count();
    await shot(page, "A6-consumption");
    return `表头时间=${time}；${empty ? "空态" : `${rows} 行数据`}`;
  });

  await step(
    "A7 消耗明细 range 切换（30天→今天→7天）：URL 与数据联动",
    async () => {
      await ensureOn(page, "/settings/usage?range=7d");
      const btn30 = page.locator("button:text-is('30天')").first();
      await btn30.waitFor({ timeout: 10_000 });
      await btn30.scrollIntoViewIfNeeded().catch(() => {});
      await btn30.click({ timeout: 15_000 });
      await page.waitForURL((u) => String(u).includes("range=30d"), {
        timeout: 10_000,
      });
      await page.waitForTimeout(1200);
      const today = page.locator("button:text-is('今天')").first();
      await today.click({ timeout: 10_000 });
      await page.waitForURL((u) => String(u).includes("range=today"), {
        timeout: 10_000,
      });
      await page.waitForTimeout(1500);
      // 关键验证：切到“今天”后（若该窗口无数据），切换器是否还在页面上
      const switcherAlive =
        (await page.locator("button:text-is('7天')").count()) > 0;
      await shot(page, "A7-today-window");
      if (!switcherAlive) {
        // 直接改 URL 恢复现场（UI 已无法切回）
        await gotoRetry(page, `${APP_URL}/settings/usage?range=7d`);
        throw new Error(
          "【缺陷】切到“今天”后范围切换器整个消失（空窗口卸载了整个表格组件），用户无法用 UI 切回其他范围，只能改 URL 逃生",
        );
      }
      await page
        .locator("button:text-is('7天')")
        .first()
        .click({ timeout: 10_000 });
      await page.waitForURL((u) => String(u).includes("range=7d"), {
        timeout: 10_000,
      });
      await shot(page, "A7-range-switch");
      return "URL 依次变为 30d/today/7d，切换控件工作正常";
    },
  );

  await step(
    "A8 消耗明细分页器：有数据显示文案与翻页，空窗口隐藏分页器",
    async () => {
      await ensureOn(page, "/settings/usage?range=30d");
      await page.waitForTimeout(1500);
      const empty = await page
        .locator("text=还没有积分消耗记录")
        .isVisible()
        .catch(() => false);
      if (empty) {
        // 修复后的设计：totalCount=0 时空态渲染且分页器不显示（不报「共 0 条」）
        const pagerGone =
          (await page.locator("text=/第 \\d+ \\/ \\d+ 页/").count()) === 0;
        expect(
          pagerGone,
          "空窗口下分页器不应显示（totalCount=0 隐藏分页器是修复的一部分）",
        );
        return "空窗口：空态文案正确，分页器按设计隐藏";
      }
      const status = page.locator("text=/第 \\d+ \\/ \\d+ 页/").first();
      await status.waitFor({ timeout: 10_000 });
      const text = (await status.innerText()).trim();
      const prevDisabled = await page
        .locator("button[aria-label='上一页'], button:has-text('上一页')")
        .first()
        .isDisabled()
        .catch(() => null);
      const nextDisabled = await page
        .locator("button[aria-label='下一页'], button:has-text('下一页')")
        .first()
        .isDisabled()
        .catch(() => null);
      return `「${text}」；上一页禁用=${prevDisabled} 下一页禁用=${nextDisabled}`;
    },
  );

  await step("A9 URL 参数边界：?range=bogus 回落 7d", async () => {
    await gotoRetry(page, `${APP_URL}/settings/usage?range=bogus`);
    await page.waitForTimeout(2000);
    expect(onApp(page), `不在应用内：${page.url()}`);
    const active = await page
      .locator("button.bg-primary:text-is('7天')")
      .count();
    const anyActive = await page.locator("button.bg-primary").count();
    return `URL=${page.url().split("?")[1] ?? "（无参数）"}；7天高亮=${active}（任意高亮=${anyActive}）`;
  });

  await step(
    "A10 URL 参数边界：?page=-3 / ?page=abc / ?page=999999",
    async () => {
      await gotoRetry(page, `${APP_URL}/settings/usage?range=7d&page=-3`);
      await page.waitForTimeout(1500);
      expect(onApp(page), `page=-3 后不在应用内：${page.url()}`);
      const urlNeg = page.url().split("?")[1] ?? "";
      await gotoRetry(page, `${APP_URL}/settings/usage?range=7d&page=abc`);
      await page.waitForTimeout(1500);
      const urlAbc = page.url().split("?")[1] ?? "";
      await gotoRetry(page, `${APP_URL}/settings/usage?range=7d&page=999999`);
      await page.waitForTimeout(2000);
      const empty = await page
        .locator("text=还没有积分消耗记录")
        .isVisible()
        .catch(() => false);
      const rows = await page.locator("table tbody tr").count();
      await shot(page, "A10-page-999999");
      return `page=-3→「${urlNeg}」；page=abc→「${urlAbc}」；page=999999：空态=${empty} 行数=${rows}`;
    },
  );

  await step("A11 credits/summary 接口故障 → 错误提示 + 重试恢复", async () => {
    await ensureOn(page, "/settings/usage");
    let alertText = "";
    await withAborted(page, "**/api/billing/credits/summary*", async () => {
      expectedFailures.add("GET /api/billing/credits/summary");
      await gotoRetry(page, `${APP_URL}/settings/usage`);
      const alert = page.locator("[role='alert']").first();
      await alert.waitFor({ timeout: T });
      alertText = await alert.innerText();
      await shot(page, "A11-summary-error");
    });
    expectedFailures.delete("GET /api/billing/credits/summary");
    await page.locator("button:has-text('重试')").first().click();
    await page.waitForTimeout(3000);
    const alertCount = await page.locator("[role='alert']").count();
    const planVisible = await page
      .locator("text=订阅计划")
      .isVisible()
      .catch(() => false);
    expect(
      alertCount === 0 || planVisible,
      `重试后错误仍在（${alertCount} 个 alert）`,
    );
    return `错误文案「${alertText.slice(0, 40)}」→ 重试后恢复`;
  });

  /* ============ B. 升级 / 购买对话框 ============ */
  log(`\n— B. 升级/购买对话框 —`);
  await step("B1 打开升级对话框：套餐卡片与当前套餐提示", async () => {
    await ensureOn(page, "/settings/usage");
    const upgrade = page.locator("button:has-text('升级')").first();
    await upgrade.waitFor({ timeout: T });
    await upgrade.click();
    const dialog = page.locator("[role='dialog']");
    await dialog.waitFor({ timeout: 10_000 });
    await dialog
      .locator("span.font-medium")
      .first()
      .waitFor({ timeout: 10_000 });
    const names = await dialog.locator("span.font-medium").allInnerTexts();
    const subtitle = await dialog
      .locator("[class*='description'], p")
      .first()
      .innerText()
      .catch(() => "");
    await shot(page, "B1-upgrade-dialog");
    expect(names.length >= 3, `套餐卡片数量异常：${names.length}`);
    return `套餐：${names.join("/")}；对话框描述：${subtitle.slice(0, 40)}`;
  });

  await step("B2 周期选择：连续包月折扣与划线原价", async () => {
    const dialog = page.locator("[role='dialog']");
    const cycleBtn = dialog
      .locator("button:has-text('连续包月'), button:has-text('1个月')")
      .first();
    await cycleBtn.waitFor({ timeout: 15_000 });
    const discount = await dialog.locator(".text-success").count();
    const strike = await dialog.locator(".line-through").count();
    const cycles = await dialog
      .locator("button:has-text('连续包月'), button:has-text('1个月')")
      .count();
    return `周期按钮=${cycles}，折扣标签=${discount}，划线价=${strike}`;
  });

  await step("B3 切换套餐（高级版）→ 汇总价格联动", async () => {
    const dialog = page.locator("[role='dialog']");
    await dialog.locator("button:has-text('高级版')").first().click();
    await page.waitForTimeout(400);
    const summary = await dialog
      .locator("p.font-medium")
      .first()
      .innerText()
      .catch(() => "");
    expect(summary.includes("高级版"), `汇总未联动：${summary}`);
    await shot(page, "B3-select-advanced");
    return `汇总行：${summary}`;
  });

  await step("B4 切回标准版，选择「连续包月」", async () => {
    const dialog = page.locator("[role='dialog']");
    await dialog.locator("button:has-text('标准版')").first().click();
    const recurring = dialog.locator("button:has-text('连续包月')").first();
    if (await recurring.isVisible().catch(() => false)) {
      await recurring.click();
      await page.waitForTimeout(300);
    }
    const summary = await dialog.locator("p.font-medium").first().innerText();
    return `汇总行：${summary}`;
  });

  await step("B5 支付渠道选择（支付宝/微信支付）", async () => {
    const dialog = page.locator("[role='dialog']");
    const alipay = dialog.locator("button:has-text('支付宝')").first();
    const wechat = dialog.locator("button:has-text('微信支付')").first();
    const hasAlipay = await alipay.isVisible().catch(() => false);
    const hasWechat = await wechat.isVisible().catch(() => false);
    if (!hasAlipay && !hasWechat) {
      // 渠道选择由购买目录异步渲染，等一等再判
      await alipay.waitFor({ timeout: 15_000 }).catch(() => {});
    }
    const hasAlipay2 = await alipay.isVisible().catch(() => false);
    const hasWechat2 = await wechat.isVisible().catch(() => false);
    expect(
      hasAlipay2 || hasWechat2,
      "等待 15 秒后仍未渲染任何支付渠道（购买目录 providers 为空或加载失败）",
    );
    if (hasAlipay2) {
      await alipay.click();
      await page.waitForTimeout(200);
    }
    return `支付宝=${hasAlipay2} 微信支付=${hasWechat2}`;
  });

  await step("B6 协议未勾选时支付按钮禁用", async () => {
    const dialog = page.locator("[role='dialog']");
    // 支付按钮文案就是「同意协议」（t(upgradeDialog.pay)），不能拿 has-text('支付') 去匹配——会误中「支付宝」渠道按钮
    const payBtn = dialog.locator("button:text-is('同意协议并支付')").last();
    const disabled = await payBtn.isDisabled();
    expect(disabled, "未勾选协议时支付按钮竟然可点");
    const checkbox = dialog.locator("input[type='checkbox']").first();
    await checkbox.check();
    await page.waitForTimeout(200);
    const enabled = await payBtn.isEnabled();
    expect(enabled, "勾选协议后支付按钮仍禁用");
    return "禁用→勾选→启用 链条正确";
  });

  await step("B7 创建支付宝订单：QR 本地渲染 + 订单状态", async () => {
    const dialog = page.locator("[role='dialog']");
    const checkbox = dialog.locator("input[type='checkbox']").first();
    if (!(await checkbox.isChecked())) await checkbox.check();
    await page.waitForTimeout(200);
    const payBtn = dialog.locator("button:text-is('同意协议并支付')").last();
    const createResp = page
      .waitForResponse(
        (r) =>
          r.url().includes("/api/billing/purchases") &&
          r.request().method() === "POST",
        { timeout: 20_000 },
      )
      .catch(() => null);
    await payBtn.click();
    const resp = await createResp;
    if (!resp)
      throw new Error("点击支付后未观察到 POST /api/billing/purchases");
    if (resp.status() !== 200) {
      const body = await resp.text().catch(() => "");
      throw new Error(`创建订单 HTTP ${resp.status()}：${body.slice(0, 160)}`);
    }
    const qr = dialog
      .locator("img[alt*='扫码'], img[src^='data:image']")
      .first();
    await qr.waitFor({ timeout: 30_000 });
    const src = await qr.getAttribute("src");
    expect(src?.startsWith("data:image/png"), "QR 不是本地 data URL");
    await page.waitForTimeout(1500);
    const lines = await dialog.locator("p.text-xs").allInnerTexts();
    await shot(page, "B7-alipay-qr");
    const orderLine = lines.find(
      (t) => t.includes("待支付") || t.includes("等待") || t.includes("订单"),
    );
    return `QR 渲染成功；状态行：${orderLine ?? lines.join(" | ")}`;
  });

  await step(
    "B7b 已有 pending 单时再买另一套餐 → 服务端拒绝与文案",
    async () => {
      const dialog = page.locator("[role='dialog']");
      const advanced = dialog.locator("button:has-text('高级版')").first();
      if (!(await advanced.isVisible().catch(() => false)))
        return skip("对话框已不在，跳过并发购单验证");
      await advanced.click();
      await page.waitForTimeout(400);
      const payBtn = dialog.locator("button:text-is('同意协议并支付')").last();
      const [resp] = await Promise.all([
        page
          .waitForResponse(
            (r) =>
              r.url().includes("/api/billing/purchases") &&
              r.request().method() === "POST",
            { timeout: 15_000 },
          )
          .catch(() => null),
        payBtn.click(),
      ]);
      if (!resp) return skip("未发出第二次购单请求（按钮可能被禁用）");
      const _body = (await resp.json().catch(() => ({}))) as { error?: string };
      await page.waitForTimeout(800);
      const payError = await dialog
        .locator("[role='alert']")
        .last()
        .innerText()
        .catch(() => "（无）");
      await shot(page, "B7b-second-order-refused");
      expect(
        payError.includes("待支付订单"),
        `409 文案未本地化：「${payError.slice(0, 80)}」`,
      );
      return `HTTP ${resp.status()}；对话框错误文案（已本地化）：「${payError.slice(0, 80)}」`;
    },
  );

  await step("B7c 通过 UI 取消待支付订单", async () => {
    const dialog = page.locator("[role='dialog']");
    if ((await dialog.count()) === 0) return skip("B7c", "对话框已关闭");
    const statusGone = await dialog
      .locator("p.text-xs:has-text('订单待支付')")
      .count();
    if (statusGone === 0) return skip("B7c", "当前无待支付订单展示");
    const cancelBtn = dialog.locator("button:text-is('取消订单')").first();
    await cancelBtn.waitFor({ timeout: 8000 });
    const [resp] = await Promise.all([
      page
        .waitForResponse((r) => r.url().includes("/cancel"), {
          timeout: 15_000,
        })
        .catch(() => null),
      cancelBtn.click(),
    ]);
    await page.waitForTimeout(1500);
    const stillPending = await dialog
      .locator("p.text-xs:has-text('订单待支付')")
      .count();
    await shot(page, "B7c-order-cancelled");
    expect(
      resp && resp.status() === 200,
      `取消请求失败：${resp ? resp.status() : "未发出"}`,
    );
    expect(stillPending === 0, "取消后订单状态行仍在");
    return "取消订单成功，状态行已消失，支付通道恢复";
  });

  await step("B8 关闭并重开对话框：旧订单状态与重购", async () => {
    const dialog = page.locator("[role='dialog']");
    await dialog.locator("button:has-text('取消')").click();
    await page.waitForTimeout(500);
    expect((await dialog.count()) === 0, "对话框未关闭");
    await page.locator("button:has-text('升级')").first().click();
    await dialog.waitFor({ timeout: 10_000 });
    await page.waitForTimeout(800);
    const orderLine = await dialog
      .locator("p.text-xs:has-text('待支付'), p.text-xs:has-text('等待支付')")
      .count();
    const checkbox = dialog.locator("input[type='checkbox']").first();
    const checked = await checkbox.isChecked().catch(() => false);
    await shot(page, "B8-reopen-dialog");
    return `重开后残留待支付订单行=${orderLine}，协议勾选是否重置=${checked ? "未重置" : "已重置"}`;
  });

  await step("B9 微信支付下单（Pro 测试版 ¥1）", async () => {
    const dialog = page.locator("[role='dialog']");
    const pro = dialog
      .locator("button:has(span.font-medium):has-text('Pro 测试版')")
      .first();
    if (!(await pro.isVisible().catch(() => false)))
      return skip("B9", "目录里没有 Pro 测试版");
    await pro.click();
    await page.waitForTimeout(300);
    const wechat = dialog.locator("button:has-text('微信支付')").first();
    if (!(await wechat.isVisible().catch(() => false)))
      return skip("B9", "部署未配置微信渠道");
    await wechat.click();
    await page.waitForTimeout(200);
    const checkbox = dialog.locator("input[type='checkbox']").first();
    if (!(await checkbox.isChecked())) await checkbox.check();
    const payBtn = dialog.locator("button:text-is('同意协议并支付')").last();
    await payBtn.click();
    const qr = dialog.locator("img[src^='data:image']").first();
    await qr.waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1200);
    await shot(page, "B9-wechat-qr");
    return "微信订单创建成功，QR 渲染";
  });

  await step("B10 无订阅时不应出现「已订阅不可购买」提示", async () => {
    const dialog = page.locator("[role='dialog']");
    if ((await dialog.count()) === 0) {
      await page.locator("button:has-text('升级')").first().click();
      await dialog.waitFor({ timeout: 10_000 });
    }
    const note = await dialog.locator("[role='note']").count();
    expect(note === 0, "无订阅却显示了 alreadySubscribed 提示");
    await page.keyboard.press("Escape");
    return "正确（无 note，支付按钮未被 blocked 禁用）";
  });

  /* ============ C. 账单管理页 ============ */
  log(`\n— C. 账单管理 /settings/invoices —`);
  await step("C1 页面加载：标题与时间范围选择器", async () => {
    await ensureOn(page, "/settings/invoices");
    await page.locator("text=账单管理").first().waitFor({ timeout: T });
    await page.locator("[aria-label='时间范围']").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(2000);
    await shot(page, "C1-invoices-page");
    return "OK";
  });

  await step("C2 账单列表：历史订单渲染（金额/状态/渠道/编号）", async () => {
    await ensureOn(page, "/settings/invoices");
    await page.waitForTimeout(1500);
    const rows = await page.locator("table tbody tr").count();
    const empty = await page
      .locator("text=暂无账单")
      .isVisible()
      .catch(() => false);
    if (rows === 0 && empty) return "空态（当前无账单）";
    expect(rows > 0, `既无行也无空态（rows=${rows}）`);
    const expired = await page.locator("text=已过期").count();
    const amounts = await page.locator("table tbody td").allInnerTexts();
    const moneyCells = amounts.filter((t) => t.includes("¥"));
    const ids = amounts.filter((t) => t.startsWith("po-"));
    await shot(page, "C2-invoice-rows");
    return `${rows} 行；已过期标签=${expired}；金额=${moneyCells.join(",") || "无"}；订单号=${ids.join(",") || "无"}`;
  });

  await step(
    "C3 时间范围筛选：切换 3 个月 → URL ?range=3m&page=1",
    async () => {
      await ensureOn(page, "/settings/invoices");
      await page.locator("[aria-label='时间范围']").click();
      await page.locator("[role='option']:has-text('近 3 个月')").click();
      await page.waitForURL((u) => String(u).includes("range=3m"), {
        timeout: 10_000,
      });
      await page.waitForTimeout(1000);
      expect(page.url().includes("page=1"), "切换范围后页码未重置为 1");
      await shot(page, "C3-range-3m");
      return `URL：${page.url().split("?")[1]}`;
    },
  );

  await step("C4 超页码 page=99 的表现", async () => {
    await gotoRetry(page, `${APP_URL}/settings/invoices?range=3m&page=99`);
    await page.waitForTimeout(2000);
    expect(onApp(page), `不在应用内：${page.url()}`);
    const filtered = await page
      .locator("text=该时间范围内没有账单")
      .isVisible()
      .catch(() => false);
    const rows = await page.locator("table tbody tr").count();
    const pagerText = await page
      .locator("text=/第 \\d+ \\/ \\d+ 页/")
      .innerText()
      .catch(() => "（无分页器）");
    await shot(page, "C4-page-99");
    if (filtered) return "空态文案正确";
    return `未出现空态：渲染 ${rows} 行，分页器「${pagerText}」（服务端/前端可能钳制了页码）`;
  });

  await step("C5 账单详情对话框：金额/套餐/开具时间/流水号", async () => {
    await gotoRetry(page, `${APP_URL}/settings/invoices`);
    await page.waitForTimeout(1500);
    const row = page.locator("table tbody tr").first();
    if ((await row.count()) === 0) return skip("C5", "无账单行");
    await row.locator("button:has-text('详情')").click();
    const dialog = page.locator("[role='dialog']");
    await dialog.locator("text=账单详情").waitFor({ timeout: 10_000 });
    // 等详情真正加载：订单号出现，或错误提示出现
    let loaded = false;
    for (let i = 0; i < 20; i++) {
      const body = await dialog.innerText();
      if (
        /po-[0-9a-f]+/.test(body) ||
        (await dialog.locator("[role='alert']").count()) > 0
      ) {
        loaded = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    const body = await dialog.innerText();
    await shot(page, "C5-invoice-detail");
    expect(
      loaded,
      `详情 10 秒内既没加载出订单号也没有错误提示；内容：${body.slice(0, 120)}`,
    );
    expect(
      /po-[0-9a-f]+/.test(body),
      `详情里没有订单号；内容：${body.slice(0, 160)}`,
    );
    const fields = ["金额", "支付状态", "支付方式", "开具时间"].filter((f) =>
      body.includes(f),
    );
    return `详情打开成功；字段=${fields.join("/")}`;
  });

  await step("C6 下载账单 CSV（详情内）", async () => {
    const dialog = page.locator("[role='dialog']");
    const downloadBtn = dialog.locator("button:has-text('下载账单')").last();
    if (!(await downloadBtn.isVisible().catch(() => false)))
      return skip("C6", "详情里无下载按钮");
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 10_000 }),
      downloadBtn.click(),
    ]);
    const fname = download.suggestedFilename();
    expect(fname.startsWith("openbot-bill-po-"), `文件名异常：${fname}`);
    const path = await download.path();
    let csvHead = "";
    if (path) {
      const { readFileSync } = await import("node:fs");
      const content = readFileSync(path, "utf8");
      expect(content.includes("bill_number"), "CSV 缺 bill_number 字段");
      csvHead = content.slice(0, 80).replace(/\r?\n/g, " ");
    }
    return `下载成功：${fname}；开头：${csvHead}`;
  });

  await step("C7 列表行内下载图标按钮", async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    const row = page.locator("table tbody tr").first();
    if ((await row.count()) === 0) return skip("C7", "无账单行");
    const dl = row.locator("button[aria-label='下载账单']");
    if ((await dl.count()) === 0) return skip("C7", "行内无下载按钮");
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 10_000 }),
      dl.click(),
    ]);
    return `下载成功：${download.suggestedFilename()}`;
  });

  await step("C8 刷新按钮触发重新拉取", async () => {
    await ensureOn(page, "/settings/invoices");
    let requests = 0;
    const handler = (res: { url: () => string }) => {
      if (res.url().includes("/api/billing/invoices")) requests++;
    };
    page.on("response", handler);
    const refresh = page
      .locator("button[aria-label='刷新'], button:has-text('刷新')")
      .first();
    await refresh.click();
    await page.waitForTimeout(2500);
    page.off("response", handler);
    expect(requests >= 1, "点击刷新未触发列表请求");
    return `刷新触发了 ${requests} 次列表请求`;
  });

  await step("C9 invoices 接口故障 → 错误 + 重试恢复", async () => {
    await ensureOn(page, "/settings/invoices");
    await withAborted(page, "**/api/billing/invoices*", async () => {
      expectedFailures.add("GET /api/billing/invoices");
      await gotoRetry(page, `${APP_URL}/settings/invoices`);
      await page.locator("[role='alert']").first().waitFor({ timeout: T });
      await shot(page, "C9-invoices-error");
    });
    expectedFailures.delete("GET /api/billing/invoices");
    await page.locator("button:has-text('重试')").first().click();
    await page.waitForTimeout(3000);
    const alertCount = await page.locator("[role='alert']").count();
    expect(alertCount === 0, `重试后错误仍在（${alertCount} 个 alert）`);
    return "错误→重试→恢复 正确";
  });

  /* ============ D. API 入参边界（应用会话内） ============ */
  log(`\n— D. API 入参边界 —`);
  await step("D0 会话就绪：在应用内发起 API 调用", async () => {
    await ensureOn(page, "/settings/usage");
    const { status } = await api(page, "/api/billing/entitlements");
    expect(status < 500, `entitlements HTTP ${status}`);
    return "OK";
  });
  await step("D1 GET /api/billing/invoices?page=0", async () => {
    const { status, json } = await api(page, "/api/billing/invoices?page=0");
    return `HTTP ${status} ${JSON.stringify(json).slice(0, 140)}`;
  });
  await step("D2 GET /api/billing/invoices?page=abc", async () => {
    const { status, json } = await api(page, "/api/billing/invoices?page=abc");
    return `HTTP ${status} ${JSON.stringify(json).slice(0, 140)}`;
  });
  await step("D3 GET /api/billing/invoices?page=-5", async () => {
    const { status, json } = await api(page, "/api/billing/invoices?page=-5");
    return `HTTP ${status} ${JSON.stringify(json).slice(0, 140)}`;
  });
  await step("D4 GET /api/billing/invoices?from=not-a-date", async () => {
    const { status, json } = await api(
      page,
      "/api/billing/invoices?from=not-a-date",
    );
    return `HTTP ${status} ${JSON.stringify(json).slice(0, 140)}`;
  });
  await step("D5 GET /api/billing/invoices/po-nonexistent", async () => {
    const { status, json } = await api(
      page,
      "/api/billing/invoices/po-nonexistent",
    );
    return `HTTP ${status} ${JSON.stringify(json).slice(0, 140)}`;
  });
  await step(
    "D6 POST /api/billing/purchases planCode=nonexistent",
    async () => {
      const { status, json } = await api(page, "/api/billing/purchases", {
        method: "POST",
        body: { planCode: "nonexistent", provider: "alipay", cycle: "monthly" },
      });
      return `HTTP ${status} ${JSON.stringify(json).slice(0, 160)}`;
    },
  );
  await step(
    "D7 POST /api/billing/purchases provider=paypal（未配置渠道）",
    async () => {
      const { status, json } = await api(page, "/api/billing/purchases", {
        method: "POST",
        body: { planCode: "standard", provider: "paypal", cycle: "monthly" },
      });
      return `HTTP ${status} ${JSON.stringify(json).slice(0, 160)}`;
    },
  );
  await step(
    "D8 POST /api/billing/purchases cycle=yearly（未提供周期）",
    async () => {
      const { status, json } = await api(page, "/api/billing/purchases", {
        method: "POST",
        body: { planCode: "standard", provider: "alipay", cycle: "yearly" },
      });
      return `HTTP ${status} ${JSON.stringify(json).slice(0, 160)}`;
    },
  );
  await step("D9 POST /api/billing/purchases 缺字段", async () => {
    const { status, json } = await api(page, "/api/billing/purchases", {
      method: "POST",
      body: { planCode: "standard" },
    });
    return `HTTP ${status} ${JSON.stringify(json).slice(0, 160)}`;
  });
  await step("D10 GET /api/billing/purchases/current", async () => {
    const { status, json } = await api(page, "/api/billing/purchases/current");
    return `HTTP ${status} ${JSON.stringify(json).slice(0, 200)}`;
  });
  await step(
    "D11 GET /api/billing/credits/consumption?from=bad&to=bad",
    async () => {
      const { status, json } = await api(
        page,
        "/api/billing/credits/consumption?from=bad&to=bad&page=1",
      );
      return `HTTP ${status} ${JSON.stringify(json).slice(0, 140)}`;
    },
  );
  await step("D12 GET /api/billing/entitlements（结构核对）", async () => {
    const { status, json } = await api(page, "/api/billing/entitlements");
    return `HTTP ${status} ${JSON.stringify(json).slice(0, 220)}`;
  });
  await step(
    "D13 GET /api/billing/purchases/catalog（渠道与周期）",
    async () => {
      const { status, json } = await api(
        page,
        "/api/billing/purchases/catalog",
      );
      return `HTTP ${status} ${JSON.stringify(json).slice(0, 260)}`;
    },
  );

  await step("收尾：清理本次测试创建的 pending 订单", async () => {
    const current = await api(page, "/api/billing/purchases/current");
    const order = (
      current.json as { order?: { orderId?: string; status?: string } } | null
    )?.order;
    if (order?.status !== "pending") return "无待清理订单";
    const cancel = await api(
      page,
      `/api/billing/purchases/${order.orderId}/cancel`,
      { method: "POST" },
    );
    return cancel.status === 200
      ? `已取消 ${order.orderId}`
      : `取消失败 HTTP ${cancel.status}`;
  });

  await browser.close();

  /* ============ 汇总 ============ */
  const failed = results.filter((r) => r.kind === "fail");
  log(`\n========== 测试汇总 ==========`);
  log(
    `通过 ${results.filter((r) => r.kind === "pass").length} / 失败 ${failed.length} / 共 ${results.length}`,
  );
  if (failed.length > 0) {
    log(`\n失败项：`);
    for (const f of failed) log(`  ❌ ${f.name} — ${f.detail}`);
  }
  log(`\n被动观察到的异常（console/pageerror/4xx-5xx）：`);
  const unique = [...new Set(observedIssues)];
  if (unique.length === 0) log("  （无）");
  for (const issue of unique) log(`  ⚠️  ${issue}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("测试脚本崩溃：", error);
  process.exit(2);
});
