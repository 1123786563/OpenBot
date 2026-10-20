# 可观测性 P1（统一 logger + 请求跟踪）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** server 与 worker 的全部日志经 pino 统一为 JSON 单行输出，主 app 与企业版 app 每个响应带 `x-request-id`、每条 API 请求有 access log，`.logs` 不再被覆盖。

**Architecture:** 新建 `shared/logger.ts`（pino 封装，按相对路径导入）；新建 `server/src/telemetry/request-tracking.ts`（requestId + access log 中间件，AsyncLocalStorage 存请求上下文）；Biome `noConsole` 规则锁住成果。本轮无 OTel、无新基础设施组件。

**Tech Stack:** Bun 1.3 workspaces、Hono 4、pino 9+、pino-pretty（仅 TTY）、Biome 2.5、bun:test。

**Spec:** `docs/specs/superpowers/2026-10-10-observability-design.md` §3.1、§3.2、§4、§5-P1、§6-P1

## Global Constraints

- `shared/` 不是 workspace 包，按**相对路径**导入，深度相关：从 `server/src/index.ts` 是 `../../shared/logger`，从 `server/src/telemetry/request-tracking.ts` 是 `../../../shared/logger`，从 `worker/src/index.ts` 是 `../../shared/logger`。
- 仓库 lint 是 **Biome**（`bun run lint` = `bunx biome lint --error-on-warnings .`），没有 ESLint；规则在根 `biome.json`。
- 工作树有 lago/tenancy 的未提交改动：**每步只 `git add` 本任务点名的文件**，禁止 `git add -A` / `git add .`。
- 日志落 stdout，JSON 单行；新增代码一律走 logger，禁止裸 `console.*`（Task 5 起由 Biome 强制）。本计划不引入任何 OpenTelemetry 包。
- 级别环境变量：`LOG_LEVEL`（别名 `OPENBOT_LOG_LEVEL`），非法值回退 `info`。
- 脱敏对齐 TEN-22：日志不输出原始 DB 报错、token、密钥；沿用现有 `type: "xxx-error"` 事件命名作为字段。
- 验证命令规避已知红门禁（`typecheck:enterprise` 因 mobile 会话问题当前红）：用 `cd server && bun run typecheck` 与定向 `bun test`；`bun run lint` 若暴露与本计划无关的存量告警，只对本计划文件负责。
- 若仓库锁文件是 `bun.lockb` 而非 `bun.lock`，提交步骤里相应替换文件名。

---

### Task 1: shared/logger（pino 封装）与依赖

**Files:**
- Create: `shared/logger.ts`
- Test: `shared/logger.test.ts`
- Modify: `server/package.json`、`worker/package.json`（依赖）、`bun.lock`

**Interfaces:**
- Produces: `export type Logger = pino.Logger`；`export function createLogger(service: string, stream?: pino.DestinationStream): Logger`；`export function getLogger(service: string): Logger`（按 service 记忆化，走 stdout）；`export function readLogLevel(raw: string | undefined, fallback: pino.Level): pino.Level`。后续所有任务经 `getLogger("<service>")` 取 logger；测试经 `createLogger(service, captureStream)` 注入捕获流。

- [ ] **Step 1: 安装依赖**

```bash
cd /Users/wuyongjun/trea/OpenBot/server && bun add pino && bun add -d pino-pretty
cd /Users/wuyongjun/trea/OpenBot/worker && bun add pino && bun add -d pino-pretty
```

记录 pino 实际解析版本（`grep '"pino"' server/package.json worker/package.json`），后续文档引用该版本。

