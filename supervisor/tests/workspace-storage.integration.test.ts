import { expect, test } from "bun:test";
import Docker from "dockerode";
import { ensure, eraseWorkspaceComputer, reset, stop } from "../src/docker";
import { namesFor } from "../src/names";

const image = process.env.WORKSPACE_STORAGE_TEST_IMAGE;
const docker = new Docker(
  process.env.DOCKER_SOCKET
    ? { socketPath: process.env.DOCKER_SOCKET }
    : undefined,
);

test.skipIf(!image)(
  "Docker refuses a Workspace Computer without bounded storage",
  async () => {
    const target = namesFor("workspace", crypto.randomUUID());
    if (!target.ok || !image)
      throw new Error("Missing workspace test configuration");
    const { names } = target;
    try {
      await expect(ensure(names, { image, environment: [] })).rejects.toThrow(
        "Workspace Computer storage unavailable",
      );
      await expect(
        docker.getContainer(names.container).inspect(),
      ).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await reset(names);
      // Also clean up any volumes made by a regressed implementation.
      for (const name of [names.profileVolume, names.workspaceVolume]) {
        await docker
          .getVolume(name)
          .remove()
          .catch(() => undefined);
      }
    }
  },
  25_000,
);

const storageRoot = process.env.WORKSPACE_STORAGE_TEST_ROOT;
const workspaceId = process.env.WORKSPACE_STORAGE_TEST_ID;
test.skipIf(!image || !storageRoot || !workspaceId)(
  "Docker enforces one ext4 capacity across profiles and workspace and erases stopped workspace content on closure",
  async () => {
    const target = namesFor("workspace", workspaceId);
    if (!target.ok || !image || !storageRoot)
      throw new Error("Missing workspace test configuration");
    const { names } = target;
    const options = {
      image,
      environment: ["COMPUTER_TOKEN=workspace-storage-test"],
      workspaceStorage: { root: storageRoot, bytes: 32 * 1024 * 1024 },
    };
    const shell = async (command: string) => {
      const exec = await docker.getContainer(names.container).exec({
        Cmd: ["sh", "-ec", command],
      });
      await exec.start({ Detach: true });
      let result = await exec.inspect();
      while (result.Running) {
        await Bun.sleep(25);
        result = await exec.inspect();
      }
      return result.ExitCode;
    };
    const { inspectWorkspaceStorage } = await import("../src/docker");
    try {
      await expect(
        ensure(names, {
          ...options,
          workspaceStorage: { ...options.workspaceStorage, bytes: 4096 },
        }),
      ).rejects.toThrow("Workspace Computer storage unavailable");
      const before = await inspectWorkspaceStorage(
        names,
        options.workspaceStorage,
        image,
      );
      await ensure(names, options);
      const original = await docker.getContainer(names.container).inspect();
      expect(original.HostConfig.ReadonlyRootfs).toBe(true);
      expect(
        await shell(
          "echo workspace > /workspace/retained; echo profile > /profiles/retained",
        ),
      ).toBe(0);
      expect(
        await shell("dd if=/dev/zero of=/profiles/fill bs=1M count=16"),
      ).toBe(0);
      expect(
        await shell("dd if=/dev/zero of=/workspace/fill bs=1M count=16"),
      ).not.toBe(0);
      const filled = await inspectWorkspaceStorage(
        names,
        options.workspaceStorage,
        image,
      );
      expect(filled.used).toBeGreaterThan(before.used + 16 * 1024 * 1024);
      expect(filled.used).toBeLessThanOrEqual(filled.capacity);
      await stop(names);
      expect(
        (await inspectWorkspaceStorage(names, options.workspaceStorage, image))
          .used,
      ).toBe(filled.used);
      await ensure(names, options);
      expect(
        (await docker.getContainer(names.container).inspect()).Id,
      ).not.toBe(original.Id);
      expect(
        await shell(
          'test "$(cat /workspace/retained)" = workspace; test "$(cat /profiles/retained)" = profile',
        ),
      ).toBe(0);
      await expect(
        eraseWorkspaceComputer(names, options.workspaceStorage, image),
      ).rejects.toThrow("Workspace Computer is not stopped and owned");
      await stop(names);
      await eraseWorkspaceComputer(names, options.workspaceStorage, image);
      await eraseWorkspaceComputer(names, options.workspaceStorage, image);
      await expect(
        docker.getContainer(names.container).inspect(),
      ).rejects.toMatchObject({ statusCode: 404 });
      await ensure(names, options);
      expect(
        await shell(
          'test -z "$(find /workspace /profiles -name retained -o -name fill)"',
        ),
      ).toBe(0);
    } finally {
      await reset(names);
    }
  },
  45_000,
);
