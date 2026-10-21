# 沙箱隔离与生命周期（P1-A，参考 Craft）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除共享沙箱的跨 Bot 文件互见（per-bot 工作区 + 独立 opencode 实例），引入空闲回收与工作区 reset，并让 run_code 的 timeoutSeconds 真正生效。

**Architecture:** wrapper（`agent-sandbox`）内新增 per-bot 运行时注册表：每个 bot 惰性获得一个独立 `opencode serve` 子进程（端口从基址递增、cwd 为 `/workspace/bots/<botId>`），代理按 `x-openbot-bot-id` 头路由；闲置超时由清扫循环停掉子进程。server 侧 client 每个 bot 独立实例（带 bot 头），网关新增 reset（治理+审计）与超时传递。

**Tech Stack:** Bun、opencode serve 多实例、Hono（server 路由）、drizzle 不动（无新表）。

**Spec:** 参考 Onyx Craft（`/Users/wuyongjun/trea/onyx/backend/onyx/server/features/build/`）：`session_workspace.py` 的会话级工作区物化（replay-safe、哨兵验证）、`configs.py` 的 `SANDBOX_IDLE_TIMEOUT_SECONDS=3600` + 60 秒清扫、`sandbox_lifecycle.py` 的 reconcile 状态机（本期只取空闲回收，完整状态机留 P1-B）。

## 范围决策

- **per-bot（不是 per-session）工作区**：Craft 的 session 是用户级长会话；我们的 run_code 每次调用都是新 opencode session，按 session 分目录会打断"上一轮的 CSV 下一轮分析"的跨轮复用。按 **bot** 分目录匹配"一个 Bot 一台电脑"的心智模型，也为 P1-B 的 supervisor per-bot 容器铺路。
- **容器保持常驻**：回收的是 per-bot 的 opencode 子进程（每个约几十 MB 常驻），容器本身仍由 compose 管理（`restart: unless-stopped`）。完整"容器级空闲回收 + 状态机"是 P1-B（需要 supervisor）。
- **工作区 TTL 清扫默认关闭**（`SANDBOX_WORKSPACE_TTL_MS=0`）：自动删用户文件必须显式 opt-in。
- **旧 /workspace 根目录文件不迁移**：现存测试产物（answer.txt 等）留在原处不再可见（新版 listFiles 以 bot 目录为根），说明即可。
- **`x-openbot-bot-id` 头是破坏性变更**：唯一消费者是本仓库的 server client，同计划内更新；live smoke 脚本一并更新。

## Global Constraints（沿用 run_code 计划的既定约束）

- opencode pin 1.18.7；provider id `openbot`；`x-sandbox-token` timing-safe。
- 审计先行：reset 与所有治理动作先写审计行再执行。
- bot id 校验与 agent-computer 的 `bot-id.ts` 同规则：`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`，≤64 字符——它是唯一允许进入路径的输入。
- 单元测试不打真实 opencode：`spawnFn`/`fetchImpl` 注入；live 验证只在 Task 6。
- 无新数据库表；新审计事件类型追加进 `auditEventTypes`。
- 测试从仓库根执行（agent-sandbox 测试用 `bun test agent-sandbox/tests/...` 形式）。

---

### Task 1: wrapper——bot id 校验 + per-bot 运行时注册表（惰性拉起/复用/空闲回收）

**Files:**
- Create: `agent-sandbox/src/bot-id.ts`
- Create: `agent-sandbox/src/bot-runtimes.ts`
- Modify: `agent-sandbox/src/env.ts`（新增 4 个可选配置）
- Test: `agent-sandbox/tests/bot-runtimes.test.ts`

**Interfaces:**
- Produces: `isPlainBotId(id): boolean`、`BotRuntimes`（`getOrSpawn(botId): { port, workspaceDir }`、`reapIdle(nowMs): string[]`、`stopBot(botId): Promise<void>`、`stopAll(): Promise<void>`、`size(): number`）、`createBotRuntimes(options)`。Task 2 的代理与 reset 依赖它（index 的 SIGTERM 走 `stopAll`）。
- env 新增（全部有默认，不破坏现有部署）：`SANDBOX_UPSTREAM_IDLE_MS`（默认 600000）、`SANDBOX_SWEEP_INTERVAL_MS`（默认 60000）、`SANDBOX_UPSTREAM_PORT_BASE`（默认 4400）、`SANDBOX_WORKSPACE_TTL_MS`（默认 0=关闭）。