- [ ] **Step 2: 写失败测试** `shared/logger.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createLogger, getLogger, readLogLevel } from "./logger";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines };
}

describe("the shared logger", () => {
  test("emits single-line JSON carrying the service name", () => {
    const { stream, lines } = capture();
    const log = createLogger("test-service", stream);
    log.info("hello");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.service).toBe("test-service");
    expect(record.level).toBe(30); // info
    expect(lines[0]!.endsWith("\n")).toBe(true);
  });

  test("a child logger carries the request id alongside the service", () => {
    const { stream, lines } = capture();
    const log = createLogger("test-service", stream);
    log.child({ request_id: "req_1" }).warn("during request");
    const record = JSON.parse(lines[0]!);
    expect(record.request_id).toBe("req_1");
    expect(record.service).toBe("test-service");
  });

  test("level comes from env-style input and unknown values fall back", () => {
    expect(readLogLevel("debug", "info")).toBe("debug");
    expect(readLogLevel(" WARN ", "info")).toBe("warn");
    expect(readLogLevel(undefined, "info")).toBe("info");
    expect(readLogLevel("", "info")).toBe("info");
    expect(readLogLevel("LOUD", "info")).toBe("info");
  });

  test("getLogger memoises per service", () => {
    expect(getLogger("memo-test")).toBe(getLogger("memo-test"));
    expect(getLogger("memo-test")).not.toBe(getLogger("memo-other"));
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test shared/logger.test.ts`
Expected: FAIL（`Cannot find module './logger'` 之类）

- [ ] **Step 4: 实现** `shared/logger.ts`

```ts
/**
 * The one logger every OpenBot process shares. pino underneath, JSON one line per
 * record on stdout, so `docker logs`, `.logs/*.log` and a future collector all read
 * the same shape. A TTY gets pino-pretty instead, because a developer's terminal is
 * not a log sink. Service names ("server", "worker", …) distinguish processes that
 * would otherwise interleave identically-shaped lines in a shared `docker logs`.
 *
 * Per-request context (request_id, trace_id) is attached with `.child(...)`, never
 * by string interpolation — the sweep that adopts this logger moves interpolated
 * values into structured fields (see the P1 plan's transformation rules).
 */
import pino from "pino";

export type Logger = pino.Logger;

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace"]);

export function readLogLevel(
  raw: string | undefined,
  fallback: pino.Level,
): pino.Level {
  const candidate = raw?.trim().toLowerCase();
  return candidate && LEVELS.has(candidate)
    ? (candidate as pino.Level)
    : fallback;
}

export function createLogger(
  service: string,
  stream?: pino.DestinationStream,
): Logger {
  const level = readLogLevel(
    process.env.LOG_LEVEL ?? process.env.OPENBOT_LOG_LEVEL,
    "info",
  );
  const pretty =
    !stream && process.stdout.isTTY && process.env.OPENBOT_LOG_FORMAT !== "json"
      ? pino.transport({
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          },
        })
      : stream;
  return pino({ level, base: { service } }, pretty);
}

const memo = new Map<string, Logger>();

export function getLogger(service: string): Logger {
  let logger = memo.get(service);
  if (!logger) {
    logger = createLogger(service);
    memo.set(service, logger);
  }
  return logger;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test shared/logger.test.ts`
Expected: 4 PASS

- [ ] **Step 6: 类型检查**

Run: `cd server && bun run typecheck`
Expected: 通过（server tsconfig 覆盖 `../shared` 的导入）

- [ ] **Step 7: Commit**

```bash
cd /Users/wuyongjun/trea/OpenBot
git add shared/logger.ts shared/logger.test.ts server/package.json worker/package.json bun.lock
git commit -m "feat(observability): shared pino logger with service base and level env"
```

---

### Task 2: 请求跟踪中间件（requestId + access log）

**Files:**
- Create: `server/src/telemetry/request-tracking.ts`
- Test: `server/tests/request-tracking.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Logger`（`../../../shared/logger`，注意深度）。
- Produces: `export type RequestTrackingVariables = { requestId?: string }`；`export function currentRequestId(): string | undefined`（AsyncLocalStorage）；`export function requestScopedLogger(root: Logger): Logger`（无请求上下文时原样返回 root）；`export function createRequestTracking(options: { logger: Logger }): { requestId: MiddlewareHandler; accessLog: MiddlewareHandler }`。requestId 中间件：入站 `x-request-id` 满足 `^[A-Za-z0-9._-]{8,128}$` 则沿用，否则生成 UUID，写回响应头；accessLog 中间件打一行 `info`：`{ method, path, status, duration_ms }`，message 为 `"request"`，经 `requestScopedLogger` 自动带 `request_id`。Task 3/6 直接注册这两个中间件。

- [ ] **Step 1: 写失败测试** `server/tests/request-tracking.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Hono } from "hono";
import { createLogger } from "../../shared/logger";
import {
  createRequestTracking,
  currentRequestId,
} from "../src/telemetry/request-tracking";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function miniApp(logger = createLogger("test", capture().stream)) {
  const tracking = createRequestTracking({ logger });
  const app = new Hono<{ Variables: { requestId?: string } }>();
  app.use("/api/*", tracking.requestId);
  app.use("/api/*", tracking.accessLog);
  app.get("/api/ping", (c) => c.json({ requestId: currentRequestId() }));
  app.get("/health", (c) => c.json({ status: "ok" }));
  return app;
}

