import {
  type ContainerPublish,
  checkRangeCovered,
  composeProjectFromDirectory,
  type DockerSnapshot,
  expectedComposeProject,
  type LsofSnapshot,
  lsofSnapshotFromSpawn,
  mergeProcessEnvOverDotEnv,
  type ProcessListen,
  parseDockerPortLines,
  parseDockerPortsField,
  parseDotEnv,
  parseLsofFOutput,
  publishedSpanSummary,
  resolvePortRange,
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
    "openbot",
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
    "openbot",
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
          project: "strange",
          port: 3011,
          family: "::1",
        }),
      lsof: () => lsofOk(),
    },
    "openbot",
  );
  expect(outcome.code).toBe(1);
  const output = text(outcome);
  expect(output).toContain(
    "strange-dashboard (image=strange/dashboard:latest, project=strange)",
  );
  expect(output).toContain("[::1]");
});

/**
 * 自己人：本栈 agent-sandbox 已发布的端口（compose label 的 service 与 project 都匹配）
 * 不算冲突，start.sh 重跑安全 —— 与 require_free_or_ours 同一语义；ours 行带容器名与
 * project（人眼可分辨「是谁的沙箱」）；docker 代理在宿主侧的监听影子也一并跳过（两族
 * 各给一条 ours 发布，lsof 快照里放同端口的 com.docker.backend 影子）。
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
            project: "openbot",
            port: 3011,
            family: "127.0.0.1",
          },
          {
            name: "openbot-agent-sandbox-1",
            image: "openbot/agent-sandbox:dev",
            service: "agent-sandbox",
            project: "openbot",
            port: 3011,
            family: "::1",
          },
          // 段外的 ours 发布：容器更宽的发布不改变「其中 N 个」的计数口径。
          {
            name: "openbot-agent-sandbox-1",
            image: "openbot/agent-sandbox:dev",
            service: "agent-sandbox",
            project: "openbot",
            port: 3012,
            family: "127.0.0.1",
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
    "openbot",
  );
  expect(outcome.code).toBe(0);
  const output = text(outcome);
  expect(output).toContain("ours");
  // ours 行带容器名与 project：冒名者（同 service 异 project）一眼可辨（R2-F2）。
  expect(output).toContain("project=openbot：openbot-agent-sandbox-1");
  // 计数只算段内（3011）；段外的 3012 不进「其中 N 个端口」。
  expect(output).toContain("已发布其中 1 个端口");
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
    "openbot",
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
    "openbot",
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
    "openbot",
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
    "openbot",
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
    "openbot",
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
    "openbot",
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
    "openbot",
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
          project: "openbot",
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
    "openbot",
  );
  expect(outcome.code).toBe(1);
  const output = text(outcome);
  expect(output).toContain(
    "openbot-test-db-1 (image=pgvector/pgvector:pg17, project=openbot)",
  );
  expect(output).not.toContain("pid=");
  expect(output.match(/- 端口 55441/g)?.length).toBe(1);
});

/*
 * ── r2 整改新增（R2-F1–F6）──────────────────────────────────────────────────
 */

/**
 * R2-F2：同 service 异 project 的 agent-sandbox 是「另一份 checkout 的栈」，不是 ours ——
 * 冒名不得假绿；冲突行带容器名、project 与「非本栈」注记，人眼可直接对出预期 project。
 */
test("foreign-project agent-sandbox is a conflict naming container and project", () => {
  const outcome = runPreflightCli(
    {
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "3011",
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "3011",
    },
    {
      docker: () =>
        dockerOk({
          name: "other-wt-agent-sandbox-1",
          image: "openbot/agent-sandbox:dev",
          service: "agent-sandbox",
          project: "other-wt",
          port: 3011,
          family: "127.0.0.1",
        }),
      lsof: () => lsofOk(),
    },
    "openbot",
  );
  expect(outcome.code).toBe(1);
  const output = text(outcome);
  expect(output).toContain("other-wt-agent-sandbox-1");
  expect(output).toContain("project=other-wt");
  expect(output).toContain("非本栈沙箱");
  expect(output).toContain("本栈预期 openbot");
});

/**
 * R2-F2：compose 对未命名 project 的默认取法 —— 目录名转小写并剔除非
 * [小写字母数字_-] 字符（`_` 保留，R2R-F1 真机对拍修正）。OpenBot → openbot 正是主
 * checkout 的栈名来源（docker-compose.yml 无 `name:` 字段，project 恒由此派生）。
 */
