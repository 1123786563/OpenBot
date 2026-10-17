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
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright-core";

// e2e.config 同款：先加载 .env，再读环境变量（DATABASE_URL 在里面）。必须
// 在下方所有常量声明之前执行：loadEnvFile 只填充 process.env，声明顺序倒置
// 的话 CRAFT_ACCEPTANCE_* 写进 .env 会静默不生效（只有晚读的 DATABASE_URL
// 之类运行期读取才赶得上）。fix-ocr19 M1：原先两行落在常量声明之后，注释
// 却自称与 e2e.config 同款——事实源那边是先 load 后读，这里对齐。
if (existsSync(".env")) process.loadEnvFile(".env");

const APP_ORIGIN =
  process.env.CRAFT_ACCEPTANCE_APP_ORIGIN ?? "http://localhost:3220";
const API_ORIGIN =
  process.env.CRAFT_ACCEPTANCE_API_ORIGIN ?? "http://localhost:3221";
/**
 * fix-ocr28 #13：镜像服务端默认端口拼写（fix-ocr27 #6 —— preview-ticket 的
 * defaultPreviewOrigin / preview-origin 的 portSuffix 同一规则）：http 的
 * scheme 默认端口 80 会被 URL 序列化丢弃，:80 监听的预览地址不带后缀。
 * 旧的 `|| "80"` 无条件拼出 `http://127.0.0.1:80` —— 行为正确的服务端
 * 永远不铸造这个地址，步骤 3 的 `origin.startsWith(PREVIEW_ORIGIN)` 对它
 * 必 FAIL。端口为空或 80 时不带后缀，与服务端逐字一致。
 */
const API_PORT = new URL(API_ORIGIN).port;
const PREVIEW_ORIGIN = `http://127.0.0.1${API_PORT === "" || API_PORT === "80" ? "" : `:${API_PORT}`}`;
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
/**
 * 本地沙箱容器名（stopSessionWebapp 的 docker exec 通道）。fix-ocr25 #11：
 * 「不可用时退化为警告」与事实不符 —— docker 二进制缺失/容器未跑时
 * Bun.spawn 同步抛错，无 catch 的调用点（步骤 2 清理循环、installProbeApp
 * 首次停服）会让所在步骤直接 FAIL；只有重拉循环与 finally 的
 * `.catch(() => {})` 才是退化形态。logTail（fix-ocr25 #9）已兜底为显式
 * 文案，不再让 spawn 抛错覆盖携带 lastSeen 的原始诊断。
 */
const SANDBOX_CONTAINER =
  process.env.CRAFT_ACCEPTANCE_SANDBOX_CONTAINER ?? "openbot-agent-sandbox-1";

const T = 45_000;
const SESSION_PREFIX = "#365 probe";
/**
 * 预览域通行证 cookie 名（fix-ocr18 #17）：与 server 侧常量保持一致的本地
 * 拼写 —— server/src/craft/preview-ticket.ts 的 PREVIEW_SESSION_COOKIE 是
 * 事实源，本模块不跨端 import，只收敛字面量到一处；6 处引用全部走它
 * （fix-ocr25 #10：实测 951/1034/1108/1112/1117/1122 六处，非旧注的 5 处）。
 * 两端拼写漂移时，断言会如实 FAIL（cookie 找不到），不会静默放过。
 */
const PREVIEW_SESSION_COOKIE = "openbot_preview_session";

/**
 * label 形状正则（fix-ocr25 #12）：脚本内两处断言（webapp_url 解析与 D7
 * 步骤）收敛单一常量，防单边修改造成断言口径分裂 —— 与
 * PREVIEW_SESSION_COOKIE 同一治理惯例（收敛字面量到一处）。
 */
const LABEL_SHAPE = /^[0-9a-f]{20}$/;

/**
 * AC5 两处 HMR socket 的完整地址（fix-ocr25 #5）：模块级收敛 —— 脚本侧已知
 * PREVIEW_ORIGIN 与 label，由脚本派生完整 ws 地址作为 evaluate 实参传入，
 * 页面内不再各自从 location 拼接。fix-ocr21 #1 的相对 URL 修复就曾被追着
 * 打了两遍补丁，正是该重复的实证风险（http→ws 只换首处 scheme：https
 * 形态自然落成 wss）。
 */
function hmrWsUrl(label: string): string {
  return `${PREVIEW_ORIGIN.replace(/^http/, "ws")}/${label}/_next/webpack-hmr`;
}
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

type StepResult = {
  name: string;
  kind: "pass" | "fail" | "skip" | "finding";
  detail: string;
};
const results: StepResult[] = [];

/**
 * 票据脱敏（fix-ocr5 A）：断言失败消息（iframe src、最终 URL、goto 错误）
 * 会把活体 ticket 带进终端日志——违反「票据值不得进入任何日志字段」红线。
 * sink 级兜底：record/log 的每一条出口文本都过一遍 ticket=… 替换，覆盖
 * previewPage 的 console/requestfailed 监听（经 log）与 goto 错误路径
 * （经 step 的 catch → record）。替换幂等：ticket=<redacted> 再过一遍不变。
 */
