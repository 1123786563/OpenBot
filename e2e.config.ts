import { existsSync } from "node:fs";
import { createOpenAI } from "@ai-sdk/openai";
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

// e2e 不读 .env；显式加载一次，OPENAI_API_KEY / OPENAI_BASE_URL 才会进入每个 worker。
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

// .env 的 OPENAI_* 指向智谱（BigModel）的 OpenAI 兼容端点；E2E_MODEL 可临时换模型。
// 该端点只有 Chat Completions、没有 Responses API，所以必须用 .chat()（默认 provider() 会打 /responses 拿 404）。
const provider = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || undefined,
});

export default {
  projectId: "openbot",
  tests: ["tests/e2e/*.e2e.ts"],
  // 全部测试共享同一个本地栈（单 Postgres、默认 Bot 的单运行锁），保持串行。
  workers: 1,
  agents: {
    default: {
      model: provider.chat(process.env.E2E_MODEL ?? "glm-5.3"),
      system:
        "You are a careful QA agent driving OpenBot's web UI. Use the visible English labels and verify the outcome on screen before finishing.",
    },
  },
  targets: [
    {
      engine: web({ locale: "en-US" }),
      app: { url: "http://localhost:3010" },
    },
  ],
} satisfies E2EConfig;