- [ ] **Step 1: 写失败测试 `agent-sandbox/tests/bot-runtimes.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { isPlainBotId } from "../src/bot-id";
import { createBotRuntimes } from "../src/bot-runtimes";
import { sandboxEnvFrom } from "../src/env";

const env = sandboxEnvFrom({
  SANDBOX_TOKEN: "t",
  SANDBOX_PROVIDER_BASE_URL: "https://example.invalid",
  SANDBOX_PROVIDER_API_KEY: "k",
  SANDBOX_MODEL: "GLM-5.3",
  SANDBOX_UPSTREAM_IDLE_MS: "1000",
  SANDBOX_SWEEP_INTERVAL_MS: "100",
  SANDBOX_UPSTREAM_PORT_BASE: "4500",
});

/** 记录 spawn 调用的假 spawn：返回一个永不退出的子进程形状。 */
function fakeSpawnFactory() {
  const spawned: Array<{ bin: string; args: string[]; cwd: string }> = [];
  const spawnFn = ((bin: string, args: string[], opts: { cwd: string }) => {
    spawned.push({ bin, args, cwd: opts.cwd });
    return {
      once: () => {},
      kill: () => true,
    };
  }) as never;
  return { spawned, spawnFn };
}

describe("isPlainBotId", () => {
  test("接受字母数字开头的字母数字-下划线-连字符组合", () => {
    expect(isPlainBotId("bot-1")).toBe(true);
    expect(isPlainBotId("General_Assistant")).toBe(true);
  });
  test("拒绝路径逃逸与非法字符", () => {
    expect(isPlainBotId("../etc")).toBe(false);
    expect(isPlainBotId("a/b")).toBe(false);
    expect(isPlainBotId(".hidden")).toBe(false);
    expect(isPlainBotId("")).toBe(false);
    expect(isPlainBotId("a".repeat(65))).toBe(false);
  });
});

describe("createBotRuntimes", () => {
  test("同一 bot 复用同一端口与目录，不同 bot 各自拉起", async () => {
    const { spawned, spawnFn } = fakeSpawnFactory();
    const runtimes = createBotRuntimes({ env, spawnFn, nowMs: () => 0 });
    const a1 = await runtimes.getOrSpawn("alpha");
    const a2 = await runtimes.getOrSpawn("alpha");
    const b = await runtimes.getOrSpawn("beta");
    expect(a1.port).toBe(a2.port);
    expect(a1.port).not.toBe(b.port);
    expect(a1.workspaceDir).toBe("/workspace/bots/alpha");
    expect(b.workspaceDir).toBe("/workspace/bots/beta");
    expect(spawned).toHaveLength(2);
    expect(spawned[0]?.cwd).toBe("/workspace/bots/alpha");
    expect(spawned[1]?.cwd).toBe("/workspace/bots/beta");
    await runtimes.stopBot("alpha");
    await runtimes.stopBot("beta");
  });

  test("getOrSpawn 会确保 bot 工作区目录存在", async () => {
    const { spawnFn } = fakeSpawnFactory();
    const runtimes = createBotRuntimes({ env, spawnFn, nowMs: () => 0 });
    const runtime = await runtimes.getOrSpawn("gamma");
    const { stat } = await import("node:fs/promises");
    expect((await stat(runtime.workspaceDir)).isDirectory()).toBe(true);
    await runtimes.stopBot("gamma");
  });

  test("空闲超过 idleMs 的 bot 在清扫时被回收并释放端口", async () => {
    const { spawned, spawnFn } = fakeSpawnFactory();
    let now = 0;
    const runtimes = createBotRuntimes({ env, spawnFn, nowMs: () => now });
    await runtimes.getOrSpawn("alpha");
    now = 1500; // 超过 SANDBOX_UPSTREAM_IDLE_MS=1000
    const reaped = runtimes.reapIdle(now);
    expect(reaped).toEqual(["alpha"]);
    expect(runtimes.size()).toBe(0);
    // 再次访问重新拉起，端口复用（注册表按 botId 记忆端口）
    const again = await runtimes.getOrSpawn("alpha");
    expect(again.port).toBe(4500);
    expect(spawned.length).toBe(2);
    await runtimes.stopBot("alpha");
  });

  test("刚使用过的 bot 不会被误回收", async () => {
    let now = 0;
    const { spawnFn } = fakeSpawnFactory();
    const runtimes = createBotRuntimes({ env, spawnFn, nowMs: () => now });
    await runtimes.getOrSpawn("alpha");
    now = 500;
    await runtimes.getOrSpawn("alpha"); // 刷新 lastUsedAt
    now = 1200; // 距上次使用 700ms < 1000ms
    expect(runtimes.reapIdle(now)).toEqual([]);
    await runtimes.stopBot("alpha");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test agent-sandbox/tests/bot-runtimes.test.ts`