function redactTicket(text: string): string {
  return text
    .replace(/ticket=[^&\s"']+/g, "ticket=<redacted>")
    // 红线补丁（fix-ocr18 #16）：JSON 字段形态的票据值。一旦断言把
    // JSON.stringify 过的响应体带进日志（"ticket":"<活体值>"），上面的
    // query 形态盖不住它 —— 票据不得进任何日志字段，两种形态都要兜底。
    // 替换幂等："<redacted>" 再过一遍不变。
    .replace(/("ticket"\s*:\s*)"[^"]*"/g, '$1"<redacted>"');
}

function log(line: string) {
  console.log(redactTicket(line));
}

function record(kind: StepResult["kind"], name: string, detail = "") {
  // 存入 results 的 detail 一并脱敏（虽然目前只用于计数，出口处不该存污点）。
  results.push({ name, kind, detail: redactTicket(detail) });
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
  kind: "pass" | "skip",
  name: string,
  fn: () => Promise<string | undefined>,
) {
  try {
    const detail = (await fn()) || "";
    // fix-ocr18 #20：kind 收窄 —— 调用方只会传 pass/skip（fail 由 catch 产出，
    // finding 由 record 的调用方直接给），三元映射是死代码形态；直接透传。
    record(kind, name, detail);
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
): Promise<
  Array<{ name: string; secure: boolean; httpOnly: boolean; sameSite: string }>
> {
  // fix-ocr18 #18：自包含 —— 从 target 自己的 context 开 CDP 会话，消除对
  // 模块级 context 的 TDZ/初始化顺序依赖（函数定义在 context 之前，只是
  // 恰好被晚调用；自包含后参数即全部依赖）。
  const cdp = await target.context().newCDPSession(target);
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
    .map((c) => ({
      name: c.name,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
    }));
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
/**
 * sessionId 形状白名单（fix-ocr5 B / fix-ocr18 #14）：sessionId 直接拼进
 * `docker exec … sh -c "<脚本>"` 的命令文本 —— API 响应里的 id 一旦被伪造，
 * 未校验的插值就是容器内任意 shell 执行。按真实 id 形状（store.ts
 * newCraftId：cs- + randomBytes(12).hex）白名单校验后 fail-fast。两个 docker
 * exec 拼接点（stopSessionWebapp 与 logTail）各自就地断言，不依赖调用顺序
 * ——「本函数在所有抵达 logTail 的路径上先被执行」的传递性论证是顺序耦合，
 * 新增调用点时必然失守；就地断言让每个拼接点自己站住。
 */
function assertSessionId(sessionId: string): void {
  assert(
    /^cs-[0-9a-f]{24}$/.test(sessionId),
    "sessionId 形状不符合 cs-[0-9a-f]{24}，拒绝拼进 docker exec 脚本",
  );
}

/**
 * docker exec 环境段的形状白名单（fix-ocr23 #1）：SANDBOX_BOT 与
 * SANDBOX_CONTAINER 和 sessionId 同一威胁模型 —— 都来自 env
 * （CRAFT_ACCEPTANCE_SANDBOX_BOT / _SANDBOX_CONTAINER），脚本被 CI/自动化以
 * 不可信 env 调用时，未校验的插值即容器内任意 shell 执行；即使无恶意输入，
 * 含空格/元字符的 bot 名也会让命令语义漂移、误停/误读其他 bot 的工作区。
 * 与 assertSessionId 同一哲学的就地断言：两个 docker exec 拼接点
 * （stopSessionWebapp 与 installProbeApp 末尾的 logTail）各自调用本校验，
 * 不依赖任何调用顺序 —— 「某个调用者已先校验过」的传递性论证在新调用点
 * 出现时必然失守，每个拼接点自己站住。首字符限字母数字（不放行 `-` 开头的
 * docker 参数形态），其余限 `[a-zA-Z0-9._-]`。
 */
function assertDockerExecEnvShape(): void {
  const shaped = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
  assert(
    shaped(SANDBOX_BOT) && shaped(SANDBOX_CONTAINER),
    "SANDBOX_BOT/SANDBOX_CONTAINER 形状非法，拒绝拼进 docker exec 脚本",
  );
}

async function stopSessionWebapp(sessionId: string): Promise<string> {
  // fix-ocr5 B / fix-ocr18 #14：就地断言（见 assertSessionId）。
  assertSessionId(sessionId);
  // fix-ocr23 #1：第一个拼接点的 env 段（bot 进脚本文本、容器名进 exec
  // 目标）就地校验，与 sessionId 断言并列，不依赖调用顺序。
  assertDockerExecEnvShape();
  // fix-ocr22 #14：容器内路径的 bot 段贯穿 SANDBOX_BOT 常量（gateway 头的
  // x-openbot-bot-id 同源）—— 覆盖 CRAFT_ACCEPTANCE_SANDBOX_BOT 指向别的
  // bot 时，docker exec 的路径若仍硬编码 craft，停服/日志就指到错误的工作区。
  const botWorkspace = `/workspace/bots/${SANDBOX_BOT}`;
  const script = [
    // fix-ocr18 #15：pid 分支不再无条件 kill。共享容器里 PID 复用会让
    // 过期/伪造的 nextjs.pid 指向别的会话（甚至宿主侧）进程 —— kill 前先做
    // 身份核对：/proc/$pid/cwd 必须正是本会话的 outputs/web（与 server 侧
    // webapp.plugin.ts 的 pidOwnsAppDir 同款）。readlink 失败（进程已死或
    // /proc 不可读）视为身份不成立，跳过 kill，交下面的 /proc 扫描兜底 ——
    // 扫描按 cmdline 匹配本会话路径，不会误伤他人。
    `pid=$(cat ${botWorkspace}/${sessionId}/nextjs.pid 2>/dev/null)`,
    `if [ -n "$pid" ] && [ "$(readlink /proc/$pid/cwd 2>/dev/null)" = "${botWorkspace}/${sessionId}/outputs/web" ]; then`,
    '  kill "$pid" 2>/dev/null',
    "fi",
    "for d in /proc/[0-9]*; do",
    // review-365 L-4：跳过 shell 自身——脚本文本本身就含 session 路径 pattern，
    // shell 的 cmdline（sh -c "<整个脚本>"）会匹配 case，没这条就把自己 kill 掉
    // （docker exec 退出码 143，被误报为停止失败）。
    '  [ "$d" = "/proc/$$" ] && continue',
    "  cmd=$(tr '\\0' ' ' 2>/dev/null < $d/cmdline || true)",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell 参数展开必须原样进入脚本
    `  case "$cmd" in */bots/${SANDBOX_BOT}/${sessionId}/outputs/web*) kill ${"${d#/proc/}"} 2>/dev/null;; esac`,
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
        // as never：page.evaluate 的实参受 Playwright 自己的结构化序列化
        // 形参校验约束，而 RequestInit 是 DOM 类型 —— Playwright 的 TS 形态
        // 不认 bun/DOM fetch 的 init 形状差，这里只跨过该校验；运行时由
        // Playwright 序列化后原样到达 evaluate 的函数体（fix-ocr23 #3：
        // 与上面两处响应体收窄同源的类型治理，此处补注原因）。
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

/**
 * POST /sessions 的会话行形状（fix-ocr23 #2）：api.craft 的 body 是
 * `Record<string, unknown> | null`，自定义 assert 不带类型谓词 —— 只断言
 * 非空的话，后续 row.id / row.nextjs_port 以 unknown 流入 string/number
 * 形参，strict 下全是编译级类型错误，类型保护名存实亡。显式类型收窄 +
 * 运行时形状断言（转型可能说谎，断言才是事实源）。
 */
type CraftSessionRow = {
  id: string;
  name: string;
  status: string;
  nextjs_port: number;
};

interface ProbeSession {
  id: string;
  port: number;
  name: string;
  label: string;
  origin: string;
}
const sessions: ProbeSession[] = [];
// fix-ocr22 #12：CLEANUP 盲区。sessions 只在创建步骤的最后（webapp-info
// 断言全过）才 push —— installProbeApp 或 webapp-info 断言失败时，会话行
// 已建、dev server 可能已在跑，却逃出 finally 的 CLEANUP，留下孤儿会话与
// 占端口的残留进程。pendingIds 在 POST /sessions 成功后立即登记，CLEANUP
// 以它为准统一停服+删除（与创建范围对齐）；sessions（完整探针信息）只服务
// 测试步骤本身。两处求并集去重，重复 stop/DELETE 无害且都带 catch。
const pendingIds: string[] = [];

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

/**
 * 杀掉占用预留端口的孤儿 dev server（#358 修复 T3 环境适配）：早前失败运行的
 * 清理停了进程、但空闲 reaper 抢先删了行 —— DB 端口回收后，孤儿进程仍监听着
 * 会被重新预约的端口。installProbeApp 自身的 /proc 扫描按会话目录匹配，杀不
 * 到别人（早前会话）的孤儿；这里的匹配物是「监听中的套接字」本身：
 * /proc/net/tcp 找到端口的 inode，再按 fd 反查 pid —— 只杀占用本会话端口的
 * 那一个进程，其他会话（包括真实使用中的）永不受及。无占用时零副作用。
 */
async function killPortOccupant(port: number, tag: string): Promise<void> {
  assertDockerExecEnvShape();
  // 端口十六进制直接内联进 awk 正则（避免多层引号陷阱；/proc/net/tcp 的
  // 本地地址列是大写十六进制的 host:port）。
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  const script = [
    `inode=$(awk 'NR>1 && $2 ~ /:${portHex}$/ && $4 == "0A" {print $10; exit}' /proc/net/tcp 2>/dev/null)`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell 参数展开必须原样进入脚本
    `[ -n "$inode" ] || exit 0`,
    `for fd in /proc/[0-9]*/fd/*; do`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell 参数展开必须原样进入脚本
    `  [ "$(readlink "$fd" 2>/dev/null)" = "socket:[$inode]" ] && kill "$(echo "$fd" | cut -d/ -f3)" 2>/dev/null && echo killed;`,
    `done`,
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
  const killed = await new Response(proc.stdout).text().catch(() => "");
  if (code !== 0) {
    log(`[${tag}] 清理端口 ${port} 占用者时 docker exec 退出码 ${code}（继续：可能本就无占用）`);
  } else if (killed.includes("killed")) {
    log(`[${tag}] 已清理占用预留端口 ${port} 的孤儿 dev server 进程`);
  }
}

async function installProbeApp(
  session: { id: string; port: number; label: string },
  tag: string,
) {
  const markerV1 = probeMarker(1, tag);
  // 0) 清掉占用预留端口的孤儿 dev server（早前失败运行留下的、按会话目录
  //    杀不到的进程）—— 端口已被 DB 回收重预约，孤儿不走 start-webapp.sh
  //    的 pid 复用门，会以「别个应用」的形状骗过就绪门。无占用时零副作用。
  await killPortOccupant(session.port, tag);
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
  //    fix-ocr5 C：身份误判需要**连续 3 次**非 marker 响应——冷启动/预编译
  //    窗口里 Turbopack 渐进编译会短暂给出无 marker 的页面（可自愈），单次
  //    观测就判「别的应用」会把可自愈的启动误判成 FAIL。空响应（端口未起）
  //    不累计：那是自愈重拉该处理的形态，不是身份信号。
  let lastSeen = "";
  let attempt = 0;
  while (attempt < 5) {
    attempt += 1;
    await startWebapp(session.id);
    const attemptDeadline = Date.now() + 60_000;
    let servedWrongApp = false;
    let nonMarkerStreak = 0;
    while (Date.now() < attemptDeadline) {
      // F-2 后 dev server 挂在 /<label> basePath 下：直连端口的就绪门也必须
      // 走 label 前缀（端口根只回 404）。
      const probe = await fetch(
        `http://127.0.0.1:${session.port}/${session.label}/api/probe`,
      ).catch(() => null);
      const probeBody = probe?.ok ? await probe.json().catch(() => null) : null;
      // fix-ocr18 #19：改名 pageHtml —— 本地变量原本遮蔽模块级 playwright
      // 的 page: Page（本文件其后所有 page.* 都是 Page 语义），同名异型是
      // 阅读陷阱。3+1 处引用（声明 + 3 使用）同步改名。
      const pageHtml = await fetch(
        `http://127.0.0.1:${session.port}/${session.label}/`,
      )
        .then((r) => r.text())
        .catch(() => "");
      lastSeen = `probe=${probe?.status ?? "err"} page=${pageHtml.slice(0, 90).replace(/\s+/g, " ")}`;
      if (
        probeBody &&
        (probeBody as { method?: string }).method === "GET" &&
        pageHtml.includes(markerV1)
      ) {
        return;
      }
      if (pageHtml.length > 0 && !pageHtml.includes(markerV1)) {
        nonMarkerStreak += 1;
        if (nonMarkerStreak >= 3) {
          // 连续 3 次非 marker：真身份错误，重拉无效
          servedWrongApp = true;
          break;
        }
      } else {
        nonMarkerStreak = 0;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (servedWrongApp) {
      // fix-ocr5 C：判错路径同样要停掉占端口的 server——残留进程会占着
      // 下一次重新预约的同端口，骗过新会话的就绪探测（与头注同因）。
      await stopSessionWebapp(session.id).catch(() => {});
      break;
    }
    // 端口死了：清干净残留再试（含跨会话孤儿——按端口定位）
    await stopSessionWebapp(session.id).catch(() => {});
    await killPortOccupant(session.port, tag);
    await waitPortFree(session.port, 30_000, `${tag} 重拉前`).catch(() => {});
  }
  // fix-ocr18 #14：第二个 docker exec 拼接点，就地断言（不再依赖
  // stopSessionWebapp 先执行的传递性论证）。
  assertSessionId(session.id);
  // fix-ocr22 #14：bot 段贯穿 SANDBOX_BOT（与 stopSessionWebapp 同理）。
  // fix-ocr23 #1：第二个拼接点的 env 段就地校验 —— 与第一个拼接点各自独立
  // 站住，不依赖 stopSessionWebapp 先执行的传递性论证（同 assertSessionId）。
  assertDockerExecEnvShape();
  // fix-ocr25 #9：诊断通道兜底 —— docker 二进制缺失/容器未跑时 Bun.spawn
  // 同步抛错会覆盖掉携带 lastSeen 的原始诊断；包一层 try/catch，失败落显式
  // 「docker exec 不可用」文案，让探针未就绪的根因仍是错误信息的主体。
  let logText = "（docker exec 不可用，无日志尾部）";
  try {
    const logTail = Bun.spawn(
      [
        "docker",
        "exec",
        SANDBOX_CONTAINER,
        "sh",
        "-c",
        `tail -c 600 /workspace/bots/${SANDBOX_BOT}/${session.id}/nextjs.log 2>/dev/null`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [out, code] = await Promise.all([
      new Response(logTail.stdout).text(),
      logTail.exited,
    ]);
    logText = code === 0 ? out : `（docker exec 退出码 ${code}）${out}`;
  } catch {
    // 保留兜底文案：此刻的原始诊断（lastSeen）比缺失的日志尾部更重要。
  }
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
  // fix-ocr22 #13（事实源钉子）：下面是裸 SQL 直写 craft_messages，不经过
  // drizzle。列集与类型约束的事实源是 server/src/db/schema/craft.ts
  // （craft_messages 表定义 + craft_messages_type_check），message_metadata
  // 的形状事实源是 server/src/craft/message-routes.ts（send-message 写入的
  // messageMetadata Json 形状）。任一侧演进（加列、改 check、改 metadata
  // 形状）必须同步本 SQL —— 漂移不会在编译期暴露，只在运行期以 SQL 错误或
  // 脏数据的形式出现。
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
      // fix-ocr21 #2: fix-ocr3 之后 handlesRequest 只认领「hostname 命中 +
      // 已注册 label 首段」——未注册首段回落主站（Hono 的主站 404 不带预览
      // 文案）。断言回落契约本身：响应不得携带预览拒绝文案。"Unknown
      // preview host" 只对 hostname 命中而 label 未注册的 host 形态可达；
      // path 形态断言它，会在正确部署上永远 FAIL（验收退出码恒 1）。
      assert(
        !bogus.body.includes("Unknown preview host"),
        `preview origin ${PREVIEW_ORIGIN} 对未知 label 应回落主站（响应不得携带预览拒绝文案），实际 ${bogus.status} ${bogus.body.slice(0, 60)}`,
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
    // fix-ocr25 #8：URL 谓词代替正则 —— 原正则只转义了斜杠，`.` 等元字符在
    // 自定义 CRAFT_ACCEPTANCE_APP_ORIGIN 下会误匹配/漏匹配登录回跳判定；
    // Playwright waitForURL 原生支持函数谓词，彻底避开正则转义问题。
    await page.waitForURL((url) => url.origin === APP_ORIGIN, {
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
      // fix-ocr25 #6：列表响应必须真的拿到 —— status 非 200 或 body 为空
      // （vite 代理截断重试后仍 null）时，`sessions ?? []` 会把残留静默
      // 落成「无残留」，假 PASS 把占端口的污染留给下一轮。
      assert(
        listed.status === 200 && listed.body !== null,
        `GET /sessions → ${listed.status}${listed.body === null ? "，响应体为空" : ""}（清理步骤拿不到会话列表）`,
      );
      const stale = (listed.body?.sessions ?? []).filter(
        (s: { name?: string }) =>
          String(s.name ?? "").startsWith(SESSION_PREFIX),
      );
      const notes: string[] = [];
      for (const s of stale as Array<{ id: string }>) {
        notes.push(
          `${s.id.slice(0, 10)} server=${await stopSessionWebapp(s.id)}`,
        );
        const deleted = await api.craft(`sessions/${s.id}`, {
          method: "DELETE",
        });
        // fix-ocr25 #6：DELETE 返回 4xx/5xx 时行仍在，notes/返回文案却已
        // 宣称「删除 N 个」—— 显式断言 2xx，把残留暴露成本步骤的 FAIL。
        assert(
          deleted.status === 200 || deleted.status === 204,
          `DELETE ${s.id} → ${deleted.status}（残留会话未删除，会占住按行预约的端口污染下一轮）`,
        );
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
      // fix-ocr16：先断言非空再读字段 —— vite 代理截断重试后 body 仍可为
      // null（api.craft 的返回类型即 Record | null），裸读 row.status 会抛出
      // 与真实原因无关的 TypeError，误导归因（fix-ocr5 A/B/C 先例）。
      assert(
        created.body !== null,
        `POST /sessions 响应体为空（vite 代理截断重试后仍 null）`,
      );
      // fix-ocr23 #2：会话行的显式形状（见 CraftSessionRow）—— 断言非空
      // 不收窄，显式类型让下游 id/port/name 传参在类型层成立；转型之后
      // 运行时断言仍守形状（转型可能说谎，断言才是事实源）。
      const row = created.body as CraftSessionRow;
      assert(
        typeof row.id === "string" && row.id.length > 0,
        `会话响应缺 id：${JSON.stringify(row).slice(0, 80)}`,
      );
      // fix-ocr22 #12 的意图、fix-ocr23 #5 的落地：会话行落地即登记 CLEANUP
      // 责任 —— POST 201 且 body 可读就已建行，push 必须先于 status/port
      // 断言：响应形状异常导致断言失败时，行若尚未登记就逃逸 finally 的
      // CLEANUP（孤儿会话行 + 占端口的残留进程，正是 #12 要消灭的盲区）。
      pendingIds.push(row.id);
      assert(row.status === "active", `会话状态 ${row.status}`);
      assert(typeof row.nextjs_port === "number", "会话未预留在端口");
      // 立刻落用户消息："空会话"判定是无消息（store.getEmptySessionForUser），
      // 不落消息的话，下一个 POST /sessions 会复用本会话行并改名 —— 两个真实
      // 会话必须是两行。形状与 send-message 写入的 user 行一致（不走 LLM turn）。
      await markSessionNonEmpty(row.id, tag);
      // 等到 start-webapp.sh 已由 provision 落进沙箱。404 是“provision 尚未写完”
      // 的常态，提前退出会与 provisioning 赛跑 —— 只有 200 才算就绪，耗尽显式失败。
      let probeStatus = 0;
      for (let i = 0; i < 30; i++) {
        const probe = await fetch(
          `${GATEWAY}/file?path=${encodeURIComponent(`${row.id}/start-webapp.sh`)}`,
          { headers: gatewayHeaders() },
        ).catch(() => null);
        probeStatus = probe?.status ?? 0;
        if (probeStatus === 200) break;
        // #358 修复 T3 环境适配（finding 同步记录）：当前沙箱镜像（opencode
        // serve 1.18.7）的文件内容读取对一切文件路径 500（目录列表正常）——
        // 上游回归，与预览修复无关。就绪的判定物不变（start-webapp.sh 已落
        // 进沙箱），回退到父目录列表里找文件名：同一事实源（沙箱文件系统），
        // 只是换了上游还能回答的读取形状。镜像修复后 200 主路直接命中。
        if (probeStatus === 500) {
          const listing = await fetch(
            `${GATEWAY}/file?path=${encodeURIComponent(row.id)}`,
            { headers: gatewayHeaders() },
          ).catch(() => null);
          const names = (await listing?.text().catch(() => "")) ?? "";
          if (listing?.status === 200 && names.includes("start-webapp.sh")) {
            probeStatus = 200;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      assert(
        probeStatus === 200,
        `start-webapp.sh 未就绪：30 次探测后最后观测状态 ${probeStatus}`,
      );
      // 建会话后立即取 webapp_url：label 是服务端 HMAC 派生的确定性值，
      // 不依赖 webapp ready —— 探针安装与直连端口就绪门都需要它（F-2 basePath）。
      const early = await api.craft(`sessions/${row.id}/webapp-info`);
      const origin = String(early.body?.webapp_url ?? "");
      assert(
        origin.startsWith(`${PREVIEW_ORIGIN}/`),
        `webapp_url=${origin} 不是 preview origin 绝对地址`,
      );
      const label = new URL(origin).pathname.slice(1).split("/")[0];
      // fix-ocr23 #4：空/畸形 label 放行的话，installProbeApp 的探测 URL 变
      // 成 //api/probe 双斜杠形态，最终以 5×60s 就绪门慢失败收场且误指
      // nextjs.log 尾部 —— 形状断言前移到安装之前（下方 D7 步骤同款），
      // fail-fast 把真实原因（webapp_url 异常）留在报错里。
      assert(
        LABEL_SHAPE.test(label),
        `label 形状异常（webapp_url=${origin}）`,
      );
      await installProbeApp({ id: row.id, port: row.nextjs_port, label }, tag);
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
        LABEL_SHAPE.test(sessionA.label),
        `label 形状异常：${sessionA.label}`,
      );
      return `label=${sessionA.label}`;
    },
  );

  // ── 4. 预览面板（iframe）进入 ─────────────────────────────────────────────
  let paneEntryOk = false;
  // fix-ocr25 #7：观测提升到与 paneEntryOk 同级 —— FINDING 按实测证据分流，
  // 不再对任何「面板进入失败」写死 F-1/F-2 结论（那是未测量事实的虚构归因：
  // 步骤内前置的 src 断言失败时，cookie 与帧文从未被观测）。
  let panePassSeen = false; // preview 域通行证已出现在 CDP 全量 jar
  let paneFrameText = ""; // 帧内文本（应用文/拒绝页；空串=未走到观测点）
  let paneObserved = false; // 步骤是否走到了 cookie/帧文观测点
  await step(
    "pass",
    "预览面板：换票 → iframe 进入 preview origin（票据在 src、应用可读、通行证种下）",
    async () => {
      // fix-ocr22 #16：旧步骤名带着「票据不留在 URL」，但本步骤并不（无法）
      // 断言它 —— frame 跨 origin，父页读不到兑换后的当前 URL；「票据不留在
      // 最终 URL」的断言在下一步「顶层第一方进入」里。步骤名按实际断言内容
      // 改名（src 在 preview origin、带票、9s 后应用文本可读、通行证已种下、
      // 不是拒绝页），断言与名称对齐。
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
      paneObserved = true;
      panePassSeen = pass.some((c) => c.name === PREVIEW_SESSION_COOKIE);
      paneFrameText = text;
      paneEntryOk =
        panePassSeen &&
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
    // fix-ocr25 #7：按实测证据分流 —— F-1 只在通行证确实缺失时记录，F-2
    // 只在帧停在拒绝页时记录；其余形态记通用 finding 留人工归因，不写死
    // 「回退 #362/#360」的结论。
    if (paneObserved && !panePassSeen) {
      record(
        "finding",
        "F-1 面板 iframe 兑换跳的 D9 cookie（SameSite=Lax）被浏览器在跨站 iframe 上下文拒收",
        `实测：preview 域通行证（CDP 全量 jar）为空 → 兑换 302 的 Set-Cookie 未存储。帧文=${JSON.stringify(paneFrameText.slice(0, 120))}。截图 01-pane-entry-failed.png（本失败路径落盘）`,
      );
    } else if (paneObserved && paneFrameText.includes("Open this preview")) {
      record(
        "finding",
        "F-2 dev 形态资源 URL 不带 <label> 段 → /_next/** 404，面板/顶层页都不 hydrate",
        `实测：帧停在拒绝页，帧文=${JSON.stringify(paneFrameText.slice(0, 120))}。截图 01-pane-entry-failed.png（本失败路径落盘）`,
      );
    } else {
      record(
        "finding",
        "面板进入失败（证据与 F-1/F-2 形态均不匹配，需人工归因）",
        paneObserved
          ? `实测：通行证存在=${panePassSeen}；帧文=${JSON.stringify(paneFrameText.slice(0, 120))}。截图 01-pane-entry-failed.png（本失败路径落盘）`
          : "实测：前置 src 断言失败，通行证与帧文均未观测到。截图 01-pane-entry-failed.png（本失败路径落盘）",
      );
    }
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
      // fix-ocr16：同上 —— 先断言非空再解构，截断重试后 null 的
      // minted.body 不得以 TypeError 的面目误导归因。
      assert(
        minted.body !== null,
        `签票响应体为空（vite 代理截断重试后仍 null）`,
      );
      // fix-ocr23 #3：签票响应的显式形状 —— 与会话行同根，断言非空不收窄，
      // 解构出的 ticket/origin 是 unknown，encodeURIComponent(ticket) 与
      // new URL(origin) 在类型层非法；按签票响应的真实形状收窄后再解构
      // （长度断言仍留在运行时，转型可能说谎）。
      const { ticket, origin } = minted.body as {
        ticket: string;
        origin: string;
      };
      assert(
        typeof ticket === "string" && ticket.length > 0,
        "签票响应缺 ticket",
      );
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
        log(
          `      [tab-requestfailed] ${r.url().slice(0, 150)} ${r.failure()?.errorText ?? ""}`,
        ),
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
      const pass = passes.find((c) => c.name === PREVIEW_SESSION_COOKIE);
      assert(
        pass,
        `预览域 cookie 未种下（CDP 全量 jar）：${JSON.stringify(passes.map((c) => c.name))}`,
      );
      assert(
        pass.secure &&
          pass.httpOnly &&
          String(pass.sameSite).toLowerCase() === "none",
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
        scripts: Array.from(document.scripts).map((s) =>
          s.src.split("/").slice(-2).join("/"),
        ),
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

  // ── #358 修复：伪造凭据必须双面被拒（Review Focus 1）───────────────────────
  // 修复前 preview cookie 的值就是 session id：手写 `openbot_preview_session=<sid>`
  // 即可通过 HTTP 门与 HMR 升级，无需票据、无需兑换。修复后凭据是部署密钥签名的
  // pass —— 本步骤在全新浏览器 context（无票据、无兑换、无主站登录）里种下明文
  // session id，断言两个面都拒绝：HTTP 401，HMR 升级不 commit。
  await step(
    "pass",
    "#358 修复：伪造明文 session-id cookie 在预览 origin 双面被拒（HTTP + HMR）",
    async () => {
      const forged = await browser.newContext({ locale: "en-US" });
      try {
        // 种伪造 cookie：值 = session id 本身（修复前的合法凭据形状），
        // Path=/ 覆盖包括 /<label>/… 在内的全部路径，与真攻击者的最简手写一致。
        await forged.addCookies([
          {
            name: PREVIEW_SESSION_COOKIE,
            value: sessionA.id,
            url: `${PREVIEW_ORIGIN}/`,
          },
        ]);
        const fpage = await forged.newPage();
        // HTTP 面：预览页同源 fetch 自身受保护的 API —— 必须 401（修复前 200）。
        const httpStatus = await fpage.evaluate(async (probeUrl) => {
          const r = await fetch(probeUrl, { credentials: "include" });
          return r.status;
        }, `${sessionA.origin}/api/probe`);
        assert(
          httpStatus === 401,
          `伪造 cookie 的预览 HTTP 请求被放行：status=${httpStatus}（修复前此值为 200 —— 这就是要封住的旁路）`,
        );
        // HMR 面：WebSocket 升级 —— 必须被拒（HTTP 401 响应，socket 不 commit）。
        const hmrOutcome = await fpage.evaluate(
          (wsUrl) =>
            new Promise<string>((resolve) => {
              let settled = false;
              const done = (v: string) => {
                if (!settled) {
                  settled = true;
                  resolve(v);
                }
              };
              const ws = new WebSocket(wsUrl);
              ws.onopen = () => {
                ws.close();
                done("open");
              };
              ws.onerror = () => done("refused");
              setTimeout(() => done("timeout"), 8_000);
            }),
          `${sessionA.origin.replace(/^http/, "ws")}/_next/webpack-hmr`,
        );
        assert(
          hmrOutcome !== "open",
          `伪造 cookie 的 HMR 升级被接受（outcome=${hmrOutcome}）—— CSWSH 面未封住`,
        );
        await shot("02b-forged-cookie-refused", fpage);
        return `HTTP=${httpStatus}；HMR=${hmrOutcome}`;
      } finally {
        await forged.close();
      }
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
      // fix-ocr20 #11：every 对空数组恒真 —— 前置失败（兑换/种 cookie 没发生）
      // 时 jar 为空，下面的 every 会误报 PASS。先钉住通行证必须真的在 jar 里，
      // 空 jar 就是 FAIL，不放行。
      assert(
        previewNames.includes(PREVIEW_SESSION_COOKIE),
        `预览域 cookie jar 为空（通行证未种下；jar 为空时 every 恒真，前置失败不得放行）：${JSON.stringify(previewNames)}`,
      );
      assert(
        previewNames.every((n) => n === PREVIEW_SESSION_COOKIE),
        `预览 host 出现非通行证 cookie：${JSON.stringify(previewNames)}`,
      );
      const leaked = await cdpDomainCookies(previewPage, "localhost");
      assert(
        !leaked.some((c) => c.name === PREVIEW_SESSION_COOKIE),
        "通行证种到了主站 host",
      );
      const mainNames = main.map((c) => c.name);
      assert(
        !mainNames.includes(PREVIEW_SESSION_COOKIE),
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

  // 协议层 401（可选证据）：从 preview origin 的取证页发起凭证请求，浏览器按
  // SameSite 不携带主站 cookie；请求是否 401 由 API server 日志佐证。
  // fix-ocr24 #7/#8 事实更正：取证页与 previewPage 共享同一 context 的 cookie
  // jar，Path=/<label> 的预览通行证会随本导航携带，落点是代理后的 Next 404 页
  // （其 CSP 为代理强制附加的 WEBAPP_DEV_CSP）；即使无通行证落到 401 拒绝页，
  // refusal.ts 的 default-src 'none' 同样拦截 fetch。两种落点下 fetch 都被
  // CSP 就地拦截、请求永不出网——取证页必须先 Page.setBypassCSP 绕过 CSP。
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
      // 无 cookie 断言的取证页：bare 页与 previewPage 同 context，Path=/<label>
      // 的通行证随导航携带，落点是代理后的 Next 404 页（WEBAPP_DEV_CSP 的
      // connect-src 'self' 不含主站 API origin）；无通行证时落到 401 拒绝页
      // （default-src 'none'）。两处 CSP 都会在 evaluate 内拦下 fetch，故用
      // CDP 绕过（仅此取证页；不改变被测的 cookie/SameSite 行为）。
      const bare = await context.newPage();
      const bareCdp = await context.newCDPSession(bare);
      await bareCdp.send("Page.setBypassCSP", { enabled: true });
      await bare.goto(`${PREVIEW_ORIGIN}/${sessionA.label}/probe-ac1-context`, {
        waitUntil: "domcontentloaded",
        timeout: T,
      });
      // 增量归因（OCR 轮 2 修复）：全量 grep 会把紧邻上一步的 401 与跨轮累积的
      // 日志都算进来——bare 页请求若未达 server 也照样 PASS。发请求前记录日志
      // 字节偏移，只对新增行断言。
      const logOffset = statSync(SERVER_LOG).size;
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
      await new Promise((r) => setTimeout(r, 2500));
      // 只读新增字节：偏移后首行若不是行首（server 恰在记录中途）则丢弃该半行，
      // 避免残片污染归因。
      const whole = readFileSync(SERVER_LOG);
      const freshLines = whole.subarray(logOffset).toString("utf8").split("\n");
      if (logOffset > 0 && whole[logOffset - 1] !== 0x0a) freshLines.shift();
      const newHits = freshLines.filter((line) =>
        line.includes('"path":"/api/craft/sessions"'),
      );
      // 请求确已达 server：增量窗口内出现了该路径的访问记录（否则下面的 401
      // 计数无从归因——旧全量 grep 会拿别步/别轮的 401 冒充）。
      assert(
        newHits.length > 0,
        "server 日志新增行未观测到该次请求（增量窗口内无该路径记录）",
      );
      const unauthed = newHits.filter((line) => line.includes('"status":401'));
      assert(unauthed.length > 0, "server 日志新增行未观测到该次 401");
      await bare.close();
      // fix-ocr22 #15：删除 evaluate 返回值形状上的恒真断言 —— evaluate 只
      // 可能返回 "readable" 或 "blocked-at-read:<name>" 两种形状，旧的
      // `assert(sent.startsWith("blocked-at-read") || sent === "readable")`
      // 永真、钉不住任何行为，属死代码。
      return `preview origin 页面 fetch（credentials:include）→ ${sent}；server 日志（增量归因）该路径 ×${newHits.length} 其中 401 ×${unauthed.length}（主站 cookie 未随行）`;
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
        async ({ labelB }) => {
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
          // fix-ocr16 语义诚实：浏览器把 Cookie 列为 forbidden header，
          // 在页面里手动设置会被静默丢弃 —— 这里不存在"伪造凭证被服务端
          // 拒绝"的可测量事实，上面的 docRoot/apiPost 实际度量的是
          // "无凭证 POST/GET 被拒"。协议级伪造验证（手工携带 Cookie 头的
          // 非浏览器客户端）属后续工作，本验收不伪装。
          return outcomes;
        },
        { labelB: sessionB.label },
      );
      assert(
        checks.docRoot === 401,
        `读 B 的文档根：${JSON.stringify(checks.docRoot)}`,
      );
      assert(
        checks.apiPost === 401,
        `POST B 的 API：${JSON.stringify(checks.apiPost)} ${String(checks.apiBody)}`,
      );
      // fix-ocr20 #13：上面两条 assert 已逐项钉死 401，再算一遍 refused 的
      // every+assert 是恒真判定（死代码），删除 —— 行为零变化。
      // 无凭证对照（fix-ocr16 语义诚实，不再是"伪造 cookie 头"）。
      return `docRoot=${checks.docRoot} apiPost=${checks.apiPost}（无凭证对照：401）`;
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
        (wsUrl) =>
          new Promise<{ frames: string[]; wsUrl: string }>(
            (resolve) => {
              const frames: string[] = [];
              // fix-ocr25 #5：完整地址由脚本侧 hmrWsUrl 派生后作为实参传入
              // —— 页面内不再各自从 location 拼接（fix-ocr21 #1 的修复曾
              // 被迫在两处 socket 各打一遍，正是该重复的实证风险）。
              const ws = new WebSocket(wsUrl);
              const finish = () => resolve({ frames, wsUrl: ws.url });
              ws.onmessage = (event) => {
                frames.push(String(event.data).slice(0, 120));
                if (frames.length >= 3) {
                  ws.close();
                  finish();
                }
              };
              ws.onerror = () => resolve({ frames, wsUrl: ws.url });
              setTimeout(() => {
                try {
                  ws.close();
                } catch {}
                finish();
              }, 20_000);
            },
          ),
        hmrWsUrl(sessionA.label),
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
        (wsUrl) =>
          new Promise<number>((resolve) => {
            const frames: string[] = [];
            // fix-ocr25 #5：同第一只 socket —— 地址由脚本侧统一派生传入。
            const ws = new WebSocket(wsUrl);
            ws.onmessage = (event) =>
              frames.push(String(event.data).slice(0, 200));
            ws.onopen = () => resolve(1);
            ws.onerror = () => resolve(0);
            setTimeout(() => resolve(frames.length > 0 ? 1 : 0), 10_000);
            (window as unknown as Record<string, unknown>).__hmrFrames = frames;
          }),
        hmrWsUrl(sessionA.label),
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
      // 基线：写文件前已入帧数 —— 连接握手帧（{"action":"sync"}）不算编辑信号，
      // 只对增量帧断言（旧写法 "action" 正则连握手也匹配，invalidation 恒真）。
      const framesBefore = await previewPage.evaluate(
        () =>
          (
            (window as unknown as Record<string, unknown>).__hmrFrames as
              | string[]
              | undefined
          )?.length ?? 0,
      );
      await gatewayWriteFile(
        sessionA.id,
        "outputs/web/app/page.tsx",
        probePage(probeMarker(2, "A")),
      );
      await new Promise((r) => setTimeout(r, 9000));
      const after = await previewPage.evaluate(
        (baseline) =>
          (
            (window as unknown as Record<string, unknown>).__hmrFrames as
              | string[]
              | undefined
          )?.slice(baseline) ?? [],
        framesBefore,
      );
      const invalidation = after.some((f) =>
        /"action":"(invalid|building|built)"/.test(f),
      );
      assert(
        invalidation,
        `编辑后未收到失效/构建帧（增量 ${after.length} 帧）：${JSON.stringify(after)}`,
      );
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
      await frame
        .locator('[data-testid="probe-click"]')
        .click({ timeout: 15_000 });
      await page.waitForTimeout(1200);
      const before = (
        await frame
          .locator('[data-testid="probe-clicks"]')
          .innerText({ timeout: 10_000 })
      ).trim();
      const expand = page.getByLabel("Expand preview");
      await expand.waitFor({ timeout: 15_000 });
      await expand.click();
      await page.getByRole("dialog").waitFor({ timeout: 10_000 });
      const during = (
        await frame
          .locator('[data-testid="probe-clicks"]')
          .innerText({ timeout: 10_000 })
      ).trim();
      // fix-ocr16：独立命名 —— 后一步骤与前一回归步骤（全屏放大/还原
      // 不重挂载）的 04/05 撞名，截图互相覆盖、销毁前一步的证据。
      await shot("04-expanded-clicks");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[role="dialog"]', {
        state: "detached",
        timeout: 10_000,
      });
      const after = (
        await frame
          .locator('[data-testid="probe-clicks"]')
          .innerText({ timeout: 10_000 })
      ).trim();
      await shot("05-collapsed-clicks");
      assert(before.length > 0, `面板内点击后读不到状态`);
      assert(during === before, `放大后点击状态丢失：${during} vs ${before}`);
      assert(after === before, `还原后点击状态丢失：${after} vs ${before}`);
      return `clicks=${before} 跨放大/还原保留`;
    });
  } else {
    await step("skip", "点击结果跨放大保留（回归）", async () => {
      throw new SkipSignal("面板未进入应用（F-1/F-2），帧内无点击状态可保留");
    });
  }

  // Server Actions（#362 的 AC2 面，回归观察）：协议级断言属后续票
  // #358 修复 T3：Server Actions 不再 SKIP —— 点击探针应用的 probe-action，
  // 断言 probe-action-result 出现 action-ok-，并以网络层证据（Next-Action 头的
  // POST 确实打到本会话预览 origin 且 200）确认协议级到达。不以 hydration 代替
  // action：DOM 热更（上方 AC5 步骤）只证明页面活着，这里证明 Server Actions
  // 这条通道在 preview origin 下可用（AC2 的明确组成部分）。
  await step(
    "pass",
    "Server Actions：probe-action 点击 → action-ok-（Next-Action POST 到达本会话 dev server）",
    async () => {
      assert(previewPage, "前置失败（顶层预览页未建立）");
      // 网络层记录：所有带 next-action 头的请求（Next.js Server Action 协议）
      const actionResponses: { url: string; status: number }[] = [];
      previewPage.on("response", (r) => {
        if (r.request().headers()["next-action"] !== undefined) {
          actionResponses.push({ url: r.url(), status: r.status() });
        }
      });
      const before = await previewPage
        .locator('[data-testid="probe-action-result"]')
        .innerText()
        .catch(() => "");
      assert(
        !before.includes("action-ok-"),
        `点击前已有 action 结果（断言无基线）：${before}`,
      );
      // UI 级点击（hydrate 完成后才有人接事件；waitForFunction 轮询结果）
      await previewPage
        .locator('[data-testid="probe-action"]')
        .click({ timeout: 10_000 });
      await previewPage.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="probe-action-result"]')
            ?.textContent?.includes("action-ok-"),
        { timeout: 15_000 },
      );
      const after = await previewPage
        .locator('[data-testid="probe-action-result"]')
        .innerText();
      assert(
        after.includes("action-ok-"),
        `action 结果未出现 action-ok-：${after}`,
      );
      // 协议级证据：这个 action-ok- 必须由一次真实的 Next-Action POST 产生，
      // 且落在本会话的预览 origin 上（不是别处代答）。
      assert(
        actionResponses.length > 0,
        "未观测到 next-action 协议请求 —— action-ok- 来源不明（可能被缓存或 hydration 替代）",
      );
      const foreign = actionResponses.filter(
        (r) =>
          !r.url.startsWith(sessionA.origin) ||
          (r.status !== 200 && r.status !== 303),
      );
      assert(
        foreign.length === 0,
        `Server Action 请求未到达本会话预览 origin 或未成功：${JSON.stringify(foreign).slice(0, 200)}`,
      );
      await shot("09-server-action", previewPage);
      return `result=${after.slice(0, 30)}…；next-action POST=${actionResponses.length} 次全部落在 ${sessionA.origin}`;
    },
  );

  // ── #358 修复 T3：webapp 工具 attach/restart 与预览同一进程（AC5 面）────
  // 停掉 dev server 后预览必须是 503 not-running（附着模型：没人拉起第二个
  // 进程），经 start-webapp.sh 重拉后同一预览地址恢复 200 —— 状态/日志/重启
  // 与预览自始至终指向同一个 dev server，不回退、不双进程。
  await step(
    "pass",
    "webapp 工具 attach：停 dev server → 预览 503 not-running → 重拉 → 同一预览地址恢复 200",
    async () => {
      assert(previewPage, "前置失败");
      const probeThroughPreview = () =>
        previewPage.evaluate(async (probeUrl) => {
          const r = await fetch(probeUrl, { credentials: "include" });
          return { status: r.status, body: await r.text().catch(() => "") };
        }, `${sessionA.origin}/api/probe`);
      // 停（webapp 工具的 stop 通道，与脚本清理同一条 docker exec 路径）
      await stopSessionWebapp(sessionA.id);
      // 503 面出现（就绪 memo TTL 3s 内可能仍答旧值，轮询到出现为止）
      let sawDown = false;
      const downDeadline = Date.now() + 20_000;
      let lastDown: { status: number } | null = null;
      while (Date.now() < downDeadline && !sawDown) {
        lastDown = await probeThroughPreview();
        if (lastDown.status === 503) sawDown = true;
        else await new Promise((r) => setTimeout(r, 1_000));
      }
      assert(
        sawDown,
        `停服后预览未给出 503（last=${JSON.stringify(lastDown)}）——附着模型破坏或 readiness memo 泄漏`,
      );
      // 重拉（同一 start-webapp.sh，唯一进程主人）并等预览恢复
      await startWebapp(sessionA.id);
      let recovered = false;
      const upDeadline = Date.now() + 150_000;
      let lastUp = 0;
      while (Date.now() < upDeadline && !recovered) {
        const r = await probeThroughPreview();
        lastUp = r.status;
        if (r.status === 200) recovered = true;
        else await new Promise((r2) => setTimeout(r2, 2_000));
      }
      assert(
        recovered,
        `重拉后预览未恢复 200（last=${lastUp}）`,
      );
      await shot("10-webapp-restart-attach", previewPage);
      return "停服 503 → 重拉 → 同一预览地址 200（附着不双进程）";
    },
  );

  // T3 记录面（明确记录、不断言 —— 已接受边界不误报为新缺陷）：
  // - 旧会话 D10：legacy 判定与旧同源路径由本 SHA 的单元/集成套件钉住
  //   （craft-webapp-proxy.test.ts「legacy sessions stay on the old same-origin
  //   path」、craft-preview-rejection.test.ts）；探针应用是新代际装配，浏览器
  //   级 legacy 流程不在本脚本范围。
  // - registry 重启空窗（M-2）：重启后旧预览标签 404、经主站重新进入恢复 ——
  //   docs/craft-preview-origin.md 已接受边界；本脚本不重启自身所依赖的 API server。
  log(
    "[边界记录] 旧会话 D10 与 M-2 重启空窗：浏览器级不重跑，行为由本 SHA 单元套件钉住 + docs 已记录，不计 FAIL。",
  );
} catch (error) {
  record(
    "fail",
    "run completed",
    error instanceof Error ? error.message.slice(0, 300) : String(error),
  );
} finally {
  if (CLEANUP) {
    // fix-ocr22 #12：以 pendingIds（创建即登记）∪ sessions 的并集为 CLEANUP
    // 范围 —— 与创建范围对齐，sessions push 前失败的会话也停服+删行。
    const cleanupIds = [
      ...new Set([...pendingIds, ...sessions.map((s) => s.id)]),
    ];
    for (const id of cleanupIds) {
      // fix-ocr27 #12：停服失败不再静默 —— 残留进程占着预约端口、骗过下一次
      // 运行的就绪探测（与头注同因），而 `.catch(() => {})` 让这类失败零痕迹。
      // catch 落一行脱敏日志（截断即脱敏：error.message 截 120 字符，不回显
      // 任何堆栈/env），并区分两类根因：形状断言失败（assertSessionId /
      // assertDockerExecEnvShape 的措辞）是事实源漂移信号，必须显眼；其余
      // （docker 二进制缺失/容器未跑等 spawn 失败）按环境不可用归类。
      await stopSessionWebapp(id).catch((error: unknown) => {
        const message = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 120);
        const shapeDrift =
          message.includes("形状") || message.includes("拒绝拼进 docker exec");
        log(
          shapeDrift
            ? `[cleanup] 停服失败（事实源漂移信号，形状断言拒绝拼接）：session=${id}：${message}`
            : `[cleanup] 停服失败（docker exec 不可用类）：session=${id}：${message}`,
        );
      });
      await api.craft(`sessions/${id}`, { method: "DELETE" }).catch(() => {});
    }
    log(`已停并删除 ${cleanupIds.length} 个探针会话（CLEANUP=1，pendingIds 与创建范围对齐）`);
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
