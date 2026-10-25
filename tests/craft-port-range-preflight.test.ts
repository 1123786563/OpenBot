import {
  type ContainerPublish,
  checkRangeCovered,
  type DockerSnapshot,
  type LsofSnapshot,
  type ProcessListen,
  parseDockerPortLines,
  parseDotEnv,
  runPreflightCli,
} from "../scripts/craft-port-range-preflight";
import { expect, test } from "./support/e2e-compat";

/*
 * #619 T2：预检脚本的纯逻辑单测。探测面（docker ps / lsof 子进程）以快照依赖注入，
 * 每个用例固定一份快照 —— 单测不依赖本机是否有 docker daemon、是否有进程恰好监听
 * 段内端口（真实系统调用只有验证落盘的手工演示那一轮）。
 */

const dockerOk = (...publishes: ContainerPublish[]): DockerSnapshot => ({
  status: "ok",
  publishes,
});
const lsofOk = (...listens: ProcessListen[]): LsofSnapshot => ({
  status: "ok",
  listens,
});
const text = (outcome: { lines: string[] }): string => outcome.lines.join("\n");

/**
 * 空闲段：两族都无占用时一行成功结论，段、端口数与地址族齐全 —— 成功输出本身也是
 * 要核的契约，AC2 的另一半（可定位的失败）各占位用例在下面。
 */
test("free range passes with the two families named", () => {
  const outcome = runPreflightCli(
    {
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "3011",
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "3012",
    },
    { docker: () => dockerOk(), lsof: () => lsofOk() },
  );
  expect(outcome.code).toBe(0);
  expect(text(outcome)).toContain("3011-3012");
  expect(text(outcome)).toContain("2 个端口");
  expect(text(outcome)).toContain("127.0.0.1 与 [::1]");
});

/**
 * 进程占用（AC2 主路径）：错误文本必须同时给出端口、占用者（名字+pid）与两条可复跑
 * 步骤的关键命令 —— `docker ps --filter publish` 与 `kill`，缺一样就是「报了错但定位
 * 不了」。
 */
test("process occupant reports port, pid and both remediation steps", () => {
  const outcome = runPreflightCli(
    {
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "3011",
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "3011",
    },
    {
      docker: () => dockerOk(),
      lsof: () =>
        lsofOk({
          name: "python3",
          pid: 48121,
          port: 3011,
          family: "127.0.0.1",
        }),
    },
  );
  expect(outcome.code).toBe(1);
  const output = text(outcome);
  expect(output).toContain("3011");
  expect(output).toContain("python3 (pid=48121)");
  expect(output).toContain("docker ps --filter publish=3011");
  expect(output).toContain("lsof -nP -iTCP:3011 -sTCP:LISTEN");
  expect(output).toContain("kill");
  expect(output).toContain("docker compose up -d agent-sandbox");
});

/** 容器占用但不是本栈 agent-sandbox：点名容器名与镜像 —— 找得到人才能停对人。 */
test("foreign container occupant is named with its image", () => {
  const outcome = runPreflightCli(
    {
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "3011",
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "3011",
    },
    {
      docker: () =>
        dockerOk({
          name: "strange-dashboard",
          image: "strange/dashboard:latest",
          service: "strange-dashboard",
          port: 3011,
          family: "::1",
        }),
      lsof: () => lsofOk(),
    },
  );
  expect(outcome.code).toBe(1);
  const output = text(outcome);
  expect(output).toContain(
    "strange-dashboard (image=strange/dashboard:latest)",
  );
  expect(output).toContain("[::1]");
});

/**
 * 自己人：本栈 agent-sandbox 已发布的端口（compose label 匹配）不算冲突，start.sh 重跑
 * 安全 —— 与 require_free_or_ours 同一语义；docker 代理在宿主侧的监听影子也一并跳过
 * （两族各给一条 ours 发布，lsof 快照里放同端口的 com.docker.backend 影子）。
 */