Expected: FAIL，`Cannot find module '../src/bot-id'`

- [ ] **Step 3: 实现 `bot-id.ts`（移植 agent-computer 同规则）**

```ts
/** What a bot id is allowed to be, before it becomes a path or a port key. */
const MAX_BOT_ID = 64;
const ALLOWED = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isPlainBotId(value: string): boolean {
  return value.length <= MAX_BOT_ID && ALLOWED.test(value);
}

export class UnusableBotIdError extends Error {
  constructor(botId: string) {
    super(
      `A bot id may contain only letters, digits, hyphen and underscore, and must start with a letter or digit: ${JSON.stringify(botId)}`,
    );
    this.name = "UnusableBotIdError";
  }
}
```

- [ ] **Step 4: env.ts 追加四个配置**

在 `SandboxEnv` 增加：

```ts
  /** Idle budget for a per-bot opencode serve before the sweep stops it. */
  upstreamIdleMs: number;
  /** How often the sweep runs. */
  sweepIntervalMs: number;
  /** First port a per-bot opencode serve may take; ports increment per concurrently-live bot. */
  upstreamPortBase: number;
  /** Bot workspace dirs untouched for longer than this are swept. 0 disables (default). */
  workspaceTtlMs: number;
```

`sandboxEnvFrom` 对应解析（默认 600000 / 60000 / 4400 / 0），变量名 `SANDBOX_UPSTREAM_IDLE_MS`、`SANDBOX_SWEEP_INTERVAL_MS`、`SANDBOX_UPSTREAM_PORT_BASE`、`SANDBOX_WORKSPACE_TTL_MS`。既有 `upstreamPort` 保留（不再被代理使用，留作兼容读取）。

- [ ] **Step 5: 实现 `bot-runtimes.ts`**

```ts
/**
 * One opencode serve per Bot, spawned on demand and reaped when idle.
 *
 * The isolation boundary is the working directory: each Bot's serve runs with cwd at
 * /workspace/bots/<botId>, so its sessions read and write only its own tree, and the file routes
 * answer from the same root. The serve process itself is trusted code; the directory is what keeps
 * Bots out of each other's artifacts.
 *
 * Idle reaping stops the child after upstreamIdleMs without a request — a resident container stays
 * up, but Bots nobody is talking to stop costing memory. Ports come from a base and are handed out
 * per registration; the registry remembers the port across reaps so a reaped Bot returns to its
 * own port.
 */
import { mkdir } from "node:fs/promises";
import type { SandboxEnv } from "./env";
import { startOpencodeServe, type Upstream } from "./upstream";
import { UnusableBotIdError, isPlainBotId } from "./bot-id";

export type BotRuntime = { port: number; workspaceDir: string };

export type BotRuntimesOptions = {
  env: SandboxEnv;
  workspaceRoot?: string;
  spawnFn?: typeof spawn;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
};

type Entry = {
  port: number;
  workspaceDir: string;
  upstream: Upstream | null;
  lastUsedAtMs: number;
};

type spawn = typeof import("node:child_process").spawn;

export type BotRuntimes = {
  getOrSpawn(botId: string): Promise<BotRuntime>;
  reapIdle(nowMs: number): string[];
  stopBot(botId: string): Promise<void>;
  size(): number;
};

export function createBotRuntimes(options: BotRuntimesOptions): BotRuntimes {
  const { env } = options;
  const workspaceRoot = options.workspaceRoot ?? `${env.workspaceDir}/bots`;
  const spawnFn = options.spawnFn;
  const nowMs = options.nowMs ?? Date.now;
  const entries = new Map<string, Entry>();
  let nextPortOffset = 0;

  const build = (botId: string, entry: Entry): void => {
    entry.upstream = startOpencodeServe({
      bin: process.env.SANDBOX_OPENCODE_BIN?.trim() || "opencode",
      port: entry.port,
      cwd: entry.workspaceDir,
      configDir: env.configDir,
      ...(spawnFn ? { spawnFn } : {}),
    });
    entry.lastUsedAtMs = nowMs();
    void entry.upstream.ready.catch(() => {
      // 上线失败不在此处崩溃：探活由代理请求失败与下次清扫兜底。
      entry.upstream = null;
    });
  };

  return {
    async getOrSpawn(botId: string): Promise<BotRuntime> {
      if (!isPlainBotId(botId)) throw new UnusableBotIdError(botId);
      let entry = entries.get(botId);
      if (!entry) {
        entry = {
          port: env.upstreamPortBase + nextPortOffset,
          workspaceDir: `${workspaceRoot}/${botId}`,
          upstream: null,
          lastUsedAtMs: nowMs(),
        };
        nextPortOffset += 1;
        entries.set(botId, entry);
        await mkdir(entry.workspaceDir, { recursive: true });
        build(botId, entry);
      } else if (!entry.upstream) {
        build(botId, entry);
      }
      entry.lastUsedAtMs = nowMs();
      return { port: entry.port, workspaceDir: entry.workspaceDir };
    },

    reapIdle(nowMs: number): string[] {
      const reaped: string[] = [];
      for (const [botId, entry] of entries) {
        if (entry.upstream && nowMs - entry.lastUsedAtMs > env.upstreamIdleMs) {
          entry.upstream.kill("SIGTERM");
          entry.upstream = null;
          reaped.push(botId);
        }
      }
      return reaped;
    },

    async stopBot(botId: string): Promise<void> {
      const entry = entries.get(botId);
      if (entry?.upstream) {
        entry.upstream.kill("SIGTERM");
        entry.upstream = null;
      }
    },

    size() {
      return entries.size;
    },
  };
}
```

