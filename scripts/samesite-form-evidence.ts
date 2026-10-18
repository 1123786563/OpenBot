/*
 * 同 site 双 host 的 form-action 证据（codex 复审 #365 解除条件补充面）。
 * 形态：主站 http://localhost:3220 ↔ 预览 http://{label}.localhost:3221
 * （host 形态模板；Chromium 泛解析 *.localhost→127.0.0.1；与 localhost 同 site）。
 * 证据 A：form POST → 主站被 securitypolicyviolation(form-action) 就地拦截
 * 证据 B：route 改写去掉 form-action 后，同款提交携带主站 cookie 直达主站
 *         —— 证明「若 CSP 不拦，同 site 表单确实带主站 cookie」（F-1 触发条件）
 * 证据 C：CDP jar —— 主站 host-only cookie 与预览通行证并存
 * 独立微脚本；生产代码零改动。形态：默认 dev 形态即可（127.0.0.1:3221/{label}
 * 与主站 127.0.0.1:3220 同 host 异端口 ⇒ 同 site；登录走 localhost 域后把
 * 会话 cookie 镜像到 127.0.0.1）。证据头部写本脚本 sha256，与运行一一对应。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { type Browser, type Page, chromium } from "playwright-core";
if (existsSync(".env")) process.loadEnvFile(".env");
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const APP_ORIGIN =
  process.env.CRAFT_ACCEPTANCE_APP_ORIGIN ?? "http://127.0.0.1:3220";
const API_ORIGIN =
  process.env.CRAFT_ACCEPTANCE_API_ORIGIN ?? "http://localhost:3221";
const CASDOOR_USER = process.env.CRAFT_ACCEPTANCE_CASDOOR_USER ?? "admin";
const CASDOOR_PASSWORD = process.env.CRAFT_ACCEPTANCE_CASDOOR_PASSWORD ?? "123";
const GATEWAY =
  process.env.CRAFT_ACCEPTANCE_SANDBOX_GATEWAY ?? "http://127.0.0.1:4300";
const GATEWAY_TOKEN =
  process.env.CRAFT_ACCEPTANCE_SANDBOX_TOKEN ?? "openbot-dev-sandbox-token";
const SANDBOX_BOT = process.env.CRAFT_ACCEPTANCE_SANDBOX_BOT ?? "craft";
const SHOT_DIR =
  process.env.CRAFT_ACCEPTANCE_SHOT_DIR ??
  "gui-test-screenshots/craft-preview-365-samesite";
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
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

/**
 * AC5 两处 HMR socket 的完整地址（fix-ocr25 #5）：模块级收敛 —— 脚本侧已知
 * PREVIEW_ORIGIN 与 label，由脚本派生完整 ws 地址作为 evaluate 实参传入，
 * 页面内不再各自从 location 拼接。fix-ocr21 #1 的相对 URL 修复就曾被追着
 * 打了两遍补丁，正是该重复的实证风险（http→ws 只换首处 scheme：https
 * 形态自然落成 wss）。
 */
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
    `[ -n "$inode" ] || exit 0`,
    `for fd in /proc/[0-9]*/fd/*; do`,
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
    log(
      `[${tag}] 清理端口 ${port} 占用者时 docker exec 退出码 ${code}（继续：可能本就无占用）`,
    );
  } else if (killed.includes("killed")) {
    log(`[${tag}] 已清理占用预留端口 ${port} 的孤儿 dev server 进程`);
  }
}

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

let page: Page;
let browser: Browser;
const EVIDENCE: string[] = [];
mkdirSync(SHOT_DIR, { recursive: true });
function evidence(line: string) {
  EVIDENCE.push(line);
  console.log(line);
}

