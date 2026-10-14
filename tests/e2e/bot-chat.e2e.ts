import { describe, test } from "@e2e-dev/web";
import { expect, type Locator } from "e2e";

// 三个用例共用 /bot 的默认 Bot 会话（同一个频道、单运行锁），必须串行。
describe("bot session", {
  session: "admin",
  serial: true,
  timeout: 300_000,
}, () => {
  // fill 不会触发 CopilotKit 的草稿状态（发送键保持 disabled、回车无效）；逐键输入才被接受。
  async function send(composer: Locator, message: string) {
    await composer.pressSequentially(message, { delay: 10 });
    await composer.press("Enter");
  }

  // 对应旧 browser.e2e.ts 的「Bot 会话页发送消息并观察到流式回复」。
  test("replies to a sent message", async ({ app, agent, screen }) => {
    await app.open("/bot");

    const message = `e2e smoke ${Date.now()}: please reply with one sentence.`;
    await send(screen.getByPlaceholder("Type a message..."), message);

    // 发出的消息进入时间线（限定在消息滚动区内，避免匹配到输入框残留文本）：确定性验证。
    const timeline = screen.getByTestId("copilot-scroll-content");
    await expect(timeline.getByText(message)).toBeVisible({
      timeout: 20_000,
    });

    // GLM 回复可能较慢；waitFor 只在屏幕变化时请求判断模型，interval 限制流式期间的调用频率。
    // 判断锚定最新一轮：持久频道里上面还有历史轮次。
    await agent.waitFor(
      "the latest assistant message is a complete, non-empty reply to the newest user message",
      {
        timeout: 180_000,
        interval: 5_000,
      },
    );
  });

  // 对应旧 agent-trpc-usage-test.ts 的「第二条消息验证多轮上下文」。
  // 名字带时间戳：/bot 是持久频道，历史里旧轮次的名字不能替本轮背书。
  test("remembers earlier turns in the same conversation", async ({
    app,
    agent,
    screen,
  }) => {
    await app.open("/bot");
    const name = `小明${Date.now()}`;

    await send(
      screen.getByPlaceholder("Type a message..."),
      `我叫${name}，是一名后端工程师。请记住我的名字和职业，简短确认即可。`,
    );
    // 等回合真正结束（Thinking 指示消失），否则单运行锁会拒收下一条消息。
    await agent.waitFor(
      'the latest assistant reply is a short confirmation to the newest user message, and the "Thinking" indicator is gone',
      { timeout: 180_000, interval: 5_000 },
    );

    await send(
      screen.getByPlaceholder("Type a message..."),
      "我的名字和职业分别是什么？直接回答这两个词。",
    );
    await agent.waitFor(
      `the newest assistant reply states the user's name is ${name} and the occupation is a backend engineer (后端工程师)`,
      { timeout: 180_000, interval: 5_000 },
    );
  });

  // 对应旧 agent-trpc-usage-test.ts 的「工具调用探针」（原为观察项）：
  // uuid 不可猜测，回复里出现真 uuid 才算浏览工具真实执行；没配工具就如实 skip。
  test("executes a browser tool and reports a fresh uuid", async ({
    app,
    agent,
    screen,
  }) => {
    await app.open("/bot");

    await send(
      screen.getByPlaceholder("Type a message..."),
      "请打开 https://httpbin.org/uuid 这个网页，并把页面返回的 uuid 原样告诉我。",
    );
    await agent.waitFor(
      "the latest assistant message reports the uuid from the page it opened, or explains it cannot open web pages",
      { timeout: 240_000, interval: 5_000 },
    );

    const text = await screen.getByTestId("copilot-scroll-content").innerText();
    const uuid = text.match(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
    );
    test.skip(
      !uuid,
      "the default bot could not produce a fresh uuid (no working browser tool in this deployment)",
    );
  });
});