（`Upstream.ready` 是 Promise：`entry.upstream.ready.catch` 的兜底保证 spawn 失败不会成为未处理拒绝；代理层对每个请求有探活重试——见 Task 2。注意 `startOpencodeServe` 的现签名接受 `spawnFn/fetchImpl`，直接透传。）

- [ ] **Step 6: 运行确认通过**

Run: `bun test agent-sandbox/tests/bot-runtimes.test.ts agent-sandbox/tests/env.test.ts && bun run --cwd agent-sandbox typecheck 2>/dev/null || cd agent-sandbox && bun run typecheck`
Expected: 全部 PASS；typecheck 无错误

- [ ] **Step 7: 提交**

```bash
git add agent-sandbox/src/bot-id.ts agent-sandbox/src/bot-runtimes.ts agent-sandbox/src/env.ts agent-sandbox/tests/bot-runtimes.test.ts
git commit -m "feat(sandbox): per-bot opencode runtimes with idle reaping"
```

---

### Task 2: wrapper——代理按 bot 头路由 + reset 端点

**Files:**
- Modify: `agent-sandbox/src/proxy.ts`
- Modify: `agent-sandbox/src/index.ts`
- Test: `agent-sandbox/tests/proxy.test.ts`（改造既有用例）

**Interfaces:**
- Consumes: `BotRuntimes`（Task 1）。
- Produces: `createProxyHandler(env, runtimes)`（签名从 `upstreamPort` 改为注册表）；所有沙箱请求要求头 `x-openbot-bot-id`（缺失/非法 → 400）；新增允许路径 `POST /workspace/reset`（清除该 bot 的 bot 工作区目录并停其 serve）；`/health` 不需要 bot 头。

- [ ] **Step 1: 改造测试 `tests/proxy.test.ts`**

关键变化（保留 token 用例，全部请求加 bot 头；新增用例）：

