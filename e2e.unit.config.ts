import { existsSync } from "node:fs";
import type { E2EConfig } from "e2e";

// e2e 不读 .env；集成测试依赖 DATABASE_URL / OPENAI_* 等变量，显式加载一次。
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

// 单元与集成套件跑在 tools-only target 上：没有 engine，因此不开浏览器、不调用模型。
// UI 套件在 e2e.config.ts（web target），两者用 --config 分开选择。
export default {
  projectId: "openbot-unit",
  tests: [
    "supervisor/tests/names.test.ts",
    "shared/logger.test.ts",
    "worker/tests/env.test.ts",
  ],
  targets: [{ name: "node", platform: "node" }],
  workers: 4,
  timeout: 60_000,
  output: ".e2e/unit",
} satisfies E2EConfig;