test("agent-sandbox occupant is ours and passes", () => {
  const outcome = runPreflightCli(
    {
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "3011",
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "3011",
    },
    {
      docker: () =>
        dockerOk(
          {
            name: "openbot-agent-sandbox-1",
            image: "openbot/agent-sandbox:dev",
            service: "agent-sandbox",
            port: 3011,
            family: "127.0.0.1",
          },
          {
            name: "openbot-agent-sandbox-1",
            image: "openbot/agent-sandbox:dev",
            service: "agent-sandbox",
            port: 3011,
            family: "::1",
          },
        ),
      lsof: () =>
        lsofOk(
          {
            name: "com.docker.backend",
            pid: 999,
            port: 3011,
            family: "127.0.0.1",
          },
          { name: "com.docker.backend", pid: 999, port: 3011, family: "::1" },
        ),
    },
  );
  expect(outcome.code).toBe(0);
  const output = text(outcome);
  expect(output).toContain("ours");
  expect(output).not.toContain("解决");
});

/** 倒置段：非零退出且错误点名两把键与两个值 —— 配置错误也要可定位。 */
test("inverted range is rejected naming both keys", () => {
  const outcome = runPreflightCli(
    {
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "3100",
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "3011",
    },
    { docker: () => dockerOk(), lsof: () => lsofOk() },
  );
  expect(outcome.code).toBe(2);
  const output = text(outcome);
  expect(output).toContain("OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START=3100");
  expect(output).toContain("OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END=3011");
  expect(output).toContain("倒置");
});

/** 非整数：拒绝并点名键与收到的原值。 */
test("non-integer port is rejected naming the key and value", () => {
  const outcome = runPreflightCli(
    {
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "abc",
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "3011",
    },
    { docker: () => dockerOk(), lsof: () => lsofOk() },
  );
  expect(outcome.code).toBe(2);
  const output = text(outcome);
  expect(output).toContain("OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START");
  expect(output).toContain('"abc"');
});

/**
 * 只设一端不算错：用另一端默认并把合并后的段说清楚 —— 沉默地用默认是「配置漂移」，
 * 提示后的默认是「有意的选择」。
 */
test("START-only falls back to the default END with an explicit note", () => {
  const outcome = runPreflightCli(
    { OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "3011" },
    { docker: () => dockerOk(), lsof: () => lsofOk() },
  );
  expect(outcome.code).toBe(0);
  const output = text(outcome);
  expect(output).toContain("3011-3100");
  expect(output).toContain("按默认 3100");
  expect(output).toContain("成对设置");
});

/**
 * lsof 缺失：明确输出「无法探测（缺 lsof）」，不用空结果冒充空闲 —— 成功结论同时注明
 * 只覆盖了容器侧（Git Bash on Windows 场景，processes.sh 的跨平台先例：降级而非静默）。
 */
test("missing lsof is reported as unable-to-probe, never as silence", () => {
  const outcome = runPreflightCli(
    {
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "3011",
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "3011",
    },
    {
      docker: () => dockerOk(),
      lsof: () => ({
        status: "unavailable",
        reason: "无法执行 lsof（缺 CLI？）：spawn lsof ENOENT",
      }),
    },
  );
  expect(outcome.code).toBe(0);
  const output = text(outcome);
  expect(output).toContain("无法探测（缺 lsof）");
  expect(output).toContain("只覆盖容器发布侧");
});

/**
 * 两个探测面都不可用：任何一面都没核过，拒绝给出「空闲」结论（退出码 3）—— 这是对
 * 「不静默通过」的底线形态：全部未验证时不能算通过。
 */
test("both probes unavailable refuses to certify the range", () => {
  const outcome = runPreflightCli(
    {
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "3011",
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "3011",
    },
    {
      docker: () => ({
        status: "unavailable",
        reason: "Cannot connect to the Docker daemon",
      }),
      lsof: () => ({ status: "unavailable", reason: "spawn lsof ENOENT" }),
    },
  );
  expect(outcome.code).toBe(3);
  const output = text(outcome);
  expect(output).toContain("无法探测（缺 docker）");
  expect(output).toContain("无法探测（缺 lsof）");
  expect(output).toContain("拒绝给出");
});

/**
 * docker 不可用时的 lsof 影子：com.docker.backend / docker-proxy 监听着段内端口但无法
 * 查容器归属 —— 按冲突报并注明无法判定，不替它猜「大概是我们的」。
 */
