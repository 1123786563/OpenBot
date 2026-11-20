import { expect, test } from "bun:test";
import { workspaceComputers } from "../src/workspace-computers";

test("a disconnected control plane cannot renew a run or wake it after local exit", async () => {
  let now = 10_000;
  let running = false;
  let finishedAt = 0;
  const computers = workspaceComputers({
    now: () => now,
    async launch() {
      running = true;
    },
    async inspect() {
      return { status: running ? "running" : "exited", finishedAt };
    },
    async stop() {
      running = false;
      finishedAt = now;
    },
  });
  const grant = { epoch: 1, issuedAt: now, expiresAt: 25_000 };
  expect(await computers.start("workspace", grant)).toBe(true);
  now = 22_000;
  await computers.sweep();
  expect(running).toBe(false);
  expect(await computers.status("workspace")).toMatchObject({
    status: "restart_required",
    cutoff: "confirmed",
  });
  expect(
    computers.renew("workspace", {
      epoch: 1,
      issuedAt: now,
      expiresAt: 37_000,
    }),
  ).toBe(false);
  expect(await computers.start("workspace", grant)).toBe(false);
  expect(
    await computers.start("workspace", {
      epoch: 2,
      issuedAt: now,
      expiresAt: 37_000,
    }),
  ).toBe(true);
  expect(running).toBe(true);
});

test("a launch that crosses cutoff is rejected and a late exit is recorded as failed", async () => {
  let now = 10_000;
  let running = false;
  let finishedAt = 0;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const computers = workspaceComputers({
    now: () => now,
    async launch() {
      started.resolve();
      await release.promise;
      running = true;
    },
    async inspect() {
      return finishedAt || running
        ? { status: running ? "running" : "exited", finishedAt }
        : null;
    },
    async stop() {
      if (!running) return;
      running = false;
      finishedAt = now;
    },
  });
  const start = computers.start("workspace", {
    epoch: 1,
    issuedAt: now,
    expiresAt: 25_000,
  });
  await started.promise;
  now = 25_001;
  await computers.sweep();
  release.resolve();
  expect(await start).toBe(false);
  expect(running).toBe(false);
  expect(await computers.status("workspace")).toMatchObject({
    status: "restart_required",
    cutoff: "failed",
  });
});

test("a prior task authorization cannot use a manually restarted Computer", async () => {
  let now = 10_000;
  let running = false;
  let finishedAt = 0;
  const address = "http://computer:4100";
  const computers = workspaceComputers({
    now: () => now,
    async launch() {
      running = true;
    },
    async inspect() {
      return { status: running ? "running" : "exited", finishedAt, address };
    },
    async stop() {
      running = false;
      finishedAt = now;
    },
  });
  expect(
    await computers.start("workspace", {
      epoch: 1,
      issuedAt: now,
      expiresAt: 25_000,
    }),
  ).toBe(true);
  const task = { epoch: 1, authorizedAt: 10_001 };
  expect((await computers.status("workspace", task)).address).toBe(address);
  now = 22_000;
  await computers.sweep();
  now = 26_000;
  expect(
    await computers.start("workspace", {
      epoch: 1,
      issuedAt: now,
      expiresAt: 41_000,
    }),
  ).toBe(true);
  expect((await computers.status("workspace", task)).address).toBeUndefined();
  expect(
    (await computers.status("workspace", { epoch: 1, authorizedAt: now + 1 }))
      .address,
  ).toBe(address);
});
