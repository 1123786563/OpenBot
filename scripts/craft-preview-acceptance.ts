/**
 * Craft 预览独立 Origin — #365 缝合验收（AC1–AC3, AC5 + 回归项）。
 *
 * 一个真实浏览器（Playwright + Casdoor 登录 + 真实 dev server）里逐条跑
 * Spec #358 的验收：隔离（AC1/AC3）、可交互（回归）、热更新（AC5）、票据流程、
 * 全屏放大不重挂载。每条 PASS/FAIL/SKIP 如实输出，截图留证；上游缺陷按
 * #365 的规则「失败即回退到对应 Ticket，不在本 Ticket 内修」——本脚本不修
 * 集成缺陷，只把它钉在证据上。
 *
 * ── 启动前置（每次运行前手工就位，脚本只做探测并拒绝给出说明）──────────
 *
 * 1. 共享容器栈在跑：postgres(:5432)、casdoor(:8000)、agent-sandbox(:4300，
 *    webapp 端口段 3011–3098 已发布)。
 * 2. 从集成了 #360–#364 的工作区起 API server（本目录），端口与 app 错开
 *    （下方示例用 3221/3220；.env 里 PORT=SERVER_PORT=3221、
 *    BETTER_AUTH_URL=http://localhost:3221、TRUSTED_ORIGINS=http://localhost:3220,...）：
 *
 *      cd server && bun --env-file=../.env src/index.ts > /tmp/365-server.log 2>&1 &
 *
 * 3. 同一工作区起 app dev server，/api 代理指向 3221（vite 不读 .env，要显式传）：
 *
 *      cd app && APP_PORT=3220 SERVER_PORT=3221 \
 *        bun --bun node_modules/vite/bin/vite.js --port 3220 --strictPort &
 *
 * 4. Casdoor 的 app-openbot 客户端 redirect_uris 已包含
 *    http://localhost:3221/api/auth/casdoor 与 .../callback/casdoor
 *    （本地 dev Casdoor 可直接改 application 行）。
 * 5. （可选，AC1 协议层证据需要）把 API server 的 stdout 日志路径传给
 *    CRAFT_ACCEPTANCE_SERVER_LOG（上面示例即 /tmp/365-server.log）。
 * 6. 本机 docker 可 exec 进 agent-sandbox 容器（清理残留 dev server 用；
 *    会话删除只清文件不停进程，残留 server 会占着重新预约的端口）。
 *    容器名用 CRAFT_ACCEPTANCE_SANDBOX_CONTAINER 覆盖（默认
 *    openbot-agent-sandbox-1）。
 *
 * 运行：bun scripts/craft-preview-acceptance.ts
 * 退出码：全部通过 0；任何 FAIL 1。
 *
 * 环境变量（默认值适合上面的 3220/3221 布局）：
 *   CRAFT_ACCEPTANCE_APP_ORIGIN / _API_ORIGIN / _CASDOOR_USER / _CASDOOR_PASSWORD
 *   CRAFT_ACCEPTANCE_SANDBOX_GATEWAY / _SANDBOX_TOKEN / _SANDBOX_BOT
 *   CRAFT_ACCEPTANCE_SERVER_LOG（可选）/ _SHOT_DIR / _CLEANUP_SESSIONS=1（跑完删会话）
 *
 * 两个已知上游缺口会在结果里以 FINDING 形式出现（不修，只报）：
 *   F-1 预览域 D9 cookie（SameSite=Lax）在跨站 iframe 兑换跳里被浏览器拒收 →
 *       预览面板 iframe 停在 401 拒绝页（回退 #362/#360）。
 *   F-2 dev 形态下应用资源 URL 是 origin 根绝对路径（/_next/...），不带
 *       <label> 段 → 全部 404，页面不 hydrate（回退 #362/#364）。
 * 脚本同时给出「顶层第一方进入」的旁路验证面，使 AC1/AC3/AC5 的通道层
 * 在旁路上仍然被真实浏览器检验；hydrate 依赖的断言会如实 FAIL/SKIP。
 *
 * #365 复跑（F-1/F-2 已修）：上面两个缺口已合入，FINDING 分支保留作回归哨兵。
 * 通行证现在是 SameSite=None; Secure —— Chrome 对 127.0.0.1 的 trustworthy-origin
 * 例外允许 http 下存储并携带（M89+），但 Playwright context.cookies() 的按 URL
 * 安全匹配对 http 不返回 Secure cookie，会把真实存在的通行证报成空 jar（上一轮
 * FINDING 里「preview 域 cookie jar 为空」即此验证工件，非产品缺陷）。因此通行证
 * 断言一律走 CDP Network.getAllCookies（浏览器真实 jar）+ 预览页同源 fetch 行为学
 * 双证。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright-core";

const APP_ORIGIN =
  process.env.CRAFT_ACCEPTANCE_APP_ORIGIN ?? "http://localhost:3220";
const API_ORIGIN =
  process.env.CRAFT_ACCEPTANCE_API_ORIGIN ?? "http://localhost:3221";
const PREVIEW_ORIGIN = `http://127.0.0.1:${new URL(API_ORIGIN).port || "80"}`;
const CASDOOR_USER = process.env.CRAFT_ACCEPTANCE_CASDOOR_USER ?? "admin";
const CASDOOR_PASSWORD = process.env.CRAFT_ACCEPTANCE_CASDOOR_PASSWORD ?? "123";
const GATEWAY =
  process.env.CRAFT_ACCEPTANCE_SANDBOX_GATEWAY ?? "http://127.0.0.1:4300";
const GATEWAY_TOKEN =
  process.env.CRAFT_ACCEPTANCE_SANDBOX_TOKEN ?? "openbot-dev-sandbox-token";
const SANDBOX_BOT = process.env.CRAFT_ACCEPTANCE_SANDBOX_BOT ?? "craft";
const SERVER_LOG = process.env.CRAFT_ACCEPTANCE_SERVER_LOG ?? "";
const SHOT_DIR =
  process.env.CRAFT_ACCEPTANCE_SHOT_DIR ??
  "gui-test-screenshots/craft-preview-365";
const CLEANUP = process.env.CRAFT_ACCEPTANCE_CLEANUP_SESSIONS === "1";
/** 本地沙箱容器名（stopSessionWebapp 的 docker exec 通道；不可用时退化为警告）。 */
const SANDBOX_CONTAINER =
  process.env.CRAFT_ACCEPTANCE_SANDBOX_CONTAINER ?? "openbot-agent-sandbox-1";

const T = 45_000;
const SESSION_PREFIX = "#365 probe";
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
// e2e.config 同款：脚本自己读一次 .env（DATABASE_URL 在里面）。
if (existsSync(".env")) process.loadEnvFile(".env");

type StepResult = {
  name: string;
  kind: "pass" | "fail" | "skip" | "finding";
  detail: string;
};
const results: StepResult[] = [];

function log(line: string) {
  console.log(line);
}