```ts
import { describe, expect, test, afterAll } from "bun:test";
import { serve } from "bun";
import { createProxyHandler } from "../src/proxy";
import { createBotRuntimes } from "../src/bot-runtimes";
import { sandboxEnvFrom } from "../src/env";

const env = sandboxEnvFrom({
  SANDBOX_TOKEN: "secret-token",
  SANDBOX_PROVIDER_BASE_URL: "https://example.invalid",
  SANDBOX_PROVIDER_API_KEY: "k",
  SANDBOX_MODEL: "GLM-5.3",
  SANDBOX_UPSTREAM_PORT_BASE: "4600",
});

/** 每个 bot 一个假上游：端口由测试表驱动。 */
const upstreamPorts: Record<string, number> = {};
const upstream = serve({
  port: 4600,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const url = new URL(request.url);
    const port = url.port;
    if (url.pathname === "/doc") return Response.json({ openapi: "3.1.0", served: port });
    if (url.pathname === "/session" && request.method === "POST")
      return Response.json({ id: `ses_${port}` });
    return Response.json({ echo: url.pathname, method: request.method, port });
  },
});
afterAll(() => upstream.stop(true));

const runtimes = createBotRuntimes({
  env,
  spawnFn: ((bin: never, args: never, opts: never) => {
    void bin; void args; void opts;
    return { once: () => {}, kill: () => true };
  }) as never,
  fetchImpl: (async (url: string | URL, init?: RequestInit) => {
    // 假探活：任何 /doc 都按 200 处理（上游是上面这个共享 serve 的语义替身）。
    void url; void init;
    return new Response(JSON.stringify({ openapi: "3.1.0" }), { status: 200 });
  }) as never,
});

const handler = createProxyHandler(env, runtimes);
const call = (path: string, init?: RequestInit) =>
  handler(new Request(`http://127.0.0.1:4300${path}`, init));
const botHeaders = { "x-sandbox-token": "secret-token", "x-openbot-bot-id": "alpha" };