test("composeProjectFromDirectory lowercases and strips invalid characters", () => {
  expect(composeProjectFromDirectory("OpenBot")).toBe("openbot");
  expect(composeProjectFromDirectory("i619-t2-port-preflight")).toBe(
    "i619-t2-port-preflight",
  );
  expect(composeProjectFromDirectory("My.Repo")).toBe("myrepo");
  expect(composeProjectFromDirectory("Repo_Name")).toBe("repo_name");
  // R2R-F1 真机对拍样本（Docker 29.8.2 / Compose v5.5.0）：`_` 保留、`.` 剔除。
  expect(composeProjectFromDirectory("UP_Period.Underscore-Name")).toBe(
    "up_periodunderscore-name",
  );
});

/** R2-F2：COMPOSE_PROJECT_NAME（进程环境或 .env）优先于目录派生，与 compose 同序。 */
test("expectedComposeProject prefers COMPOSE_PROJECT_NAME over the directory", () => {
  expect(
    expectedComposeProject(
      { COMPOSE_PROJECT_NAME: "explicit-name" },
      "OpenBot",
    ),
  ).toBe("explicit-name");
  expect(expectedComposeProject({}, "OpenBot")).toBe("openbot");
});

/**
 * R2-F1：parseDotEnv 的行内注释边界与 compose 对齐 —— 空白前置的 `#` 起注释；引号内的
 * `#` 保留；无空白的 `#` 是值的一部分（compose 同样如此，随后端口校验如实拒绝）；
 * `KEY="3011" # c` 裁注释后恰好成引号段，剥成 3011。
 */
test("parseDotEnv strips whitespace-preceded inline comments like compose", () => {
  const parsed = parseDotEnv(
    [
      "OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START=3011 # dev range",
      "INLINE_NO_SPACE=3011#x",
      'QUOTED_HASH="a # b"',
      'AFTER_QUOTE="3011" # trailing',
    ].join("\n"),
  );
  expect(parsed.OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START).toBe("3011");
  expect(parsed.INLINE_NO_SPACE).toBe("3011#x");
  expect(parsed.QUOTED_HASH).toBe("a # b");
  expect(parsed.AFTER_QUOTE).toBe("3011");
});

/**
 * R2-F3：docker ps Ports 列方言表测。`0.0.0.0` 与 `::` 是族通配（覆盖 loopback）；
 * 段形态展开；不带 `->` 的容器侧端口与空串跳过；project 由调用方透传。
 */
test("parseDockerPortsField handles the docker ps dialects", () => {
  const publishes = [
    ...parseDockerPortsField(
      "0.0.0.0:9000-9001->9000-9001/tcp",
      "minio",
      "minio:latest",
      "minio",
      "some-stack",
    ),
    ...parseDockerPortsField(
      ":::3011->3011/tcp",
      "sb",
      "img",
      "agent-sandbox",
      "openbot",
    ),
    ...parseDockerPortsField(
      "[::1]:3012->3012/tcp",
      "sb",
      "img",
      "agent-sandbox",
      "openbot",
    ),
    ...parseDockerPortsField("9999/tcp", "no-publish", "img", "svc", "proj"),
    ...parseDockerPortsField("", "empty", "img", "svc", "proj"),
  ];
  expect(publishes).toEqual([
    {
      name: "minio",
      image: "minio:latest",
      service: "minio",
      project: "some-stack",
      port: 9000,
      family: "127.0.0.1",
    },
    {
      name: "minio",
      image: "minio:latest",
      service: "minio",
      project: "some-stack",
      port: 9001,
      family: "127.0.0.1",
    },
    {
      name: "sb",
      image: "img",
      service: "agent-sandbox",
      project: "openbot",
      port: 3011,
      family: "::1",
    },
    {
      name: "sb",
      image: "img",
      service: "agent-sandbox",
      project: "openbot",
      port: 3012,
      family: "::1",
    },
  ]);
});

/**
 * R2-F3：lsof -Fpcn 状态机表测 —— p/c 每进程一次、n 每 fd 一次；`*` 通配按两族；非
 * loopback 显式绑定不覆盖两族；p 行未到的 n 行照样收（pid 0，占用事实不依赖 pid）。
 */
test("parseLsofFOutput walks the -Fpcn stream", () => {
  const listens = parseLsofFOutput(
    [
      "p48121",
      "cPython",
      "n127.0.0.1:3050",
      "n*:3051",
      "p999",
      "ccom.docker.backend",
      "n[::1]:3052",
      "n192.168.1.5:3053",
      "n[::1]:3054",
    ].join("\n"),
  );
  expect(listens).toEqual([
    { name: "Python", pid: 48121, port: 3050, family: "127.0.0.1" },
    { name: "Python", pid: 48121, port: 3051, family: "127.0.0.1" },
    { name: "Python", pid: 48121, port: 3051, family: "::1" },
    { name: "com.docker.backend", pid: 999, port: 3052, family: "::1" },
    { name: "com.docker.backend", pid: 999, port: 3054, family: "::1" },
  ]);
});

