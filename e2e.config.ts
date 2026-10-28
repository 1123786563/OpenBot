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

// 默认套件的引擎套件令牌（T04.12）：BA 套件守卫凭它识别“运行的不是 better-auth 配置”。
process.env.E2E_ENGINE_SUITE = "default";

export default {
  projectId: "openbot",
  // 默认引擎套件只收 tests/e2e/*.e2e.ts，显式拒绝 better-auth 子树（T04.12）：BA Web 浏览器
  // 套件有自己的配置 e2e.better-auth.config.ts（bun run test:ui:better-auth），互斥关系由
  // tests/config/e2e-engine-suites.json 登记并经 coverage audit --engine-list 审计；文件被显式
  // 传给本配置时 runner 以 NO_TESTS 非零拒绝，被误收集时套件守卫再拦一次。
  tests: ["tests/e2e/*.e2e.ts", "!tests/e2e/better-auth/**"],
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
