import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCraftConfig } from "../src/craft/config";
import type { SandboxGateway } from "../src/craft/sandbox-gateway";
import {
  deleteSnapshots,
  restoreLatestSnapshot,
  snapshotStoragePath,
  startCraftIdleReaper,
  takeSnapshot,
} from "../src/craft/snapshot";
import {
  createObjectStore,
  type ObjectStore,
} from "../src/craft/storage/object-store";
import type {
  CraftSessionRow,
  CraftSnapshotRow,
  CraftStore,
} from "../src/craft/store";

// SandboxGateway and CraftStore are wide interfaces; the snapshot pipeline touches a few
// methods each, so the tests pin those and cast the rest away.
const fakeGateway = (overrides: Partial<SandboxGateway> = {}): SandboxGateway =>
  overrides as unknown as SandboxGateway;

const fakeStore = (overrides: Partial<CraftStore> = {}): CraftStore =>
  overrides as unknown as CraftStore;

type MemStore = ObjectStore & { values: Map<string, Uint8Array> };
function memStore(): MemStore {
  const values = new Map<string, Uint8Array>();
  return {
    values,
    async put(key, bytes) {
      values.set(key, bytes);
    },
    async get(key) {
      return values.get(key) ?? null;
    },
    async has(key) {
      return values.has(key);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

const config = loadCraftConfig({});
const bytes = new TextEncoder().encode("archive-bytes");

function snapshotRow(
  overrides: Partial<CraftSnapshotRow> = {},
): CraftSnapshotRow {
  return {
    id: "csn-1",
    sessionId: "cs-sess",
    storagePath: "sandbox-snapshots/craft/csn-1.tar.gz",
    sizeBytes: bytes.byteLength,
    createdAt: new Date(),
    ...overrides,
  };
}

function sessionRow(overrides: Partial<CraftSessionRow> = {}): CraftSessionRow {
  return {
    id: "cs-sess",
    userId: "u1",
    name: null,
    status: "active",
    lastActivityAt: new Date(),
    createdAt: new Date(),
    nextjsPort: null,
    sharingScope: "private",
    origin: "INTERACTIVE",
    opencodeSessionId: null,
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
    ...overrides,
  };
}

describe("local object store", () => {
  let dir: string;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("put/get/has/delete round-trips under the root", async () => {
    dir = await mkdtemp(join(tmpdir(), "craft-store-"));
    const store = createObjectStore({
      backend: "local",
      localDirectory: dir,
      s3Endpoint: "",
      s3Region: "",
      s3Bucket: "",
      s3AccessKeyId: "",
      s3SecretAccessKey: "",
      s3ForcePathStyle: true,
    });

    await store.put("sandbox-snapshots/craft/csn-1.tar.gz", bytes);
    expect(await store.has("sandbox-snapshots/craft/csn-1.tar.gz")).toBe(true);
    expect(await store.get("sandbox-snapshots/craft/csn-1.tar.gz")).toEqual(
      bytes,
    );
    await store.delete("sandbox-snapshots/craft/csn-1.tar.gz");
    expect(await store.has("sandbox-snapshots/craft/csn-1.tar.gz")).toBe(false);
    expect(await store.get("sandbox-snapshots/craft/csn-1.tar.gz")).toBeNull();
  });

  test("a key may not escape the root", async () => {
    dir = await mkdtemp(join(tmpdir(), "craft-store-"));
    const store = createObjectStore({
      backend: "local",
      localDirectory: dir,
      s3Endpoint: "",
      s3Region: "",
      s3Bucket: "",
      s3AccessKeyId: "",
      s3SecretAccessKey: "",
      s3ForcePathStyle: true,
    });
    await expect(store.put("../escape.tar.gz", bytes)).rejects.toThrow();
    await expect(store.put("/etc/passwd", bytes)).rejects.toThrow();
  });
});

describe("snapshotStoragePath", () => {
  test("anchors the archive under the bot key", () => {
    expect(snapshotStoragePath("craft", "csn-1")).toBe(
      "sandbox-snapshots/craft/csn-1.tar.gz",
    );
  });
});

describe("takeSnapshot", () => {
  test("persists the archive and records a row with a non-empty storage path", async () => {
    const objectStore = memStore();
    const store = fakeStore({
      createSnapshot: async (input) =>
        snapshotRow({
          id: "csn-2",
          sessionId: input.sessionId,
          storagePath: input.storagePath,
          sizeBytes: input.sizeBytes,
        }),
    });
    const gateway = fakeGateway({ snapshotArchiveFor: async () => bytes });

    const row = await takeSnapshot(
      { config, store, gateway, objectStore },
      { botId: "craft", sessionId: "cs-sess" },
    );

    expect(row.storagePath).not.toBe("");
    expect(objectStore.values.get(row.storagePath)).toEqual(bytes);
    expect(row.sizeBytes).toBe(bytes.byteLength);
  });

  test("throws when the sandbox produced no archive", async () => {
    const gateway = fakeGateway({ snapshotArchiveFor: async () => null });
    await expect(
      takeSnapshot(
        { config, store: fakeStore(), gateway, objectStore: memStore() },
        { botId: "craft", sessionId: "cs-sess" },
      ),
    ).rejects.toThrow();
  });
});

describe("restoreLatestSnapshot", () => {
  const ctx = (overrides: {
    store?: Partial<CraftStore>;
    gateway?: Partial<SandboxGateway>;
    objectStore?: MemStore;
  }) => {
    const objectStore = overrides.objectStore ?? memStore();
    return {
      config,
      store: fakeStore(overrides.store),
      gateway: fakeGateway(overrides.gateway),
      objectStore,
    };
  };

  test("replays the newest snapshot and returns true", async () => {
    const objectStore = memStore();
    await objectStore.put(snapshotRow().storagePath, bytes);
    const c = ctx({
      store: { getLatestSnapshot: async () => snapshotRow() },
      gateway: { restoreWorkspace: async () => true },
      objectStore,
    });
    expect(
      await restoreLatestSnapshot(c, { botId: "craft", sessionId: "cs-sess" }),
    ).toBe(true);
  });

  test("returns false when there is no snapshot row", async () => {
    const c = ctx({ store: { getLatestSnapshot: async () => undefined } });
    expect(
      await restoreLatestSnapshot(c, { botId: "craft", sessionId: "cs-sess" }),
    ).toBe(false);
  });

  test("returns false when the blob was evicted", async () => {
    const c = ctx({ store: { getLatestSnapshot: async () => snapshotRow() } });
    expect(
      await restoreLatestSnapshot(c, { botId: "craft", sessionId: "cs-sess" }),
    ).toBe(false);
  });
});

describe("deleteSnapshots", () => {
  test("frees each row's blob and the rows", async () => {
    const objectStore = memStore();
    const a = snapshotRow({
      id: "csn-a",
      storagePath: "sandbox-snapshots/craft/a.tar.gz",
    });
    const b = snapshotRow({
      id: "csn-b",
      storagePath: "sandbox-snapshots/craft/b.tar.gz",
    });
    await objectStore.put(a.storagePath, bytes);
    await objectStore.put(b.storagePath, bytes);
    const store = fakeStore({ deleteSnapshots: async () => [a, b] });

    await deleteSnapshots(
      { config, store, gateway: fakeGateway(), objectStore },
      "cs-sess",
    );

    expect(objectStore.values.size).toBe(0);
  });
});

describe("idle reaper", () => {
  test("snapshots an idle session and flips it idle through the guarded CAS", async () => {
    const objectStore = memStore();
    const flips: Array<{ sessionId: string; before: Date }> = [];
    const store = fakeStore({
      listIdleSessions: async () => [sessionRow()],
      createSnapshot: async (input) =>
        snapshotRow({
          sessionId: input.sessionId,
          storagePath: input.storagePath,
        }),
      markSessionIdleIfStillIdle: async (sessionId, before) => {
        flips.push({ sessionId, before });
        return true;
      },
    });
    const gateway = fakeGateway({ snapshotArchiveFor: async () => bytes });

    const reaper = startCraftIdleReaper(
      { config, store, gateway, objectStore },
      { botIdFor: async () => "craft" },
    );
    const slept = await reaper.sweepOnce();
    reaper.stop();

    expect(slept).toBe(1);
    expect(flips).toHaveLength(1);
    expect(flips[0]?.sessionId).toBe("cs-sess");
    expect(objectStore.values.size).toBe(1);
  });
});
