import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// 对应旧 browser.e2e.ts 的「Bot 会话页发送消息并观察到流式回复」：
// 发送用确定性定位器（CopilotKit textarea 的英文 placeholder），回复完成交给 agent.waitFor 判断。
test("bot session replies to a sent message", {
  session: "admin",
  timeout: 300_000,
}, async ({ app, agent, screen }) => {
  await app.open("/bot");

  const composer = screen.getByPlaceholder("Type a message...");
  const message = `e2e smoke ${Date.now()}: please reply with one sentence.`;
  // fill 不会触发 CopilotKit 的草稿状态（发送键保持 disabled、回车无效）；逐键输入才被接受。
  await composer.pressSequentially(message, { delay: 10 });
  await composer.press("Enter");

  // 发出的消息进入时间线（限定在消息滚动区内，避免匹配到输入框残留文本）：确定性验证。
  const timeline = screen.getByTestId("copilot-scroll-content");
  await expect(timeline.getByText(message)).toBeVisible({ timeout: 20_000 });

  // GLM 回复可能较慢；waitFor 只在屏幕变化时请求判断模型，interval 限制流式期间的调用频率。
  await agent.waitFor(
    "the assistant has replied with a complete, non-empty message",
    {
      timeout: 180_000,
      interval: 5_000,
    },
  );
});
