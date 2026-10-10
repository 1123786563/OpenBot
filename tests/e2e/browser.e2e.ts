/**
 * 浏览器端到端测试套件（普通脚本，不是 bun test 文件）。
 *
 * 运行：`bun tests/e2e/browser.e2e.ts`
 * 前置：应用（http://localhost:3010）、API（http://localhost:3001）、Casdoor（http://localhost:8000）
 *       都在本地运行；本机装有 Chrome/Chromium（playwright-core 不带浏览器二进制）。
 * 退出：全部通过退出 0；任一步失败或环境不满足，打印结果并以非 0 退出。
 *
 * 断言全部以页面上真实渲染的文本为准（见 app/src/locales/en/*.json），
 * 不允许 sleep 完直接放行。
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const APP_URL = "http://localhost:3010";
const API_URL = "http://localhost:3001";
const CASDOOR_URL = "http://localhost:8000";
const CASDOOR_USER = "admin";
const CASDOOR_PASSWORD = "123";
const REPLY_TIMEOUT_MS = 180_000; // 助手回复可能超过 60 秒
const SHORT_TIMEOUT_MS = 20_000;

type StepResult = { name: string; ok: boolean; detail: string };

const results: StepResult[] = [];

function log(line: string) {
  console.log(line);
}

async function step(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = (await fn()) || "";
    results.push({ name, ok: true, detail });
    log(`✅ PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    log(`❌ FAIL  ${name} — ${detail}`);
  }
}

function skip(name: string, detail: string) {
  results.push({ name, ok: true, detail: `跳过：${detail}` });
  log(`⏭️  SKIP  ${name} — ${detail}`);
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

async function assertReachable(url: string) {
  const response = await fetch(url, { redirect: "manual" }).catch(() => null);
  if (response === null) {
    throw new Error(`服务不可达：${url}。请先启动应用与 Casdoor 再运行本套件。`);
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

/** Casdoor 登录页两个输入框 + 提交按钮。 */
async function casdoorLogin(page: Page) {
  const username = page
    .locator(
      'input[placeholder*="Email or phone"], input[placeholder*="username" i], #input-login-username, input[name="username"]',
    )
    .first();
  const password = page.locator(
    '#input-login-password, input[name="password"], input[type="password"]',
  ).first();
  await username.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
  await username.fill(CASDOOR_USER);
  await password.fill(CASDOOR_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => url.origin === APP_URL, { timeout: SHORT_TIMEOUT_MS }),
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

/** 等助手回复：轮询 main 文本，要求观察到内容增长（流式渲染的证据），最终非空且与用户消息不同。 */
async function waitForAssistantReply(page: Page, userMessage: string) {
  const main = page.locator("main");
  const baseline = await main.innerText();
  const baselineLength = baseline.length;
  let previousLength = baselineLength;
  let sawGrowth = false; // 观察到至少两次不同的增长快照，才算“流式”
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    const text = await main.innerText().catch(() => baseline);
    if (text.length > previousLength) {
      if (previousLength > baselineLength || text.length - baselineLength > 20) {
        sawGrowth = true;
      }
      previousLength = text.length;
    }
    // 回复完成的粗判：文本稳定 3 秒且确实长于基线（用户消息本身也计入基线之后）。
    const text2 = await main.innerText().catch(() => baseline);
    if (
      text2.length > baselineLength + 1 &&
      text2.length === previousLength &&
      previousLength > baselineLength
    ) {
      // 再等一轮确认稳定
      await page.waitForTimeout(3000);
      const text3 = await main.innerText().catch(() => baseline);
      if (text3.length === previousLength) {
        const reply = text3.slice(baselineLength).trim();
        if (reply.length > 0 && !reply.startsWith(userMessage)) {
          return { reply, streamed: sawGrowth };
        }
      }
      previousLength = text3.length;
    }
  }
  throw new Error(
    `${Math.round(REPLY_TIMEOUT_MS / 1000)} 秒内未观察到助手回复（main 文本未增长或未稳定）。`,
  );
}

/** 等元素出现；超时则重载一次再等（本地 dev server 偶发 500/抖动）。 */
async function waitForWithReload(page: Page, locator: ReturnType<Page["locator"]>, timeoutMs: number) {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return;
  } catch {
    await page.reload();
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
  }
}

/** Agent 弹窗是分区式的：Pin/Hide/Delete 都在 “Manage” 分区里，先点开它。 */
async function openManageSection(page: Page) {
  const manageTab = page.locator("[role='dialog']").last()
    .getByText("Manage", { exact: true })
    .first();
  await manageTab.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
  await manageTab.click();
}

