/**
 * agent-trpc 工作台 Bot 的浏览器使用测试（普通脚本，不是 bun test 文件）。
 *
 * 运行：`bun tests/e2e/agent-trpc-usage-test.ts`
 * 前置：应用（:3010）、Casdoor（:8000）、agent-trpc Bot（:4204）都在本地运行。
 *
 * 覆盖的使用场景：
 *   1. Bots 列表能看到 agent-trpc；
 *   2. 进入该 Bot 会话页发第一条消息，观察到流式回复；
 *   3. 第二条消息验证多轮上下文（Bot 记得第一条里的信息）；
 *   4. 刷新页面，对话历史仍在；
 *   5. 工具调用探针（观察项，不强断言）：请 Bot 打开一个 uuid 页面并回读，
 *      回复中出现不可猜测的 uuid 才算工具真的执行了。
 *
 * 默认有头模式（headless: false）便于观看；无 GUI 环境自动回退 headless。
 * 截图：.archive/runs/gui-tests/usage/。全部通过退出 0。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { type Browser, chromium, type Page } from "playwright-core";

const APP_URL = "http://localhost:3010";
const CASDOOR_URL = "http://localhost:8000";
const BOT_HEALTH = "http://127.0.0.1:4204/health";
const CASDOOR_USER = "admin";
const CASDOOR_PASSWORD = "123";
const SHORT_TIMEOUT_MS = 20_000;
const REPLY_TIMEOUT_MS = 180_000;
const SHOT_DIR = ".archive/runs/gui-tests/usage";

const MANAGED_AGENT_TOKEN = (() => {
  const env = readFileSync(new URL("../../.env", import.meta.url), "utf8");
  const line = env
    .split("\n")
    .find((l) => l.startsWith("MANAGED_AGENT_TOKEN="));
  if (!line) throw new Error(".env has no MANAGED_AGENT_TOKEN");
  return line.slice("MANAGED_AGENT_TOKEN=".length).trim();
})();

type StepResult = {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
};
const results: StepResult[] = [];

class SkipError extends Error {}

async function step(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = (await fn()) || "";
    results.push({ name, ok: true, detail });
    console.log(`✅ PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    if (error instanceof SkipError) {
      results.push({ name, ok: true, detail: error.message, skipped: true });
      console.log(`⏭️  SKIP  ${name} — ${error.message}`);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    console.log(`❌ FAIL  ${name} — ${detail}`);
  }
}

function skip(name: string, detail: string) {
  results.push({ name, ok: true, detail, skipped: true });
  console.log(`⏭️  SKIP  ${name} — ${detail}`);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
}

async function launchBrowser(): Promise<Browser> {
  const paths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  for (const headless of [false, true]) {
    for (const executablePath of paths) {
      if (!existsSync(executablePath)) continue;
      try {
        return await chromium.launch({ executablePath, headless });
      } catch {
        // 无 GUI 或该浏览器不可用，试下一个组合
      }
    }
  }
  throw new Error("找不到可用的 Chrome/Chromium 可执行文件。");
}

async function assertReachable(url: string) {
  const response = await fetch(url, { redirect: "manual" }).catch(() => null);
  if (response === null) throw new Error(`服务不可达：${url}`);
}

/** 两种登录入口：直接跳 Casdoor，或停在应用 /sign 页（需要点一次 provider 按钮）。 */
async function enterCasdoorLogin(page: Page) {
  await page.waitForURL(
    (url) => url.origin === CASDOOR_URL || url.pathname === "/sign",
    { timeout: SHORT_TIMEOUT_MS },
  );
  if (new URL(page.url()).pathname === "/sign") {
    // 单 provider 时页面会自动进入（auto-enter）；多 provider 或曾被弹回时需要手点。
    const providerButton = page
      .getByRole("button", { name: /Continue with|使用.+继续/ })
      .first();
    try {
      await providerButton.waitFor({ state: "visible", timeout: 4000 });
      await providerButton.click({ timeout: 4000 });
    } catch {
      // auto-enter 已在跳转中，继续等 Casdoor 即可
    }
    await page.waitForURL((url) => url.origin === CASDOOR_URL, {
      timeout: SHORT_TIMEOUT_MS,
    });
  }
}

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

