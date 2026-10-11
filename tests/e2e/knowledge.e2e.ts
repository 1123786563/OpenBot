/**
 * 知识库浏览器端到端测试套件（普通脚本，不是 bun test 文件）。
 *
 * 运行：`bun tests/e2e/knowledge.e2e.ts`（或 `bun run test:e2e-knowledge`）
 * 前置：应用（http://localhost:3010）、API（http://localhost:3001）、Casdoor
 *       （http://localhost:8000）、kb-mastra（http://localhost:8082）都在本地
 *       运行；本机装有 Chrome/Chromium（playwright-core 不带浏览器二进制）。
 * 退出：全部通过退出 0；任一用例失败或环境不满足，打印结果并以非 0 退出。
 *
 * 断言全部以页面上真实渲染的文本为准（见 app/src/locales/en/knowledge.json），
 * 不 mock 任何后端——建库/上传/解析/检索走真实 kb-mastra 链路（真实
 * embedding，解析需要数秒，等待均为轮询而非 sleep 放行）。
 *
 * 数据隔离：所有库名以 `e2e-` 为前缀；套件开始前与结束后都会通过 kb-mastra
 * API 清理该前缀的残留库（含失败路径留下的），保证可重复执行。
 * 失败截图：任一用例失败时截图到 /tmp/kb-e2e-fail-{case}.png 便于排查。
 */
import { type Browser, chromium, type Page } from "playwright-core";

// 本脚本的全部 fetch 目标都是本机（3010/3001/8000/8082）：开发机的 HTTP_PROXY
// 会把 127.0.0.1/localhost 请求劫持成代理 404/HTML（kb-mastra T05 实测），
// 摘掉本进程的代理变量是最稳出口（与 kb-mastra 入口同款缓解）。
delete process.env.HTTP_PROXY;
delete process.env.http_proxy;
delete process.env.HTTPS_PROXY;
delete process.env.https_proxy;

const APP_URL = "http://localhost:3010";
const API_URL = "http://localhost:3001";
const CASDOOR_URL = "http://localhost:8000";
const KB_URL = "http://localhost:8082";
const KB_API_KEY = "sk-kb-dev-001"; // tenant-a / admin（kb-mastra KB_API_KEYS 部署默认）
const CASDOOR_USER = "admin";
const CASDOOR_PASSWORD = "123";
const SHORT_TIMEOUT_MS = 20_000;
/** 真实解析（含 embedding）轮询上限。 */
const PARSE_TIMEOUT_MS = 60_000;
const SCREENSHOT_DIR = "/tmp";

const E2E_PREFIX = "e2e-";
const runTag = `${Date.now().toString(36)}`;
const kbName = (seq: number) => `${E2E_PREFIX}${runTag}-${seq}`;

/** E5 检索锚点：上传文本里的独特关键词（检索查询复用它）。 */
const DOC_KEYWORD = "核心资本充足率";
const DOC_CONTENT = [
  "商业银行风险监管核心指标。",
  `根据《商业银行资本管理办法》，${DOC_KEYWORD}不得低于百分之八，`,
  "各级资本充足率应当持续满足监管要求，否则将被采取监管措施。",
  "流动性覆盖率应当不低于百分之百，净稳定资金比例不低于百分之百。",
].join("\n");

type CaseResult = { name: string; ok: boolean; detail: string };

const results: CaseResult[] = [];

function log(line: string) {
  console.log(line);
}

/**
 * 单用例执行器（browser.e2e.ts 的 step 同款）+ 失败截图：
 * 失败时把当前页面截图到 /tmp/kb-e2e-fail-{case}.png 再记录失败。
 */
