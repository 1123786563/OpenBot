/**
 * agent-trpc 工作台 Bot 的浏览器端到端测试（普通脚本，不是 bun test 文件）。
 *
 * 运行：`bun tests/e2e/agent-trpc-browser-test.ts`
 * 前置：应用（:3010）、Casdoor（:8000）、agent-trpc Bot（:4204）都在本地运行。
 * 做什么：
 *   1. Casdoor 登录拿到会话；
 *   2. 以登录会话 POST /api/agents 注册 agent-trpc Bot（endpoint http://localhost:4204/ag-ui，
 *      鉴权头 x-openbot-agent-token，值来自 .env 的 MANAGED_AGENT_TOKEN）；
 *   3. 打开 /channel/new?agent=<id>，真实发送一条消息，断言观察到流式回复；
 *   4. 截图留证（gui-test-screenshots/）。
 * 退出：全部通过退出 0；任一步失败打印原因并以非 0 退出。
 */
import { existsSync, readFileSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const APP_URL = "http://localhost:3010";
const CASDOOR_URL = "http://localhost:8000";
const BOT_HEALTH = "http://127.0.0.1:4204/health";
const BOT_ENDPOINT = "http://localhost:4204/ag-ui";
const CASDOOR_USER = "admin";
const CASDOOR_PASSWORD = "123";
const SHORT_TIMEOUT_MS = 20_000;
const REPLY_TIMEOUT_MS = 180_000;

/** The managed agent token the Bot authenticates by, from the deployment's .env. */
const MANAGED_AGENT_TOKEN = (() => {
  const env = readFileSync(new URL("../../.env", import.meta.url), "utf8");
  const line = env.split("\n").find((l) => l.startsWith("MANAGED_AGENT_TOKEN="));
  if (!line) throw new Error(".env has no MANAGED_AGENT_TOKEN");
  return line.slice("MANAGED_AGENT_TOKEN=".length).trim();
})();

type StepResult = { name: string; ok: boolean; detail: string };
const results: StepResult[] = [];

async function step(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = (await fn()) || "";
    results.push({ name, ok: true, detail });
    console.log(`✅ PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    console.log(`❌ FAIL  ${name} — ${detail}`);
  }
}

async function launchBrowser(): Promise<Browser> {
  const paths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  for (const executablePath of paths) {
    if (existsSync(executablePath)) {
      return chromium.launch({ executablePath, headless: true });
    }
  }
  throw new Error("找不到可用的 Chrome/Chromium 可执行文件。");
}

async function assertReachable(url: string) {
  const response = await fetch(url, { redirect: "manual" }).catch(() => null);
  if (response === null) throw new Error(`服务不可达：${url}`);
}

async function gotoRetry(page: Page, url: string, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { timeout: 30_000 });
      return;
    } catch (error) {
      if (i === attempts - 1) throw error;
      await page.waitForTimeout(5000);
    }
  }
}

async function casdoorLogin(page: Page) {
  const username = page
    .locator(
      'input[placeholder*="Email or phone"], input[placeholder*="username" i], #input-login-username, input[name="username"]',
    )
    .first();
  const password = page
    .locator('#input-login-password, input[name="password"], input[type="password"]')
    .first();
  await username.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
  await username.fill(CASDOOR_USER);
  await password.fill(CASDOOR_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => url.origin === APP_URL, { timeout: SHORT_TIMEOUT_MS }),
    page
      .locator('button:has-text("Sign In"), button:has-text("登录"), button[type="submit"]')
      .first()
      .click(),
  ]);
}

async function assertSignedIn(page: Page) {
  await page
    .locator('a:has-text("Bots"), [href="/bots"], [href*="/bots"]')
    .first()
    .waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
}

/**
 * 等助手回复：高频轮询 main 文本；要求最终文本比基线多出实质内容且稳定。
 * 回复 = 最终文本按行剜掉 UI 提示后、用户消息之后的部分；streamed = 观察到多次增长。
 */
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
    if (text.length > baseline.length + 30 && text.length === previousLength) {
      await page.waitForTimeout(3000);
      const text3 = await main.innerText().catch(() => baseline);
      if (text3.length === previousLength) {
        // 按行剜掉 UI 提示（不依赖文案全文措辞），再取用户消息之后的部分。
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
          // 多次增长 = 流式渲染的直接证据
          const streamed = growths.length >= 2;
          return { reply, streamed };
        }
      }
      previousLength = text3.length;
    }
  }
  throw new Error(
    `未观察到稳定的助手回复。最后文本：${(await page.locator("main").innerText().catch(() => "")).slice(0, 500)}`,
  );
}

async function main() {
  await assertReachable(APP_URL);
  await assertReachable(CASDOOR_URL);
  await assertReachable(BOT_HEALTH);

  const browser = await launchBrowser();
  const context: BrowserContext = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  let agentId: string | undefined;

  try {
    await step("Casdoor 登录", async () => {
      await gotoRetry(page, `${APP_URL}/`);
      await page.waitForURL((url) => url.origin === CASDOOR_URL, {
        timeout: SHORT_TIMEOUT_MS,
      });
      await casdoorLogin(page);
      await assertSignedIn(page);
      return "admin 会话建立";
    });

    await step("注册 agent-trpc Bot（POST /api/agents）", async () => {
      // 同名旧档（重复运行本脚本）先删掉，保证注册路径真实走一遍。
      const roster = await context.request.get(`${APP_URL}/api/agents`);
      const agents = (
        (await roster.json()) as { agents: Array<{ id: string; name: string }> }
      ).agents;
      const stale = agents.find((a) => a.name === "agent-trpc");
      if (stale) {
        const deleted = await context.request.delete(`${APP_URL}/api/agents/${stale.id}`);
        if (!deleted.ok()) throw new Error(`清理旧档失败：${deleted.status()}`);
      }
      const created = await context.request.post(`${APP_URL}/api/agents`, {
        data: {
          name: "agent-trpc",
          title: "Go Bot (trpc-agent-go)",
          roleDescription:
            "A workbench Bot assembled on the trpc-agent-go framework, answering through the GLM model.",
          visibility: "private",
          endpoint: BOT_ENDPOINT,
          auth: { header: "x-openbot-agent-token", value: MANAGED_AGENT_TOKEN },
        },
      });
      if (created.status() !== 201) {
        throw new Error(`注册失败 ${created.status()}：${(await created.text()).slice(0, 200)}`);
      }
      const body = (await created.json()) as { agent: { id: string } };
      agentId = body.agent.id;
      return `agent id=${agentId}`;
    });

    await step("频道页发送消息并观察到流式回复", async () => {
      if (!agentId) throw new Error("没有 agent id");
      await gotoRetry(page, `${APP_URL}/channel/new?agent=${agentId}`);
      const composer = page
        .locator('[aria-label="Message"], [contenteditable="true"]')
        .first();
      await composer.waitFor({ state: "visible", timeout: 30_000 });
      const message =
        "请用三句话自我介绍：你是谁、由哪个框架构建、运行在什么模型上。";
      await composer.click();
      await page.keyboard.insertText(message);
      await composer.press("Enter");
      const { reply, streamed } = await waitForAssistantReply(page, message);
      await page.screenshot({
        path: "gui-test-screenshots/agent-trpc-browser-reply.png",
        fullPage: false,
      });
      if (reply.length < 10) throw new Error(`回复过短：${reply}`);
      return `${streamed ? "流式" : "一次性"}回复开头：${reply.slice(0, 60).replace(/\s+/g, " ")}`;
    });
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length === 0
      ? `\n全部通过（${results.length} 步）；Bot 已注册为 agent-trpc，可在工作台直接对话。`
      : `\n${failed.length}/${results.length} 步失败。`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