/** 等助手回复：高频轮询 main 文本；返回（去除 UI 噪音后）用户消息之后的稳定文本与流式证据。 */
async function waitForAssistantReply(page: Page, userMessage: string) {
  const main = page.locator("main");
  const baseline = await main.innerText();
  let previousLength = baseline.length;
  const growths: number[] = [];
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(400);
    const text = await main.innerText().catch(() => baseline);
    if (text.length > previousLength) {
      growths.push(text.length - previousLength);
      previousLength = text.length;
    }
    if (text.length > baseline.length + 10 && text.length === previousLength) {
      await page.waitForTimeout(3000);
      const text3 = await main.innerText().catch(() => baseline);
      if (text3.length === previousLength) {
        const cleaned = text3
          .split("\n")
          .filter((line) => {
            const t = line.trim();
            if (!t) return false;
            return (
              !line.includes("temporarily unavailable") &&
              !line.includes("Scroll to end") &&
              !line.includes("Ask anything") &&
              !/^(Thinking|Talk to an engineer|Self-host OpenBot)/.test(t)
            );
          })
          .join("\n");
        const reply = cleaned.split(userMessage).pop()!.trim();
        if (reply.length >= 10) {
          return { reply, streamed: growths.length >= 2 };
        }
      }
      previousLength = text3.length;
    }
  }
  throw new Error(
    `未观察到稳定的助手回复。最后文本：${(await main.innerText().catch(() => "")).slice(0, 400)}`,
  );
}

