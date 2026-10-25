/**
 * agent-sandbox 端口段占用预检（#619 AC2；AC3 的一致性核验复用本模块的解析与比对）。
 *
 * 为什么需要它：compose 把段逐端口展开成两族 loopback 发布（127.0.0.1 与 [::1]），撞上
 * 占用者时 `docker compose up` 只给一句 "port is already allocated" —— 既不说段，也不说
 * 占用者，几十个端口的段没人想手工二分。本脚本在 up 之前把「段内每个端口 × 两族」的
 * 占用者找出来，连同两条可复跑的解决步骤一起给出（改段 / 停占用）。
 *
 * 解析来源与 compose 插值同序：进程环境优先，其次仓库根 `.env`（docker compose 的 .env
 * 发现位置），缺省回退 3010/3100 —— 与 docker-compose.yml 的 `${...:-3010}-${...:-3100}`
 * 及 server/src/craft/config.ts 的服务端默认三方同一事实源，无 env 时发布段 = 分配段。
 *
 * 「自己人」判定：占用容器须同时满足 compose label `com.docker.compose.service=
 * agent-sandbox` 与 `com.docker.compose.project` == 本栈预期 project（COMPOSE_PROJECT_
 * NAME → 仓库根目录名规范化；docker-compose.yml 无 `name:` 字段，主栈 project 恒由此
 * 派生）→ 记 ours，不算冲突 —— 与 scripts/start.sh 的 require_free_or_ours 同一语义：
 * 重跑 start.sh 不该被它自己上次拉起的沙箱挡住。本仓多 worktree 并行开发，另一份
 * checkout 的栈 service 同名而 project 不同 —— 那是要报冲突的「外栈」，冒名不得假绿。
 * compose 发布的宿主端口由引擎代理在两族上监听，lsof 必然看到影子 —— 某端口 × 地址族上
 * 有容器发布时，同键上的进程一律按该发布的代理影子跳过（套接字独占），容器行把占用者
 * 说得更准。
 *
 * 降级而非静默：lsof / docker 缺失或不可用时逐条输出「无法探测」，不用空结果冒充空闲；
 * lsof 退出码 >1 或 stderr 有告警同样按「无法探测」处理（真失败不当空闲，见
 * lsofSnapshotFromSpawn）；两个探测面都不可用（任何一面都没核过）时以退出码 3 拒绝背书。
 *
 * 用法：bun --no-env-file scripts/craft-port-range-preflight.ts（--no-env-file 是调用
 * 契约的一部分：Bun 默认预载 cwd 的 .env 变体族，.local 形态 compose 不认，见 main 处
 * 注释；scripts/start.sh 在首次 docker compose up 之前自动调用；
 * scripts/craft-preview-acceptance.ts 的 preflight 复用 resolvePortRange /
 * dockerPortPublishedPorts / checkRangeCovered / publishedSpanSummary 做 AC3 的段一致
 * 性核验）。
 *
 * 退出码：0 无冲突（含 ours 与单侧降级提示）；1 段内有非本栈占用；2 段配置非法；
 * 3 两个探测面都不可用。探测函数（docker 查询、lsof 调用）以快照依赖注入，单测不碰真实
 * 系统调用（tests/craft-port-range-preflight.test.ts）。
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PORT_START_KEY = "OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START";
export const PORT_END_KEY = "OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END";
/** 缺省段 = 服务端默认（server/src/craft/config.ts），compose 插值同值：三方一致。 */
export const DEFAULT_PORT_START = 3010;
export const DEFAULT_PORT_END = 3100;
/** compose label：本栈沙箱服务的「自己人」标记（与 require_free_or_ours 同语义）。 */
export const OUR_SANDBOX_COMPOSE_SERVICE = "agent-sandbox";
/** 段长超过它只警告不拒绝：compose 逐端口展开，段越长 up/ps 越重。 */
export const RANGE_SIZE_WARNING = 200;