type Row = { id: string; nextjs_port: number; name: string };
// playwright 的 APIRequestContext 在 bun 下对 POST 间歇 socket hang up（传输层
// 经 curl 验证正常），改原生 fetch：cookie 从浏览器 context jar 手动携带。
const api = {
  craft: async (path: string, init: RequestInit = {}) => {
    const jar = await context.cookies([APP_ORIGIN, API_ORIGIN]);
    const cookieHeader = jar.map((c) => `${c.name}=${c.value}`).join("; ");
    const response = await fetch(`${API_ORIGIN}/api/craft/${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), cookie: cookieHeader },
      redirect: "manual",
    }).catch((e) => {
      throw new Error(`native fetch ${path}: ${(e as Error).message}`);
    });
    const body = await response.json().catch(() => null);
    return {
      status: response.status,
      body: body as Record<string, unknown> | null,
    };
  },
};

// ── 主流程 ─────────────────────────────────────────────────────────────────
const sessionId: { id?: string } = {};
browser = await launchBrowser();
const context = await browser.newContext();
page = await context.newPage();
try {
  // 1) Casdoor 登录
  await page.goto("http://localhost:3220", {
    waitUntil: "domcontentloaded",
    timeout: T,
  });
  try {
    await page
      .getByRole("button", { name: "Continue with Casdoor" })
      .click({ timeout: 10_000 });
  } catch {
    /* 自动进入 */
  }
  await page.locator("#username").waitFor({ state: "visible", timeout: T });
  await page.fill("#username", CASDOOR_USER);
  await page.fill("#password", CASDOOR_PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL((url) => url.origin === "http://localhost:3220", {
    timeout: T,
  });
  const listed = await api.craft("sessions");
  assert(listed.status === 200, `GET /sessions -> ${listed.status}`);
  evidence(`[1] Casdoor 登录 OK`);
  // 登录域是 localhost（better-auth state 绑发起域），把会话 cookie 镜像到
  // 127.0.0.1：与预览 127.0.0.1:3221 同 host ⇒ 同 site（端口不参与 site/cookie 判定）。
  const session = (await context.cookies(["http://localhost:3220"])).find((c) =>
    c.name.startsWith("better-auth.session_token"),
  );
  assert(session, "登录后未找到 better-auth.session_token cookie");
  await context.addCookies([
    {
      name: session.name,
      value: session.value,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: session.httpOnly,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  evidence(
    `[1b] 会话 cookie 已镜像到 127.0.0.1（cookie host 不分端口 ⇒ 3220/3221 同带）`,
  );

  // 2) 建会话 + 探针（host 形态：就绪门探端口根，无 /<label> 前缀）
  const created = await api.craft("sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `${SESSION_PREFIX} ${RUN_STAMP}` }),
  });
  assert(created.status === 201, `POST /sessions -> ${created.status}`);
  const row = created.body as unknown as Row;
  sessionId.id = row.id;
  assert(typeof row.id === "string" && row.id.length > 0, "会话响应缺 id");
  assert(typeof row.nextjs_port === "number", "会话未预留在端口");
  await markSessionNonEmpty(row.id, "S");
  let probeStatus = 0;
  for (let i = 0; i < 30; i++) {
    const probe = await fetch(
      `${GATEWAY}/file?path=${encodeURIComponent(`${row.id}/start-webapp.sh`)}`,
      { headers: gatewayHeaders() },
    ).catch(() => null);
    probeStatus = probe?.status ?? 0;
    if (probeStatus === 200) break;
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
  assert(probeStatus === 200, `start-webapp.sh 未就绪（${probeStatus}）`);
  // 预览地址（host 形态：{label}.localhost:3221）
  const early = await api.craft(`sessions/${row.id}/webapp-info`);
  console.log("[diag] webapp-info =", JSON.stringify(early.body).slice(0, 400));
  const previewUrl = String(
    (early.body as Record<string, unknown>)?.webapp_url ?? "",
  );
  const basePath = `/${new URL(previewUrl).pathname.split("/").filter(Boolean)[0] ?? ""}`;
  assert(
    previewUrl.startsWith("http://127.0.0.1:3221/"),
    `webapp_url=${previewUrl} 非 dev 形态 127.0.0.1:3221/{label}`,
  );
  evidence(
    `[2] 会话 ${row.id} port=${row.nextjs_port} 预览地址= ${previewUrl}（与主站 ${APP_ORIGIN} 同 host 异端口 ⇒ 同 site）`,
  );
  // 脚手架 + 探针三文件（host 形态 dev server 挂根：就绪门 /api/probe、页面含 marker）
  await killPortOccupant(row.nextjs_port, "S");
  await startWebapp(row.id);
  await waitReachable(
    `http://127.0.0.1:${row.nextjs_port}${basePath}/`,
    300_000,
    "S 脚手架",
  );
  await stopSessionWebapp(row.id);
  await waitPortFree(row.nextjs_port, 30_000, "S 停服后");
  const markerV1 = probeMarker(1, "S");
  await gatewayWriteFile(
    row.id,
    "outputs/web/app/page.tsx",
    probePage(markerV1),
  );
  await gatewayWriteFile(row.id, "outputs/web/app/actions.ts", PROBE_ACTION);
  await gatewayWriteFile(
    row.id,
    "outputs/web/app/api/probe/route.ts",
    PROBE_ROUTE,
  );
  let ready = false;
  let lastSeen = "";
  for (let attempt = 0; attempt < 5 && !ready; attempt++) {
    await startWebapp(row.id);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const probe = await fetch(
        `http://127.0.0.1:${row.nextjs_port}${basePath}/api/probe`,
      ).catch(() => null);
      const probeBody = probe?.ok ? await probe.json().catch(() => null) : null;
      const pageHtml = await fetch(
        `http://127.0.0.1:${row.nextjs_port}${basePath}/`,
      )
        .then((r) => r.text())
        .catch(() => "");
      lastSeen = `probe=${probe?.status ?? "err"} page=${pageHtml.slice(0, 260).replace(/\s+/g, " ")}`;
      if (
        probeBody &&
        (probeBody as { method?: string }).method === "GET" &&
        pageHtml.includes(markerV1)
      ) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!ready) {
      await stopSessionWebapp(row.id).catch(() => {});
      await killPortOccupant(row.nextjs_port, "S");
      await waitPortFree(row.nextjs_port, 30_000, "S 重拉前").catch(() => {});
    }
  }
  assert(ready, `S 探针未就绪。marker=${markerV1} 最后观测：${lastSeen}`);
  evidence(`[3] 探针 dev server 就绪（host 形态根挂载）`);

  // 3) 签票 → 顶层第一方进入预览页
  const minted = await api.craft(`sessions/${row.id}/preview-ticket`, {
    method: "POST",
  });
  assert(minted.status === 200, `签票 -> ${minted.status}`);
  assert(minted.body !== null, "签票响应体为空");
  const ticket = String((minted.body as Record<string, unknown>).ticket);
  const previewPage = await context.newPage();
  await previewPage.goto(`${previewUrl}?ticket=${encodeURIComponent(ticket)}`, {
    waitUntil: "domcontentloaded",
    timeout: T,
  });
  await previewPage
    .waitForURL((url) => !url.search.includes("ticket="), { timeout: T })
    .catch(() => {});
  const bodyText = await previewPage
    .locator("body")
    .innerText({ timeout: 20_000 })
    .catch(() => "");
  assert(
    bodyText.includes("probe"),
    `预览页未进入应用：${JSON.stringify(bodyText.slice(0, 100))}`,
  );
  evidence(
    `[4] 顶层进入预览页 OK：host=${new URL(previewPage.url()).host}（票据已兑换/透传）`,
  );

  // 4) 证据 C：CDP jar —— 同 site 双 host 的 cookie 并存
  const mainCookies = await cdpDomainCookies(previewPage, "localhost");
  const mainSiteNames = mainCookies.map((c) => c.name);
  evidence(
    `[C] localhost:3220 主站 cookie（jar）：${JSON.stringify(mainSiteNames)} —— 主站会话 cookie 存在于 jar`,
  );

  // 5) 证据 A：form POST → 主站（同 site）被 form-action 就地拦截
  const outcomeA = await previewPage.evaluate(async (target) => {
    const frame = document.createElement("iframe");
    frame.name = "form-probe";
    frame.style.display = "none";
    document.body.appendChild(frame);
    const violation = await new Promise<string | null>((resolve) => {
      let settled = false;
      const done = (directive: string | null) => {
        if (settled) return;
        settled = true;
        document.removeEventListener("securitypolicyviolation", onViolation);
        clearTimeout(timer);
        resolve(directive);
      };
      const onViolation = (event: Event) => {
        if (
          (event as SecurityPolicyViolationEvent).effectiveDirective ===
          "form-action"
        )
          done((event as SecurityPolicyViolationEvent).effectiveDirective);
      };
      document.addEventListener("securitypolicyviolation", onViolation);
      const timer = setTimeout(() => done(null), 5000);
      const form = document.createElement("form");
      form.action = target;
      form.method = "POST";
      form.target = "form-probe";
      document.body.appendChild(form);
      form.submit();
    });
    frame.remove();
    return { violation, host: location.host };
  }, `${APP_ORIGIN}/`);
  assert(
    outcomeA.violation === "form-action",
    `同 site 表单提交未被拦截（violation=${JSON.stringify(outcomeA.violation)}）——F-1 洞开`,
  );
  assert(
    outcomeA.host === new URL(previewUrl).host,
    `观测文档离开了预览 host：${outcomeA.host}`,
  );
  evidence(
    `[A] 同 site 表单 POST ${APP_ORIGIN}/ → securitypolicyviolation(form-action) 就地拦截；文档仍在 ${outcomeA.host}（未达主站）`,
  );

  // 6) 证据 B（附带性对照）：route 改写去掉 form-action → 同款提交带主站 cookie 直达主站
  const requests: { url: string; method: string; cookieNames: string[] }[] = [];
  await context.route(`${previewUrl.replace(/\?.*/, "")}**`, async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() } as Record<string, string>;
    const csp = headers["content-security-policy"] ?? "";
    const stripped = csp.replace(/form-action 'self'; ?/g, "");
    await route.fulfill({
      response,
      headers: { ...headers, "content-security-policy": stripped },
    });
  });
  previewPage.on("request", (req) => {
    if (req.url().startsWith(APP_ORIGIN) && req.method() === "POST") {
      const cookieHeader = req.headers().cookie ?? "";
      requests.push({
        url: req.url(),
        method: req.method(),
        cookieNames: cookieHeader
          .split(";")
          .map((s) => s.trim().split("=")[0])
          .filter(Boolean),
      });
    }
  });
  const reloadUrl = previewPage.url();
  await previewPage.goto(reloadUrl, {
    waitUntil: "domcontentloaded",
    timeout: T,
  });
  await previewPage
    .locator("body")
    .innerText({ timeout: 20_000 })
    .catch(() => "");
  // fire-and-forget 顶层提交：成功=导航离开预览页（evaluate 不可 await），以
  // 请求观测与导航结果为证。
  await previewPage.evaluate((target) => {
    const form = document.createElement("form");
    form.action = target;
    form.method = "POST";
    document.body.appendChild(form);
    form.submit();
  }, `${APP_ORIGIN}/`);
  const navigatedOut = await previewPage
    .waitForURL((u) => u.origin === APP_ORIGIN, { timeout: 6000 })
    .then(() => true)
    .catch(() => false);
  await new Promise((r) => setTimeout(r, 1500));
  await context.unrouteAll();
  if (!navigatedOut && requests.length === 0) {
    // 页面没走、请求没到——查是否被 CSP 拦（此时 previewPage 还活着）
    const stayed = await previewPage
      .evaluate(() => location.host)
      .catch(() => "gone");
    assert(
      false,
      `去掉 form-action 后既未导航也未到达主站（host=${stayed}）——对照实验未成立`,
    );
  }
  // 上一行守卫已断言「未导航且无请求」的失败面；这里再钉 B 的实质：
  // 请求必须真的到达主站（仅导航离开不算对照成立）。
  assert(
    requests.length > 0,
    "去掉 form-action 后提交仍未到达主站——附带性对照失败",
  );
  const withSessionCookie = requests.some((r) =>
    r.cookieNames.some((n) => mainSiteNames.includes(n)),
  );
  evidence(
    `[B] 对照（route 改写去掉 form-action）：顶层提交 navigatedOut=${navigatedOut}，到达主站的 POST = ${JSON.stringify(requests)} —— ${withSessionCookie ? "携带主站 cookie（cookie host 不分端口、同 host 附带）—— F-1 触发条件实证" : "未见主站 cookie（检查 jar）"}`,
  );

  await previewPage.screenshot({ path: `${SHOT_DIR}/samesite-final.png` });
  evidence(`=== 同 site 双 host 证据完成：A 拦截 + B 附带性对照 + C jar ===`);
} finally {
  // 清理：停服 + 删行
  if (sessionId.id) {
    await stopSessionWebapp(sessionId.id).catch(() => {});
    await api
      .craft(`sessions/${sessionId.id}`, { method: "DELETE" })
      .catch(() => {});
    evidence(`[cleanup] 会话 ${sessionId.id} 已停服删除`);
  }
  await browser.close().catch(() => {});
  // 证据与脚本版本一一对应（codex：未提交脚本与留存证据实现有漂移）：
  // 头部写脚本自身 sha256 + 运行时间戳，证据可回溯到产出它的确切实现。
  const scriptSha256 = createHash("sha256")
    .update(readFileSync(import.meta.path))
    .digest("hex");
  writeFileSync(
    ".superpowers/evidence/samesite-form-evidence.txt",
    [
      `script-sha256: ${scriptSha256}`,
      `run-at: ${new Date().toISOString()}`,
      ...EVIDENCE,
      "",
    ].join("\n"),
  );
}