describe("proxy with per-bot runtimes", () => {
  test("缺 bot 头是 400，token 检查仍在前", async () => {
    const noBot = await call("/session", {
      method: "POST",
      headers: { "x-sandbox-token": "secret-token" },
      body: "{}",
    });
    expect(noBot.status).toBe(400);
    const noToken = await call("/session", {
      method: "POST",
      headers: { "x-openbot-bot-id": "alpha" },
      body: "{}",
    });
    expect(noToken.status).toBe(401);
  });

  test("非法 bot id 是 400", async () => {
    const response = await call("/session", {
      method: "POST",
      headers: { ...botHeaders, "x-openbot-bot-id": "../escape" },
      body: "{}",
    });
    expect(response.status).toBe(400);
  });

  test("同一 bot 的请求被路由到同一个上游端口", async () => {
    const r1 = await call("/session", { method: "POST", headers: botHeaders, body: "{}" });
    const r2 = await call("/session", { method: "POST", headers: botHeaders, body: "{}" });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { id: string };
    const b2 = (await r2.json()) as { id: string };
    expect(b1.id).toBe(b2.id);
  });

  test("reset 端点移除 bot 工作区并返回 200", async () => {
    const runtime = await runtimes.getOrSpawn("reset-me");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${runtime.workspaceDir}/keep.txt`, "x");
    const response = await call("/workspace/reset", {
      method: "POST",
      headers: { ...botHeaders, "x-openbot-bot-id": "reset-me" },
    });
    expect(response.status).toBe(200);
    const { stat } = await import("node:fs/promises");
    let gone = false;
    try { await stat(`${runtime.workspaceDir}/keep.txt`); } catch { gone = true; }
    expect(gone).toBe(true);
  });
});
```

（假 upstream 的细节按实际编译报错微调：目标是让"同一 bot 复用同一端口"与"reset 删目录"两个行为被确定性验证。真正的多端口路由由 Task 6 的 live 测试验证。）

- [ ] **Step 2: 实现 proxy.ts 改造**

`createProxyHandler(env, runtimes)`：

```ts
export function createProxyHandler(
  env: SandboxEnv,
  runtimes: BotRuntimes,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });

    const presented = request.headers.get("x-sandbox-token") ?? undefined;
    if (!tokenMatches(presented, env.token))
      return Response.json({ error: "The sandbox token is missing or wrong." }, { status: 401 });

    if (!allowedPath(request.method, url.pathname))
      return Response.json({ error: "No such sandbox route." }, { status: 404 });

    const botId = request.headers.get("x-openbot-bot-id")?.trim() ?? "";
    if (!isPlainBotId(botId))
      return Response.json({ error: "A valid x-openbot-bot-id header is required." }, { status: 400 });

    // reset 是治理动作：只允许显式端点，路径白名单之外照旧 404。
    if (url.pathname === "/workspace/reset") {
      if (request.method !== "POST")
        return Response.json({ error: "Use POST." }, { status: 405 });
      await runtimes.stopBot(botId);
      await rm(`${env.workspaceDir}/bots/${botId}`, { recursive: true, force: true });
      return Response.json({ ok: true, botId });
    }

    const runtime = await runtimes.getOrSpawn(botId);
    const headers = new Headers(request.headers);
    headers.delete("x-sandbox-token");
    headers.delete("host");
    headers.delete("content-length");
    const body = request.method === "GET" ? undefined : await request.arrayBuffer();

    // 探活重试：子进程可能刚被清扫或正在上线，最多等 15 秒。
    let response: Response | null = null;
    for (let attempt = 0; attempt < 30 && response === null; attempt++) {
      try {
        const probe = await fetch(`http://127.0.0.1:${runtime.port}/doc`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (!probe.ok) throw new Error("not ready");
        response = await fetch(`${upstreamBase(runtime.port)}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body,
        });
        if (response.status >= 502) { response = null; await sleep(500); }
      } catch {
        await sleep(500);
      }
    }
    if (response === null)
      return Response.json({ error: "The bot's sandbox runtime is not ready." }, { status: 503 });

    const upstreamLength = Number(response.headers.get("content-length") ?? "0");
    if (upstreamLength > env.maxResponseBytes)
      return Response.json({ error: "The sandbox response is too large." }, { status: 413 });
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
}
```

配套小工具（同文件）：`upstreamBase(port) = \`http://127.0.0.1:${port}\``、`sleep(ms)`；`ALLOWED` 集合加入 `"POST /workspace/reset"`；`allowedPath` 对 `/workspace/reset` 放行 POST。导入 `isPlainBotId`、`BotRuntimes`、`rm`（node:fs/promises）。删除原 `upstreamPort` 参数与旧转发逻辑。

- [ ] **Step 3: index.ts 改造**

单实例 `startOpencodeServe` 调用移除，换成：

```ts
const runtimes = createBotRuntimes({ env });
const handler = createProxyHandler(env, runtimes);
const server = serve({ port: env.port, hostname: "0.0.0.0", fetch: handler });
log("sandbox-listening", { port: env.port, mode: "per-bot" });
// 清扫循环：空闲回收 + 可选工作区 TTL
const sweep = setInterval(() => {
  const reaped = runtimes.reapIdle(Date.now());
  if (reaped.length > 0) log("sandbox-runtimes-reaped", { bots: reaped });
}, env.sweepIntervalMs);
sweep.unref?.();
```

SIGTERM 处理改为停止 server + 全部 bot（遍历 `stopBot` 需要注册表暴露 `stopAll()`——在 BotRuntimes 接口加 `stopAll(): Promise<void>`，实现为遍历 stopBot）。`upstream.exited.then(...)` 的全局退出监听移除（子进程生命周期归注册表管）。

- [ ] **Step 4: 全量 wrapper 测试 + 提交**

Run: `bun test agent-sandbox/tests/ && cd agent-sandbox && bun run typecheck`
Expected: 全绿

```bash
git add agent-sandbox/src/proxy.ts agent-sandbox/src/index.ts agent-sandbox/tests/proxy.test.ts
git commit -m "feat(sandbox): per-bot proxy routing, bot header enforcement, workspace reset"
```

---

### Task 3: server——client 携带 botId + 超时传递

**Files:**
- Modify: `server/src/codesandbox/client.ts`
- Modify: `server/src/codesandbox/gateway.ts`
- Modify: `server/src/codesandbox/routes.ts`
- Test: `server/tests/codesandbox-client.test.ts`、`server/tests/codesandbox-gateway.test.ts`、`server/tests/codesandbox-routes.test.ts`

**Interfaces:**
- `createSandboxClient(options)` 新增必填 `botId: string`（所有请求带 `x-openbot-bot-id`）。
- `sendMessage` 的 `SandboxSendMessageOptions.timeoutMs` 由网关按 `timeoutSeconds` 计算。
- 网关 `run(task, opts?: { timeoutSeconds?: number; toolCallId?: string })`；钳制 1–600，默认 120。
- reset：`gateway.resetWorkspace(): Promise<{ok: true} | {ok: false, reason: string}>` → wrapper `POST /workspace/reset`。

- [ ] **Step 1: 更新 client 测试**——`base` 增 `botId: "bot-1"`；每个捕获的请求断言头 `x-openbot-bot-id: bot-1`；新增超时传递断言（sendMessage 传 `timeoutMs: 5000` 时 init.signal 存在即可，不必真等）。
- [ ] **Step 2: 实现 client 变更**——headers.set("x-openbot-bot-id", options.botId)；`sendMessage` 已接受 `timeoutMs`（无签名变化）。
- [ ] **Step 3: 网关变更**

```ts
export type CodeRunGateway = {
  run(task: string, opts?: { timeoutSeconds?: number; toolCallId?: string }): Promise<CodeRunOutcome>;
  resetWorkspace(): Promise<{ ok: true } | { ok: false; reason: string }>;
};
```

`run` 内：`const timeoutMs = clampSeconds(opts?.timeoutSeconds) * 1000`（clamp: 非法/缺省 → 120；上限 600）。审计 payload 记 `timeoutMs`。`resetWorkspace`：先 `audit("code.workspace_reset", {...})`（Task 4 加类型）再调 `client.resetWorkspace()`——**审计先于动作**，与 run 同序。

- [ ] **Step 4: 路由变更**——`POST /runs` 把 `timeoutSeconds` 传入 `factory(...).run(task, { timeoutSeconds, toolCallId: undefined })`；新增 `POST /reset`（body `{botId}`，canUseBot 检查同 runs，成功 200 `{ok:true}`，refused 语义 409）。返回 400 的用例补 timeoutSeconds 越界（0 与 601）。
- [ ] **Step 5: 测试确认 + lint + 提交**

Run: `bun test server/tests/codesandbox-client.test.ts server/tests/codesandbox-gateway.test.ts server/tests/codesandbox-routes.test.ts && bunx biome lint --error-on-warnings server/src/codesandbox`
Expected: 全绿

```bash
git add server/src/codesandbox server/tests/codesandbox-client.test.ts server/tests/codesandbox-gateway.test.ts server/tests/codesandbox-routes.test.ts
git commit -m "feat(codesandbox): bot-scoped client, effective timeoutSeconds, workspace reset"
```

---

### Task 4: 审计事件 + app 装配更新

**Files:**
- Modify: `server/src/audit.ts`（追加 `"code.workspace_reset"`）
- Modify: `server/src/app.ts`（`codeRunGatewayFactory` 的工厂体：client 每调用创建并带 botId）
- Test: `server/tests/codesandbox-gateway.test.ts`（reset 用例）

**Interfaces:**
- app.ts 工厂体形如：

```ts
codeRunGatewayFactory: ({ botId, ownerUserId }) =>
  createCodeRunGateway({
    ...baseOptions,
    client: createSandboxClient({ baseUrl: codeRun.baseUrl, token: codeRun.token, botId }),
    botId,
    ownerUserId,
  }),
```

- [ ] **Step 1: audit.ts 追加事件类型**（`code.run_failed` 之后）：`"code.workspace_reset"`，注释说明审计先于删除。
- [ ] **Step 2: 网关测试加 reset 用例**：配置了 client 时 reset 审计事件先于 client.resetWorkspace 调用（fake client 记录调用序）；未配置时返回 `{ok:false, reason:"not-configured"}` 且不发请求。
- [ ] **Step 3: app.ts 工厂体改造**（client 从共享单例改为每调用创建，带 botId；确认 import 与 baseUrl/token 从既有 codeRun 配置对象取）。
- [ ] **Step 4: 运行 + lint + 提交**

```bash
bun test server/tests/codesandbox-gateway.test.ts server/tests/codesandbox-routes.test.ts && bun run --filter server typecheck
git add server/src/audit.ts server/src/app.ts server/tests/codesandbox-gateway.test.ts
git commit -m "feat(codesandbox): governed workspace reset with audit-first ordering"
```

（注：`bun run --filter server typecheck` 若因 `server/scripts/enterprise-runtime-*.ts` 未跟踪文件报错——那是并行工作流的在途文件，验证方式改为 `bunx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -v enterprise-runtime` 无输出即可。）

---

### Task 5: 配置接线 + 冒烟脚本更新

**Files:**
- Modify: `docker-compose.yml`（agent-sandbox environment 增 4 个变量透传）
- Modify: `.env.example`（沙箱小节补变量说明）
- Modify: `scripts/codesandbox-smoke.ts`（client 加 `botId: "smoke-bot"`）
- Modify: `server/src/codesandbox/client.ts` 的 `SandboxClientOptions.botId` 为必填后，全仓 grep `createSandboxClient(` 确认调用点齐全（app.ts 工厂、smoke 脚本、测试）

- [ ] **Step 1: compose/`.env.example`**——environment 增加：

```yaml
      SANDBOX_UPSTREAM_IDLE_MS: ${SANDBOX_UPSTREAM_IDLE_MS:-600000}
      SANDBOX_SWEEP_INTERVAL_MS: ${SANDBOX_SWEEP_INTERVAL_MS:-60000}
      SANDBOX_UPSTREAM_PORT_BASE: ${SANDBOX_UPSTREAM_PORT_BASE:-4400}
      SANDBOX_WORKSPACE_TTL_MS: ${SANDBOX_WORKSPACE_TTL_MS:-0}
```

`.env.example` 补注释：per-bot 工作区布局 `/workspace/bots/<botId>`、空闲回收默认 10 分钟、TTL 默认关闭。
- [ ] **Step 2: smoke 脚本加 botId**（`createSandboxClient({ baseUrl, token, botId: "smoke-bot" })`）。
- [ ] **Step 3: 全量测试 + lint + 提交**

```bash
bun test server/tests/codesandbox-client.test.ts agent-sandbox/tests/proxy.test.ts agent-sandbox/tests/bot-runtimes.test.ts && bunx biome lint --error-on-warnings agent-sandbox/src server/src/codesandbox
git add docker-compose.yml .env.example scripts/codesandbox-smoke.ts
git commit -m "feat(sandbox): wire per-bot lifecycle env and update smoke script"
```

---

### Task 6: 重建 + 双 bot 隔离 live 验证

**Files:** 无新文件（验证任务）

- [ ] **Step 1: 重建并重启**

```bash
NPM_REGISTRY=https://registry.npmmirror.com docker compose build agent-sandbox
docker compose up -d agent-sandbox
curl -s -o /dev/null -w "health=%{http_code}\n" http://127.0.0.1:4300/health
```

- [ ] **Step 2: 隔离验证（两个 bot 的文件互不可见）**

```bash
H1='x-sandbox-token: openbot-dev-sandbox-token'
# bot-a 写文件
SID=$(curl -s -X POST http://127.0.0.1:4300/session -H "$H1" -H 'x-openbot-bot-id: bot-a' -H 'content-type: application/json' -d '{"title":"t"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
curl -s -X POST "http://127.0.0.1:4300/session/$SID/message" -H "$H1" -H 'x-openbot-bot-id: bot-a' -H 'content-type: application/json' -d '{"model":{"providerID":"openbot","modelID":"GLM-5.3"},"parts":[{"type":"text","text":"创建文件 only-a.txt 内容写 A"}]}'
# bot-a 可见、bot-b 不可见
curl -s "http://127.0.0.1:4300/file?path=." -H "$H1" -H 'x-openbot-bot-id: bot-a' | grep -c only-a   # 期望 ≥1
curl -s "http://127.0.0.1:4300/file?path=." -H "$H1" -H 'x-openbot-bot-id: bot-b'                     # 期望不含 only-a（空或 []）
ls /workspace 2>/dev/null; docker exec openbot-agent-sandbox-1 ls /workspace/bots   # 期望 bots/alpha… bots/bot-a bots/bot-b 目录
```

- [ ] **Step 3: reset 验证**——经 server 路由（带登录态的 curl 麻烦，可用 gateway 单测覆盖治理顺序，live 只验证 wrapper 层）：`curl -s -X POST http://127.0.0.1:4300/workspace/reset -H "$H1" -H 'x-openbot-bot-id: bot-a'` → `{"ok":true}` 且 `bots/bot-a` 目录清空。
- [ ] **Step 4: 浏览器回归**——跑一轮 run_code（同前配方），确认产品路径不受破坏；核对 `code_runs` 新行与 `bots/<真实botId>/` 目录出现。
- [ ] **Step 5: 提交（如有残留改动）+ 汇报**

---

## P1-B 待办（本计划不实现）

- supervisor per-bot 沙箱容器 + 状态机（SLEEPING/TERMINATED/FAILED、durable provisioning）——Craft `sandbox_lifecycle.py` 完整形态。
- 工作区快照到对象存储（tar-stream 经 server，agent 容器无存储凭据）。
- turn 活动超时（SSE 事件流 + inactivity timeout + 打断 + 流式持久化）。
- `code_runs` 用量 → Lago 计量上报。
- headless（run-turn）路径接入 run_code。
