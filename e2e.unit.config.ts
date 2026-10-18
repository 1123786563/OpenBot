import { existsSync, readFileSync } from "node:fs";
import { SUITE_DIRS } from "./scripts/lib/e2e-manifest.mjs";
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
// 目录清单与 scripts/e2e-coverage-audit.mjs 的核对面共用一个事实源，两侧不可能各跑各的。
const ALL = SUITE_DIRS;
const scope = (process.env.E2E_UNIT_SCOPE ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const unknown = scope.filter((name) => !ALL.includes(name));
if (unknown.length) {
  throw new Error(
    `E2E_UNIT_SCOPE names no suite directory: ${unknown.join(", ")}`,
  );
}
const suites = scope.length ? scope : ALL;

// 留在 Bun 运行时上的套件由 tests/bun-suites.test.ts 代为调度与报告，这里必须排除它们，
// 否则同一份测试既被驱动一次又被收集一次。清单来自逐文件收集审计（scripts/e2e-bun-manifest.mjs）。
/*
 * Suites this repository cannot load at all right through no fault of the runner: their own fixture
 * moved. `e2e` aborts a whole run at the first uncollectable file, so they are excluded here and
 * named in docs/verification/e2e-known-broken.json — `bun run test:ci` prints the count, and the
 * entry disappears when whoever owns that suite repoints it.
 */
const broken: string[] = (() => {
  const path = "docs/verification/e2e-known-broken.json";
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    entries?: { file: string }[];
  };
  return (parsed.entries ?? []).map((entry) => entry.file);
})();

const driven = (() => {
  const path = "docs/verification/e2e-bun-suites.json";
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    files?: string[];
    artifacts?: string[];
  };
  return [...(parsed.files ?? []), ...(parsed.artifacts ?? [])];
})();

/*
 * Suites that only mean something against a running deployment. They are excluded from
 * `bun run test` the way the smoke journey already is, because a developer or CI job without the
 * stack up gets 43 connection failures that look like product regressions and are not. The suite
 * keeps its assertions intact: `bun run test:api` (or OPENBOT_LIVE_API=1) runs it against
 * OPENBOT_API_BASE_URL.
 */
const LIVE = ["tests/e2e/api.e2e.test.ts"];
const liveWanted = Boolean(process.env.OPENBOT_LIVE_API);

export default {
  projectId: "openbot-unit",
  tests: [
    ...suites.flatMap((dir) =>
      dir === "app"
        ? ["app/**/*.test.ts", "app/**/*.test.tsx"]
        : [`${dir}/**/*.test.ts`],
    ),
    "!**/node_modules/**",
    ...(liveWanted ? [] : LIVE.map((file) => `!${file}`)),
    ...driven.map((file) => `!${file}`),
    ...broken.map((file) => `!${file}`),
  ],
  targets: [{ name: "node", platform: "node" }],
  workers: 4,
  timeout: 60_000,
  // Sessions run concurrently in this checkout, and a second `e2e run` writing the same directory
  // overwrites the first one's report. A measurement names its own output.
  output: process.env.E2E_UNIT_OUTPUT ?? ".e2e/unit",
} satisfies E2EConfig;