/**
 * R2-F3 补缺：docker 侧 unavailable 而 lsof 正常的绿路径 —— 退出 0，成功行之外跟一条
 * 「无法探测（缺 docker）」并注明本结论只覆盖宿主进程侧（不含 ours 判定）。
 */
test("docker unavailable with healthy lsof passes covering only the process side", () => {
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
      lsof: () => lsofOk(),
    },
    "openbot",
  );
  expect(outcome.code).toBe(0);
  const output = text(outcome);
  expect(output).toContain("无法探测（缺 docker）");
  expect(output).toContain("只覆盖宿主进程侧");
});

/**
 * R2-F4：lsof 的退出码裁决 —— 1 = 无匹配（空闲）；2+ = 真失败；任何 stderr 输出都按
 * unavailable（结果集可能不完整，如非特权看不到 root 的监听）。真失败不背书空闲。
 */
test("lsofSnapshotFromSpawn treats exit>1 and stderr as unavailable", () => {
  const exited2 = lsofSnapshotFromSpawn({
    exitCode: 2,
    stdout: "",
    stderr: "",
  });
  expect(exited2.status).toBe("unavailable");

  const warned = lsofSnapshotFromSpawn({
    exitCode: 0,
    stdout: "p1\ncx\nn127.0.0.1:3050",
    stderr: "lsof: some warning",
  });
  expect(warned.status).toBe("unavailable");

  const free = lsofSnapshotFromSpawn({ exitCode: 1, stdout: "", stderr: "" });
  expect(free.status).toBe("ok");

  const parsed = lsofSnapshotFromSpawn({
    exitCode: 0,
    stdout: "p7\ncPython\nn127.0.0.1:3050",
    stderr: "",
  });
  expect(parsed.status).toBe("ok");
  if (parsed.status === "ok") {
    expect(parsed.listens).toEqual([
      { name: "Python", pid: 7, port: 3050, family: "127.0.0.1" },
    ]);
  }
});

/**
 * R2-F5：发布面摘要 —— AC3 FAIL 文案里的「另一侧段值」。端口数小于跨度即暴露段内有洞
 * （3011-3013 共 2），读者不必另跑 docker port。
 */
test("publishedSpanSummary names the published span and count", () => {
  expect(publishedSpanSummary([])).toBe("未发布任何端口");
  expect(publishedSpanSummary([3011])).toBe("3011（共 1 个端口）");
  expect(publishedSpanSummary([3011, 3012, 3013])).toBe(
    "3011-3013（共 3 个端口）",
  );
  expect(publishedSpanSummary([3011, 3013])).toBe("3011-3013（共 2 个端口）");
});

/**
 * R2-F6：同一键既有 error 时不再输出「未设置，按默认」note —— 两方向都核（START 非法 /
 * END 非法），错误文案本身仍点名键与原值。
 */
test("invalid value suppresses the unset-default note for the same key", () => {
  const startBad = runPreflightCli(
    {
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "abc",
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "3011",
    },
    { docker: () => dockerOk(), lsof: () => lsofOk() },
    "openbot",
  );
  expect(startBad.code).toBe(2);
  const startOutput = text(startBad);
  expect(startOutput).toContain('"abc"');
  expect(startOutput).not.toContain("未设置");

  const endBad = runPreflightCli(
    {
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "3011",
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "99999",
    },
    { docker: () => dockerOk(), lsof: () => lsofOk() },
    "openbot",
  );
  expect(endBad.code).toBe(2);
  expect(text(endBad)).not.toContain("未设置");
});

/*
 * ── 终审整改新增（C-F1/C-F2）──────────────────────────────────────────────
 */

/**
 * C-F1：只设 START 且高于默认 END → 默认合成的最终段倒置（4011-3100），配置错误路径：
 * 退出 2、报出实际生效两端与修正示例。健康空快照下也不得出现任何占用背书 —— 倒置段
 * 连占用探测都不该进（修前 4011-3100 空循环零次即「均无占用」假绿）。
 */
