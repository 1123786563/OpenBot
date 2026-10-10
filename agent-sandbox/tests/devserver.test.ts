import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createDevServers } from "../src/devserver";

/**
 * The dev server pool against a fake spawn: allocation, reuse, the cap as a refusal, and the
 * release-and-reuse cycle. Nothing here runs vite; everything here pins what would break a
 * Bot's preview if it drifted.
 */
function fakeChild(): ChildProcess {
  const emitter = new EventEmitter() as unknown as ChildProcess;
  return Object.assign(emitter, {
    kill: () => {
      emitter.emit("exit", 0, null);
    },
  });
}

function build(max = 8, portBase = 4600) {
  const spawns: Array<{ command: string; args: string[]; cwd: string }> = [];
  const children: ChildProcess[] = [];
  const capacityLogs: Array<Record<string, unknown>> = [];
  const devservers = createDevServers({
    portBase,
    max,
    workspaceRoot: "/workspace/bots",
    spawnFn: (command, args, cwd) => {
      spawns.push({ command, args, cwd });
      const child = fakeChild();
      children.push(child);
      return child;
    },
    nowMs: () => 1_000,
    log: (line) => capacityLogs.push(line),
  });
  return { devservers, spawns, children, capacityLogs };
}

describe("the per-bot dev server pool (S8)", () => {
  test("same bot and dir reuse the same running server", async () => {
    const { devservers, spawns } = build();
    const first = await devservers.start({ botId: "alpha", dir: "apps/web" });
    const second = await devservers.start({ botId: "alpha", dir: "apps/web" });
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.port).toBe(4600);
    expect(spawns).toHaveLength(1); // One child, not two.
    expect(spawns[0]?.cwd).toBe("/workspace/bots/alpha/apps/web");
  });

  test("different bots and different dirs take different ports from the pool", async () => {
    const { devservers } = build();
    const a = await devservers.start({ botId: "alpha", dir: "web" });
    const b = await devservers.start({ botId: "beta", dir: "web" });
    const c = await devservers.start({ botId: "alpha", dir: "admin" });
    expect(new Set([a, b, c].map((r) => (r.ok ? r.port : -1))).size).toBe(3);
  });

  test("the cap is a refusal with a structured line, never a queue", async () => {
    const { devservers, capacityLogs } = build(2);
    await devservers.start({ botId: "a", dir: "web" });
    await devservers.start({ botId: "b", dir: "web" });
    const third = await devservers.start({ botId: "c", dir: "web" });
    expect(third).toEqual({ ok: false, reason: "capacity", running: 2, max: 2 });
    expect(capacityLogs).toHaveLength(1);
    expect(capacityLogs[0]).toMatchObject({
      type: "sandbox-devserver-capacity",
      running: 2,
      max: 2,
      botId: "c",
    });
  });

  test("stop releases the port, and the next start reuses the freed slot", async () => {
    const { devservers } = build();
    const a = await devservers.start({ botId: "a", dir: "web" });
    const b = await devservers.start({ botId: "b", dir: "web" });
    await devservers.stop("a");
    expect(devservers.list().map((entry) => entry.botId)).toEqual(["b"]);
    const c = await devservers.start({ botId: "c", dir: "web" });
    // The freed slot (offset 0) serves the new start, not a fresh grow.
    if (c.ok && a.ok) expect(c.port).toBe(a.port);
    if (b.ok) expect(devservers.list()).toHaveLength(2);
  });

  test("a bot's every dev server stops at once (the cascade's unit)", async () => {
    const { devservers } = build();
    await devservers.start({ botId: "alpha", dir: "web" });
    await devservers.start({ botId: "alpha", dir: "admin" });
    await devservers.start({ botId: "beta", dir: "web" });
    await devservers.stop("alpha");
    expect(devservers.list().map((entry) => entry.botId)).toEqual(["beta"]);
  });

  test("a child dying on its own releases its slot (belief follows the process)", async () => {
    const { devservers, spawns, children } = build(2);
    const a = await devservers.start({ botId: "a", dir: "web" });
    await devservers.start({ botId: "b", dir: "web" });
    // The first child crashes out from under us (vite died).
    children[0]?.emit("exit", 1, null);
    expect(devservers.list().map((entry) => entry.botId)).toEqual(["b"]);
    // The freed slot answers a NEW bot: the map no longer holds the dead one.
    const c = await devservers.start({ botId: "c", dir: "web" });
    expect(c.ok).toBe(true);
    if (c.ok && a.ok) expect(c.port).toBe(a.port);
  });

  test("an explicit command overrides vite, verbatim", async () => {
    const { devservers, spawns } = build();
    await devservers.start({ botId: "a", dir: "web", command: "next dev -p 3000" });
    expect(spawns[0]).toMatchObject({ command: "next", args: ["dev", "-p", "3000"] });
  });
});