function record(kind: StepResult["kind"], name: string, detail = "") {
  results.push({ name, kind, detail });
  const icon = {
    pass: "✅ PASS ",
    fail: "❌ FAIL ",
    skip: "⏭️  SKIP ",
    finding: "🔍 FIND",
  }[kind];
  log(`${icon} ${name}${detail ? ` — ${detail}` : ""}`);
}

class SkipSignal extends Error {}
async function step(
  kind: "pass" | "fail" | "skip",
  name: string,
  fn: () => Promise<string | undefined>,
) {
  try {
    const detail = (await fn()) || "";
    record(kind === "skip" ? "skip" : "pass", name, detail);
  } catch (error) {
    if (error instanceof SkipSignal) {
      record("skip", name, error.message);
      return;
    }
    record(
      "fail",
      name,
      error instanceof Error
        ? error.message.replace(/\s*\n\s*/g, " ").slice(0, 300)
        : String(error),
    );
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function launchBrowser(): Promise<Browser> {
  for (const candidate of [
    { channel: "chrome" as const },
    { channel: "chrome-canary" as const },
    { channel: "microsoft-edge" as const },
  ]) {
    try {
      return await chromium.launch({ ...candidate, headless: true });
    } catch {
      /* next */
    }
  }
  const paths = [
    `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  for (const executablePath of paths) {
    if (existsSync(executablePath))
      return await chromium.launch({ executablePath, headless: true });
  }
  throw new Error(
    "找不到可用的 Chrome/Chromium（安装 playwright 浏览器或系统 Chrome）",
  );
}

function gatewayHeaders(): Record<string, string> {
  return { "x-sandbox-token": GATEWAY_TOKEN, "x-openbot-bot-id": SANDBOX_BOT };
}

/**
 * CDP 全量 cookie jar 里某 domain 的 cookie。为什么不用 context.cookies(urls)：
 * 它按 URL 安全匹配（Network.getCookies 语义），对 http://127.0.0.1 不返回
 * Secure cookie —— 而 trustworthy-origin 例外让 Chrome 真实存储并携带它（见头注）。
 */
async function cdpDomainCookies(
  target: Page,
  domain: string,
): Promise<Array<{ name: string; secure: boolean; httpOnly: boolean; sameSite: string }>> {
  const cdp = await context.newCDPSession(target);
  const all = (await cdp.send("Network.getAllCookies")).cookies as Array<{
    domain: string;
    name: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite: string;
  }>;
  await cdp.detach().catch(() => {});
  return all
    .filter((c) => c.domain === domain)
    .map((c) => ({ name: c.name, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite }));
}

async function gatewayWriteFile(
  sessionId: string,
  relPath: string,
  content: string,
) {
  const response = await fetch(
    `${GATEWAY}/file?path=${encodeURIComponent(`${sessionId}/${relPath}`)}`,
    {
      method: "POST",
      headers: { ...gatewayHeaders(), "content-type": "text/plain" },
      body: content,
    },
  );
  if (response.status !== 201) {
    throw new Error(
      `gateway POST /file → ${response.status}: ${(await response.text()).slice(0, 120)}`,
    );
  }
}

/** 会话里跑 start-webapp.sh（附着模型：脚本是唯一进程主人，我们只是触发它）。 */
async function startWebapp(sessionId: string) {
  const response = await fetch(`${GATEWAY}/devserver/start`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ dir: sessionId, command: "bash start-webapp.sh" }),
  });
  if (response.status !== 200) {
    throw new Error(
      `gateway /devserver/start → ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  return (await response.json()) as { port: number; command: string };
}

/**
 * 停掉本脚本探针会话的 dev server（容器内 /proc 扫描 + nextjs.pid）。
 *
 * 为什么需要它：会话删除只清文件不停进程（平台既有形状），残留 server 占着端口，
 * 而端口按行重新预约 —— 新会话拿到同端口时，start-webapp.sh 的就绪探测会被
 * 残留 server 骗过（探测到 200 就“就绪”，但那是别人的应用）。只停探针会话的
 * server，不碰其他会话。依赖本地 docker exec（前置说明第 6 条）。
 */
async function stopSessionWebapp(sessionId: string): Promise<string> {
  const script = [
    `pid=$(cat /workspace/bots/craft/${sessionId}/nextjs.pid 2>/dev/null)`,
    '[ -n "$pid" ] && kill "$pid" 2>/dev/null',
    "for d in /proc/[0-9]*; do",
    // review-365 L-4：跳过 shell 自身——脚本文本本身就含 session 路径 pattern，
    // shell 的 cmdline（sh -c "<整个脚本>"）会匹配 case，没这条就把自己 kill 掉
    // （docker exec 退出码 143，被误报为停止失败）。
    '  [ "$d" = "/proc/$$" ] && continue',
    "  cmd=$(tr '\\0' ' ' 2>/dev/null < $d/cmdline || true)",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell 参数展开必须原样进入脚本
    `  case "$cmd" in */bots/craft/${sessionId}/outputs/web*) kill ${"${d#/proc/}"} 2>/dev/null;; esac`,
    "done",
    "true",
  ].join("\n");
  const proc = Bun.spawn([
    "docker",
    "exec",
    SANDBOX_CONTAINER,
    "sh",
    "-c",
    script,
  ]);
  const code = await proc.exited;
  return code === 0 ? "stopped" : `docker-exec-exit-${code}`;
}

// ── 探针应用（最小 fixture：脚手架之上只换 page、加一条 API 路由）──────────

function probeMarker(version: number, tag: string): string {
  return `probe-v${version}-${tag}-${RUN_STAMP}`;
}

const PROBE_ROUTE = `import { NextResponse } from "next/server";

async function handle(request: Request, method: string) {
  let echo: string | null = null;
  if (method !== "GET" && method !== "DELETE") {
    echo = await request.text().catch(() => null);
  }
  return NextResponse.json({ ok: true, method, echo, at: Date.now() });
}

export const GET = (r: Request) => handle(r, "GET");
export const POST = (r: Request) => handle(r, "POST");
export const PUT = (r: Request) => handle(r, "PUT");
export const PATCH = (r: Request) => handle(r, "PATCH");
export const DELETE = (r: Request) => handle(r, "DELETE");
`;

const PROBE_ACTION = `"use server";

export async function ping(): Promise<string> {
  return \`action-ok-\${Date.now()}\`;
}
`;

function probePage(marker: string): string {
  return `"use client";

import { useState } from "react";
import { ping } from "./actions";
// F-2 后 dev 形态挂在 /<label> basePath 下：Next 只给 Link/router/资产加前缀，
// 裸 fetch 必须自己带（模板 lib/base-path.ts 的 apiUrl，NEXT_PUBLIC_BASE_PATH 内联）。
import { apiUrl } from "@/lib/base-path";

const MARKER = ${JSON.stringify(marker)};

export default function ProbePage() {
  const [clicks, setClicks] = useState(0);
  const [results, setResults] = useState<string[]>([]);
  const [action, setAction] = useState("");

  async function send(method: string) {
    const response = await fetch(apiUrl("/api/probe"), {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify({ probe: 1 }),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean };
    setResults((prev) => [\`\${method} → \${response.status} ok=\${String(body.ok)}\`, ...prev].slice(0, 8));
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: 24, display: "grid", gap: 12 }}>
      <h1>#365 probe app</h1>
      <p data-testid="probe-marker">{MARKER}</p>
      <p>clicks: <span data-testid="probe-clicks">{clicks}</span></p>
      <button type="button" data-testid="probe-click" onClick={() => setClicks(clicks + 1)}>
        click me
      </button>
      {["POST", "PUT", "PATCH", "DELETE"].map((method) => (
        <button
          key={method}
          type="button"
          data-testid={\`probe-\${method}\`}
          onClick={() => void send(method)}
        >
          {method}
        </button>
      ))}
      <button
        type="button"
        data-testid="probe-action"
        onClick={() => void ping().then(setAction)}
      >
        server action
      </button>
      <ul data-testid="probe-results">
        {results.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
      <p data-testid="probe-action-result">{action}</p>
    </main>
  );
}
`;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

mkdirSync(SHOT_DIR, { recursive: true });
const browser = await launchBrowser();
const context: BrowserContext = await browser.newContext({
  locale: "en-US",
  viewport: { width: 1440, height: 900 },
});
const page: Page = await context.newPage();

const api = {
  async craft(
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const attempt = async () =>
      await page.evaluate(
        async ({ path, init }) => {
          const response = await fetch(`/api/craft/${path}`, init);
          return {
            status: response.status,
            body: await response.json().catch(() => null),
          };
        },
        { path, init: init ?? {} } as never,
      );
    const first = await attempt();
    // vite 代理偶发截断响应体（json() 失败 → body null；run3 实测，server 侧
 // 同一请求 200 有体）：harness 层重试一次，不弱化任何断言。
    if (first.body !== null && first.status < 500) return first;
    await new Promise((r) => setTimeout(r, 1500));
    return await attempt();
  },
};

interface ProbeSession {
  id: string;
  port: number;
  name: string;
  label: string;
  origin: string;
}
const sessions: ProbeSession[] = [];

async function shot(name: string, target: Page = page) {
  await target
    .screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false })
    .catch(() => {});
}

async function waitReachable(
  url: string,
  timeoutMs: number,
  label: string,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    last = await fetch(url, { redirect: "manual" })
      .then((r) => r.status)
      .catch(() => 0);
    if (last > 0) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `${label} 在 ${timeoutMs / 1000}s 内未就绪（最后状态 ${last}）`,
  );
}

/** 端口真正释放（连接拒绝）才返回；stop 是异步的，立即重启会 EADDRINUSE。 */
async function waitPortFree(port: number, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const code = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: "manual",
    })
      .then((r) => r.status)
      .catch(() => 0);
    if (code === 0) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `${label}：端口 ${port} 在 ${timeoutMs / 1000}s 内未释放（残留进程？）`,
  );
}