test("START-only above the default END is rejected naming the effective endpoints", () => {
  const outcome = runPreflightCli(
    { OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "4011" },
    { docker: () => dockerOk(), lsof: () => lsofOk() },
    "openbot",
  );
  expect(outcome.code).toBe(2);
  const output = text(outcome);
  expect(output).toContain("生效段 4011-3100");
  expect(output).toContain("倒置");
  expect(output).toContain("OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END=4020");
  expect(output).not.toContain("均无占用");
});

/** C-F1 反向：只设 END 且低于默认 START → 合成段 3010-3000 倒置，同样拒绝。 */
test("END-only below the default START is rejected naming the effective endpoints", () => {
  const outcome = runPreflightCli(
    { OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "3000" },
    { docker: () => dockerOk(), lsof: () => lsofOk() },
    "openbot",
  );
  expect(outcome.code).toBe(2);
  const output = text(outcome);
  expect(output).toContain("生效段 3010-3000");
  expect(output).toContain("倒置");
  expect(output).not.toContain("均无占用");
});

/**
 * C-F1 边界保留：合法单端回退仍通过并提示（END=3098 → 3010-3098，与既定「单端合成 +
 * 提示」决定一致），倒置拒绝只针对合成后 START>END 的形态。
 */
test("END-only inside the default START keeps the synthesized pass with a note", () => {
  const outcome = runPreflightCli(
    { OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "3098" },
    { docker: () => dockerOk(), lsof: () => lsofOk() },
    "openbot",
  );
  expect(outcome.code).toBe(0);
  const output = text(outcome);
  expect(output).toContain("3010-3098");
  expect(output).toContain("按默认 3010");
  expect(output).toContain("成对设置");
});

/**
 * C-F1 验收复用路径：倒置范围进 checkRangeCovered 必须拒绝 —— 空循环会零次通过，把
 * 非法范围读成「全覆盖」（craft-preview-acceptance 的 0b 步正常先经 resolvePortRange
 * 拦截，这里守住比较函数自身不接这个形态）。
 */
test("checkRangeCovered rejects an inverted range instead of vacuously passing", () => {
  const coverage = checkRangeCovered({ start: 3100, end: 3011 }, [3011, 3012]);
  expect(coverage.ok).toBe(false);
});

/**
 * C-F2 主形态：.env 双键非空 + shell 双键显式空 → 合并后按 compose `:-` 语义落默认
 * 3010-3100（实证 P2：docker compose config 同环境展开同为 3010-3100）。修前的合并
 * 丢弃空串、退回 .env 的 4011-4040 —— 预检查的段与 compose 发布的段不同源。
 */
test("empty shell values override .env so the compose defaults apply", () => {
  const merged = mergeProcessEnvOverDotEnv(
    {
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "4011",
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "4040",
    },
    {
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "",
      OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "",
    },
  );
  const resolution = resolvePortRange(merged);
  expect(resolution.errors).toEqual([]);
  expect(resolution.range).toEqual({ start: 3010, end: 3100 });
});

/**
 * C-F2 单键空：START 空落默认 3010，END 仍取 .env 的 4040（实证 P3：compose 展开同为
 * 3010-4040）；对照键保持 undefined 时 .env 值原样透传（P1：4011-4040）。
 */
test("single empty shell key overrides only that key", () => {
  const dotEnv = {
    OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "4011",
    OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_END: "4040",
  };
  const singleEmpty = mergeProcessEnvOverDotEnv(dotEnv, {
    OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_START: "",
  });
  expect(resolvePortRange(singleEmpty).range).toEqual({
    start: 3010,
    end: 4040,
  });

  const untouched = mergeProcessEnvOverDotEnv(dotEnv, {});
  expect(resolvePortRange(untouched).range).toEqual({ start: 4011, end: 4040 });
});

/**
 * C-F2：COMPOSE_PROJECT_NAME 空值按实证对拍（P4/P5，Compose v5.5.0）—— shell 空串同样
 * 覆盖 .env 值，覆盖后的空值由 expectedComposeProject 回退目录派生，与 compose 实际
 * project 一致；非空照旧优先（P1）。
 */
test("COMPOSE_PROJECT_NAME empty shell override falls back to the directory", () => {
  const overridden = mergeProcessEnvOverDotEnv(
    { COMPOSE_PROJECT_NAME: "dot-env-project" },
    { COMPOSE_PROJECT_NAME: "" },
  );
  expect(expectedComposeProject(overridden, "OpenBot")).toBe("openbot");

  const kept = mergeProcessEnvOverDotEnv(
    { COMPOSE_PROJECT_NAME: "dot-env-project" },
    {},
  );
  expect(expectedComposeProject(kept, "OpenBot")).toBe("dot-env-project");
});