async function runCase(
  page: Page | null,
  name: string,
  fn: () => Promise<string | undefined>,
) {
  try {
    const detail = (await fn()) ?? "";
    results.push({ name, ok: true, detail });
    log(`✅ PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (page) {
      const slug = name
        .replace(/[^a-z0-9]+/gi, "-")
        .slice(0, 40)
        .toLowerCase();
      const shot = `${SCREENSHOT_DIR}/kb-e2e-fail-${slug}.png`;
      await page
        .screenshot({ path: shot, fullPage: true })
        .catch(() => undefined);
      log(`   失败截图：${shot}`);
    }
    results.push({ name, ok: false, detail });
    log(`❌ FAIL  ${name} — ${detail}`);
  }
}

/** 找一个可用的 Chrome/Chromium 可执行文件。找不到就明确报错退出，绝不伪造通过。 */
async function launchBrowser(): Promise<Browser> {
  const candidates = [
    { channel: "chrome" as const },
    { channel: "chrome-canary" as const },
    { channel: "microsoft-edge" as const },
  ];
  for (const candidate of candidates) {
    try {
      return await chromium.launch({ ...candidate, headless: true });
    } catch {
      // 继续尝试下一个
    }
  }
  const paths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  const { existsSync } = await import("node:fs");
  for (const executablePath of paths) {
    if (existsSync(executablePath)) {
      return await chromium.launch({ executablePath, headless: true });
    }
  }
  throw new Error(
    "找不到可用的 Chrome/Chromium 可执行文件（playwright-core 未安装浏览器二进制）。请安装 Google Chrome 后重试。",
  );
}

async function assertReachable(url: string, label: string) {
  const { request } = await import("node:http");
  const parsed = new URL(url);
  const ok = await new Promise<boolean>((resolve) => {
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
      },
      (res) => {
        res.resume(); // 丢弃主体，只要“连得上”。
        resolve(true);
      },
    );
    req.on("error", () => resolve(false));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
  if (!ok) {
    throw new Error(
      `服务不可达：${url}（${label}）。请先启动应用、Casdoor 与 kb-mastra 再运行本套件。`,
    );
  }
}

/** 带重试的导航：本地 dev server 偶尔抖动（ERR_CONNECTION_REFUSED）。 */
async function gotoRetry(page: Page, url: string, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { timeout: 30000 });
      return;
    } catch (error) {
      if (i === attempts - 1) throw error;
      await page.waitForTimeout(5000);
    }
  }
}

/** Casdoor 登录页两个输入框 + 提交按钮（browser.e2e.ts 同款）。 */
async function casdoorLogin(page: Page) {
  const username = page
    .locator(
      'input[placeholder*="Email or phone"], input[placeholder*="username" i], #input-login-username, input[name="username"]',
    )
    .first();
  const password = page
    .locator(
      '#input-login-password, input[name="password"], input[type="password"]',
    )
    .first();
  await username.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
  await username.fill(CASDOOR_USER);
  await password.fill(CASDOOR_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => url.origin === APP_URL, {
      timeout: SHORT_TIMEOUT_MS,
    }),
    page
      .locator(
        'button:has-text("Sign In"), button:has-text("登录"), button[type="submit"]',
      )
      .first()
      .click(),
  ]);
}

/** 确认已回到已登录首页：侧栏里能看见 Bots 导航项（app-sidebar.tsx:390）。 */
async function assertSignedIn(page: Page) {
  await page
    .locator('a:has-text("Bots"), [href="/bots"], [href*="/bots"]')
    .first()
    .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
}

/** 在干净上下文里走一次完整的 Casdoor 登录，返回该上下文与页面。 */
async function freshLogin(browser: Browser) {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  await gotoRetry(page, `${APP_URL}/`);
  await page.waitForURL((url) => url.origin === CASDOOR_URL, {
    timeout: SHORT_TIMEOUT_MS,
  });
  await casdoorLogin(page);
  await assertSignedIn(page);
  return { context, page };
}

/* ------------------------------------------------------------------ */
/* kb-mastra API 数据准备与清理（fetch 直调，不经浏览器）               */
/* ------------------------------------------------------------------ */

/** node:http 直连 GET（读 JSON）；fetch 在本机被环境代理劫持时不可信。 */
async function httpGetJson(url: string, headers: Record<string, string>) {
  const { request } = await import("node:http");
  const parsed = new URL(url);
  return new Promise<unknown>((resolve, reject) => {
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString("utf8");
          if (status < 200 || status >= 300) {
            reject(new Error(`GET ${url} -> ${status}: ${body.slice(0, 120)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(
              new Error(
                `GET ${url} 返回非 JSON（前 80 字符）：${body.slice(0, 80)}`,
              ),
            );
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** node:http 直连请求（任意方法，JSON 体）；返回 status。 */
async function httpRequest(
  url: string,
  method: "POST" | "DELETE",
  headers: Record<string, string>,
): Promise<number> {
  const { request } = await import("node:http");
  const parsed = new URL(url);
  return new Promise<number>((resolve, reject) => {
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(res.statusCode ?? 0));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const kbHeaders = {
  authorization: `Bearer ${KB_API_KEY}`,
  "content-type": "application/json",
};

/** 列出当前租户全部 KB（node:http 直连）。 */
async function kbList(): Promise<{ id: string; name: string }[]> {
  const body = (await httpGetJson(`${KB_URL}/kb`, {
    authorization: kbHeaders.authorization,
  })) as { items: { id: string; name: string }[] };
  return body.items;
}

/** 删除全部 `e2e-` 前缀的库（开始前清残留、结束后清本轮）。返回删除数。 */
async function cleanupE2eBases(): Promise<number> {
  const items = await kbList();
  const stale = items.filter((kb) => kb.name.startsWith(E2E_PREFIX));
  for (const kb of stale) {
    const status = await httpRequest(`${KB_URL}/kb/${kb.id}`, "DELETE", {
      authorization: kbHeaders.authorization,
    });
    if (status < 200 || status >= 300) {
      log(`  清理警告：DELETE ${kb.name} -> ${status}`);
    }
  }
  return stale.length;
}

/* ------------------------------------------------------------------ */
/* 页面级 helper                                                        */
/* ------------------------------------------------------------------ */

/** 进知识库列表页并等列表区渲染（loading 或空态或列表任一）。 */
async function openKnowledgeList(page: Page) {
  await gotoRetry(page, `${APP_URL}/knowledge`);
  await page
    .getByRole("heading", { name: "Knowledge" })
    .first()
    .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
}

/**
 * 轮询文档行到目标状态：行内状态徽标文本变为目标（Completed/Failed）。
 * 真实解析含 embedding，数秒级；上限 PARSE_TIMEOUT_MS，间隔 2s。
 */
async function waitForDocStatus(
  page: Page,
  docTitle: string,
  target: "Completed" | "Failed",
) {
  const row = page.locator("tbody tr").filter({ hasText: docTitle }).first();
  const badge = row.locator("span", { hasText: target }).first();
  const deadline = Date.now() + PARSE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // 文档列表存在非终态行时页面每 5s 自刷；轮询读 DOM 即可。
    if (await badge.isVisible().catch(() => false)) return;
    await page.waitForTimeout(2000);
  }
  const rowText = await row.innerText().catch(() => "(行不存在)");
  throw new Error(
    `${Math.round(PARSE_TIMEOUT_MS / 1000)} 秒内文档「${docTitle}」未到 ${target}；当前行文本：${rowText.slice(0, 120).replace(/\s+/g, " ")}`,
  );
}

/* ------------------------------------------------------------------ */
/* 用例                                                                 */
/* ------------------------------------------------------------------ */

async function main() {
  log("== 知识库浏览器端到端测试 ==");
  await assertReachable(`${APP_URL}/`, "应用 dev server");
  await assertReachable(`${CASDOOR_URL}/`, "Casdoor");
  await assertReachable(`${API_URL}/`, "API");
  await assertReachable(`${KB_URL}/health`, "kb-mastra");
  log("前置检查：3010 / 8000 / 3001 / 8082 均可达");

  const cleaned = await cleanupE2eBases();
  if (cleaned > 0) log(`已清理前缀 ${E2E_PREFIX} 的残留库 ${cleaned} 个`);

  const browser = await launchBrowser();
  log("已启动浏览器（headless Chrome）");

  try {
    await runKnowledgeFlow(browser);
  } finally {
    // 无论成败，清掉本轮产生的前缀库（含失败路径留下的）。
    const removed = await cleanupE2eBases().catch(() => -1);
    log(`收尾清理：删除前缀库 ${removed} 个`);
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  log("\n== 结果汇总 ==");
  for (const r of results) log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  log(`共 ${results.length} 例，失败 ${failed.length} 例`);
  if (failed.length > 0) process.exit(1);
  process.exit(0);
}

async function runKnowledgeFlow(browser: Browser) {
  const { context, page } = await freshLogin(browser);
  const KB_NAME = kbName(1);

  /* ---- E1 列表页渲染 ---- */
  await runCase(page, "E1 列表页渲染：标题/列表区/Create 按钮", async () => {
    await openKnowledgeList(page);
    await page
      .getByRole("heading", { name: "Knowledge bases" })
      .first()
      .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    // 空态或列表项其一（部署里可能有别的库）。dev server 抖动时 reload 重试。
    const emptyState = page.getByText("No knowledge bases yet");
    const anyItem = page.locator("main a[href*='/knowledge/']").first();
    const target = emptyState.or(anyItem).first();
    try {
      await target.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    } catch {
      await page.reload();
      await target.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    }
    await page
      .getByRole("button", { name: "Create a knowledge base", exact: true })
      .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    return "标题、列表区（或空态）与 Create 按钮均可见";
  });

  /* ---- E2 建库正向 ---- */
  await runCase(
    page,
    "E2 建库正向：填名+描述→列表出现新库与 0 docs",
    async () => {
      await page
        .getByRole("button", { name: "Create a knowledge base", exact: true })
        .click();
      const dialog = page.locator("[role='dialog']").last();
      await dialog
        .getByRole("heading", { name: "Create a knowledge base" })
        .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      await dialog
        .locator("label")
        .filter({ hasText: /^Name/ })
        .locator("input")
        .fill(KB_NAME);
      await dialog
        .locator("label")
        .filter({ hasText: /^Description/ })
        .locator("textarea")
        .fill("e2e 套件创建");
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      // Dialog 关闭 + 列表出现新库行 + 0 docs 徽标。
      await dialog.waitFor({ state: "hidden", timeout: SHORT_TIMEOUT_MS });
      const row = page
        .locator("main a[href*='/knowledge/']")
        .filter({ hasText: KB_NAME })
        .first();
      await row.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      // 记录 kbId（E13 删后直访用）。
      recordedKbId = (await row.getAttribute("href"))?.split("/").pop() ?? null;
      await row
        .locator("..")
        .getByText("0 docs")
        .first()
        .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      return `库「${KB_NAME}」已创建（id=${recordedKbId}），docCount 徽标 0 docs`;
    },
  );

  /* ---- E3 建库空输入（异常） ---- */
  await runCase(page, "E3 建库空输入：Name 必填被拦，列表不新增", async () => {
    const before = await page.locator("main a[href*='/knowledge/']").count();
    await page
      .getByRole("button", { name: "Create a knowledge base", exact: true })
      .click();
    const dialog = page.locator("[role='dialog']").last();
    await dialog
      .getByRole("heading", { name: "Create a knowledge base" })
      .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    const submit = dialog.getByRole("button", { name: "Create", exact: true });
    // 空 Name 时提交按钮被禁用（disabled={!name.trim()}），点击无效。
    if (!(await submit.isDisabled())) {
      throw new Error("空 Name 时 Create 按钮应当禁用（必填校验）");
    }
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: SHORT_TIMEOUT_MS });
    const after = await page.locator("main a[href*='/knowledge/']").count();
    if (after !== before) throw new Error(`列表数变化：${before} → ${after}`);
    return "必填禁用生效，取消后列表不变";
  });

  /* ---- E4 高级折叠 ---- */
  await runCase(
    page,
    "E4 高级折叠：展开出现 512/80 默认值，收起消失",
    async () => {
      await page
        .getByRole("button", { name: "Create a knowledge base", exact: true })
        .click();
      const dialog = page.locator("[role='dialog']").last();
      await dialog
        .getByRole("heading", { name: "Create a knowledge base" })
        .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      await dialog
        .getByRole("button", { name: "Advanced settings", exact: true })
        .click();
      const chunkSize = dialog
        .locator("label")
        .filter({ hasText: "Chunk size" })
        .locator("input");
      const chunkOverlap = dialog
        .locator("label")
        .filter({ hasText: "Chunk overlap" })
        .locator("input");
      await chunkSize.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      await chunkOverlap.waitFor({
        state: "visible",
        timeout: SHORT_TIMEOUT_MS,
      });
      const sizeValue = await chunkSize.inputValue();
      const overlapValue = await chunkOverlap.inputValue();
      if (sizeValue !== "512" || overlapValue !== "80") {
        throw new Error(
          `高级默认值不符：chunk=${sizeValue} overlap=${overlapValue}`,
        );
      }
      await dialog
        .getByRole("button", { name: "Hide advanced settings", exact: true })
        .click();
      await chunkSize.waitFor({ state: "hidden", timeout: SHORT_TIMEOUT_MS });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "hidden", timeout: SHORT_TIMEOUT_MS });
      return "展开默认 512/80，收起后字段消失";
    },
  );

  /* ---- 进新库详情（后续用例的舞台） ---- */
  await openKnowledgeList(page);
  const kbItem = page
    .locator("main a[href*='/knowledge/']")
    .filter({ hasText: KB_NAME })
    .first();
  await kbItem.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
  await kbItem.click();
  await page
    .getByRole("heading", { name: "Add a document" })
    .first()
    .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });

  /* ---- E5 text 文档上传→解析完成 ---- */
  const DOC_TITLE = `风险制度-${runTag}`;
  await runCase(
    page,
    "E5 text 文档：上传→轮询到 Completed 且 chunks ≥1",
    async () => {
      await page
        .locator("label")
        .filter({ hasText: "Title (optional)" })
        .locator("input")
        .fill(DOC_TITLE);
      await page
        .locator("label")
        .filter({ hasText: /^Content/ })
        .locator("textarea")
        .fill(DOC_CONTENT);
      await page.getByRole("button", { name: "Add", exact: true }).click();
      // 行出现（先 Pending/Processing），轮询到 Completed。
      const row = page
        .locator("tbody tr")
        .filter({ hasText: DOC_TITLE })
        .first();
      await row.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      await waitForDocStatus(page, DOC_TITLE, "Completed");
      // chunk 计数 ≥1（"N chunks" 文案）。
      const rowText = await row.innerText();
      const match = rowText.match(/(\d+)\s*chunks?/);
      if (!match || Number.parseInt(match[1] ?? "0", 10) < 1) {
        throw new Error(`行内未见 ≥1 chunks：${rowText.slice(0, 120)}`);
      }
      return `Completed，${match[1]} chunks（真实解析）`;
    },
  );

  /* ---- E6 URL 文档异常（不可达地址→Failed） ---- */
  await runCase(
    page,
    "E6 URL 文档异常：不可达内网地址→文档行最终 Failed",
    async () => {
      const typeSelect = page
        .locator("label")
        .filter({ hasText: /^Type/ })
        .locator("select");
      await typeSelect.selectOption("url");
      const urlInput = page
        .locator("label")
        .filter({ hasText: /^URL/ })
        .locator("input");
      await urlInput.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      // 10.255.255.1：保留网段，必然不可达；kb-mastra 摄取在 docreader 抓取
      // 阶段失败（或 SSRF 拒绝），BullMQ 重试耗尽后落 Failed 终态。
      await urlInput.fill("http://10.255.255.1/robots.txt");
      await page
        .locator("label")
        .filter({ hasText: "Title (optional)" })
        .locator("input")
        .fill(`unreachable-${runTag}`);
      await page.getByRole("button", { name: "Add", exact: true }).click();
      const row = page
        .locator("tbody tr")
        .filter({ hasText: `unreachable-${runTag}` })
        .first();
      await row.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      // 4 次重试 × 指数退避 + 每次超时，Failed 可能要 1-2 分钟；上限 150s。
      const badge = row.locator("span", { hasText: "Failed" }).first();
      const deadline = Date.now() + 150_000;
      while (Date.now() < deadline) {
        if (await badge.isVisible().catch(() => false)) break;
        await page.waitForTimeout(3000);
      }
      if (!(await badge.isVisible().catch(() => false))) {
        const rowText = await row.innerText().catch(() => "(行不存在)");
        throw new Error(
          `150 秒内未到 Failed（重试 ×4 后应死信）；当前行：${rowText.slice(0, 120).replace(/\s+/g, " ")}`,
        );
      }
      return "重试耗尽后 Failed（死信终态）";
    },
  );

  /* ---- E7 空内容异常 ---- */
  await runCase(
    page,
    "E7 空内容异常：Content 留空 Add 被禁，列表不新增",
    async () => {
      const typeSelect = page
        .locator("label")
        .filter({ hasText: /^Type/ })
        .locator("select");
      await typeSelect.selectOption("text");
      const contentArea = page
        .locator("label")
        .filter({ hasText: /^Content/ })
        .locator("textarea");
      await contentArea.waitFor({
        state: "visible",
        timeout: SHORT_TIMEOUT_MS,
      });
      const before = await page.locator("tbody tr").count();
      const add = page.getByRole("button", { name: "Add", exact: true });
      // 空 Content 时按钮禁用（disabled={!content.trim()}）。
      if (!(await add.isDisabled())) {
        throw new Error("空 Content 时 Add 按钮应当禁用（必填校验）");
      }
      const after = await page.locator("tbody tr").count();
      if (after !== before) throw new Error(`行数变化：${before} → ${after}`);
      return "必填禁用生效，列表不变";
    },
  );

  /* ---- E8 检索命中与 miss ---- */
  await runCase(
    page,
    "E8 检索：关键词命中（含 score），无关词 No results",
    async () => {
      const queryInput = page
        .locator("label")
        .filter({ hasText: /^Query/ })
        .locator("input");
      await queryInput.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      await queryInput.fill(DOC_KEYWORD);
      await page.getByRole("button", { name: "Search", exact: true }).click();
      // 结果卡：content 含关键词片段 + score 数字。
      const resultCard = page
        .locator("article")
        .filter({ hasText: DOC_KEYWORD })
        .first();
      await resultCard.waitFor({ state: "visible", timeout: 30000 });
      const scoreText = await resultCard
        .getByText(/score 0\.\d+/)
        .first()
        .innerText();
      // 无关查询：No results 文案。
      await queryInput.fill("量子物理冷聚变");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await page
        .getByText(
          "No matching chunks. Try a different query or add more documents.",
        )
        .first()
        .waitFor({ state: "visible", timeout: 30000 });
      return `命中卡含「${scoreText}」；无关词 No results`;
    },
  );

  /* ---- E9 检索参数控件 ---- */
  await runCase(page, "E9 检索参数：Top K 可改（UI 交互）", async () => {
    const topK = page
      .locator("label")
      .filter({ hasText: "Top K" })
      .locator("input");
    await topK.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    await topK.fill("3");
    const value = await topK.inputValue();
    if (value !== "3") throw new Error(`Top K 改写失败：${value}`);
    // threshold 数字控件也在（可交互即可，不断言结果差异——向量分数不定）。
    const threshold = page
      .locator("label")
      .filter({ hasText: "Score threshold" })
      .locator("input");
    if (!(await threshold.isVisible())) throw new Error("threshold 控件缺失");
    return `Top K=3，threshold 控件在`;
  });

  /* ---- E10 删单文档（确认流） ---- */
  await runCase(page, "E10 删单文档：确认框含标题→确认→行消失", async () => {
    const row = page.locator("tbody tr").filter({ hasText: DOC_TITLE }).first();
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.locator("[role='dialog']").last();
    await dialog
      .getByText("Delete the document below from this knowledge base?")
      .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    await dialog
      .getByText(DOC_TITLE, { exact: true })
      .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: SHORT_TIMEOUT_MS });
    await row.waitFor({ state: "detached", timeout: SHORT_TIMEOUT_MS });
    return `文档「${DOC_TITLE}」已删除`;
  });

  /* ---- E11 批量删除（上传 2 个 + shift 范围选） ---- */
  await runCase(
    page,
    "E11 批量删除：2 文档 shift 全选→Delete 2→空态",
    async () => {
      // 先删掉 E6 留下的 failed 行，保证"上传 2 个→清空回空态"可断言。
      const staleRow = page
        .locator("tbody tr")
        .filter({ hasText: `unreachable-${runTag}` })
        .first();
      if (await staleRow.isVisible().catch(() => false)) {
        await staleRow
          .getByRole("button", { name: "Delete", exact: true })
          .click();
        const confirmDialog = page.locator("[role='dialog']").last();
        await confirmDialog
          .getByRole("button", { name: "Delete", exact: true })
          .click();
        await confirmDialog.waitFor({
          state: "hidden",
          timeout: SHORT_TIMEOUT_MS,
        });
        await staleRow.waitFor({
          state: "detached",
          timeout: SHORT_TIMEOUT_MS,
        });
      }
      // 上传两个小 text 文档（顺序提交，行按创建时间倒序不在意——断言用标题）。
      const titles = [`批量A-${runTag}`, `批量B-${runTag}`];
      for (const title of titles) {
        await page
          .locator("label")
          .filter({ hasText: "Title (optional)" })
          .locator("input")
          .fill(title);
        await page
          .locator("label")
          .filter({ hasText: /^Content/ })
          .locator("textarea")
          .fill(`批量删除测试 ${title}`);
        await page.getByRole("button", { name: "Add", exact: true }).click();
        await page
          .locator("tbody tr")
          .filter({ hasText: title })
          .first()
          .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      }
      // shift 范围选：点首行 checkbox，shift 点末行 checkbox。
      const checkboxes = page.locator('tbody tr [role="checkbox"]');
      const total = await checkboxes.count();
      if (total < 2) throw new Error(`期望 ≥2 行，实际 ${total}`);
      await checkboxes.first().click();
      // shift+click 末行：Checkbox 的 onClick 读 event.shiftKey。
      await checkboxes.nth(total - 1).click({
        modifiers: ["Shift"],
      });
      await page
        .getByText("2 selected")
        .first()
        .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      await page.getByRole("button", { name: "Delete 2", exact: true }).click();
      // 批量删除无确认弹窗（工具栏直删），等空态。
      await page
        .getByText("No documents yet")
        .first()
        .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      return "2 selected → Delete 2 → 空态";
    },
  );

  /* ---- E12 删库（确认流） ---- */
  await runCase(page, "E12 删库：确认框含库名→确认→列表消失", async () => {
    await openKnowledgeList(page);
    const item = page
      .locator("main a[href*='/knowledge/']")
      .filter({ hasText: KB_NAME })
      .first();
    await item.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    // 删除按钮与链接同在 [data-slot=item] 行内（Item 组件统一 slot 标记）。
    const rowContainer = page
      .locator("main [data-slot='item']")
      .filter({
        has: page.locator(`a[href*='/knowledge/']:has-text("${KB_NAME}")`),
      })
      .first();
    await rowContainer.locator("button[aria-label='Delete']").first().click();
    const dialog = page.locator("[role='dialog']").last();
    await dialog
      .getByText(
        `Delete the knowledge base “${KB_NAME}” and all of its documents?`,
      )
      .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    await dialog
      .getByText(KB_NAME, { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: SHORT_TIMEOUT_MS });
    await item.waitFor({ state: "detached", timeout: SHORT_TIMEOUT_MS });
    return `库「${KB_NAME}」已删除`;
  });

  /* ---- E13 删后访问详情（异常） ---- */
  await runCase(page, "E13 删后访问详情：unreachable 文案", async () => {
    const kbId = recordedKbId;
    if (!kbId) throw new Error("未记录本轮 kbId（E2 应捕获）");
    await gotoRetry(page, `${APP_URL}/knowledge/${kbId}`);
    await page
      .getByText("This knowledge base could not be loaded.")
      .first()
      .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    return "已删库详情页显示 unreachable";
  });

  await context.close();
}

/** E2 创建时记录的本轮 kbId（E13 删后直访用）。 */
let recordedKbId: string | null = null;

main().catch(async (error) => {
  log(
    `❌ 套件未能完成：${error instanceof Error ? error.message : String(error)}`,
  );
  await cleanupE2eBases().catch(() => undefined);
  process.exit(2);
});