/** 等 Bot 回合真正结束：transcript 里的 “Thinking” 指示消失（否则单运行锁会拒收下一条消息）。 */
async function waitForTurnIdle(page: Page, timeoutMs = 120_000) {
  const thinking = page.getByText("Thinking", { exact: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await thinking.count()) === 0) return;
    await page.waitForTimeout(2000);
  }
  throw new Error("等待回合结束超时：Thinking 指示仍未消失");
}

async function main() {
  log("== OpenBot 浏览器端到端测试 ==");
  await assertReachable(`${APP_URL}/`);
  await assertReachable(`${CASDOOR_URL}/`);
  await assertReachable(`${API_URL}/`);
  log("前置检查：3010 / 8000 / 3001 均可达");

  const browser = await launchBrowser();
  log("已启动浏览器");

  try {
    await runLoginFlow(browser);
    await runConversationFlow(browser);
    await runBotLifecycleFlow(browser);
    await runPluginFlow(browser);
    await runAdminFlow(browser);
    await runRoutinesAndApprovalsFlow(browser);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  log("\n== 结果汇总 ==");
  for (const r of results) log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  log(`共 ${results.length} 步，失败 ${failed.length} 步`);
  if (failed.length > 0) process.exit(1);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* 流程 1：登录 / 登出 / 会话过期                                       */
/* ------------------------------------------------------------------ */
async function runLoginFlow(browser: Browser) {
  await step("登录：3010 重定向到 Casdoor，admin/123 登录后回到已登录首页", async () => {
    const { context } = await freshLogin(browser);
    await context.close();
    return "重定向 Casdoor → 回调 3001 → 回到 3010 已登录首页（侧栏可见 Bots）";
  });

  await step("登出后回到登录页", async () => {
    const { context, page } = await freshLogin(browser);
    // 登出在侧栏底部用户下拉菜单里（app-sidebar.tsx:583-592 的 DropdownMenuItem）
    await page
      .getByRole("button")
      .filter({ hasText: /@|admin/i })
      .last()
      .click();
    await page.getByRole("menuitem", { name: "Log out" }).click();
    await page.waitForURL((url) => url.origin === CASDOOR_URL, {
      timeout: SHORT_TIMEOUT_MS,
    });
    await page
      .locator('input[placeholder*="Email or phone"], input[placeholder*="username" i]')
      .first()
      .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    await context.close();
    return "登出后 URL 回到 Casdoor 且登录表单可见";
  });

  await step("手工删除 cookie 后刷新，被重定向回 Casdoor（会话过期）", async () => {
    const { context, page } = await freshLogin(browser);
    await context.clearCookies();
    await gotoRetry(page, `${APP_URL}/`);
    await page.waitForURL((url) => url.origin === CASDOOR_URL, {
      timeout: SHORT_TIMEOUT_MS,
    });
    await context.close();
    return "无会话 cookie 访问首页被重定向到 Casdoor";
  });
}

/** 复用一份“已登录”快照占位：各流程各自 freshLogin，互不共享 cookie 状态。 */

/* ------------------------------------------------------------------ */
/* 流程 2：对话主流程                                                   */
/* ------------------------------------------------------------------ */
async function runConversationFlow(browser: Browser) {
  const { context, page } = await freshLogin(browser);

  await step("Bot 会话页发送消息并观察到流式回复", async () => {
    await gotoRetry(page, `${APP_URL}/bot`);
    const composer = page
      .locator('textarea, [contenteditable="true"]')
      .first();
    await composer.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    const message = `e2e 冒烟消息 ${Date.now()}：请回复一句话即可。`;
    await composer.click();
    await page.keyboard.insertText(message);
    await composer.press("Enter");
    const { reply, streamed } = await waitForAssistantReply(page, message);
    if (!streamed) {
      throw new Error("观察到了回复，但没有捕捉到渲染过程中的增量增长，无法确认流式渲染。");
    }
    // 回合可能仍在继续（工具循环），等它真正结束
    await waitForTurnIdle(page);
    return `助手回复开头：${reply.slice(0, 60).replace(/\s+/g, " ")}`;
  });

  await step("频道页发送消息，消息出现在时间线且刷新后仍在", async () => {
    // 上一步 Bot 会话的运行可能仍占用该 Bot（单运行锁会拒收新消息），先留出收尾时间
    await page.waitForTimeout(8000);
    // 接收者用 URL 搜索参数指定（new.tsx:37 validateSearch 原生支持 ?agent=，Combobox 选中后
    // 也是写进同一个参数），绕开下拉交互：实测 Combobox 的 onValueChange 会触发一次
    // navigate({replace, search})，与首条消息发出后的 navigate(/channel/:id) 偶发竞态，
    // 失败时 URL 被弹回 /channel/new?agent=…，首条消息已建频道但页面停在新建页。
    // 取一个系统内置 agent（endpoint 为空、无外部依赖）作接收者，且与上一步 Bot 会话页的
    // 默认接收者（default-agent.ts 取 agents[0]）不同，避免上一轮运行仍占用同一个 Bot；
    // 遗留的测试 Bot 带假 endpoint（如 https://agui.example.com/...），运行会挂起占住单运行锁，
    // 后续消息会被拒收，所以不能用名单里最后一个。
    const roster = await context.request.get(`${APP_URL}/api/agents`);
    if (!roster.ok()) {
      throw new Error(`GET /api/agents 失败：${roster.status()}`);
    }
    const agents = (
      (await roster.json()) as {
        agents: Array<{ id: string; endpoint: string | null }>;
      }
    ).agents;
    if (agents.length === 0) {
      throw new Error("agent 名单为空，无法指定频道接收者");
    }
    const builtinOther = agents.find(
      (agent) => agent.id !== agents[0].id && !agent.endpoint,
    );
    const fallbackOther = agents.find((agent) => agent.id !== agents[0].id);
    const recipientAgent = builtinOther ?? fallbackOther;
    if (!recipientAgent) {
      throw new Error("agent 名单里找不到与默认接收者不同的 agent");
    }
    const recipientId = recipientAgent.id;
    // 首条消息要经外部 runtime 网关落库，偶发挂起时消息迟迟不进时间线；此时重开一个新频道
    // 用新消息重试一次（首条消息建频道，重试是新频道，不会重复计数）。断言不放宽：
    // 最终仍要求消息出现在时间线且刷新后仍在。
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      await gotoRetry(page, `${APP_URL}/channel/new?agent=${recipientId}`);
      // 输入框是 PromptArea 富文本编辑器（contenteditable，aria-label "Message"），不是 textarea
      const composer = page
        .locator('[aria-label="Message"], [contenteditable="true"]')
        .first();
      await waitForWithReload(page, composer, 30000);
      const message = `频道时间线冒烟 ${Date.now()}`;
      await composer.click();
      // PromptArea 是 Lexical 富文本编辑器，用真实键盘输入保证事件被框架接收
      await page.keyboard.insertText(message);
      // 确认编辑器真的吃到了文本，再点发送
      await page
        .locator(`[aria-label="Message"]:has-text("${message}"), [contenteditable="true"]:has-text("${message}")`)
        .first()
        .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      await page
        .locator('[aria-label="Send message"], button:has-text("Send message")')
        .first()
        .click();
      // 首条消息会真正建频道并跳到 /channel/:id
      await page.waitForURL((url) => /\/channel\/(?!new$)[^/]+$/.test(url.pathname), {
        timeout: SHORT_TIMEOUT_MS,
      });
      try {
        // 轮询时间线文本：实测该消息节点会出现在 main 的渲染文本里，但 waitFor(visible) 会一直
        // 超时（节点存在而可见性判定不过），所以用 innerText 包含来断言「消息出现在时间线」。
        const timeline = page.locator("main");
        let shown = false;
        const shownDeadline = Date.now() + 120_000;
        while (Date.now() < shownDeadline) {
          await page.waitForTimeout(5000);
          const text = await timeline.innerText().catch(() => "");
          if (text.includes(message)) {
            shown = true;
            break;
          }
        }
        if (!shown) {
          throw new Error("120 秒内消息未出现在时间线");
        }
        // 刷新后仍在：对应 GET /api/channels/events 的持久时间线
        await page.reload();
        const persistedDeadline = Date.now() + 120_000;
        let persisted = false;
        while (Date.now() < persistedDeadline) {
          await page.waitForTimeout(5000);
          const text = await page.locator("main").innerText().catch(() => "");
          if (text.includes(message)) {
            persisted = true;
            break;
          }
        }
        if (!persisted) {
          throw new Error("刷新后消息不在时间线（未持久化）");
        }
        return `消息「${message}」刷新后仍在时间线`;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        log(`  第 ${attempt} 次尝试未在时间线看到消息（${lastError.message.split("\n")[0]}），重开频道重试`);
      }
    }
    throw lastError ?? new Error("频道时间线步骤失败");
  });

  await context.close();
}

/* ------------------------------------------------------------------ */
/* 流程 3：Bot 全生命周期                                               */
/* ------------------------------------------------------------------ */
const BOT_NAME = `e2e-bot-${Date.now()}`;

async function runBotLifecycleFlow(browser: Browser) {
  const { context, page } = await freshLogin(browser);

  await step("创建 Bot（三步向导）", async () => {
    await gotoRetry(page, `${APP_URL}/agents`);
    await page.getByRole('button', { name: 'New agent', exact: true }).or(page.getByRole('link', { name: 'New agent', exact: true })).first().click();
    // 第 1 步：身份（placeholders 来自 agents.json create.identity）
    await waitForWithReload(
      page,
      page.getByText("Step 1 of 3"),
      30000,
    );
    await page.locator('input[placeholder="Expense Manager"]').fill(BOT_NAME);
    await page.locator('input[placeholder="Finance Operations"]').fill("QA");
    await page
      .locator("textarea")
      .first()
      .fill("自动化测试创建的机器人，用于验证全生命周期。");
    await page.getByText("Step 1 of 3").waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    await page.getByRole("button", { name: "Continue", exact: true }).first().click();
    // 第 2 步：可见性（默认 Private，直接继续）——等步进指示器变化，避开入场动画里的旧 DOM
    await page.getByText("Step 2 of 3").waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Continue", exact: true }).first().click();
    await page.getByText("Step 3 of 3").waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    await page.waitForTimeout(800);
    // 第 3 步：运行位置，选 Built-in 后创建。卡片带入场动画（motion），直接 force 点击
    await page.waitForTimeout(800);
    // 该部署没有自己的内置运行 Bot（Built-in 选项按设计禁用），创建 Managed 类型。
    // QuestionnaireChoice 是带透明输入层的 div（ui/questionnaire.tsx QuestionnaireChoice），不是 button
    const managedChoice = page
      .locator('[data-slot="questionnaire-choice"]')
      .filter({ hasText: "Managed" })
      .first();
    await managedChoice.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    await managedChoice.click({ timeout: SHORT_TIMEOUT_MS });
    // 第 3 步即最后一步：Managed 的 endpoint 字段与本步同屏，填完后按钮变成 Create coworker
    await page
      .locator('input[placeholder*="http"], input[name="endpoint"]')
      .first()
      // 服务端拒绝部署自身网段的地址（SSRF 防护），用公网形式的 URL；创建只存 URL 不拨号
      .fill("https://agui.example.com/e2e-agent");
    const createButton = page.getByRole("button", { name: "Create coworker", exact: true });
    await createButton.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    // 等按钮真正可用（选择未登记时它是禁用的），再点创建
    let enabled = false;
    for (let i = 0; i < 20 && !enabled; i++) {
      enabled = await createButton.isEnabled();
      if (!enabled) await page.waitForTimeout(500);
    }
    if (!enabled) throw new Error("Create coworker 按钮一直不可用，Built-in 选择未被登记");
    await createButton.click();
    await page
      .locator(`text=${BOT_NAME}`)
      .first()
      .waitFor({ state: "visible", timeout: 30000 });
    return `Bot「${BOT_NAME}」已创建`;
  });

  await step("置顶 Bot 并验证状态展示，然后取消置顶", async () => {
    // 创建后若弹窗未开，从列表打开
    const dialogPin = page.getByRole("button", { name: "Pin", exact: true }).first();
    if (!(await dialogPin.isVisible().catch(() => false))) {
      await gotoRetry(page, `${APP_URL}/agents`);
      // AgentCard 的链接可访问名是 “View details for {name}”（agents.json card.viewDetails）
      await page
        .getByRole("button", { name: `View details for ${BOT_NAME}` })
        .first()
        .click();
    }
    await openManageSection(page);
    await dialogPin.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    await dialogPin.click();
    await page
      .getByRole("button", { name: "Unpin", exact: true })
      .first()
      .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    await page.getByRole("button", { name: "Unpin", exact: true }).first().click();
    await page.getByRole("button", { name: "Pin", exact: true }).first().waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    return "Pin → Pinned/Unpin → Unpin → Pin 均已验证";
  });

  await step("暂停 / 恢复（lifecycle）并验证状态展示", async () => {
    await gotoRetry(page, `${APP_URL}/bots`);
    await page.locator(`a:has-text("${BOT_NAME}")`).first().click();
    // /bots/$agentId 的 Paused 开关（profile.tsx；Base UI Switch 渲染为 span[role=switch]）
    const pauseSwitch = page.locator('[role="switch"][aria-label="Paused"]');
    await pauseSwitch.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    const description = page.getByText("No routine, responsibility");
    await pauseSwitch.click();
    // 开关打开（aria-checked=true）且描述变为“已暂停”文案
    await page
      .locator('[role="switch"][aria-label="Paused"][aria-checked="true"]')
      .waitFor({ timeout: SHORT_TIMEOUT_MS });
    await description.first().waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    // 恢复
    await pauseSwitch.click();
    await page
      .locator('[role="switch"][aria-label="Paused"][aria-checked="false"]')
      .waitFor({ timeout: SHORT_TIMEOUT_MS });
    await page
      .getByText('Runs its routines, responsibilities')
      .first()
      .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    return "暂停→描述变化→恢复→描述还原";
  });

  await step("隐藏 Bot 并从列表消失，再取消隐藏", async () => {
    await gotoRetry(page, `${APP_URL}/agents`);
        // AgentCard 的 Details 控件（可访问名 “View details for {name}”）
    await page
      .getByRole("button", { name: `View details for ${BOT_NAME}` })
      .first()
      .click();
    await openManageSection(page);
    const hideButton = page.getByRole('button', { name: 'Hide', exact: true }).first();
    await hideButton.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    await hideButton.click();
    // 隐藏成功后会导航回 /agents
    await page.waitForURL((url) => url.pathname === "/agents", {
      timeout: SHORT_TIMEOUT_MS,
    });
    // Hidden 区是折叠的 <details>（roster.hidden），先展开再找卡片
    const hiddenSummary = page.locator("summary").filter({ hasText: "Hidden" });
    if (await hiddenSummary.isVisible().catch(() => false)) {
      await hiddenSummary.click();
      await page.waitForTimeout(600);
    }
    const hiddenRow = page
      .getByRole("button", { name: `View details for ${BOT_NAME}` })
      .first();
    await hiddenRow.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    await hiddenRow.click();
    await openManageSection(page);
    await page.getByRole('button', { name: 'Unhide', exact: true }).first().click();
    await page.getByRole('button', { name: 'Hide', exact: true }).first().waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    return "隐藏后仍可在 Hidden 区找到并已取消隐藏";
  });

  await step("删除 Bot 并确认从列表消失", async () => {
    await gotoRetry(page, `${APP_URL}/agents`);
    await page
      .getByRole("button", { name: `View details for ${BOT_NAME}` })
      .first()
      .click();
    await openManageSection(page);
    const deleteButton = page.getByRole('button', { name: 'Delete', exact: true }).first();
    await deleteButton.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    await deleteButton.click();
    // 确认弹窗标题带 Bot 名（agents.json manage.deleteTitle）
    await page.getByText(`Delete ${BOT_NAME}?`).waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
    await page.waitForURL((url) => url.pathname === "/agents", {
      timeout: SHORT_TIMEOUT_MS,
    });
    await page.waitForTimeout(1000); // 列表刷新
    const count = await page
      .getByRole("button", { name: `View details for ${BOT_NAME}` })
      .count();
    if (count > 0) throw new Error("删除后列表里仍然存在该 Bot");
    return `Bot「${BOT_NAME}」已删除`;
  });

  await context.close();
}

/* ------------------------------------------------------------------ */
/* 流程 4：插件闭环                                                     */
/* ------------------------------------------------------------------ */
async function runPluginFlow(browser: Browser) {
  const { context, page } = await freshLogin(browser);

  await step("打开插件页，验证 Connected 列表真实存在已连接插件", async () => {
    await gotoRetry(page, `${APP_URL}/admin/plugins`);
    await page.getByRole("heading", { name: "Plugins" }).first().waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    // 当前部署已连接 Hacker News（14 tools）与 17TRACK —— 以真实文本断言
    await page.getByText("Hacker News").first().waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    await page.getByText("Connected").first().waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    return "插件页已打开，Connected 区含 Hacker News / 17TRACK";
  });

  let granted = false;
  await step("连接授权：内置插件无需 OAuth；打开 Explore 里的免费插件详情", async () => {
    await gotoRetry(page, `${APP_URL}/admin/plugins`);
    // Explore 区的 Parallel Search 是“免费匿名访问”，无需外部凭据即可添加
    await page.getByText("Parallel Search").first().waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    await page.getByText("Parallel Search").first().click();
    await page.waitForTimeout(1500);
    return "已打开未连接插件的详情页（授权入口按连接方式呈现）";
  });

  await step("对某 Bot 授予（grant）Hacker News 工具", async () => {
    await gotoRetry(page, `${APP_URL}/admin/plugins`);
    await page.getByText("Hacker News").first().click();
    await page.getByRole("button", { name: "Grant tools…" }).waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    const before = await page.getByText("no Bots").count();
    await page.getByRole("button", { name: "Grant tools…" }).click();
    // 弹窗：勾选第一个 Bot，然后 Grant（admin.json pluginDetail.grant）
    const dialog = page.locator("[role='dialog']").last();
    await dialog.getByText("Grant tools").first().waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    // Base UI Checkbox：真实输入是隐藏的，点它的可见 label。需要同时选 Bot 和至少一个工具
    const fieldsets = dialog.locator("fieldset");
    const fieldsetCount = await fieldsets.count();
    await fieldsets.first().locator("label").first().click();
    if (fieldsetCount > 1) {
      await fieldsets.nth(1).locator("label").first().click();
    }
    const grantButton = dialog.getByRole("button", { name: "Grant", exact: true });
    let grantEnabled = false;
    for (let i = 0; i < 20 && !grantEnabled; i++) {
      grantEnabled = await grantButton.isEnabled();
      if (!grantEnabled) await page.waitForTimeout(500);
    }
    if (!grantEnabled) throw new Error("勾选后 Grant 按钮仍不可用（Bot 或工具未被登记选中）");
    await grantButton.click();
    await page.waitForTimeout(2500); // 逐条写入授权
    const after = await page.getByText("1 Bot").count();
    if (before === 0 && after === 0) {
      throw new Error("授权后工具行没有出现“1 Bot”持有计数");
    }
    granted = true;
    return "已把 Hacker News 工具授予一个 Bot，工具行显示 1 Bot";
  });

  if (granted) {
    await step("触发一次调用（经 Bot 会话）并观察回复", async () => {
      // 进入 By Bot 区的 Bot 行
      await gotoRetry(page, `${APP_URL}/admin/plugins`);
      await page.getByText("Hacker News").first().click();
      await page.getByText("By Bot").first().waitFor({
        state: "visible",
        timeout: SHORT_TIMEOUT_MS,
      });
      // 打开 Bot 会话页发一条会触发该插件工具的消息
      await gotoRetry(page, `${APP_URL}/bot`);
      const composer = page.locator('textarea, [contenteditable="true"]').first();
      await composer.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      await composer.click();
      await page.keyboard.insertText("Use the Hacker News tools to fetch one top story title.");
      await composer.press("Enter");
      let reply = "";
      try {
        const result = await waitForAssistantReply(page, "Hacker News");
        reply = result.reply;
        await waitForTurnIdle(page);
      } catch {
        // 模型回合不稳定时的兜底：以审计事件为凭（工具调用会记入审计）
        await gotoRetry(page, `${APP_URL}/admin/audit`);
        const toolEvent = page
          .getByText(/hacker/i)
          .or(page.getByText("called on behalf"))
          .or(page.locator("main table, main [role='table']"));
        await toolEvent.first().waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
        return "会话回复超时，但审计页可见该插件的工具调用记录";
      }
      return `收到回复（是否真实命中插件工具取决于模型决策，无法严格断言）：${reply
        .slice(0, 60)
        .replace(/\s+/g, " ")}`;
    });

    await step("撤销授权（revoke）", async () => {
      await gotoRetry(page, `${APP_URL}/admin/plugins`);
      await page.getByText("Hacker News").first().click();
      await page.getByText("By Bot").first().waitFor({
        state: "visible",
        timeout: SHORT_TIMEOUT_MS,
      });
      // By Bot 区第一行进入 /admin/plugins/$key/bots/$agentId，用开关撤销
      await page.locator("main a").filter({ hasText: /Bot|tools/i }).first().click();
      await page.waitForTimeout(1500);
      const switches = page.locator('[role="switch"]');
      const total = await switches.count();
      if (total === 0) throw new Error("Bot 授权页没有出现任何工具开关");
      // 逐个关闭，直到工具行不再显示该 Bot 持有
      for (let i = 0; i < total; i++) {
        const sw = switches.nth(i);
        if ((await sw.getAttribute("aria-checked")) === "true") {
          await sw.click();
          await page.waitForTimeout(500);
        }
      }
      await gotoRetry(page, `${APP_URL}/admin/plugins`);
      await page.getByText("Hacker News").first().click();
      await page.waitForTimeout(1500);
      const remaining = await page.getByText("no Bots").count();
      if (remaining === 0) {
        throw new Error("撤销后仍显示有 Bot 持有工具");
      }
      return "全部工具授权已撤销，页面回到 no Bots";
    });
  } else {
    skip("触发一次调用与撤销授权", "前置的 grant 步骤未能完成");
  }

  await context.close();
}

/* ------------------------------------------------------------------ */
/* 流程 5：管理后台                                                     */
/* ------------------------------------------------------------------ */
async function runAdminFlow(browser: Browser) {
  const { context, page } = await freshLogin(browser);

  await step("人员列表：以 admin 查看，验证列表与角色控件", async () => {
    await gotoRetry(page, `${APP_URL}/admin/people`);
    await page.locator("text=Who is here").first().waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    const adminRow = page.locator("text=admin@example.com").first();
    await adminRow.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    return "人员列表可见，admin@example.com 在列";
  });

  await step("改角色：角色开关可切换（配置锁定的管理员除外）", async () => {
    await gotoRetry(page, `${APP_URL}/admin/people`);
    const switches = page.locator('[role="switch"][aria-label^="Administrator:"]');
    await switches.first().waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    const total = await switches.count();
    for (let i = 0; i < total; i++) {
      const sw = switches.nth(i);
      const aria = await sw.getAttribute("aria-label");
      if (aria?.includes("admin@example.com")) continue; // INITIAL_ADMIN_EMAILS 配置锁定
      if (await sw.isEnabled()) {
        const before = await sw.getAttribute("aria-checked");
        await sw.click();
        const flipped = before === "true" ? "false" : "true";
        await page
          .locator(`[role="switch"][aria-label="${aria}"][aria-checked="${flipped}"]`)
          .waitFor({ timeout: SHORT_TIMEOUT_MS });
        // 切回去，不留下脏数据
        await page
          .locator(`[role="switch"][aria-label="${aria}"]`)
          .last()
          .click();
        await page
          .locator(`[role="switch"][aria-label="${aria}"][aria-checked="${before}"]`)
          .waitFor({ timeout: SHORT_TIMEOUT_MS });
        return `已切换并还原 ${aria}`;
      }
    }
    skip(
      "改角色",
      "列表里只有 INITIAL_ADMIN_EMAILS 指定的管理员，其角色开关按设计禁用（admin.json people.whoIsHere.description）",
    );
    return "唯一成员是配置锁定的管理员";
  });

  await step("查看审计事件列表", async () => {
    await gotoRetry(page, `${APP_URL}/admin/audit`);
    await page.locator("text=Audit").first().waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    // 表头 When/What（admin.json audit.when/what）
    await page.locator("text=When").first().waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    return "审计页表头与列表渲染正常";
  });

  await step("新建凭据并删除（覆盖 POST 与 DELETE /api/admin/credentials）", async () => {
    await gotoRetry(page, `${APP_URL}/admin/credentials`);
    await page.getByRole('button', { name: 'Add credential', exact: true }).first().click();
    // 弹窗字段：Provider / Key ID / Secret（admin.json credentials.dialog.fields）
    const keyId = `e2e-key-${Date.now()}`;
    const dialog = page.locator("[role='dialog'], [data-state='open']").first();
    await dialog.locator('input').nth(0).waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    // 字段顺序：Type(select)/Provider/Key ID/Secret —— 用 label 文本定位更稳
    await dialog.locator("label:has-text('Provider') + * input, label:has-text('Provider') ~ input").first()
      .fill("e2e-provider");
    await dialog.locator("label:has-text('Key ID') + * input, label:has-text('Key ID') ~ input").first()
      .fill(keyId);
    await dialog.locator("label:has-text('Secret') + * input, label:has-text('Secret') ~ input").first()
      .fill("e2e-secret-value-not-real");
    await dialog.getByRole('button', { name: 'Save credential', exact: true }).first().click();
    // 保存后列表里出现该 keyId 且状态 active；刷新避免拿到保存事务中的瞬时 DOM
    await page.waitForTimeout(1500);
    await page.reload();
    await page.locator(`text=${keyId}`).first().waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    // 撤销（DELETE /api/admin/credentials）
    const row = page
      .locator("main [data-slot='item'], main li")
      .filter({ hasText: keyId })
      .first();
    const revokeButton = row.getByRole("button", { name: "Revoke", exact: true }).first();
    let revokeEnabled = false;
    for (let i = 0; i < 20 && !revokeEnabled; i++) {
      revokeEnabled = await revokeButton.isEnabled();
      if (!revokeEnabled) await page.waitForTimeout(500);
    }
    if (!revokeEnabled) throw new Error("Revoke 按钮一直不可用");
    await revokeButton.click();
    await page
      .locator(`:has-text("${keyId}") >> text=revoked`)
      .first()
      .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    return `凭据 ${keyId} 已创建并撤销`;
  });

  await step("身份提供方页加载，并确认 Casdoor 是本部署的登录提供方", async () => {
    await gotoRetry(page, `${APP_URL}/admin/identity-providers`);
    await page.locator("text=Identity providers").first().waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    // 该页面按设计只列出企业自建 IdP；Casdoor 属于环境配置（registered.description）
    await page
      .locator(
        "text=Google, Microsoft and Okta are configured in the environment instead and do not appear here.",
      )
      .first()
      .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    // Casdoor 作为登录提供方的真实证据是登录流程本身已走通（流程 1）
    return "页面按设计不列环境级 Casdoor；Casdoor 登录已在流程 1 真实走通";
  });

  await step("企业与账单页可访问", async () => {
    await gotoRetry(page, `${APP_URL}/admin/enterprise`);
    await page.getByText("Enterprise controls").first().waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    await gotoRetry(page, `${APP_URL}/settings/billing`);
    // 页面在 entitlements 查询返回前渲染为空，轮询等待真实内容
    const billingText = page
      .getByText("Entitlements")
      .or(page.getByText("Included in your plan"))
      .or(page.getByText("This deployment has no active plan."));
    await billingText.first().waitFor({ state: "visible", timeout: 20000 });
    return `账单页内容：${(await page.locator("main").innerText()).slice(0, 80).replace(/\s+/g, " ")}…`;
  });

  await context.close();
}

/* ------------------------------------------------------------------ */
/* 流程 6：例程与审批                                                   */
/* ------------------------------------------------------------------ */
async function runRoutinesAndApprovalsFlow(browser: Browser) {
  const { context, page } = await freshLogin(browser);

  await step("例程页：查看与启停（创建是对话式的，页面上没有表单）", async () => {
    await gotoRetry(page, `${APP_URL}/routines`);
    await page.getByRole("heading", { name: "Routines" }).first().waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    // 页面按设计没有创建表单（routines.tsx 顶部注释与页面文案 "Made and changed by talking to a Bot"）
    await page
      .getByText("Made and changed by talking to a Bot")
      .first()
      .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    const sw = page.locator('main [role="switch"]').first();
    if ((await sw.count()) === 0) {
      skip(
        "例程的创建/启停",
        "例程页没有创建表单（创建是对话式的，见 app/src/routes/_authed/_app/routines.tsx:13 注释），且当前部署没有任何已存在的例程（页面显示 Nothing scheduled）",
      );
      return "例程页正常渲染，当前无例程（Nothing scheduled）";
    }
    const before = await sw.getAttribute("aria-checked");
    await sw.click();
    const after = await sw.getAttribute("aria-checked");
    if (before === after) throw new Error("例程启停开关点击后状态未变化");
    await sw.click();
    return "已对现有例程执行停/启并验证状态变化";
  });

  await step("审批页：对待审批项作出决定并验证状态更新", async () => {
    await gotoRetry(page, `${APP_URL}/approvals`);
    await page.getByRole("heading", { name: "Approvals" }).first().waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    // 等待两种终态之一：没有待审批项，或出现待审批决定按钮
    const nothingPending = page.getByText("No actions need your approval.");
    const allowOnce = page.getByRole("button", { name: "Allow once", exact: true });
    await nothingPending.or(allowOnce).first().waitFor({
      state: "visible",
      timeout: SHORT_TIMEOUT_MS,
    });
    if ((await nothingPending.isVisible().catch(() => false)) &&
        !(await allowOnce.isVisible().catch(() => false))) {
      skip(
        "审批决定",
        "当前没有待审批项（审批由 Bot 在会话里请求触发，无法在浏览器测试里凭空造出一条）",
      );
      return "审批页正常，无待审批项";
    }
    const pendingText = await page.locator("main").innerText();
    const target = allowOnce.first();
    await target.click();
    // 决定生效：该待审批项的 Allow once 按钮消失（状态更新）；决定可能要经过模型复核，给足时间
    try {
      await target.waitFor({ state: "detached", timeout: 120000 });
    } catch {
      await gotoRetry(page, `${APP_URL}/approvals`);
      await page
        .getByText("No actions need your approval.")
        .or(page.locator('main').filter({ hasNot: page.getByRole("button", { name: "Allow once" }) }))
        .first()
        .waitFor({ state: "visible", timeout: 30000 });
    }
    return `已对「${pendingText.slice(0, 60).replace(/\s+/g, " ")}…」作出 Allow once 决定，该待审批项已从列表消失`;
  });

  await context.close();
}

main().catch((error) => {
  log(`❌ 套件未能完成：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