async function installProbeApp(
  session: { id: string; port: number; label: string },
  tag: string,
) {
  const markerV1 = probeMarker(1, tag);
  // 1) 脚手架落地：start-webapp.sh 拷模板 → bun install → 起 dev server
  //    （附着模型：脚本是唯一进程主人，我们只触发它）
  await startWebapp(session.id);
  await waitReachable(
    `http://127.0.0.1:${session.port}/`,
    180_000,
    `${tag} 脚手架 dev server`,
  );
  // 2) 停掉，把探针写进 outputs/web 后再启动：Turbopack 对“运行中新增的路由
  //    目录”不拾取（实测：启动后写入 app/api/probe/route.ts 永远 404），
  //    文件在启动前存在则会编译。stop 用容器内 /proc 扫描（前置说明第 6 条）。
  await stopSessionWebapp(session.id);
  await waitPortFree(session.port, 30_000, `${tag} 停服后`);
  await gatewayWriteFile(
    session.id,
    "outputs/web/app/page.tsx",
    probePage(markerV1),
  );
  await gatewayWriteFile(
    session.id,
    "outputs/web/app/actions.ts",
    PROBE_ACTION,
  );
  await gatewayWriteFile(
    session.id,
    "outputs/web/app/api/probe/route.ts",
    PROBE_ROUTE,
  );
  // 3) 再次启动（node_modules 已就绪，快）+ 就绪门。沙箱里 next dev 偶发
  //    秒级自灭（与 #365 无关的沙箱不稳定：复现干跑时好时坏），所以门里带
  //    自愈：端口死掉就重拉（start-webapp.sh 幂等：pid 活着复用，死了重拉）；
  //    连接活着但不足我们的 marker = 别的 server 占位，直接失败不白等。
  let lastSeen = "";
  let attempt = 0;
  while (attempt < 5) {
    attempt += 1;
    await startWebapp(session.id);
    const attemptDeadline = Date.now() + 60_000;
    let servedWrongApp = false;
    while (Date.now() < attemptDeadline) {
      // F-2 后 dev server 挂在 /<label> basePath 下：直连端口的就绪门也必须
      // 走 label 前缀（端口根只回 404）。
      const probe = await fetch(
        `http://127.0.0.1:${session.port}/${session.label}/api/probe`,
      ).catch(() => null);
      const probeBody = probe?.ok ? await probe.json().catch(() => null) : null;
      const page = await fetch(
        `http://127.0.0.1:${session.port}/${session.label}/`,
      )
        .then((r) => r.text())
        .catch(() => "");
      lastSeen = `probe=${probe?.status ?? "err"} page=${page.slice(0, 90).replace(/\s+/g, " ")}`;
      if (
        probeBody &&
        (probeBody as { method?: string }).method === "GET" &&
        page.includes(markerV1)
      ) {
        return;
      }
      if (page.length > 0 && !page.includes(markerV1)) {
        // 有应答但不是我们的应用：重拉无效，直接判身份错误
        servedWrongApp = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (servedWrongApp) break;
    // 端口死了：清干净残留再试
    await stopSessionWebapp(session.id).catch(() => {});
    await waitPortFree(session.port, 30_000, `${tag} 重拉前`).catch(() => {});
  }
  const logTail = Bun.spawn([
    "docker",
    "exec",
    SANDBOX_CONTAINER,
    "sh",
    "-c",
    `tail -c 600 /workspace/bots/craft/${session.id}/nextjs.log 2>/dev/null`,
  ]);
  const logText = await new Response(logTail.stdout).text();
  throw new Error(
    `${tag} 探针未就绪（${attempt} 次自愈重启后）。最后观测：${lastSeen}；nextjs.log 尾部：${logText.slice(0, 300).replace(/\s+/g, " ")}`,
  );
}

/**
 * 给会话落一条 user 消息行（与 send-message 写入的同形）："空会话"判定是
 * "无消息"，不落消息的话下一个 POST /sessions 会复用本行并改名，两个真实
 * 会话就变不成两行。用 Bun.sql 直写（DATABASE_URL），不触发 LLM turn。
 */
async function markSessionNonEmpty(
  sessionId: string,
  tag: string,
): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL 未设置（.env 存在时脚本会自动加载），无法标记探针会话为非空",
    );
  }
  const sql = new Bun.sql(url);
  try {
    await sql`insert into craft_messages (id, session_id, turn_index, type, message_metadata)
      values (${`cm-accept-${tag.toLowerCase()}-${RUN_STAMP}`}, ${sessionId}, 0, 'user',
        ${JSON.stringify({
          type: "user_message",
          content: {
            type: "text",
            text: `#365 acceptance probe session ${tag}`,
          },
        })}::jsonb)`;
  } finally {
    await sql.end();
  }
}

try {
  // ── 0. 前置探测 ────────────────────────────────────────────────────────────
  await step(
    "pass",
    "preflight: app / API / Casdoor / sandbox / preview-origin 可达",
    async () => {
      const app = await fetch(`${APP_ORIGIN}/`)
        .then((r) => r.status)
        .catch(() => 0);
      assert(
        app === 200,
        `app ${APP_ORIGIN} → ${app}（先起 app dev server，见脚本头说明）`,
      );
      const casdoor = await fetch("http://localhost:8000/")
        .then((r) => r.status)
        .catch(() => 0);
      assert(casdoor === 200, `Casdoor :8000 → ${casdoor}`);
      const gw = await fetch(`${GATEWAY}/health`, { headers: gatewayHeaders() })
        .then((r) => r.status)
        .catch(() => 0);
      assert(gw === 200, `sandbox gateway ${GATEWAY} /health → ${gw}`);
      const bogus = await fetch(`${PREVIEW_ORIGIN}/definitely-not-a-label/`)
        .then(async (r) => ({ status: r.status, body: await r.text() }))
        .catch(() => ({ status: 0, body: "" }));
      assert(
        bogus.status === 404 && bogus.body.includes("Unknown preview host"),
        `preview origin ${PREVIEW_ORIGIN} 对未知 label 应回 404 "Unknown preview host"，实际 ${bogus.status} ${bogus.body.slice(0, 60)}`,
      );
      return `preview origin ${PREVIEW_ORIGIN} 就绪`;
    },
  );

  // ── 1. Casdoor 登录 ────────────────────────────────────────────────────────
  await step("pass", "Casdoor 真实登录回到应用", async () => {
    await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded", timeout: T });
    try {
      await page
        .getByRole("button", { name: "Continue with Casdoor" })
        .click({ timeout: 10_000 });
    } catch {
      /* 单提供商时已自动进入 */
    }
    await page.locator("#username").waitFor({ state: "visible", timeout: T });
    await page.fill("#username", CASDOOR_USER);
    await page.fill("#password", CASDOOR_PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForURL(new RegExp(APP_ORIGIN.replace(/\//g, "\\/")), {
      timeout: T,
    });
    const listed = await api.craft("sessions");
    assert(
      listed.status === 200,
      `登录后 GET /api/craft/sessions → ${listed.status}`,
    );
    return page.url();
  });

  // ── 2. 清掉上一轮的探针会话（幂等复跑）────────────────────────────────────
  await step(
    "pass",
    "清理上一轮探针会话（先停残留 dev server 再删行）",
    async () => {
      const listed = await api.craft("sessions");
      const stale = (listed.body?.sessions ?? []).filter(
        (s: { name?: string }) =>
          String(s.name ?? "").startsWith(SESSION_PREFIX),
      );
      const notes: string[] = [];
      for (const s of stale as Array<{ id: string }>) {
        notes.push(
          `${s.id.slice(0, 10)} server=${await stopSessionWebapp(s.id)}`,
        );
        await api.craft(`sessions/${s.id}`, { method: "DELETE" });
      }
      return stale.length
        ? `删除 ${stale.length} 个（${notes.join(" ")}）`
        : "无残留";
    },
  );

  // ── 3. 两个真实会话 + 探针应用 ────────────────────────────────────────────
  for (const tag of ["A", "B"]) {
    await step("pass", `会话 ${tag}：创建并装上探针应用`, async () => {
      const created = await api.craft("sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `${SESSION_PREFIX} ${tag} ${RUN_STAMP}` }),
      });
      assert(
        created.status === 201,
        `POST /sessions → ${created.status} ${JSON.stringify(created.body).slice(0, 120)}`,
      );
      const row = created.body;
      assert(row.status === "active", `会话状态 ${row.status}`);
      assert(typeof row.nextjs_port === "number", "会话未预留在端口");
      // 立刻落用户消息："空会话"判定是无消息（store.getEmptySessionForUser），
      // 不落消息的话，下一个 POST /sessions 会复用本会话行并改名 —— 两个真实
      // 会话必须是两行。形状与 send-message 写入的 user 行一致（不走 LLM turn）。
      await markSessionNonEmpty(row.id, tag);
      // 等到 start-webapp.sh 已由 provision 落进沙箱
      for (let i = 0; i < 30; i++) {
        const probe = await fetch(
          `${GATEWAY}/file?path=${encodeURIComponent(`${row.id}/start-webapp.sh`)}`,
          { headers: gatewayHeaders() },
        ).catch(() => null);
        if (probe?.status === 200 || probe?.status === 404) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      // 建会话后立即取 webapp_url：label 是服务端 HMAC 派生的确定性值，
      // 不依赖 webapp ready —— 探针安装与直连端口就绪门都需要它（F-2 basePath）。
      const early = await api.craft(`sessions/${row.id}/webapp-info`);
      const origin = String(early.body?.webapp_url ?? "");
      assert(
        origin.startsWith(`${PREVIEW_ORIGIN}/`),
        `webapp_url=${origin} 不是 preview origin 绝对地址`,
      );
      const label = new URL(origin).pathname.slice(1).split("/")[0];
      await installProbeApp(
        { id: row.id, port: row.nextjs_port, label },
        tag,
      );
      const info = await api.craft(`sessions/${row.id}/webapp-info`);
      assert(
        info.body?.ready === true,
        `webapp-info 不 ready：${JSON.stringify(info.body).slice(0, 160)}`,
      );
      assert(
        String(info.body?.webapp_url ?? "") === origin,
        `webapp_url 前后不一致：${String(info.body?.webapp_url)} vs ${origin}`,
      );
      sessions.push({
        id: row.id,
        port: row.nextjs_port,
        name: row.name,
        label,
        origin,
      });
      return `sid=${row.id} port=${row.nextjs_port} label=${sessions.at(-1)?.label}`;
    });
  }
  const [sessionA, sessionB] = sessions;
  assert(sessionA && sessionB, "两个会话未能建立");

  // webapp_url 不含会话 id（D7/AC9 面）：label 是 hash，不是 cs-…
  await step(
    "pass",
    "预览地址的 host/label 不泄露会话 id（D7 面）",
    async () => {
      assert(
        !sessionA.origin.includes(sessionA.id),
        `origin 含 session id：${sessionA.origin}`,
      );
      assert(
        /^[0-9a-f]{20}$/.test(sessionA.label),
        `label 形状异常：${sessionA.label}`,
      );
      return `label=${sessionA.label}`;
    },
  );

  // ── 4. 预览面板（iframe）进入 ─────────────────────────────────────────────
  let paneEntryOk = false;
  await step(
    "pass",
    "预览面板：换票 → iframe 进入 preview origin 且票据不留在 URL",
    async () => {
      await page.goto(`${APP_ORIGIN}/craft/${sessionA.id}`, {
        waitUntil: "domcontentloaded",
        timeout: T,
      });
      await page.waitForSelector("iframe[title]", { timeout: T });
      const iframe = page.locator("iframe[title]");
      const entrySrc = await iframe.getAttribute("src");
      assert(
        entrySrc?.startsWith(`${PREVIEW_ORIGIN}/`),
        `iframe src 不在 preview origin：${entrySrc}`,
      );
      assert(
        entrySrc.includes("ticket="),
        "iframe src 未带票据（换票封装未生效）",
      );
      await page.waitForTimeout(9000); // 兑换跳 + 后续请求窗口
      const frame = page.frameLocator("iframe[title]");
      const text = await frame
        .locator("body")
        .innerText({ timeout: 15_000 })
        .catch(() => "");
      const pass = await cdpDomainCookies(page, "127.0.0.1");
      paneEntryOk =
        pass.some((c) => c.name === "openbot_preview_session") &&
        text.includes("probe") &&
        !text.includes("Open this preview");
      assert(
        paneEntryOk,
        `面板未进入应用；帧文=${JSON.stringify(text.slice(0, 120))}；preview 域通行证（CDP 全量 jar）=${JSON.stringify(pass.map((c) => c.name))}`,
      );
      await shot("01-pane-entry");
      return "面板进入成功";
    },
  );
  if (!paneEntryOk) {
    record(
      "finding",
      "F-1 面板 iframe 兑换跳的 D9 cookie（SameSite=Lax）被浏览器在跨站 iframe 上下文拒收",
      `iframe 停在拒绝页。preview 域通行证（CDP 全量 jar）为空 → 兑换 302 的 Set-Cookie 未存储。Chrome 对跨站 iframe 内设置的 cookie 拒绝存储时即为 F-1 形态。截图 01-pane-entry.png`,
    );
    record(
      "finding",
      "F-2 dev 形态资源 URL 不带 <label> 段 → /_next/** 404，面板/顶层页都不 hydrate",
      `HTML 引用 origin 根绝对 /_next/...，preview origin 按 label 路由 → "Unknown preview host" 404。点按/Server Action/HMR 的 DOM 热更依赖 hydrate，全部受阻。回退 #362（dev 形态资源路由）与 #364（退场 basePath 后资源 URL 形状）`,
    );
    await shot("01-pane-entry-failed");
  }

  // ── 5. 顶层第一方进入（旁路验证面：票据兑换在第一方跳转里成立）────────────
  let previewPage: Page | null = null;
  await step(
    "pass",
    "顶层第一方进入：票据兑换 302 → 干净 URL + 预览域会话 cookie 种下",
    async () => {
      const minted = await api.craft(`sessions/${sessionA.id}/preview-ticket`, {
        method: "POST",
      });
      assert(minted.status === 200, `签票 → ${minted.status}`);
      const { ticket, origin } = minted.body;
      assert(
        origin === sessionA.origin,
        `origin 不一致：${origin} vs ${sessionA.origin}`,
      );
      previewPage = await context.newPage();
      // harness 诊断：预览 tab 的控制台/页面错误/失败请求直接落在日志里，
      // hydrate 类断言失败时无需复跑即可归因。
      previewPage.on("console", (m) =>
        log(`      [tab-console:${m.type()}] ${m.text().slice(0, 220)}`),
      );
      previewPage.on("pageerror", (e) =>
        log(`      [tab-pageerror] ${String(e).slice(0, 300)}`),
      );
      previewPage.on("requestfailed", (r) =>
        log(`      [tab-requestfailed] ${r.url().slice(0, 150)} ${r.failure()?.errorText ?? ""}`),
      );
      await previewPage.goto(`${origin}?ticket=${encodeURIComponent(ticket)}`, {
        waitUntil: "domcontentloaded",
        timeout: T,
      });
      await previewPage
        .waitForLoadState("load", { timeout: T })
        .catch(() => {});
      const url = previewPage.url();
      assert(!url.includes("ticket="), `票据留在最终 URL：${url}`);
      // 通行证存在性走 CDP 全量 jar（context.cookies() 对 http 不返回 Secure
      // cookie，见头注）；并断言 F-1 的形状与行为学可达。
      const passes = await cdpDomainCookies(previewPage, "127.0.0.1");
      const pass = passes.find((c) => c.name === "openbot_preview_session");
      assert(
        pass,
        `预览域 cookie 未种下（CDP 全量 jar）：${JSON.stringify(passes.map((c) => c.name))}`,
      );
      assert(
        pass.secure && pass.httpOnly && String(pass.sameSite).toLowerCase() === "none",
        `通行证形状不是 F-1 的 HttpOnly; SameSite=None; Secure：${JSON.stringify(pass)}`,
      );
      // 行为学：通行证真的随请求走 —— 预览页同源 fetch 自身受保护的 API 必须通
      // （无通行证的对照是 AC3 的 401）。
      const probed = await previewPage.evaluate(async (label) => {
        const r = await fetch(`/${label}/api/probe`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const b = (await r.json().catch(() => ({}))) as { ok?: boolean };
        return { status: r.status, ok: b.ok === true };
      }, sessionA.label);
      assert(
        probed.status === 200 && probed.ok,
        `预览页同源 fetch 未携带通行证：${JSON.stringify(probed)}`,
      );
      // harness 诊断：React 接管信号快照（chunks/portal/DOM 子节点数）
      const hydrateSnapshot = await previewPage.evaluate(() => ({
        mainChildren: document.querySelector("main")?.children.length ?? -1,
        scripts: Array.from(document.scripts).map((s) => s.src.split("/").slice(-2).join("/")),
        portal: document.querySelector("nextjs-portal") !== null,
      }));
      log(`      [hydrate-snapshot] ${JSON.stringify(hydrateSnapshot)}`);
      const html = await previewPage.content();
      assert(
        html.includes("#365 probe"),
        "顶层预览页未渲染探针应用（服务端渲染面）",
      );
      await shot("02-first-party-entry", previewPage);
      return `url=${url} cookie=HttpOnly;SameSite=None;Secure 同源fetch=${probed.status}/ok`;
    },
  );

  // ── AC1：隔离 ─────────────────────────────────────────────────────────────
  await step(
    "pass",
    "AC1 document.cookie：预览页看不到任何主站 cookie（通行证 HttpOnly 也不可见）",
    async () => {
      assert(previewPage, "前置失败");
      const docCookie = await previewPage.evaluate(() => document.cookie);
      assert(
        docCookie.trim() === "",
        `document.cookie 非空：${JSON.stringify(docCookie)}`,
      );
      return `document.cookie=${JSON.stringify(docCookie)}`;
    },
  );

  await step(
    "pass",
    "AC1 cookie jar 真值：主站会话 cookie 只在主站 host，预览 host 只有通行证",
    async () => {
      assert(previewPage, "前置失败");
      const main = await context.cookies([APP_ORIGIN]);
      assert(main.length > 0, "主站 cookie jar 为空（未登录？）");
      // 预览 host 侧用 CDP 全量 jar（context.cookies() 看不到 Secure cookie，见头注）
      const preview = await cdpDomainCookies(previewPage, "127.0.0.1");
      const previewNames = preview.map((c) => c.name);
      assert(
        previewNames.every((n) => n === "openbot_preview_session"),
        `预览 host 出现非通行证 cookie：${JSON.stringify(previewNames)}`,
      );
      const leaked = await cdpDomainCookies(previewPage, "localhost");
      assert(
        !leaked.some((c) => c.name === "openbot_preview_session"),
        "通行证种到了主站 host",
      );
      const mainNames = main.map((c) => c.name);
      assert(
        !mainNames.includes("openbot_preview_session"),
        "通行证种到了主站 host",
      );
      return `主站=${JSON.stringify(mainNames.slice(0, 4))}… 预览（CDP）=${JSON.stringify(previewNames)}`;
    },
  );

  await step(
    "pass",
    "AC1 localStorage：预览 origin 是独立库（双向隔离）",
    async () => {
      assert(previewPage, "前置失败");
      // 主站页写一个标记
      await page.evaluate(
        (v) => localStorage.setItem("main-marker", v),
        `main-${RUN_STAMP}`,
      );
      // 预览页看不到它，且能读写自己的库
      const previewState = await previewPage.evaluate(async (stamp) => {
        const seenMain = localStorage.getItem("main-marker");
        localStorage.setItem("preview-marker", `preview-${stamp}`);
        return {
          seenMain,
          own: localStorage.getItem("preview-marker"),
          keys: Object.keys(localStorage),
        };
      }, RUN_STAMP);
      assert(
        previewState.seenMain === null,
        `预览 localStorage 读到主站标记：${previewState.seenMain}`,
      );
      assert(
        previewState.own === `preview-${RUN_STAMP}`,
        "预览 localStorage 读写自身失败",
      );
      // 反向：主站看不到预览的标记
      const mainSees = await page.evaluate(() =>
        localStorage.getItem("preview-marker"),
      );
      assert(mainSees === null, `主站 localStorage 读到预览标记：${mainSees}`);
      return `预览 keys=${JSON.stringify(previewState.keys)}`;
    },
  );

  await step(
    "pass",
    "AC1 生成代码跨 origin 调主站 API：拿不到平台会话（CSP 拒绝或 401）",
    async () => {
      assert(previewPage, "前置失败");
      const outcome = await previewPage.evaluate(async (target) => {
        try {
          const response = await fetch(target, { credentials: "include" });
          const body = await response.text();
          return {
            kind: "responded",
            status: response.status,
            body: body.slice(0, 80),
          };
        } catch (error) {
          return {
            kind: "refused",
            name: (error as Error).name,
            message: (error as Error).message.slice(0, 120),
          };
        }
      }, `${APP_ORIGIN}/api/craft/sessions`);
      const leaked = outcome.kind === "responded" && outcome.status === 200;
      assert(
        !leaked,
        `跨 origin 调用拿到 200（会话泄露）：${JSON.stringify(outcome)}`,
      );
      const detail =
        outcome.kind === "refused"
          ? `请求被拒（${outcome.name}: ${outcome.message}）——CSP connect-src 'self' 先于网络拦截`
          : `HTTP ${outcome.status}（未携带平台会话）`;
      return detail;
    },
  );

  // 协议层 401（可选证据）：从 preview origin 的无 CSP 拒绝页发起 no-cors 凭证请求，
  // 浏览器按 SameSite 不携带主站 cookie；请求是否 401 由 API server 日志佐证。
  await step(
    "pass",
    "AC1 协议层：preview origin 发起的凭证请求不带主站 cookie（server 日志 401）",
    async () => {
      if (!SERVER_LOG || !existsSync(SERVER_LOG)) {
        throw new SkipSignal(
          "未提供 CRAFT_ACCEPTANCE_SERVER_LOG，跳过（脚本头说明第 5 步）",
        );
      }
      assert(previewPage, "前置失败");
      // 无 cookie 请求 preview origin 的受保护路径 → 拒绝页（无 CSP 的执行上下文）
      const bare = await context.newPage();
      await bare.goto(`${PREVIEW_ORIGIN}/${sessionA.label}/probe-ac1-context`, {
        waitUntil: "domcontentloaded",
        timeout: T,
      });
      const sent = await bare.evaluate(async (target) => {
        // 默认 cors 模式：响应无 ACAO 不可读（fetch 抛 TypeError），但请求本身
        // 已过网：SameSite=Lax 的主站 cookie 在跨站子资源请求里不被携带，
        // server 侧如实记下 401 —— 用日志钉住协议层事实。
        try {
          await fetch(target, { credentials: "include" });
          return "readable";
        } catch (error) {
          return `blocked-at-read:${(error as Error).name}`;
        }
      }, `${API_ORIGIN}/api/craft/sessions`);
      assert(
        sent.startsWith("blocked-at-read") || sent === "readable",
        `fetch 形状异常：${sent}`,
      );
      await new Promise((r) => setTimeout(r, 2500));
      const log = readFileSync(SERVER_LOG, "utf8");
      const hits = log
        .split("\n")
        .filter(
          (line) =>
            line.includes('"path":"/api/craft/sessions"') &&
            line.includes('"status":401'),
        );
      assert(hits.length > 0, "server 日志未观测到该次 401");
      await bare.close();
      return `preview origin 页面 fetch（credentials:include）→ ${sent}；server 日志 401 ×${hits.length}（主站 cookie 未随行）`;
    },
  );

  // ── AC2 面（可交互不回退）：应用自身 API 四动词经过 preview origin 代理 ────
  await step(
    "pass",
    "可交互：应用自身 API 的 POST/PUT/PATCH/DELETE 经 preview origin 全部 200",
    async () => {
      assert(previewPage, "前置失败");
      const verdicts: string[] = [];
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const verdict = await previewPage.evaluate(
          async ({ label, method }) => {
            const response = await fetch(`/${label}/api/probe`, {
              method,
              headers: { "content-type": "application/json" },
              body:
                method === "DELETE" ? undefined : JSON.stringify({ probe: 1 }),
            });
            const body = (await response.json().catch(() => ({}))) as {
              ok?: boolean;
              method?: string;
            };
            return `${method}:${response.status}/${body.ok === true && body.method === method ? "reached" : "wrong"}`;
          },
          { label: sessionA.label, method },
        );
        verdicts.push(verdict);
      }
      const bad = verdicts.filter((v) => !/:200\/reached$/.test(v));
      assert(
        bad.length === 0,
        `未全部到达自身 route handler：${JSON.stringify(verdicts)}`,
      );
      return verdicts.join(" ");
    },
  );

  // 点按（UI 级点击 → POST → 200）依赖 hydrate；F-2 下如实记录
  await step("pass", "点击 → POST → 200（UI 级，依赖 hydrate）", async () => {
    assert(previewPage, "前置失败");
    const marker = await previewPage.evaluate(() => {
      const el = document.querySelector('[data-testid="probe-marker"]');
      return el?.textContent ?? null;
    });
    const hydrated = await previewPage
      .evaluate(() => {
        const button = document.querySelector('[data-testid="probe-POST"]');
        return button !== null;
      })
      .catch(() => false);
    // SSR 也渲染按钮，靠 React 客户端接管信号判断：点击后 DOM 变化。
    // hydrate 完成前的点击会丢（事件无人接）：最多两轮点击，每轮后轮询 5s，
    // 断言不变 —— UI 点击最终必须到达 handler。
    let clicked = false;
    if (hydrated) {
      for (let attempt = 0; attempt < 2 && !clicked; attempt++) {
        await previewPage
          .locator('[data-testid="probe-POST"]')
          .click({ timeout: 10_000 })
          .catch(() => {});
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !clicked) {
          clicked = await previewPage
            .locator('[data-testid="probe-results"]')
            .innerText()
            .then((t) => t.includes("POST → 200"))
            .catch(() => false);
          if (!clicked) await previewPage.waitForTimeout(1000);
        }
      }
    }
    assert(
      clicked,
      `未 hydrate（marker=${marker}）——F-2 阻塞，UI 点击无法到达 handler`,
    );
    await shot("03-click-post", previewPage);
    return "点击后结果列表出现 POST → 200";
  });

  // ── AC3：会话互访拒绝 ─────────────────────────────────────────────────────
  await step(
    "pass",
    "AC3 会话 A 的预览内 fetch 会话 B 的路径 → 一律拒绝",
    async () => {
      assert(previewPage, "前置失败");
      const checks = await previewPage.evaluate(
        async ({ labelB, sidB }) => {
          const outcomes: Record<string, unknown> = {};
          const get = await fetch(`/${labelB}/`).catch(() => null);
          outcomes.docRoot = get ? get.status : "network-error";
          const post = await fetch(`/${labelB}/api/probe`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ try: "write-into-b" }),
          }).catch(() => null);
          outcomes.apiPost = post ? post.status : "network-error";
          outcomes.apiBody = post
            ? (await post.text().catch(() => "")).slice(0, 80)
            : "";
          // 直接带 B 的 session id 也打不开 B（cookie 名义当前 host 的会话）
          const forged = await fetch(`/${labelB}/api/probe`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: `openbot_preview_session=${sidB}`,
            },
          }).catch(() => null);
          outcomes.forgedCookie =
            forged === null ? "browser-blocked" : forged.status;
          return outcomes;
        },
        { labelB: sessionB.label, sidB: sessionB.id },
      );
      assert(
        checks.docRoot === 401,
        `读 B 的文档根：${JSON.stringify(checks.docRoot)}`,
      );
      assert(
        checks.apiPost === 401,
        `POST B 的 API：${JSON.stringify(checks.apiPost)} ${String(checks.apiBody)}`,
      );
      const refused = [checks.docRoot, checks.apiPost].every((v) => v === 401);
      assert(refused, `存在未被拒绝的跨会话访问：${JSON.stringify(checks)}`);
      return `docRoot=${checks.docRoot} apiPost=${checks.apiPost}（伪造 cookie 头：${String(checks.forgedCookie)}）`;
    },
  );

  // ── AC5：HMR 通道 + 热更新 ────────────────────────────────────────────────
  let hmrFrames: { frames: string[]; wsUrl: string } | null = null;
  await step(
    "pass",
    "AC5 HMR：preview origin 上的 /_next/webpack-hmr 升级成功且帧双向流动",
    async () => {
      assert(previewPage, "前置失败");
      hmrFrames = await previewPage.evaluate(
        (label) =>
          new Promise<{ frames: string[]; wsUrl: string; opened: boolean }>(
            (resolve) => {
              const frames: string[] = [];
              const ws = new WebSocket(`/${label}/_next/webpack-hmr`);
              const finish = () =>
                resolve({ frames, wsUrl: ws.url, opened: frames.length > 0 });
              ws.onmessage = (event) => {
                frames.push(String(event.data).slice(0, 120));
                if (frames.length >= 3) {
                  ws.close();
                  finish();
                }
              };
              ws.onerror = () =>
                resolve({ frames, wsUrl: ws.url, opened: false });
              setTimeout(() => {
                try {
                  ws.close();
                } catch {}
                finish();
              }, 20_000);
            },
          ),
        sessionA.label,
      );
      assert(
        hmrFrames.frames.length > 0,
        `HMR 升级后 0 帧（ws=${hmrFrames.wsUrl}）`,
      );
      return `frames=${hmrFrames.frames.length} 首帧=${JSON.stringify(hmrFrames.frames[0]?.slice(0, 60))}`;
    },
  );

  await step(
    "pass",
    "AC5 文件改动触发热更新：编辑 page.tsx → 通道收到失效信号",
    async () => {
      assert(previewPage && hmrFrames, "前置失败");
      // 第二只 socket：只负责收编辑后的失效/构建帧
      const opened = await previewPage.evaluate(
        (label) =>
          new Promise<number>((resolve) => {
            const frames: string[] = [];
            const ws = new WebSocket(`/${label}/_next/webpack-hmr`);
            ws.onmessage = (event) =>
              frames.push(String(event.data).slice(0, 200));
            ws.onopen = () => resolve(1);
            ws.onerror = () => resolve(0);
            setTimeout(() => resolve(frames.length > 0 ? 1 : 0), 10_000);
            (window as unknown as Record<string, unknown>).__hmrFrames = frames;
          }),
        sessionA.label,
      );
      assert(opened === 1, "第二只 HMR socket 未建立");
      // 记住当前 marker，再改文件（marker 断言在下一 check）
      const markerBefore = await previewPage.evaluate(
        () =>
          document.querySelector('[data-testid="probe-marker"]')?.textContent ??
          null,
      );
      await previewPage.evaluate(() => {
        (window as unknown as Record<string, unknown>).liveStamp = "alive";
      });
      await gatewayWriteFile(
        sessionA.id,
        "outputs/web/app/page.tsx",
        probePage(probeMarker(2)),
      );
      await new Promise((r) => setTimeout(r, 9000));
      const after = await previewPage.evaluate(
        () =>
          (
            (window as unknown as Record<string, unknown>).__hmrFrames as
              | string[]
              | undefined
          )?.slice(-4) ?? [],
      );
      const invalidation = after.some((f) =>
        /invalid|built|"action"|hmr|change/i.test(f),
      );
      assert(invalidation, `编辑后未收到失效/构建帧：${JSON.stringify(after)}`);
      return `编辑后新增帧：${JSON.stringify(after.slice(-2).map((f) => f.slice(0, 60)))}；markerBefore=${String(markerBefore)}`;
    },
  );

  await step(
    "pass",
    "AC5 热更新生效于 DOM（改一行 → DOM 变化且不整页刷新）",
    async () => {
      assert(previewPage, "前置失败");
      let markerNow: string | null = null;
      for (let i = 0; i < 15; i++) {
        markerNow = await previewPage.evaluate(
          () =>
            document.querySelector('[data-testid="probe-marker"]')
              ?.textContent ?? null,
        );
        if (markerNow?.startsWith("probe-v2-")) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      const survived = await previewPage.evaluate(
        () => "liveStamp" in (window as unknown as Record<string, unknown>),
      );
      assert(
        typeof markerNow === "string" && markerNow.startsWith("probe-v2-"),
        `DOM 未热更（marker=${String(markerNow)}）——F-2 未 hydrate 时预期失败`,
      );
      assert(survived, "window 身份丢失（整页刷新而非热更）");
      await shot("06-hmr-dom", previewPage);
      return `marker → ${markerNow}，window 身份保留`;
    },
  );

  // ── 全屏放大/还原（回归）──────────────────────────────────────────────────
  await step("pass", "全屏放大/还原不重挂载 iframe（回归）", async () => {
    await page.bringToFront().catch(() => {});
    const iframe = page.locator("iframe[title]");
    await iframe.waitFor({ timeout: T });
    // 帧内世界放一个标记（跨 origin 也可：isolated world 属于当前文档）
    const frame = page.frameLocator("iframe[title]");
    await frame
      .locator("body")
      .evaluate(() => {
        (window as unknown as Record<string, unknown>).__expandProbe = "alive";
      })
      .catch(() => {});
    const expand = page.getByLabel("Expand preview");
    await expand.waitFor({ timeout: 15_000 });
    await expand.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 10_000 });
    const box = await dialog.boundingBox();
    assert(
      box && box.width > 1400 && box.height > 850,
      `放大后视口 ${JSON.stringify(box)}`,
    );
    const markerAfter = await frame
      .locator("body")
      .evaluate(
        () =>
          (window as unknown as Record<string, unknown>).__expandProbe ?? null,
      )
      .catch(() => null);
    await shot("04-expanded");
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', {
      state: "detached",
      timeout: 10_000,
    });
    const markerAfterCollapse = await frame
      .locator("body")
      .evaluate(
        () =>
          (window as unknown as Record<string, unknown>).__expandProbe ?? null,
      )
      .catch(() => null);
    await shot("05-collapsed");
    assert(
      markerAfter === "alive",
      `放大后帧内标记丢失（重挂载）：${String(markerAfter)}`,
    );
    assert(
      markerAfterCollapse === "alive",
      `还原后帧内标记丢失（重挂载）：${String(markerAfterCollapse)}`,
    );
    const note = paneEntryOk
      ? "帧内容为运行中的应用"
      : "帧内容是 401 拒绝页（F-1）；标记存活仍证明同一文档未重挂载";
    return `放大/还原标记均存活；${note}`;
  });

  if (paneEntryOk) {
    // F-1/F-2 修复后面板进入应用，这个此前只能 SKIP 的回归现在可以真跑：
    // 面板内点击产生状态，放大/还原后状态必须还在（同一文档、未重挂载）。
    await step("pass", "点击结果跨放大保留（回归）", async () => {
      const frame = page.frameLocator("iframe[title]");
      await frame.locator('[data-testid="probe-click"]').click({ timeout: 15_000 });
      await page.waitForTimeout(1200);
      const before = (
        await frame.locator('[data-testid="probe-clicks"]').innerText({ timeout: 10_000 })
      ).trim();
      const expand = page.getByLabel("Expand preview");
      await expand.waitFor({ timeout: 15_000 });
      await expand.click();
      await page.getByRole("dialog").waitFor({ timeout: 10_000 });
      const during = (
        await frame.locator('[data-testid="probe-clicks"]').innerText({ timeout: 10_000 })
      ).trim();
      await shot("04-expanded");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 10_000 });
      const after = (
        await frame.locator('[data-testid="probe-clicks"]').innerText({ timeout: 10_000 })
      ).trim();
      await shot("05-collapsed");
      assert(before.length > 0, `面板内点击后读不到状态`);
      assert(
        during === before,
        `放大后点击状态丢失：${during} vs ${before}`,
      );
      assert(
        after === before,
        `还原后点击状态丢失：${after} vs ${before}`,
      );
      return `clicks=${before} 跨放大/还原保留`;
    });
  } else {
    await step("skip", "点击结果跨放大保留（回归）", async () => {
      throw new SkipSignal("面板未进入应用（F-1/F-2），帧内无点击状态可保留");
    });
  }

  // Server Actions（#362 的 AC2 面，回归观察）：依赖 hydrate
  await step(
    "skip",
    "Server Actions（依赖 hydrate，F-2 修复后启用协议级断言）",
    async () => {
      throw new SkipSignal(
        "页面未 hydrate（F-2），action id 尚未进入客户端 bundle",
      );
    },
  );
} catch (error) {
  record(
    "fail",
    "run completed",
    error instanceof Error ? error.message.slice(0, 300) : String(error),
  );
} finally {
  if (CLEANUP) {
    for (const s of sessions) {
      await stopSessionWebapp(s.id).catch(() => {});
      await api.craft(`sessions/${s.id}`, { method: "DELETE" }).catch(() => {});
    }
    log(`已停并删除 ${sessions.length} 个探针会话（CLEANUP=1）`);
  }
  const counts = { pass: 0, fail: 0, skip: 0, finding: 0 } as Record<
    string,
    number
  >;
  for (const r of results) counts[r.kind] += 1;
  log(
    `\n=== #365 缝合验收：${counts.pass} PASS / ${counts.fail} FAIL / ${counts.skip} SKIP / ${counts.finding} FINDING ===`,
  );
  log(
    `会话：${sessions.map((s) => `${s.name}(${s.id}, :${s.port}, label=${s.label})`).join(" ; ") || "（未建立）"}`,
  );
  log(`截图目录：${SHOT_DIR}/`);
  await browser.close();
  process.exit(counts.fail > 0 ? 1 : 0);
}
