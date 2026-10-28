import { existsSync } from "node:fs";
import { createOpenAI } from "@ai-sdk/openai";
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";
import {
  BA_WEB_TARGET_NAME,
  runBaWebPreflight,
} from "./tests/support/better-auth-preflight.ts";

// e2e 不读 .env；显式加载一次，OPENAI_API_KEY / OPENAI_BASE_URL 才会进入每个 worker（同 e2e.config.ts）。
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

// 套件令牌必须先于 preflight：BA Web 套件文件的守卫靠它识别本配置，worker 重新解析配置时
// 同样先拿到它，再进入任何 engine 创建。
process.env.E2E_ENGINE_SUITE = "better-auth-web";

// engine 创建/导航前的强制 preflight（T04.12 / F4）：缺 BA_E2E_APP_ORIGIN / BA_E2E_API_ORIGIN /
// 身份，或 BA 栈不在，run 在配置加载处非零退出，不开浏览器。`e2e list` 只收集不执行，
// preflight 对其放行，收集面才能被 tests/e2e-browser-isolation.test.ts 与审计枚举。
const baWeb = await runBaWebPreflight();

// 同 e2e.config.ts：.env 的 OPENAI_* 指向智谱（BigModel）的 OpenAI 兼容端点，只有 Chat
// Completions，必须用 .chat()。
const provider = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || undefined,
});

export default {
  projectId: "openbot-ba-web",
  // BA Web 只收 better-auth/web 子树；默认套件（tests/e2e/*.e2e.ts）与本配置互斥，
  // 关系由 tests/config/e2e-engine-suites.json 与 coverage audit 的 --engine-list 共同审计。
  tests: ["tests/e2e/better-auth/web/*.e2e.ts"],
  workers: 1,
  timeout: 120_000,
  agents: {
    default: {
      model: provider.chat(process.env.E2E_MODEL ?? "glm-5.3"),
      system:
        "You are a careful QA agent driving OpenBot's better-auth Web UI. Use the visible English labels and verify the outcome on screen before finishing.",
    },
  },
  targets: [
    {
      name: BA_WEB_TARGET_NAME,
      engine: web({ locale: "en-US" }),
      app: { url: baWeb.appOrigin },
    },
  ],
  // 与默认引擎运行的 .e2e 输出分开，两个入口并行时互不覆盖（同 e2e.unit.config.ts 的理由）。
  output: ".e2e/ba-web",
} satisfies E2EConfig;