/** 本预检只管 loopback 两族（compose 发布段就绑在这两族上）。 */
export type AddressFamily = "127.0.0.1" | "::1";
export const PROBE_FAMILIES: readonly AddressFamily[] = ["127.0.0.1", "::1"];

export interface PortRange {
  start: number;
  end: number;
}

/** docker ps 侧：某容器在某个端口 × 地址族上的发布（project = compose project label）。 */
export interface ContainerPublish {
  name: string;
  image: string;
  service: string;
  project: string;
  port: number;
  family: AddressFamily;
}

/** lsof 侧：某进程在某个端口 × 地址族上的 LISTEN。 */
export interface ProcessListen {
  name: string;
  pid: number;
  port: number;
  family: AddressFamily;
}

export type DockerSnapshot =
  | { status: "ok"; publishes: ContainerPublish[] }
  | { status: "unavailable"; reason: string };
export type LsofSnapshot =
  | { status: "ok"; listens: ProcessListen[] }
  | { status: "unavailable"; reason: string };

/** 探测面（可注入）：一次调用返回全量快照，而不是逐端口 × N 次子进程。 */
/**
 * compose 对「未显式命名的 project」的默认取法：目录名转小写并去掉既非小写字母数字也非
 * 连字符的字符（OpenBot → openbot，My.Repo → myrepo）。docker-compose.yml 自身没有
 * `name:` 字段（本仓事实），所以主栈 project 恒走这条规则或显式 COMPOSE_PROJECT_NAME。
 */