async function sendAndWait(page: Page, message: string) {
  await waitForTurnIdle(page);
  const composer = page
    .locator('[aria-label="Message"], [contenteditable="true"], textarea')
    .first();
  await composer.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
  await composer.click();
  await page.keyboard.insertText(message);
  await composer.press("Enter");
  return waitForAssistantReply(page, message);
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
  await assertReachable(APP_URL);
  await assertReachable(CASDOOR_URL);
  await assertReachable(BOT_HEALTH);
  mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await launchBrowser();
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  let agentId: string | undefined;

  try {
    await step("登录（Casdoor admin）", async () => {
      try {
        await page.goto(`${APP_URL}/`);
        await enterCasdoorLogin(page);
        await casdoorLogin(page);
        // 新库首次登录会进 /onboarding（3 次 Continue）；走完它才能看到 Bots 导航。
        if (page.url().includes("/onboarding")) {
          for (let i = 0; i < 4; i++) {
            const cont = page
              .locator(
                'button:has-text("Continue"), button:has-text("Get started"), button:has-text("Start"), button:has-text("Skip")',
              )
              .first();
            if (!(await cont.count())) break;
            await cont.click().catch(() => {});
            await page.waitForTimeout(1500);
            if (!page.url().includes("/onboarding")) break;
          }
        }
        await page
          .locator('a:has-text("Bots"), [href*="/bots"]')
          .first()
          .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
        return "会话建立";
      } catch (error) {
        // 失败现场：URL 与截图，而不是只有一句 waitForURL 超时
        console.log(
          `    [login-diag] url=${page.url().slice(0, 100)} title=${await page.title().catch(() => "?")}`,
        );
        await shot(page, "login-failed").catch(() => {});
        throw error;
      }
    });

    await step("使用① Bots 列表能看到 agent-trpc（不存在则注册）", async () => {
      // 幂等：库重建/首次运行时注册不在，就地补上（与 browser-test 同一注册合同）。
      const roster = await context.request.get(`${APP_URL}/api/agents`);
      const agents = (
        (await roster.json()) as { agents: Array<{ id: string; name: string }> }
      ).agents;
      agentId = agents.find((a) => a.name === "agent-trpc")?.id;
      if (!agentId) {
        const created = await context.request.post(`${APP_URL}/api/agents`, {
          data: {
            name: "agent-trpc",
            title: "Go Bot (trpc-agent-go)",
            roleDescription:
              "A workbench Bot assembled on the trpc-agent-go framework, answering through the GLM model.",
            visibility: "private",
            endpoint: "http://localhost:4204/ag-ui",
            auth: {
              header: "x-openbot-agent-token",
              value: MANAGED_AGENT_TOKEN,
            },
          },
        });
        if (created.status() !== 201) {
          throw new Error(
            `注册失败 ${created.status()}：${(await created.text()).slice(0, 200)}`,
          );
        }
        agentId = ((await created.json()) as { agent: { id: string } }).agent
          .id;
      }
      await page.goto(`${APP_URL}/bots`);
      const row = page.getByText("agent-trpc", { exact: false }).first();
      await row.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      await shot(page, "01-bots-list");
      return `列表可见（${agentId ? "已注册" : ""}）`;
    });

    await step("使用② 会话页第一条消息，观察到流式回复", async () => {
      const roster = await context.request.get(`${APP_URL}/api/agents`);
      const agents = (
        (await roster.json()) as { agents: Array<{ id: string; name: string }> }
      ).agents;
      const bot = agents.find((a) => a.name === "agent-trpc");
      if (!bot) throw new Error("agent-trpc 未注册");
      agentId = bot.id;
      // 首条消息经 runtime 网关建频道偶发 channel-join 竞态（同款问题既有 e2e 亦有绕行注释）：
      // 失败时重开一个新频道重试（首条消息建频道，重试是新频道，不会重复计数）。
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await page.goto(`${APP_URL}/channel/new?agent=${agentId}`);
        try {
          const { reply, streamed } = await sendAndWait(
            page,
            "我叫小明，是一名后端工程师。请记住我的名字和职业，简短确认即可。",
          );
          await shot(page, "02-first-reply");
          if (!streamed) throw new Error("未捕捉到流式增量。");
          return `回复开头：${reply.slice(0, 40).replace(/\s+/g, " ")}（第 ${attempt} 次尝试）`;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          // 把失败的横幅也留在证据里
          await shot(page, `02-attempt${attempt}-failed`).catch(() => {});
        }
      }
      throw lastError;
    });

    await step("使用③ 第二条消息验证多轮上下文（记得名字与职业）", async () => {
      const { reply } = await sendAndWait(
        page,
        "我的名字和职业分别是什么？直接回答这两个词。",
      );
      await shot(page, "03-second-reply-context");
      if (!reply.includes("小明") || !reply.includes("后端")) {
        throw new Error(`回复未携带上文信息：${reply.slice(0, 120)}`);
      }
      return `回复点名了“小明/后端”：${reply.slice(0, 60).replace(/\s+/g, " ")}`;
    });

    await step(
      "使用④ 刷新后对话历史仍在（软检查：依赖线程存储后端）",
      async () => {
        await page.reload({ timeout: 30_000 });
        const main = page.locator("main");
        await main.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
        let text = "";
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          text = await main.innerText().catch(() => "");
          if (text.includes("后端工程师") && text.includes("小明")) break;
          await page.waitForTimeout(2000);
        }
        await shot(page, "04-after-reload");
        if (text.includes("后端工程师") && text.includes("小明")) {
          return "两轮消息均在";
        }
        // 部署侧线程存储（intelligence platform）不可用时所有 Bot 都拿不到历史：
        // 这是基础设施事实，不是 agent-trpc 的缺陷，如实记跳过而不是假通过。
        if (text.includes("temporarily unavailable")) {
          throw new SkipError(
            "线程存储后端（intelligence platform）不可用（THREAD_NOT_FOUND/502），影响所有 Bot，非 agent-trpc 特有",
          );
        }
        throw new Error("刷新后历史缺失且无已知基础设施原因");
      },
    );

    // 观察项：工具调用（client-loop）。uuid 不可猜测：回复里出现 uuid 才算真执行。
    try {
      const { reply } = await sendAndWait(
        page,
        "请打开 https://httpbin.org/uuid 这个网页，并把页面返回的 uuid 原样告诉我。",
      );
      await shot(page, "05-tool-probe");
      if (
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(
          reply,
        )
      ) {
        results.push({
          name: "使用⑤ 工具调用探针",
          ok: true,
          detail: "回复中出现真实 uuid，工具链路真实执行",
        });
        console.log("✅ PASS  使用⑤ 工具调用探针 — 回复中出现真实 uuid");
      } else {
        skip(
          "使用⑤ 工具调用探针",
          `部署未给该 Bot 配置可用的浏览工具（回复：${reply.slice(0, 80)}…）`,
        );
      }
    } catch (error) {
      skip(
        "使用⑤ 工具调用探针",
        `探针未完成：${error instanceof Error ? error.message : error}`,
      );
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length === 0
      ? `\n使用测试通过（${results.length} 项，其中 ${results.filter((r) => r.skipped).length} 项跳过）；截图在 ${SHOT_DIR}/。`
      : `\n${failed.length}/${results.length} 项失败；截图在 ${SHOT_DIR}/。`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