describe("request tracking", () => {
  test("mints a request id, echoes it back, and the handler sees the same one", async () => {
    const response = await miniApp().request("/api/ping");
    const requestId = response.headers.get("x-request-id");
    expect(requestId ?? "").toMatch(UUID);
    expect((await response.json()).requestId).toBe(requestId);
  });

  test("reuses a well-formed inbound x-request-id", async () => {
    const response = await miniApp().request("/api/ping", {
      headers: { "x-request-id": "client-trace-42" },
    });
    expect(response.headers.get("x-request-id")).toBe("client-trace-42");
  });

  test("replaces a malformed inbound id with a minted one", async () => {
    const response = await miniApp().request("/api/ping", {
      headers: { "x-request-id": "bad id with spaces" },
    });
    expect(response.headers.get("x-request-id") ?? "").toMatch(UUID);
  });

  test("the access log line carries method, path, status, duration and request id", async () => {
    const { stream, lines } = capture();
    await miniApp(createLogger("test", stream)).request("/api/ping");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.msg).toBe("request");
    expect(record.method).toBe("GET");
    expect(record.path).toBe("/api/ping");
    expect(record.status).toBe(200);
    expect(record.duration_ms).toBeTypeOf("number");
    expect(record.request_id ?? "").toMatch(UUID);
  });

  test("probes outside /api are not access-logged", async () => {
    const { stream, lines } = capture();
    await miniApp(createLogger("test", stream)).request("/health");
    expect(lines).toHaveLength(0);
  });

  test("outside a request there is no ambient request id", () => {
    expect(currentRequestId()).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test server/tests/request-tracking.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `server/src/telemetry/request-tracking.ts`

```ts
/**
 * Per-request correlation for the main deployment app: every response carries an
 * `x-request-id`, and every log emitted while a request is in flight can pick that
 * id up through the ambient store instead of threading a parameter through every
 * handler. The id is server-minted unless the caller sent a well-formed one, so a
 * hostile header cannot smuggle junk into Loki; that matches the tenancy plan's
 * rule (TEN-22) that logs correlate by server-generated ids.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Logger } from "../../../shared/logger";

export type RequestTrackingVariables = { requestId?: string };

const INBOUND_ID = /^[A-Za-z0-9._-]{8,128}$/;

const requestStore = new AsyncLocalStorage<{ requestId: string }>();

export function currentRequestId(): string | undefined {
  return requestStore.getStore()?.requestId;
}

export function requestScopedLogger(root: Logger): Logger {
  const requestId = currentRequestId();
  return requestId ? root.child({ request_id: requestId }) : root;
}

export function createRequestTracking(options: {
  logger: Logger;
}): {
  requestId: MiddlewareHandler<{ Variables: RequestTrackingVariables }>;
  accessLog: MiddlewareHandler<{ Variables: RequestTrackingVariables }>;
} {
  const requestId: MiddlewareHandler<{ Variables: RequestTrackingVariables }> =
    async (context, next) => {
      const inbound = context.req.header("x-request-id");
      const id =
        inbound && INBOUND_ID.test(inbound) ? inbound : randomUUID();
      context.header("x-request-id", id);
      context.set("requestId", id);
      await requestStore.run({ requestId: id }, next);
    };

  const accessLog: MiddlewareHandler<{
    Variables: RequestTrackingVariables;
  }> = async (context, next) => {
    const start = performance.now();
    let status = 0;
    try {
      await next();
      status = context.res.status;
    } finally {
      // Logs even when a handler throws, so 5xx requests keep their access line;
      // an unhandled error surfaces as Hono's 500 fallback.
      requestScopedLogger(options.logger).info(
        {
          method: context.req.method,
          path: context.req.path,
          status: status || 500,
          duration_ms: Math.round(performance.now() - start),
        },
        "request",
      );
    }
  };

  return { requestId, accessLog };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test server/tests/request-tracking.test.ts`
Expected: 6 PASS

- [ ] **Step 5: 类型检查**

Run: `cd server && bun run typecheck`
Expected: 通过

- [ ] **Step 6: Commit**

```bash
cd /Users/wuyongjun/trea/OpenBot
git add server/src/telemetry/request-tracking.ts server/tests/request-tracking.test.ts
git commit -m "feat(observability): request id and access log middleware for Hono"
```

---

### Task 3: 主 app 接线与进程级错误路径

**Files:**
- Modify: `server/src/app.ts`（createApp 内 cors 块之后，约 490 行附近）
- Modify: `server/src/index.ts`（unhandledRejection 处理器，约 1015-1035 行）

**Interfaces:**
- Consumes: Task 1 `getLogger`、Task 2 `createRequestTracking`。
- Produces: 主 app 所有响应带 `x-request-id`；`/api/*` 每请求一条 access log；进程级兜底错误经 logger 输出（保留 `type` 事件字段）。无新增导出。

- [ ] **Step 1: 写失败测试**（加到 `server/tests/request-tracking.test.ts` 末尾）

```ts
describe("the main deployment app", () => {
  test("carries x-request-id on a plain route", async () => {
    const { createApp } = await import("../src/app");
    const { loadConfig } = await import("../src/config");
    const app = createApp(loadConfig(testEnvironment()));
    const response = await app.request("/health");
    expect(response.headers.get("x-request-id") ?? "").toMatch(UUID);
  });
});
```

文件顶部补一个 import：`import { testEnvironment } from "./support/environment";`（仓库既有测试支撑，参考 `server/tests/agent-callback-token.test.ts` 的用法；若 `testEnvironment` 的实参签名不同，按该文件同款调用改写此行——其余断言不变）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test server/tests/request-tracking.test.ts`
Expected: 新用例 FAIL（响应无 `x-request-id`）

- [ ] **Step 3: 在 createApp 注册中间件**

`server/src/app.ts`：createApp 函数体内，cors 注册块（`app.use("/api/*", cors(...))` 的 `if` 之后、`mountDesktopConnectionFailure(app, desktopHostToken);` 之前）插入：

```ts
// Correlation first: every response carries x-request-id, and /api requests get an
// access log line with that id on it. Registered before any route so sub-apps
// mounted later inherit the ambient request id for their own logs.
const tracking = createRequestTracking({ logger: getLogger("server") });
app.use("*", tracking.requestId);
app.use("/api/*", tracking.accessLog);
```

顶部 import 区补：

```ts
import { getLogger } from "../../shared/logger";
import { createRequestTracking } from "./telemetry/request-tracking";
```

- [ ] **Step 4: unhandledRejection 接 logger**

`server/src/index.ts` 的 unhandledRejection 处理器（约 1015-1035 行，现为 `console.error(JSON.stringify({ type: "unhandled-rejection", ... }))` 风格）：保留处理器的结构与后续逻辑，把打日志那几行换成：

```ts
getLogger("server").error(
  {
    type: "unhandled-rejection",
    reason:
      reason instanceof Error
        ? { message: reason.message, stack: reason.stack }
        : String(reason),
  },
  "unhandled rejection",
);
```

并在顶部 import 区补 `import { getLogger } from "../../shared/logger";`。若处理器里还有别的字段被 stringify，把它们原样并入对象字面量（保持 `type` 字段名不变）。

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test server/tests/request-tracking.test.ts && cd server && bun run typecheck`
Expected: 全部 PASS、类型检查通过

- [ ] **Step 6: 回归主测试面**

Run: `bun test server/tests`
Expected: 既有用例无新增失败（与本改动无关的既有失败按基线记录，不在本任务修）

- [ ] **Step 7: Commit**

```bash
cd /Users/wuyongjun/trea/OpenBot
git add server/src/app.ts server/src/index.ts server/tests/request-tracking.test.ts
git commit -m "feat(observability): wire request tracking and process error logging into the main app"
```

---

### Task 4: server/src 存量 console 全量清扫

**Files:**
- Modify: `server/src/**/*.ts`（约 62 个非测试文件、~150 处；`server/scripts/**` 本轮不动——那是集群 CronJob 脚本）

**Interfaces:**
- Consumes: Task 1 `getLogger`。
- Produces: `server/src` 内零裸 `console.*`；每处日志变结构化字段。无新增导出。

- [ ] **Step 1: 列出全部现场**

```bash
grep -rn "console\.\(log\|error\|warn\|info\)" /Users/wuyongjun/trea/OpenBot/server/src --include="*.ts"
```

按文件逐个处理，处理完一个文件就在清单上划掉一个。

- [ ] **Step 2: 按固定映射改写**（pino 约定：字段对象在前，message 在后）

| 现状 | 改为 |
|---|---|
| `console.log("msg")` | `log.info("msg")` |
| `console.error("msg", err)` | `log.error({ err }, "msg")` |
| `` console.info(`worker status: ${s}`) `` | `log.info({ status: s }, "worker status")` |
| `console.error(JSON.stringify({ type: "x-route-error", ...rest }))` | `log.error({ type: "x-route-error", ...rest }, "x-route-error")` |

每个文件顶部加 `import { getLogger } from "<相对深度>/shared/logger";` 与 `const log = getLogger("server");`（与其他 import 排序一致）。`err` 字段直接放 Error 对象（pino 默认对 `err` 键做序列化，含 message/stack；本任务**不改** `shared/logger.ts`）。

脱敏红线：原语句若输出的是完整 DB 错误、第三方 API 响应体或 token，改写时按 TEN-22 只留 `{ message }` 或领域字段，不照搬。

- [ ] **Step 3: 验证清零**

Run: `grep -rn "console\." /Users/wuyongjun/trea/OpenBot/server/src --include="*.ts" | wc -l`
Expected: `0`

- [ ] **Step 4: 回归**

Run: `cd server && bun run typecheck && cd .. && bun test server/tests`
Expected: 类型通过；测试与基线一致（无新增失败）

- [ ] **Step 5: Commit**

```bash
cd /Users/wuyongjun/trea/OpenBot
git add server/src
git commit -m "refactor(observability): route all server logging through the shared logger"
```

（`git add server/src` 只会带上本任务改过的文件——若有本任务之外的同目录脏文件，逐个点名添加。）

---

### Task 5: worker 清扫 + Biome noConsole 上锁

**Files:**
- Modify: `worker/src/index.ts`（~6 处 console）及 `worker/src/**` 其余命中
- Modify: `biome.json`

**Interfaces:**
- Consumes: Task 1 `getLogger`（worker 侧相对路径 `../../shared/logger`）。
- Produces: Biome 规则：`server/src/**`、`worker/src/**` 内 `noConsole: "error"`；tests override 内 `noConsole: "off"`。此后 CI lint 会拒绝新增裸 console。

- [ ] **Step 1: worker 清扫**

```bash
grep -rn "console\." /Users/wuyongjun/trea/OpenBot/worker/src --include="*.ts"
```

按 Task 4 Step 2 的同一套规则改写。映射表（pino 约定：字段对象在前，message 在后）：

| 现状 | 改为 |
|---|---|
| `console.log("msg")` | `log.info("msg")` |
| `console.error("msg", err)` | `log.error({ err }, "msg")` |
| `` console.info(`worker status: ${s}`) `` | `log.info({ status: s }, "worker status")` |
| `console.error(JSON.stringify({ type: "x-error", ...rest }))` | `log.error({ type: "x-error", ...rest }, "x-error")` |

文件顶部 `import { getLogger } from "../../shared/logger";`、`const log = getLogger("worker");`。首行状态日志（`console.info(\`OpenBot worker status: ${workerStatus().status}\`)`）改为：

```ts
log.info({ status: workerStatus().status }, "worker status");
```

- [ ] **Step 2: 验证清零**

Run: `grep -rn "console\." /Users/wuyongjun/trea/OpenBot/worker/src --include="*.ts" | wc -l`
Expected: `0`

- [ ] **Step 3: biome.json 加规则**

`overrides` 数组追加：

```json
{
  "includes": ["server/src/**", "worker/src/**"],
  "linter": {
    "rules": {
      "suspicious": {
        "noConsole": "error"
      }
    }
  }
}
```

同时在既有的 tests override（`includes: ["**/tests/**", "**/*.test.ts", "**/*.test.tsx"]`）的 `rules` 里补：

```json
"suspicious": {
  "noConsole": "off"
}
```

- [ ] **Step 4: lint 验证**

Run: `bunx biome lint --error-on-warnings server/src worker/src shared`
Expected: 通过（故意在任一文件临时加一行 `console.log("x")` 应得到报错，验证后删除——验证这一步是规则生效的证据）

- [ ] **Step 5: 回归 + Commit**

Run: `bun test worker && cd server && bun run typecheck`

```bash
cd /Users/wuyongjun/trea/OpenBot
git add worker/src biome.json
git commit -m "refactor(observability): worker logs through shared logger; enforce noConsole in server/worker src"
```

---

### Task 6: 企业版 app 复用请求 ID

**Files:**
- Modify: `server/src/enterprise/app.ts`（createEnterpriseApp 内，约 67-86 行 onError）

**Interfaces:**
- Consumes: Task 2 `createRequestTracking`、`currentRequestId`。
- Produces: 企业版 app（独立运行与被挂载两种形态）响应带 `x-request-id`；onError 复用中间件的 ID，只有中间件缺席时才自生成；`logRedactedSecurityError` 的调用不变。

- [ ] **Step 1: 修改 createEnterpriseApp**

`app.onError(...)` 之前注册中间件；onError 首行改为复用：

```ts
const tracking = createRequestTracking({ logger: getLogger("enterprise") });
app.use("*", tracking.requestId);

app.onError((error, c) => {
  // The middleware already minted and echoed the id for any request that reached it;
  // onError is the fallback for paths that somehow skipped it (and for the mounted
  // case the ambient store still holds the main app's id).
  const requestId = currentRequestId() ?? crypto.randomUUID();
  c.header("x-request-id", requestId);
  // …其余保持原样（asEnterpriseError / status / code / logRedactedSecurityError / 响应体）
```

import 区补 `getLogger`（`../../../shared/logger`）与 `createRequestTracking, currentRequestId`（`../telemetry/request-tracking`）。

- [ ] **Step 2: 验证**

Run: `cd server && bun run typecheck`
Expected: 通过（含 `src/enterprise`，默认 tsconfig 覆盖）

Run: `bun test server/tests/enterprise`（若既有失败为基线，记录不修）
Expected: 无新增失败

- [ ] **Step 3: Commit**

```bash
cd /Users/wuyongjun/trea/OpenBot
git add server/src/enterprise/app.ts
git commit -m "feat(observability): enterprise app reuses the tracked request id"
```

---

### Task 7: start.sh 追加式日志 + LOG_LEVEL 样例

**Files:**
- Modify: `scripts/start.sh`（三处重定向：migrate ≈262 行、server 两分支 ≈349/353 行、worker ≈380 行）
- Modify: `.env.example`（`OPENBOT_OTEL_EXPORT` 附近，≈551-558 行）

**Interfaces:**
- Consumes: 无。
- Produces: `.logs/*.log` 追加不覆盖；`LOG_LEVEL` 有文档样例。

- [ ] **Step 1: 三处 `>` 改 `>>`**

`>"$LOGS/migrate.log"` → `>>"$LOGS/migrate.log"`；两处 `>"$LOGS/server.log"` → `>>"$LOGS/server.log"`；一处 `>"$LOGS/worker.log"` → `>>"$LOGS/worker.log"`。注释各加一行理由（collector tail 依赖文件连续性，覆盖会让 Alloy/人工丢历史）。

- [ ] **Step 2: .env.example 增补**

在 `OPENBOT_OTEL_EXPORT` 条目旁加：

```bash
# Log level for every OpenBot process (fatal|error|warn|info|debug|trace). Alias: OPENBOT_LOG_LEVEL.
LOG_LEVEL=info
```

- [ ] **Step 3: 验证**

Run: `bash -n scripts/start.sh && grep -c '>>"$LOGS/' scripts/start.sh`
Expected: 语法通过；计数 ≥ 4（migrate+server 两分支+worker）

- [ ] **Step 4: Commit**

```bash
cd /Users/wuyongjun/trea/OpenBot
git add scripts/start.sh .env.example
git commit -m "fix(observability): append host process logs instead of truncating; document LOG_LEVEL"
```

---

### Task 8: 约定文档与收尾

**Files:**
- Create: `reference/observability.md`
- Modify: `reference/development.md`（加一节指向 observability.md）

**Interfaces:**
- Consumes: Task 1 记录的 pino 版本；Task 5 的 lint 规则。
- Produces: 团队日志约定文档（级别语义、字段约定、脱敏红线、查看路径）。

- [ ] **Step 1: 写 `reference/observability.md`**

内容必须覆盖以下小节（写成仓库正式文档风格，正文用这里给定的要点展开）：

```markdown
# 可观测性约定

## 日志
- 统一经 `shared/logger`（pino <版本>），新代码禁止裸 console（Biome noConsole 强制，范围 server/src、worker/src）。
- 级别语义：error=需要人看的失败；warn=自动恢复但值得知道；info=请求/状态变化；debug=排查细节。默认 info，`LOG_LEVEL` 调整（别名 OPENBOT_LOG_LEVEL）。
- 固定字段：`service`（进程名）；请求内日志自动带 `request_id`；事件型错误沿用 `type: "xxx-…-error"` 命名。
- 脱敏红线（TEN-22）：不输出原始 DB 报错、token、密钥；第三方失败只留 message 与领域字段。
- 查看：本地 `.logs/*.log` 用 `jq`（如 `tail -f .logs/server.log | jq 'select(.level>=50)'`）；TTY 开发态自动 pino-pretty，`OPENBOT_LOG_FORMAT=json` 强制 JSON。

## 请求跟踪
- 每个响应带 `x-request-id`（中间件生成或沿用合法入站值，正则 `^[A-Za-z0-9._-]{8,128}$`）；企业版错误体 `request_id` 与响应头同源。
- access log：`/api/*` 每请求一行 `method/path/status/duration_ms`。

## 待办（后续期次）
- trace_id 贯通与 Tempo（P2）；Grafana/Loki 起栈（P3）；/metrics（P4）；客户端崩溃上报（P5）。
- 备忘：pino 默认对 `err` 键序列化（含 message/stack）；其余自定义字段一律走结构化字段，不做字符串拼接。
```

- [ ] **Step 2: `reference/development.md` 加指引**

在开发环境相关章节附近加一小节：

```markdown
## 日志与排障
服务端日志为 JSON 单行，级别用 `LOG_LEVEL` 控制；字段与查看方式见 [可观测性约定](../../observability.md)。宿主机进程日志在 `.logs/`（追加式），容器日志用 `docker logs`。
```

- [ ] **Step 3: 全量门禁**

Run: `bunx biome lint --error-on-warnings server/src worker/src shared && cd server && bun run typecheck && bun test server/tests shared/`
Expected: 全绿（或仅记录基线外既有失败）

- [ ] **Step 4: Commit**

```bash
cd /Users/wuyongjun/trea/OpenBot
git add reference/observability.md reference/development.md
git commit -m "docs: observability conventions for logging and request tracking"
```

---

## 验收对照（spec §6-P1）

| 验收项 | 落点 |
|---|---|
| server/worker 全部日志经 logger 输出 JSON 单行 | Task 4、Task 5（grep 清零 + lint 上锁） |
| 每个 HTTP 响应带 `x-request-id` | Task 3（`app.use("*")`）、Task 6（企业版） |
| 每请求一条 access log | Task 2、Task 3（`/api/*`） |
| `.logs` 不再被覆盖 | Task 7 |
| 新代码 no-console 规则生效 | Task 5（含故意违规验证） |
