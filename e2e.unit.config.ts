import { existsSync } from "node:fs";
import type { E2EConfig } from "e2e";

// e2e 不读 .env；集成测试依赖 DATABASE_URL / OPENAI_* 等变量，显式加载一次。
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

// 单元与集成套件跑在 tools-only target 上：没有 engine，因此不开浏览器、不调用模型。
// UI 套件在 e2e.config.ts（web target），两者用 --config 分开选择。
// e2e 的 glob 不支持花括号，只能一种扩展名一条；node_modules 必须排除，否则会收集依赖包自带的测试。
//
// E2E_UNIT_SCOPE=app,server 只收集这些目录：整套收集一次要几分钟，改一个套件时用它把回合压到秒级。
const ALL = [
  "shared",
  "supervisor",
  "worker",
  "deliverables",
  "desktop",
  "agent-bot",
  "agent-sandbox",
  "agent-langgraph",
  "agent-mastra",
  "agent-computer",
  "app",
  "server",
  "tests",
  "scripts",
];
const scope = (process.env.E2E_UNIT_SCOPE ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const unknown = scope.filter((name) => !ALL.includes(name));
if (unknown.length) {
  throw new Error(`E2E_UNIT_SCOPE names no suite directory: ${unknown.join(", ")}`);
}
const suites = scope.length ? scope : ALL;

export default {
  projectId: "openbot-unit",
  tests: [
    ...suites.flatMap((dir) =>
      dir === "app"
        ? ["app/**/*.test.ts", "app/**/*.test.tsx"]
        : [`${dir}/**/*.test.ts`],
    ),
    "!**/node_modules/**",
  ],
  targets: [{ name: "node", platform: "node" }],
  workers: 4,
  timeout: 60_000,
  output: ".e2e/unit",
} satisfies E2EConfig;
