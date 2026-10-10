import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isPlainBotId } from "../src/bot-id";
import { createBotRuntimes } from "../src/bot-runtimes";
import { sandboxEnvFrom } from "../src/env";

// 宿主机没有 /workspace（容器内的挂载点）：用一次性临时目录充当 volume，路径断言相对它书写。
const workspaceDir = await mkdtemp(`${tmpdir()}/bot-runtimes-test-`);

const env = sandboxEnvFrom({
  SANDBOX_TOKEN: "t",
  SANDBOX_PROVIDER_BASE_URL: "https://example.invalid",
  SANDBOX_PROVIDER_API_KEY: "k",
  SANDBOX_MODEL: "GLM-5.3",
  SANDBOX_WORKSPACE_DIR: workspaceDir,
  SANDBOX_UPSTREAM_IDLE_MS: "1000",
  SANDBOX_ACTIVITY_TIMEOUT_MS: "1000",
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
    expect(a1.workspaceDir).toBe(`${workspaceDir}/bots/alpha`);
    expect(b.workspaceDir).toBe(`${workspaceDir}/bots/beta`);
    expect(spawned).toHaveLength(2);
    expect(spawned[0]?.cwd).toBe(`${workspaceDir}/bots/alpha`);
    expect(spawned[1]?.cwd).toBe(`${workspaceDir}/bots/beta`);
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

  test("同一 bot 的并发首次请求只拉起一个 upstream（mkdir 的 await 不再放行双重 spawn）", async () => {
    const { spawned, spawnFn } = fakeSpawnFactory();
    const runtimes = createBotRuntimes({ env, spawnFn, nowMs: () => 0 });
    // 两个并发 getOrSpawn：第一个在 entries.set 之后、upstream 就位之前让出（mkdir 的 await），
    // 第二个此时命中注册表。修复前第二个会在 upstream 仍为 null 时再 build 一次，把前一个
    // 子进程覆盖成孤儿；修复后它等待同一次启动，spawn 只发生一次。
    const [first, second] = await Promise.all([
      runtimes.getOrSpawn("alpha"),
      runtimes.getOrSpawn("alpha"),
    ]);
    expect(first.port).toBe(second.port);
    expect(first.workspaceDir).toBe(second.workspaceDir);
    expect(spawned).toHaveLength(1);
    await runtimes.stopBot("alpha");
  });

  test("空闲且静默都超时的 bot 在清扫时被回收并释放端口", async () => {
    const { spawned, spawnFn } = fakeSpawnFactory();
    let now = 0;
    const runtimes = createBotRuntimes({ env, spawnFn, nowMs: () => now });
    await runtimes.getOrSpawn("alpha");
    now = 1500; // 超过 idleMs=1000 且超过 activityTimeoutMs=1000：双钟皆尽
    const { idle, stalled } = runtimes.reapIdle(now);
    expect(stalled).toEqual(["alpha"]);
    expect(idle).toEqual([]);
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
    await runtimes.getOrSpawn("alpha"); // 刷新 lastUsed 与 lastActivity
    now = 1200; // 距上次使用/活动 700ms < 1000ms
    expect(runtimes.reapIdle(1200)).toEqual({ idle: [], stalled: [] });
    await runtimes.stopBot("alpha");
  });

  test("流上持续有事件的 bot 即使请求空闲也不回收（S5 活动超时语义）", async () => {
    let now = 0;
    const { spawnFn } = fakeSpawnFactory();
    const runtimes = createBotRuntimes({ env, spawnFn, nowMs: () => now });
    await runtimes.getOrSpawn("alpha");
    now = 1200; // 请求已空闲 1200ms > idleMs=1000
    runtimes.markActivity("alpha"); // 但流刚转发了事件块
    now = 1400; // 距活动 200ms < activityTimeoutMs=1000
    expect(runtimes.reapIdle(1400)).toEqual({ idle: [], stalled: [] });
    await runtimes.stopBot("alpha");
  });

  test("流静默超过活动超时的 bot 被回收并报告为 stalled", async () => {
    let now = 0;
    const { spawnFn } = fakeSpawnFactory();
    const runtimes = createBotRuntimes({ env, spawnFn, nowMs: () => now });
    await runtimes.getOrSpawn("alpha");
    now = 2500; // 双钟皆尽（idle 2500ms、静默 2500ms 都 > 1000）
    const { idle, stalled } = runtimes.reapIdle(2500);
    expect(stalled).toEqual(["alpha"]);
    expect(idle).toEqual([]);
    expect(runtimes.size()).toBe(0);
  });

  test("stopAll 停掉全部 bot（SIGTERM 退出路径）", async () => {
    const { spawnFn } = fakeSpawnFactory();
    const runtimes = createBotRuntimes({ env, spawnFn, nowMs: () => 0 });
    await runtimes.getOrSpawn("alpha");
    await runtimes.getOrSpawn("beta");
    expect(runtimes.size()).toBe(2);
    await runtimes.stopAll();
    expect(runtimes.size()).toBe(0);
  });
});