export function composeProjectFromDirectory(dir: string): string {
  return dir.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/**
 * 本栈预期的 compose project（ours 判定的另一半）：COMPOSE_PROJECT_NAME（进程环境或
 * .env，compose 两者都认）→ 仓库根目录名规范化。与 compose 自身的优先级一致，多
 * worktree 并行开发时不同 checkout 因目录名不同而互为「外栈」——这正是要分辨的形态。
 */
export function expectedComposeProject(
  env: Record<string, string | undefined>,
  repoRootDirName: string,
): string {
  const override = env.COMPOSE_PROJECT_NAME?.trim();
  if (override) return override;
  return composeProjectFromDirectory(repoRootDirName);
}

export interface ProbeDeps {
  /** 运行中容器 → 发布端口 × 地址族；不可用时如实返回 unavailable。 */
  docker: () => DockerSnapshot;
  /** LISTEN 套接字 → 进程 × 端口 × 地址族；缺 lsof 时如实返回 unavailable。 */
  lsof: () => LsofSnapshot;
}

/**
 * `.env` 极小解析器，不新增 dotenv 依赖：键=值、跳过空行与 `#` 注释行、剥一层引号、
 * 未加引号的值剥掉空白前置的 `#` 行内注释、重复键后者胜 —— 与 compose 对 `.env` 的
 * 解析及 scripts/start.sh `setting()` 的 grep + tail -1（后者胜）同一语义。行内注释
 * 的边界与 compose 一致：`3011 # dev range` 取 3011；引号内的 `#`（`"a # b"`）保留；
 * 不带空白的 `3011#x` 不算注释（compose 同样把它当值的一部分，端口校验会如实拒绝）。
 */
export function parseDotEnv(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  const unquote = (value: string): string => {
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    return quoted ? value.slice(1, -1) : value;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ")
      ? line.slice("export ".length)
      : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    const value = body.slice(eq + 1).trim();
    // 值以引号开头且闭合：取引号内整段（引号后的余文含注释一并丢弃，compose/godotenv
    // 同款）；否则先裁空白前置的行内注释，再剥「裁完恰好被引号包住」的形态。
    const quoted = value.match(/^"([^"]*)"|^'([^']*)'/);
    parsed[key] = quoted
      ? (quoted[1] ?? quoted[2] ?? "")
      : unquote(value.replace(/\s+#.*$/, "").trim());
  }
  return parsed;
}

export interface RangeResolution {
  /** errors 非空时为 null：非法配置下不存在「生效段」。 */
  range: PortRange | null;
  errors: string[];
  notes: string[];
}

/**
 * 段解析与校验（纯函数，预检 CLI 与 craft-preview-acceptance 共用）。只设一端不算错：
 * 用另一端默认并提示合并后的段；倒置 / 非整数 / 越界才是错，错误文案点名键与值并给
 * 修正示例 —— AC2 的「可定位」从配置错误就开始，不等到撞上端口。
 */
export function resolvePortRange(
  env: Record<string, string | undefined>,
): RangeResolution {
  const errors: string[] = [];
  const notes: string[] = [];
  // 「未设置」与「设置了但非法」必须分开：R2-F6 的矛盾输出（先说「START 未设置按默认」
  // 再说「START 不是合法端口」）就是把两者折叠成一个 null 的结果。
  const readKey = (
    key: string,
    raw: string | undefined,
  ): { present: boolean; port: number | null } => {
    const value = raw?.trim();
    if (value === undefined || value === "")
      return { present: false, port: null };
    const port = Number(value);
    if (
      !/^\d+$/.test(value) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      errors.push(
        `${key} 不是合法 TCP 端口（应为 1–65535 的整数）：${JSON.stringify(value)}；修正示例：${key}=4010`,
      );
      return { present: true, port: null };
    }
    return { present: true, port };
  };
  const start = readKey(PORT_START_KEY, env[PORT_START_KEY]);
  const end = readKey(PORT_END_KEY, env[PORT_END_KEY]);
  const startFinal = start.port ?? DEFAULT_PORT_START;
  const endFinal = end.port ?? DEFAULT_PORT_END;
  // 只在「真的只设置了一端且无任何错误」时提示；同一键已报错就不再说「未设置」（R2-F6）。
  if (errors.length === 0 && start.present && !end.present) {
    notes.push(
      `只设置了 ${PORT_START_KEY}=${start.port}；${PORT_END_KEY} 未设置，按默认 ${DEFAULT_PORT_END} 使用，生效段 ${startFinal}-${endFinal}（建议在 .env 成对设置两键）`,
    );
  }
  if (errors.length === 0 && end.present && !start.present) {
    notes.push(
      `只设置了 ${PORT_END_KEY}=${end.port}；${PORT_START_KEY} 未设置，按默认 ${DEFAULT_PORT_START} 使用，生效段 ${startFinal}-${endFinal}（建议在 .env 成对设置两键）`,
    );
  }
  if (start.port !== null && end.port !== null && start.port > end.port) {
    errors.push(
      `端口段倒置：${PORT_START_KEY}=${start.port} > ${PORT_END_KEY}=${end.port}；修正示例：${PORT_START_KEY}=${end.port}、${PORT_END_KEY}=${start.port}`,
    );
  }
  if (errors.length === 0 && endFinal - startFinal + 1 > RANGE_SIZE_WARNING) {
    notes.push(
      `段长 ${endFinal - startFinal + 1} 个端口（> ${RANGE_SIZE_WARNING}）：compose 会逐端口展开发布，up/ps 的输出与启动开销显著增大，建议收窄（仅提示，不算错误）`,
    );
  }
  return {
    range: errors.length === 0 ? { start: startFinal, end: endFinal } : null,
    errors,
    notes,
  };
}

/**
 * AC3 一致性核验的纯比对：配置段每个端口都在运行中容器的发布集合里才算一致。
 * 严格 ⊆ 而非 ==：容器多发布几个端口（别的 compose project、更宽的旧段）不阻塞验收，
 * 配置里有端口没发布才是「栈与配置不一致」—— 正是 AC3 要明确报错的形态。
 */
export function checkRangeCovered(
  range: PortRange,
  published: Iterable<number>,
): { ok: boolean; missing: number[] } {
  const set = new Set(published);
  const missing: number[] = [];
  for (let port = range.start; port <= range.end; port++) {
    if (!set.has(port)) missing.push(port);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * `docker port <container>` 每行 `<容器端口>/<proto> -> <host 地址>:<host 端口>` 的解析
 * （纯函数）。host 端口可能是 `3011-3098` 段形态 —— 展开成逐端口，与 docker ps 侧同一
 * 处理；只认 host 侧端口：容器侧端口号不决定宿主监听。无法解析的行跳过而非报错 ——
 * 漏掉的是「容器发布面」数据，缺失会被 ⊆ 比较放大成 missing，不会静默。
 */
export function parseDockerPortLines(text: string): number[] {
  const ports = new Set<number>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const arrow = line.indexOf("->");
    if (arrow < 0) continue;
    const hostPart = line.slice(arrow + 2).trim();
    const colon = hostPart.lastIndexOf(":");
    if (colon < 0) continue;
    const portPart = hostPart.slice(colon + 1);
    const dash = portPart.indexOf("-");
    const from = Number(dash < 0 ? portPart : portPart.slice(0, dash));
    const to = dash < 0 ? from : Number(portPart.slice(dash + 1));
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 1 ||
      to < from
    ) {
      continue;
    }
    for (let port = from; port <= to; port++) ports.add(port);
  }
  return [...ports];
}

function familiesOfHost(host: string): AddressFamily[] {
  if (host === "127.0.0.1" || host === "0.0.0.0") return ["127.0.0.1"];
  if (host === "[::1]" || host === "[::]" || host === "::") return ["::1"];
  // 显式绑到非 loopback 地址的发布不覆盖本预检只管的两族。
  return [];
}

/**
 * `docker ps` Ports 列的解析：`127.0.0.1:3011->3011/tcp, [::1]:3011->3011/tcp, …`，
 * host 侧同样可能是 `3011-3098` 段形态（逐端口展开）；不带 `->` 的容器侧端口
 * （`9999/tcp`）与空串跳过。0.0.0.0/:: 绑全部该族接口、含 loopback；[::] 只按 v6 计
 * （v4-mapped 保守不计，compose 本就两族各自显式发布）。name/image/service/project
 * 由调用方从同一条 docker ps 行的其余列带进来，ours 判定用后两者。
 */
export function parseDockerPortsField(
  ports: string,
  name: string,
  image: string,
  service: string,
  project: string,
): ContainerPublish[] {
  const publishes: ContainerPublish[] = [];
  for (const part of ports
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const match = /^(.+):(\d+(?:-\d+)?)->/.exec(part);
    if (!match) continue;
    const bounds = match[2].split("-").map(Number);
    for (let port = bounds[0]; port <= bounds[bounds.length - 1]; port++) {
      for (const family of familiesOfHost(match[1])) {
        publishes.push({ name, image, service, project, port, family });
      }
    }
  }
  return publishes;
}

/**
 * `lsof -nP -sTCP:LISTEN -Fpcn` 的机器可读输出（scripts/processes.sh 的 holder() 用同一
 * 格式）：p<pid> / c<命令> 每进程一次，n<地址:端口> 每监听 fd 一次，按行状态机累积。
 * `*` 通配监听按两族处理；显式非 loopback 绑定不覆盖 loopback，跳过。pid 缺失（-F 序列
 * 里 p 行未到）的 n 行也收：占用事实不依赖 pid，只是定位信息少一截。
 */
export function parseLsofFOutput(text: string): ProcessListen[] {
  const listens: ProcessListen[] = [];
  let pid = 0;
  let command = "";
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 2) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pid = Number(value) || 0;
    } else if (tag === "c") {
      command = value;
    } else if (tag === "n") {
      const colon = value.lastIndexOf(":");
      if (colon < 0) continue;
      const port = Number(value.slice(colon + 1));
      if (!Number.isInteger(port) || port < 1) continue;
      const host = value.slice(0, colon);
      const families =
        host === "*" ? PROBE_FAMILIES.slice() : familiesOfHost(host);
      for (const family of families) {
        listens.push({ name: command, pid, port, family });
      }
    }
  }
  return listens;
}