test("docker-unavailable shadow of a docker proxy is a flagged conflict", () => {
  const outcome = runPreflightCli(
    {
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "3011",
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "3011",
    },
    {
      docker: () => ({
        status: "unavailable",
        reason: "Cannot connect to the Docker daemon",
      }),
      lsof: () =>
        lsofOk({
          name: "com.docker.backend",
          pid: 999,
          port: 3011,
          family: "127.0.0.1",
        }),
    },
  );
  expect(outcome.code).toBe(1);
  const output = text(outcome);
  expect(output).toContain("无法判定是否本栈 agent-sandbox");
});

/**
 * 段长超限只警告不拒绝（compose 逐端口展开是开销问题不是合法性问题），警告里带段长
 * 数字，让人能对着 .env 核。
 */
test("oversized range warns with the size but passes", () => {
  const outcome = runPreflightCli(
    {
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "2000",
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "2500",
    },
    { docker: () => dockerOk(), lsof: () => lsofOk() },
  );
  expect(outcome.code).toBe(0);
  const output = text(outcome);
  expect(output).toContain("501 个端口");
  expect(output).toContain("收窄");
});

/**
 * AC3 的比对纯函数两态：配置段 ⊆ 发布段 → 通过；有端口未发布 → 不通过并列出 missing
 * （craft-preview-acceptance 的 preflight 用同一函数做「段与栈不一致时明确报错」）。
 */
test("checkRangeCovered passes when the range is fully published", () => {
  const coverage = checkRangeCovered(
    { start: 3011, end: 3013 },
    [3011, 3012, 3013],
  );
  expect(coverage.ok).toBe(true);
  expect(coverage.missing).toEqual([]);
});

test("checkRangeCovered fails listing the unpublished ports", () => {
  const coverage = checkRangeCovered({ start: 3011, end: 3013 }, [3011, 3012]);
  expect(coverage.ok).toBe(false);
  expect(coverage.missing).toEqual([3013]);
});

/**
 * `docker port` 行解析：v4/v6 各一行（同一端口去重）、host 端口段形态展开 —— 容器发布
 * 面的读数错了，AC3 的比对就整体失真。
 */
test("parseDockerPortLines dedupes families and expands host ranges", () => {
  const ports = parseDockerPortLines(
    [
      "3011/tcp -> 127.0.0.1:3011",
      "3011/tcp -> [::1]:3011",
      "4300/tcp -> 127.0.0.1:4300",
      "3012-3013/tcp -> 127.0.0.1:3012-3013",
    ].join("\n"),
  );
  expect(ports.sort((a, b) => a - b)).toEqual([3011, 3012, 3013, 4300]);
});

/** .env 解析与 start.sh 的 setting() 同语义：注释/空行跳过、剥引号、重复键后者胜。 */
test("parseDotEnv skips comments, unquotes and lets the last key win", () => {
  const parsed = parseDotEnv(
    [
      "# comment",
      "",
      "OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START=3011",
      "OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END=3098",
      'QUOTED="3011"',
      "OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END=3100",
    ].join("\n"),
  );
  expect(parsed.OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START).toBe("3011");
  expect(parsed.OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END).toBe("3100");
  expect(parsed.QUOTED).toBe("3011");
});

/**
 * 引擎代理的影子去重：容器已发布某端口 × 地址族时，lsof 在同键上看到的进程只能是该
 * 发布的宿主侧代理（com.docker.backend / OrbStack Helper…）—— 跳过它，容器行已把占用
 * 者说得更准；不去重则每个容器冲突都叠一条进程行，两条「解决步骤」各打一遍。
 */
test("engine proxy shadow behind a foreign publish is not double-reported", () => {
  const outcome = runPreflightCli(
    {
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "55441",
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "55441",
    },
    {
      docker: () =>
        dockerOk({
          name: "openbot-test-db-1",
          image: "pgvector/pgvector:pg17",
          service: "postgres",
          port: 55441,
          family: "127.0.0.1",
        }),
      lsof: () =>
        lsofOk({
          name: "OrbStack Helper",
          pid: 12337,
          port: 55441,
          family: "127.0.0.1",
        }),
    },
  );
  expect(outcome.code).toBe(1);
  const output = text(outcome);
  expect(output).toContain("openbot-test-db-1 (image=pgvector/pgvector:pg17)");
  expect(output).not.toContain("pid=");
  expect(output.match(/- 端口 55441/g)?.length).toBe(1);
});