export interface PreflightOutcome {
  code: number;
  lines: string[];
}

const familyLabel = (family: AddressFamily): string =>
  family === "::1" ? "[::1]" : "127.0.0.1";

/**
 * 占用判定本体（纯逻辑 + 注入快照，无系统调用）。判定顺序：容器侧优先 —— 容器发布的
 * 宿主端口由引擎代理监听（com.docker.backend / docker-proxy / OrbStack Helper…），
 * lsof 必然看到它的影子。套接字独占意味着：某个端口 × 地址族上有容器发布时，lsof 在
 * 同一键上看到的进程只能是那个发布代理 —— 跳过它，容器行已经把占用者（名字+镜像）
 * 说得更准；ours 容器同理（连容器行也不报，只计 ours）。其余任何占用者（含本栈其他
 * 服务占入段内）都是冲突。docker 查询不可用时没有容器侧可对照，lsof 里的引擎代理无法
 * 判定归属 —— 按冲突报并注明原因，不替它猜「大概是我们的」。
 */
export function runPreflight(
  range: PortRange,
  deps: ProbeDeps,
  expectedProject: string,
): PreflightOutcome {
  const lines: string[] = [];
  const size = range.end - range.start + 1;
  const docker = deps.docker();
  const lsof = deps.lsof();
  const dockerOk = docker.status === "ok";
  const lsofOk = lsof.status === "ok";

  const dockerByKey = new Map<string, ContainerPublish[]>();
  const oursPorts = new Set<number>();
  const oursNames = new Set<string>();
  if (dockerOk) {
    for (const publish of docker.publishes) {
      const key = `${publish.port}/${publish.family}`;
      const bucket = dockerByKey.get(key);
      if (bucket) bucket.push(publish);
      else dockerByKey.set(key, [publish]);
      // ours = service 与 compose project 都得对上：本仓多 worktree 并行，另一份
      // checkout 的栈 service 同名而 project 随目录名不同 —— 那是要报冲突的外栈。
      // 只计段内的 ours 发布：ours 行声称「已发布其中 N 个端口」，段外发布不属「其中」。
      if (
        publish.service === OUR_SANDBOX_COMPOSE_SERVICE &&
        publish.project === expectedProject &&
        publish.port >= range.start &&
        publish.port <= range.end
      ) {
        oursPorts.add(publish.port);
        oursNames.add(publish.name);
      }
    }
  }
  const lsofByKey = new Map<string, ProcessListen[]>();
  if (lsofOk) {
    for (const listen of lsof.listens) {
      const key = `${listen.port}/${listen.family}`;
      const bucket = lsofByKey.get(key);
      if (bucket) bucket.push(listen);
      else lsofByKey.set(key, [listen]);
    }
  }

  interface Conflict {
    port: number;
    family: AddressFamily;
    holder: string;
    note?: string;
  }
  const conflicts: Conflict[] = [];
  for (let port = range.start; port <= range.end; port++) {
    for (const family of PROBE_FAMILIES) {
      const key = `${port}/${family}`;
      const publishers = dockerOk ? (dockerByKey.get(key) ?? []) : null;
      // 有容器发布（无论 ours 还是外来的）时同键上的进程只能是它的宿主侧代理。
      const shadowedByPublish = publishers !== null && publishers.length > 0;
      if (publishers) {
        for (const publish of publishers) {
          const ours =
            publish.service === OUR_SANDBOX_COMPOSE_SERVICE &&
            publish.project === expectedProject;
          if (ours) continue;
          const holder = `${publish.name} (image=${publish.image}${
            publish.project ? `, project=${publish.project}` : ""
          })`;
          conflicts.push({
            port,
            family,
            holder,
            note:
              publish.service === OUR_SANDBOX_COMPOSE_SERVICE
                ? `非本栈沙箱：project=${publish.project || "(无 label)"} ≠ 本栈预期 ${expectedProject}（另一份 checkout 的栈？）`
                : undefined,
          });
        }
      }
      const listeners = lsofOk ? (lsofByKey.get(key) ?? []) : null;
      if (listeners) {
        for (const listen of listeners) {
          if (shadowedByPublish) continue;
          const dockerProxyShadow =
            !dockerOk && /com\.docker\.backend|docker-proxy/.test(listen.name);
          conflicts.push({
            port,
            family,
            holder: `${listen.name} (pid=${listen.pid})`,
            note: dockerProxyShadow
              ? "docker 查询不可用，无法判定是否本栈 agent-sandbox 的发布代理"
              : undefined,
          });
        }
      }
    }
  }

  if (conflicts.length > 0) {
    lines.push(
      `agent-sandbox 端口段 ${range.start}-${range.end}（${size} 个端口）：127.0.0.1 与 [::1] 共 ${conflicts.length} 处占用`,
    );
    for (const conflict of conflicts) {
      lines.push(
        `  - 端口 ${conflict.port}（${familyLabel(conflict.family)}）：${conflict.holder}` +
          (conflict.note ? ` —— ${conflict.note}` : ""),
      );
    }
    lines.push("");
    lines.push(
      "解决（两选一，修完重跑 bun --no-env-file scripts/craft-port-range-preflight.ts 验证）：",
    );
    lines.push(
      `  1. 改段：编辑 .env 的 ${PORT_START_KEY} / ${PORT_END_KEY}（当前 ${range.start}/${range.end}），再执行`,
    );
    lines.push("       docker compose up -d agent-sandbox");
    lines.push(
      "     宿主上直接跑的 API server 也要重启 —— 它在启动时读取这两个键。",
    );
    lines.push("  2. 停占用：先定位占用者 ——");
    for (const port of [
      ...new Set(conflicts.map((conflict) => conflict.port)),
    ]) {
      lines.push(`       docker ps --filter publish=${port}`);
      lines.push(`       lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    }
    lines.push("     确认后停止：docker stop <容器名> 或 kill <pid>。");
    if (!dockerOk) {
      lines.push(
        `  无法探测（缺 docker）：容器发布面未核验（原因：${(docker as { reason: string }).reason}）—— 上面的冲突只来自进程侧。`,
      );
    }
    if (!lsofOk) {
      lines.push(
        `  无法探测（缺 lsof）：进程监听面未核验（原因：${(lsof as { reason: string }).reason}）—— 上面的冲突只来自容器侧。`,
      );
    }
    return { code: 1, lines };
  }

  if (!dockerOk && !lsofOk) {
    lines.push(
      `无法探测（缺 docker）：容器发布面未核验（原因：${(docker as { reason: string }).reason}）`,
    );
    lines.push(
      `无法探测（缺 lsof）：进程监听面未核验（原因：${(lsof as { reason: string }).reason}）`,
    );
    lines.push(
      `agent-sandbox 端口段 ${range.start}-${range.end}：两个探测面都不可用，未做任何占用判定，拒绝给出「空闲」结论`,
    );
    return { code: 3, lines };
  }

  lines.push(
    `ok：agent-sandbox 端口段 ${range.start}-${range.end}（${size} 个端口）在 127.0.0.1 与 [::1] 均无占用`,
  );
  if (oursPorts.size > 0) {
    lines.push(
      `  本栈 agent-sandbox（project=${expectedProject}：${[...oursNames].join("、")}）已发布其中 ${oursPorts.size} 个端口（ours，重跑安全，不算冲突）`,
    );
  }
  if (!dockerOk) {
    lines.push(
      `无法探测（缺 docker）：容器发布面未核验（原因：${(docker as { reason: string }).reason}）—— 本结论只覆盖宿主进程侧。`,
    );
  }
  if (!lsofOk) {
    lines.push(
      `无法探测（缺 lsof）：进程监听面未核验（原因：${(lsof as { reason: string }).reason}）—— 本结论只覆盖容器发布侧。`,
    );
  }
  return { code: 0, lines };
}

/**
 * 完整 CLI 口径（解析 + 校验 + 判定），返回行与退出码而不直接打印 —— 单测与 main 共用
 * 同一条路径，没有「测试跑的逻辑」和「用户跑的逻辑」两份。
 */
export function runPreflightCli(
  env: Record<string, string | undefined>,
  deps: ProbeDeps,
  expectedProject: string,
): PreflightOutcome {
  const { range, errors, notes } = resolvePortRange(env);
  const lines: string[] = notes.map((note) => `注：${note}`);
  if (!range) {
    lines.push(
      "agent-sandbox 端口段配置非法（来源：进程环境 > 仓库根 .env）：",
    );
    for (const error of errors) lines.push(`  - ${error}`);
    lines.push(
      "修正示例（写入 .env 后重跑 bun --no-env-file scripts/craft-port-range-preflight.ts）：",
    );
    lines.push(`  ${PORT_START_KEY}=3011`);
    lines.push(`  ${PORT_END_KEY}=3098`);
    return { code: 2, lines };
  }
  const outcome = runPreflight(range, deps, expectedProject);
  return { code: outcome.code, lines: [...lines, ...outcome.lines] };
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 子进程的一次性封装：argv 调用不经 shell；spawn 本身失败（缺 CLI）与「命令跑完但退出码
 * 非零」分开返回 —— 前者是「无法探测（缺 X）」，后者按命令语义各自解释（lsof 找不到
 * 监听本就退出 1，那是空闲不是失败）。
 */
function spawnText(
  command: string[],
):
  | { ok: true; exitCode: number; stdout: string; stderr: string }
  | { ok: false; error: string } {
  try {
    const spawned = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
    return {
      ok: true,
      exitCode: spawned.exitCode,
      stdout: new TextDecoder().decode(spawned.stdout),
      stderr: new TextDecoder().decode(spawned.stderr),
    };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/**
 * lsof 一次调用的结果裁决（纯函数，供 cliDeps 与单测共用）。lsof 的退出码语义不对称：
 * 0 = 有匹配，1 = 无匹配（= 段内空闲，不是失败），2 及以上 = 真失败 —— 旧实现把一切
 * 非零都当空闲，真失败（坏 flag、坏内核表）会以「ok」背书一个没探测过的段（R2-F4）。
 * stderr 出现任何输出同样按 unavailable 处理：lsof 的告警意味着结果集可能不完整
 * （如非特权运行看不到 root 拥有者的监听），宁可降级明示也不静默收窄探测面。
 */
export function lsofSnapshotFromSpawn(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): LsofSnapshot {
  if (result.exitCode > 1) {
    return {
      status: "unavailable",
      reason: `lsof 退出码 ${result.exitCode}（0/1 之外按失败处理，不背书空闲）`,
    };
  }
  const warning = result.stderr.trim();
  if (warning !== "") {
    return {
      status: "unavailable",
      reason: `lsof stderr 非空：${warning.slice(0, 160)}`,
    };
  }
  return { status: "ok", listens: parseLsofFOutput(result.stdout) };
}

// Go 模板字面量（{{.Names}} 等）里的花括号是 docker 的格式方言，不是 JS 模板插值。
const DOCKER_PS_FORMAT =
  '{{.Names}}\t{{.Image}}\t{{.Label "com.docker.compose.service"}}\t{{.Label "com.docker.compose.project"}}\t{{.Ports}}';

/**
 * CLI 探测接线（真实系统调用，仅 import.meta.main 路径使用；单测注入的是 ProbeDeps 的
 * 纯数据快照）。docker ps / lsof 各一次全量调用再本地过滤 —— 逐端口 × 2 族会放大成
 * 数百次子进程。lsof 无匹配时退出码 1 且无输出，那是「空闲」不是失败；docker ps 非零
 * 退出（daemon 未起、CLI 缺失）才是 unavailable，由 runPreflight 翻译成「无法探测」。
 */
function cliDeps(): ProbeDeps {
  return {
    docker(): DockerSnapshot {
      const spawned = spawnText(["docker", "ps", "--format", DOCKER_PS_FORMAT]);
      if (!spawned.ok) {
        return {
          status: "unavailable",
          reason: `无法执行 docker（缺 CLI？）：${spawned.error}`,
        };
      }
      if (spawned.exitCode !== 0) {
        return {
          status: "unavailable",
          reason:
            spawned.stderr.trim() || `docker ps 退出码 ${spawned.exitCode}`,
        };
      }
      const publishes: ContainerPublish[] = [];
      for (const line of spawned.stdout.split(/\r?\n/).filter(Boolean)) {
        const [name = "", image = "", service = "", project = "", ports = ""] =
          line.split("\t");
        publishes.push(
          ...parseDockerPortsField(ports, name, image, service, project),
        );
      }
      return { status: "ok", publishes };
    },
    lsof(): LsofSnapshot {
      const spawned = spawnText(["lsof", "-nP", "-sTCP:LISTEN", "-Fpcn"]);
      if (!spawned.ok) {
        return {
          status: "unavailable",
          reason: `无法执行 lsof（缺 CLI？）：${spawned.error}`,
        };
      }
      return lsofSnapshotFromSpawn(spawned);
    },
  };
}

/**
 * 容器实际发布面的一句话摘要（AC3 FAIL 文案的「另一侧段值」，R2-F5）：min–max + 端口数
 * —— 端口数小于跨度即说明段内有洞，读者不必另跑 docker port 就能对出两侧差异。
 */
export function publishedSpanSummary(ports: number[]): string {
  if (ports.length === 0) return "未发布任何端口";
  const min = Math.min(...ports);
  const max = Math.max(...ports);
  return min === max
    ? `${min}（共 1 个端口）`
    : `${min}-${max}（共 ${ports.length} 个端口）`;
}

export type DockerPortSnapshot =
  | { status: "ok"; ports: number[] }
  | { status: "unavailable"; reason: string };

/**
 * 读运行中容器的实际发布端口（`docker port`）。容器不在运行 / 不存在时 docker 非零退出
 * —— 那是 AC3 的「明确报错」材料而不是可跳过状态：调用方（craft-preview-acceptance 的
 * preflight）把 reason 翻成失败文案与修正命令。argv 形式调用不经 shell，容器名不构成
 * 注入面；与 killPortOccupant 的 docker exec 不同，这里不需要形状白名单。
 */
export function dockerPortPublishedPorts(
  container: string,
): DockerPortSnapshot {
  const spawned = spawnText(["docker", "port", container]);
  if (!spawned.ok) {
    return {
      status: "unavailable",
      reason: `无法执行 docker（缺 CLI？）：${spawned.error}`,
    };
  }
  if (spawned.exitCode !== 0) {
    return {
      status: "unavailable",
      reason: spawned.stderr.trim() || `docker port 退出码 ${spawned.exitCode}`,
    };
  }
  return { status: "ok", ports: parseDockerPortLines(spawned.stdout) };
}

if (import.meta.main) {
  // 进程环境优先（compose 插值同序），其次仓库根 .env（与 compose 的发现位置一致），
  // 两键缺省回退 3010/3100。只透传三键（段两键 + COMPOSE_PROJECT_NAME）：整个
  // process.env 不是 .env 语义。⚠ 调用方必须用 `bun --no-env-file`：Bun 默认会把
  // cwd 的 .env/.env.local/.env.<NODE_ENV> 预载进 process.env，其中 .local 变体是
  // compose 不认的事实源 —— 预载后 CLI 会拿「compose 不会用的值」当最高优先级来源
  // （R2-F1）。start.sh 与文档命令都已带 --no-env-file。
  const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  const env: Record<string, string> = existsSync(envPath)
    ? parseDotEnv(readFileSync(envPath, "utf8"))
    : {};
  for (const key of [PORT_START_KEY, PORT_END_KEY, "COMPOSE_PROJECT_NAME"]) {
    const value = process.env[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  const repoRootDirName = basename(dirname(envPath));
  const outcome = runPreflightCli(
    env,
    cliDeps(),
    expectedComposeProject(env, repoRootDirName),
  );
  for (const line of outcome.lines) console.log(line);
  process.exit(outcome.code);
}
