// server/tests/package-index-ops.test.ts
// PKG08（Issue #467，Spec §6/§10/§12 + #467 AC1/AC4/AC6）：部署侧发布与安全
// 撤回——索引契约、publish/withdraw 命令、锁/原子写与权限边界（native 套件）。
//
// 证据面：
//   (1) 索引契约：state 缺省=published 显式化；非词表 state、未知字段拒绝
//       （strict）；同版本异摘要拒绝（A01）。
//   (2) publish：制品先验证（缺失/身份不符拒绝）；同版本异摘要拒绝覆盖；
//       同摘要=元数据更新；回执机器可读；退出码。
//   (3) withdraw：仅改 state 元数据，行/摘要/listed/制品全保留（AC6，V1 无
//       自动 GC）；幂等；未知 release 拒绝；与 listed 正交。
//   (4) 锁与原子写：并发读改写不丢更新；陈旧锁破除；占用锁超时拒绝；临时
//       文件不留。
//   (5) 权限边界（AC1）：命令模块不导入任何 DB/HTTP/租户通道；包路由面无
//       publish/withdraw 路由（公司管理员无全局撤回入口）。
//   (6) CLI：spawn 真实命令，stdout/stderr 为可解析 JSON 回执。

import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { exportBuiltinPackage } from "../../scripts/plugin-packages/export-builtin";
import {
  acquireIndexLock,
  type IndexLockHandle,
  IndexOperationError,
  readMarketplaceIndex,
  withIndexLock,
  writeMarketplaceIndexAtomic,
} from "../../scripts/plugin-packages/index-file";
import {
  type PublishReceipt,
  publishMarketplaceRelease,
} from "../../scripts/plugin-packages/publish";
import {
  type WithdrawReceipt,
  withdrawMarketplaceRelease,
} from "../../scripts/plugin-packages/withdraw";
import {
  MarketplaceV1Schema,
  type PackageManifestV1,
} from "../../shared/enterprise/plugin-package-contracts";
import {
  afterEach,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { createMarketplaceGate } from "../src/enterprise/plugin-packages/marketplace-gate";
import { createPluginPackageRoutes } from "../src/enterprise/plugin-packages/routes";
import { buildArtifact, storeArtifact } from "../src/plugin-packages/artifact";
import { loadPackageCatalogue } from "../src/plugin-packages/catalogue";

const REPO_ROOT = resolve(import.meta.dir, "../..");

/** One source tree + verified artifact per packageKey@version. */
async function storeFixturePackage(
  artifactRoot: string,
  packageKey: string,
  version: string,
  /** Different content ⇒ different digest, same identity (the A01 pair). */
  variant = "",
): Promise<{ digest: string; manifest: PackageManifestV1 }> {
  const [publisher, name] = packageKey.split("/") as [string, string];
  const source = await mkdtemp(join(tmpdir(), "pkg08-source-"));
  const manifest: PackageManifestV1 = {
    schemaVersion: 1,
    platformApi: 1,
    publisher,
    name,
    version,
    display: {
      name: `PKG08 ${name}`,
      summary: `The PKG08 fixture package ${packageKey} ${version}.`,
    },
    resources: [
      { kind: "skill", id: "summarize", path: "skills/summarize/SKILL.md" },
    ],
    dependencies: [],
  };
  try {
    await writeFile(
      join(source, "openbot.plugin.json"),
      JSON.stringify(manifest),
    );
    const skillPath = join(source, "skills", "summarize", "SKILL.md");
    await mkdir(dirname(skillPath), { recursive: true });
    await writeFile(skillPath, `# summarize @ ${version}${variant}\n`);
    const artifact = await buildArtifact(source);
    await storeArtifact(artifact, artifactRoot);
    return { digest: artifact.digest, manifest };
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

async function expectIndexError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IndexOperationError);
  expect((caught as IndexOperationError).code).toBe(code);
}

describe("PKG08 marketplace index contract (state)", () => {
  test("an absent state parses as published; the default is explicit in the record", () => {
    const parsed = MarketplaceV1Schema.parse({
      schemaVersion: 1,
      packages: [
        {
          packageKey: "openbot/demo",
          version: "1.0.0",
          artifactDigest: "a".repeat(64),
          category: "productivity",
          listed: true,
        },
      ],
    });
    expect(parsed.packages[0]?.state).toBe("published");
  });

  test("a state outside the closed vocabulary is refused (strict)", () => {
    const result = MarketplaceV1Schema.safeParse({
      schemaVersion: 1,
      packages: [
        {
          packageKey: "openbot/demo",
          version: "1.0.0",
          artifactDigest: "a".repeat(64),
          category: "productivity",
          listed: true,
          state: "paused",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("an unknown index field is still refused (strict regression)", () => {
    const result = MarketplaceV1Schema.safeParse({
      schemaVersion: 1,
      packages: [
        {
          packageKey: "openbot/demo",
          version: "1.0.0",
          artifactDigest: "a".repeat(64),
          category: "productivity",
          listed: true,
          state: "published",
          withdrawnAt: "2026-10-25T00:00:00Z",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("A01: one release declared with two different digests refuses to load the catalogue", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkg08-artifacts-"));
    try {
      const { digest } = await storeFixturePackage(
        root,
        "openbot/demo",
        "1.0.0",
      );
      await expect(
        loadPackageCatalogue({
          artifactRoot: root,
          index: {
            schemaVersion: 1,
            packages: [
              {
                packageKey: "openbot/demo",
                version: "1.0.0",
                artifactDigest: digest,
                category: "productivity",
                listed: true,
              },
              {
                packageKey: "openbot/demo",
                version: "1.0.0",
                artifactDigest: "b".repeat(64),
                category: "productivity",
                listed: true,
              },
            ],
          },
        }),
      ).rejects.toThrow("two different digests");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PKG08 publish command", () => {
  let root = "";
  let indexPath = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function freshIndex(): Promise<void> {
    root = await mkdtemp(join(tmpdir(), "pkg08-publish-"));
    indexPath = join(root, "marketplace.json");
    await writeFile(
      indexPath,
      `${JSON.stringify({ schemaVersion: 1, packages: [] }, null, 2)}\n`,
    );
  }

  test("registers a verified release with a machine-readable receipt", async () => {
    await freshIndex();
    const { digest } = await storeFixturePackage(root, "openbot/demo", "1.0.0");
    const receipt: PublishReceipt = await publishMarketplaceRelease({
      indexPath,
      artifactRoot: root,
      packageKey: "openbot/demo",
      version: "1.0.0",
      artifactDigest: digest,
      category: "productivity",
    });
    expect(receipt).toMatchObject({
      ok: true,
      action: "registered",
      packageKey: "openbot/demo",
      version: "1.0.0",
      artifactDigest: digest,
      listed: true,
      state: "published",
      artifactsGc: "none",
    });
    expect(receipt.indexDigest).toMatch(/^[0-9a-f]{64}$/);
    const index = await readMarketplaceIndex(indexPath);
    expect(index.packages).toHaveLength(1);
    expect(index.packages[0]).toMatchObject({
      state: "published",
      listed: true,
    });
  });

  test("re-registering the same digest is a metadata update, and listed is orthogonal to state", async () => {
    await freshIndex();
    const { digest } = await storeFixturePackage(root, "openbot/demo", "1.0.0");
    await publishMarketplaceRelease({
      indexPath,
      artifactRoot: root,
      packageKey: "openbot/demo",
      version: "1.0.0",
      artifactDigest: digest,
      category: "productivity",
    });
    // 下架（listed=false）：只影响发现，state 保持 published。
    const receipt = await publishMarketplaceRelease({
      indexPath,
      artifactRoot: root,
      packageKey: "openbot/demo",
      version: "1.0.0",
      artifactDigest: digest,
      category: "productivity",
      listed: false,
    });
    expect(receipt.action).toBe("updated");
    const index = await readMarketplaceIndex(indexPath);
    expect(index.packages[0]).toMatchObject({
      listed: false,
      state: "published",
    });
    expect(index.packages).toHaveLength(1);
  });

  test("OCR-fix-C (R2-H1): an omitted --state/--listed re-publish inherits the recorded values; explicit --state revives", async () => {
    await freshIndex();
    const { digest } = await storeFixturePackage(root, "openbot/demo", "1.0.0");
    const cliPublish = (extra: string[]) => {
      const proc = Bun.spawn(
        [
          "bun",
          join(REPO_ROOT, "scripts/plugin-packages/publish.ts"),
          "--index",
          indexPath,
          "--artifact-root",
          root,
          "--package",
          "openbot/demo",
          "--version",
          "1.0.0",
          "--digest",
          digest,
          "--category",
          "productivity",
          ...extra,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      return (async () => {
        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        return {
          exitCode,
          receipt:
            exitCode === 0 ? (JSON.parse(stdout) as PublishReceipt) : null,
          stderr: exitCode === 0 ? "" : stdout,
        };
      })();
    };
    // 下架（listed=false）后撤回：state=withdrawn、listed=false。
    const unlist = await cliPublish(["--listed", "false"]);
    expect(unlist.exitCode).toBe(0);
    await withdrawMarketplaceRelease({
      indexPath,
      packageKey: "openbot/demo",
      version: "1.0.0",
    });
    // ① 省参重跑 publish：§10 撤回闸门——不复活 withdrawn/unlisted。
    const bare = await cliPublish([]);
    expect(bare.exitCode).toBe(0);
    expect(bare.receipt).toMatchObject({
      action: "updated",
      state: "withdrawn",
      listed: false,
    });
    expect(await readMarketplaceIndex(indexPath)).toMatchObject({
      packages: [
        expect.objectContaining({ state: "withdrawn", listed: false }),
      ],
    });
    // ② 显式 --state published：复活是显式意图，不受继承限制。
    const revived = await cliPublish(["--state", "published"]);
    expect(revived.exitCode).toBe(0);
    expect(revived.receipt).toMatchObject({
      action: "updated",
      state: "published",
      listed: false,
    });
    // ③ 新包注册省参仍是 published/true（默认只属于首次注册）。
    const { digest: otherDigest } = await storeFixturePackage(
      root,
      "openbot/other",
      "1.0.0",
    );
    const proc = Bun.spawn(
      [
        "bun",
        join(REPO_ROOT, "scripts/plugin-packages/publish.ts"),
        "--index",
        indexPath,
        "--artifact-root",
        root,
        "--package",
        "openbot/other",
        "--version",
        "1.0.0",
        "--digest",
        otherDigest,
        "--category",
        "productivity",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const freshExit = await proc.exited;
    const freshReceipt = JSON.parse(
      await new Response(proc.stdout).text(),
    ) as PublishReceipt;
    expect(freshExit).toBe(0);
    expect(freshReceipt).toMatchObject({
      action: "registered",
      state: "published",
      listed: true,
    });
  });

  test("a different digest for the same version is refused and leaves the index untouched (A01)", async () => {
    await freshIndex();
    const { digest } = await storeFixturePackage(root, "openbot/demo", "1.0.0");
    await publishMarketplaceRelease({
      indexPath,
      artifactRoot: root,
      packageKey: "openbot/demo",
      version: "1.0.0",
      artifactDigest: digest,
      category: "productivity",
    });
    // Same package@version, different bytes: the classic same-version
    // different-digest attack, not an identity mismatch.
    const { digest: other } = await storeFixturePackage(
      root,
      "openbot/demo",
      "1.0.0",
      " (revised)",
    );
    await expectIndexError(
      publishMarketplaceRelease({
        indexPath,
        artifactRoot: root,
        packageKey: "openbot/demo",
        version: "1.0.0",
        artifactDigest: other,
        category: "productivity",
      }),
      "PACKAGE_DIGEST_CONFLICT",
    );
    const index = await readMarketplaceIndex(indexPath);
    expect(index.packages[0]?.artifactDigest).toBe(digest);
  });

  test("an absent artifact is a typed refusal, never a silent registration", async () => {
    await freshIndex();
    await expectIndexError(
      publishMarketplaceRelease({
        indexPath,
        artifactRoot: root,
        packageKey: "openbot/demo",
        version: "1.0.0",
        artifactDigest: "c".repeat(64),
        category: "productivity",
      }),
      "ARTIFACT_MISSING",
    );
    const index = await readMarketplaceIndex(indexPath);
    expect(index.packages).toHaveLength(0);
  });

  test("an artifact claiming another identity is refused", async () => {
    await freshIndex();
    const { digest } = await storeFixturePackage(root, "openbot/demo", "1.0.0");
    await expectIndexError(
      publishMarketplaceRelease({
        indexPath,
        artifactRoot: root,
        packageKey: "openbot/other",
        version: "1.0.0",
        artifactDigest: digest,
        category: "productivity",
      }),
      "ARTIFACT_IDENTITY_MISMATCH",
    );
  });
});

describe("PKG08 withdraw command", () => {
  let root = "";
  let indexPath = "";
  let digest = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function registeredFixture(): Promise<void> {
    root = await mkdtemp(join(tmpdir(), "pkg08-withdraw-"));
    indexPath = join(root, "marketplace.json");
    await writeFile(
      indexPath,
      `${JSON.stringify({ schemaVersion: 1, packages: [] }, null, 2)}\n`,
    );
    const stored = await storeFixturePackage(root, "openbot/demo", "1.0.0");
    digest = stored.digest;
    await publishMarketplaceRelease({
      indexPath,
      artifactRoot: root,
      packageKey: "openbot/demo",
      version: "1.0.0",
      artifactDigest: digest,
      category: "productivity",
      listed: false,
    });
  }

  test("withdraws by flipping state only: the row, digest, listed flag and artifact bytes all stay (AC6)", async () => {
    await registeredFixture();
    const receipt: WithdrawReceipt = await withdrawMarketplaceRelease({
      indexPath,
      packageKey: "openbot/demo",
      version: "1.0.0",
    });
    expect(receipt).toMatchObject({
      ok: true,
      action: "withdrawn",
      packageKey: "openbot/demo",
      version: "1.0.0",
      artifactDigest: digest,
      listed: false,
      state: "withdrawn",
      artifactsGc: "none",
    });
    const index = await readMarketplaceIndex(indexPath);
    expect(index.packages).toHaveLength(1);
    expect(index.packages[0]).toMatchObject({
      artifactDigest: digest,
      listed: false,
      state: "withdrawn",
    });
    // V1 无自动 GC：撤回只改元数据，制品字节原样保留。
    const artifactDir = await stat(join(root, "sha256", digest));
    expect(artifactDir.isDirectory()).toBe(true);
  });

  test("withdrawing an already-withdrawn release is the idempotent no-op", async () => {
    await registeredFixture();
    await withdrawMarketplaceRelease({
      indexPath,
      packageKey: "openbot/demo",
      version: "1.0.0",
    });
    const receipt = await withdrawMarketplaceRelease({
      indexPath,
      packageKey: "openbot/demo",
      version: "1.0.0",
    });
    expect(receipt.action).toBe("already-withdrawn");
    const index = await readMarketplaceIndex(indexPath);
    expect(index.packages).toHaveLength(1);
  });

  test("an unknown release is a typed refusal", async () => {
    await registeredFixture();
    await expectIndexError(
      withdrawMarketplaceRelease({
        indexPath,
        packageKey: "openbot/demo",
        version: "2.0.0",
      }),
      "PACKAGE_RELEASE_NOT_FOUND",
    );
  });

  test("CLI receipts are machine-readable JSON on stdout with exit codes (listed vs withdrawn demo)", async () => {
    await registeredFixture();
    // CLI 差异演示的一半：unlist（listed=false）保持 state=published。
    const unlist = Bun.spawn(
      [
        "bun",
        join(REPO_ROOT, "scripts/plugin-packages/publish.ts"),
        "--index",
        indexPath,
        "--artifact-root",
        root,
        "--package",
        "openbot/demo",
        "--version",
        "1.0.0",
        "--digest",
        digest,
        "--category",
        "productivity",
        "--listed",
        "false",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const unlistExit = await unlist.exited;
    const unlistReceipt = JSON.parse(
      await new Response(unlist.stdout).text(),
    ) as PublishReceipt;
    expect(unlistExit).toBe(0);
    expect(unlistReceipt).toMatchObject({
      ok: true,
      listed: false,
      state: "published",
    });

    // 另一半：withdraw 后 state=withdrawn 而 listed 保持 false（正交）。
    const proc = Bun.spawn(
      [
        "bun",
        join(REPO_ROOT, "scripts/plugin-packages/withdraw.ts"),
        "--index",
        indexPath,
        "--package",
        "openbot/demo",
        "--version",
        "1.0.0",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    const receipt = JSON.parse(
      await new Response(proc.stdout).text(),
    ) as WithdrawReceipt;
    expect(exitCode).toBe(0);
    expect(receipt).toMatchObject({
      ok: true,
      state: "withdrawn",
      listed: false,
    });

    // 失败路径同样是 JSON（stderr）+ 非零退出码。
    const failure = Bun.spawn(
      [
        "bun",
        join(REPO_ROOT, "scripts/plugin-packages/withdraw.ts"),
        "--index",
        indexPath,
        "--package",
        "openbot/demo",
        "--version",
        "3.0.0",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const failureExit = await failure.exited;
    const failureReceipt = JSON.parse(
      await new Response(failure.stderr).text(),
    ) as { ok: boolean; error: string };
    expect(failureExit).toBe(1);
    expect(failureReceipt).toMatchObject({
      ok: false,
      error: "PACKAGE_RELEASE_NOT_FOUND",
    });
  });
});

describe("PKG08 index lock and atomic replace", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("concurrent publish and withdraw both land: no lost update", async () => {
    root = await mkdtemp(join(tmpdir(), "pkg08-lock-"));
    const indexPath = join(root, "marketplace.json");
    await writeFile(
      indexPath,
      `${JSON.stringify({ schemaVersion: 1, packages: [] }, null, 2)}\n`,
    );
    const alpha = await storeFixturePackage(root, "openbot/alpha", "1.0.0");
    const beta = await storeFixturePackage(root, "openbot/beta", "1.0.0");
    await publishMarketplaceRelease({
      indexPath,
      artifactRoot: root,
      packageKey: "openbot/beta",
      version: "1.0.0",
      artifactDigest: beta.digest,
      category: "productivity",
    });
    const [published, withdrawn] = await Promise.all([
      publishMarketplaceRelease({
        indexPath,
        artifactRoot: root,
        packageKey: "openbot/alpha",
        version: "1.0.0",
        artifactDigest: alpha.digest,
        category: "productivity",
      }),
      withdrawMarketplaceRelease({
        indexPath,
        packageKey: "openbot/beta",
        version: "1.0.0",
      }),
    ]);
    expect(published.ok).toBe(true);
    expect(withdrawn.ok).toBe(true);
    const index = await readMarketplaceIndex(indexPath);
    // Both mutations survived the race: registration AND withdrawal.
    expect(index.packages).toHaveLength(2);
    expect(
      index.packages.find((entry) => entry.packageKey === "openbot/alpha")
        ?.state,
    ).toBe("published");
    expect(
      index.packages.find((entry) => entry.packageKey === "openbot/beta")
        ?.state,
    ).toBe("withdrawn");
    // 原子替换不留临时文件，也不留锁目录。
    const files: string[] = [];
    for await (const entry of await import("node:fs/promises").then((fs) =>
      fs.readdir(root),
    )) {
      files.push(entry);
    }
    expect(files.filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(files.includes("marketplace.json.lock")).toBe(false);
  });

  test("a held lock times out with a typed refusal; a stale lock is broken", async () => {
    root = await mkdtemp(join(tmpdir(), "pkg08-stale-"));
    const indexPath = join(root, "marketplace.json");
    await writeFile(
      indexPath,
      `${JSON.stringify({ schemaVersion: 1, packages: [] }, null, 2)}\n`,
    );
    // 陈旧锁：mtime 远早于阈值 → 破除后正常执行。
    const staleLock = `${indexPath}.lock`;
    await mkdir(staleLock);
    const ancient = new Date(Date.now() - 60_000);
    await utimes(staleLock, ancient, ancient);
    const result = await withIndexLock(indexPath, async () => "ran", {
      timeoutMs: 2_000,
      staleMs: 30_000,
    });
    expect(result).toBe("ran");
    // 被占用的新锁：短超时内拒绝。
    await mkdir(staleLock);
    await expectIndexError(
      withIndexLock(indexPath, async () => "never", {
        timeoutMs: 150,
        staleMs: 30_000,
      }),
      "PACKAGE_INDEX_LOCKED",
    );
    await rm(staleLock, { recursive: true, force: true });
  });

  // —— OCR-fix-B (B1)：共享 release 锁的心跳与破锁 TOCTOU（dispatch 持锁跨
  // DB 事务+制品读取后，无心跳的长持锁会被他进程当崩溃残留破除）。 ——

  /** A REAL second process holding the lock (the dispatch-side shape). */
  async function spawnHolder(input: {
    readonly indexPath: string;
    readonly staleMs: number;
    readonly holdMs: number | null;
    readonly heldMarker: string;
    readonly doneMarker: string | null;
  }): Promise<Bun.Subprocess> {
    const script = `
      const { acquireIndexLock } = await import(${JSON.stringify(
        pathToFileURL(join(REPO_ROOT, "scripts/plugin-packages/index-file.ts"))
          .href,
      )});
      const { writeFile } = await import("node:fs/promises");
      const lock = await acquireIndexLock(${JSON.stringify(input.indexPath)}, {
        staleMs: ${input.staleMs},
      });
      await writeFile(${JSON.stringify(input.heldMarker)}, "1");
      await new Promise((resolve) => setTimeout(resolve, ${input.holdMs ?? 0}));
      ${
        input.doneMarker
          ? `await writeFile(${JSON.stringify(input.doneMarker)}, "1");`
          : ""
      }
      ${
        input.holdMs === null
          ? `await new Promise(() => {});` // park forever — the "crash" is kill -9
          : `await lock.release();`
      }
    `;
    return Bun.spawn(["bun", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  async function waitForMarker(path: string): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      if (
        await stat(path).then(
          () => true,
          () => false,
        )
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`PKG08_TEST_MARKER_TIMEOUT ${path}`);
  }

  test("OCR-fix-B1: a holder past staleMs with a live heartbeat is never broken by another process", async () => {
    root = await mkdtemp(join(tmpdir(), "pkg08-hb-"));
    const indexPath = join(root, "marketplace.json");
    await writeFile(
      indexPath,
      `${JSON.stringify({ schemaVersion: 1, packages: [] }, null, 2)}\n`,
    );
    const heldMarker = join(root, "held");
    const doneMarker = join(root, "done");
    // The holder keeps the lock for 1200ms against a 500ms stale window —
    // only the heartbeat keeps it unbreakable.
    const proc = await spawnHolder({
      indexPath,
      staleMs: 500,
      holdMs: 1_200,
      heldMarker,
      doneMarker,
    });
    await waitForMarker(heldMarker);
    // The competing acquire waits the full timeout and refuses: it never
    // broke the live (heartbeating) lock even though the hold outlasts
    // staleMs.
    await expectIndexError(
      acquireIndexLock(indexPath, { staleMs: 500, timeoutMs: 700 }),
      "PACKAGE_INDEX_LOCKED",
    );
    // The holder's critical section completed and released cleanly.
    await waitForMarker(doneMarker);
    expect(await proc.exited).toBe(0);
    // And the lock is genuinely free afterwards.
    const handle = await acquireIndexLock(indexPath, { staleMs: 500 });
    await handle.release();
    expect(
      await stat(`${indexPath}.lock`).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("OCR-fix-B1: a real crash (kill -9, heartbeat silenced) is breakable after staleMs", async () => {
    root = await mkdtemp(join(tmpdir(), "pkg08-crash-"));
    const indexPath = join(root, "marketplace.json");
    await writeFile(
      indexPath,
      `${JSON.stringify({ schemaVersion: 1, packages: [] }, null, 2)}\n`,
    );
    const heldMarker = join(root, "held");
    const proc = await spawnHolder({
      indexPath,
      staleMs: 700,
      holdMs: null,
      heldMarker,
      doneMarker: null,
    });
    await waitForMarker(heldMarker);
    proc.kill(9);
    expect(await proc.exited).not.toBe(0);
    // With the holder gone the lock ages past staleMs and the survivor
    // breaks it and proceeds.
    const handle = await acquireIndexLock(indexPath, {
      staleMs: 700,
      timeoutMs: 4_000,
    });
    await handle.release();
  });

  test("OCR-fix-B1: a lock recreated between the stale judgement and the break is not deleted (TOCTOU)", async () => {
    root = await mkdtemp(join(tmpdir(), "pkg08-toctou-"));
    const indexPath = join(root, "marketplace.json");
    await writeFile(
      indexPath,
      `${JSON.stringify({ schemaVersion: 1, packages: [] }, null, 2)}\n`,
    );
    const lockDir = `${indexPath}.lock`;
    // A live holder whose heartbeat interval is far longer than the test —
    // then age its directory so a short-staleMs breaker judges it crashed.
    const old = await acquireIndexLock(indexPath, { staleMs: 60_000 });
    const ancient = new Date(Date.now() - 60_000);
    await utimes(lockDir, ancient, ancient);
    let successor: IndexLockHandle | null = null;
    let hooked = false;
    // The breaker judges stale, then — inside the break window — the old
    // holder releases and a NEW process creates a fresh lock. The breaker
    // must refuse to delete the newcomer and keep waiting instead. (The
    // successor's own heartbeat keeps it fresh under the same staleMs, so
    // the hook runs exactly once.)
    const breaker = acquireIndexLock(indexPath, {
      staleMs: 500,
      timeoutMs: 900,
      onStaleLockDetected: async () => {
        if (hooked) return;
        hooked = true;
        await old.release();
        successor = await acquireIndexLock(indexPath, { staleMs: 500 });
      },
    });
    await expectIndexError(breaker, "PACKAGE_INDEX_LOCKED");
    // The successor's lock survived the breaker's judgement and releases
    // cleanly.
    expect(successor).not.toBeNull();
    await successor?.release();
    expect(
      await stat(lockDir).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
});

describe("PKG08 permission boundary (AC1)", () => {
  test("the management commands import no database, HTTP or tenancy channel", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const name of ["publish.ts", "withdraw.ts", "index-file.ts"]) {
      const source = await readFile(
        join(REPO_ROOT, "scripts/plugin-packages", name),
        "utf8",
      );
      const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
      for (const specifier of imports) {
        const forbidden =
          /db\/client|enterprise\/tenancy|plugin-catalog|tool-invocation|workspace-admin|hono|index\.ts$|drizzle/;
        expect(`${name}: ${specifier}`).not.toMatch(forbidden);
      }
    }
  });

  test("the company HTTP surface exposes no publish or withdraw route", async () => {
    const routes = createPluginPackageRoutes({
      gate: createMarketplaceGate({
        enabled: true,
        pilotWorkspaces: [{ tenantId: "tenant-1", workspaceId: "workspace-1" }],
      }),
      catalogue: null,
      resolveScope: async () => {
        throw new Error("PKG08_TEST_SCOPE_UNRESOLVED");
      },
    });
    const table = routes.routes.map(
      (route: { method: string; path: string }) =>
        `${route.method} ${route.path}`,
    );
    expect(table.length).toBeGreaterThan(0);
    for (const line of table) {
      // Segment-aware: ":publisher" is a parameter name, not a /publish route.
      expect(line).not.toMatch(/\/(publish|withdraw)(\/|$)/i);
    }
    // The documented surface is exactly the read/install/grant/lifecycle set.
    expect(table).toEqual(
      expect.arrayContaining([
        "GET /",
        "GET /catalogue/:publisher/:name",
        "GET /installs/:id",
        "POST /plans",
        "POST /plans/:id/apply",
        "PUT /installs/:id/bots/:botId/grants",
        "DELETE /installs/:id/bots/:botId/grants",
        "POST /installs/:id/experts/:resourceId",
        "PATCH /installs/:id/status",
      ]),
    );
  });
});

describe("PKG11 builtin export respects lifecycle state (OCR-fix-A3)", () => {
  let root = "";
  let indexPath = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  /** A throwaway repo root: plugins/marketplace.json + artifact tree. */
  async function freshRepo(): Promise<void> {
    root = await mkdtemp(join(tmpdir(), "pkg11-export-"));
    await mkdir(join(root, "plugins"), { recursive: true });
    indexPath = join(root, "plugins/marketplace.json");
    await writeFile(
      indexPath,
      `${JSON.stringify({ schemaVersion: 1, packages: [] }, null, 2)}\n`,
    );
  }

  test("a re-export over a withdrawn release keeps the withdrawal; a new version registers published", async () => {
    await freshRepo();
    const first = await exportBuiltinPackage({
      repoRoot: root,
      version: "1.0.0",
    });
    expect(first.indexAction).toBe("registered");
    // The withdrawal is PKG08's gate decision; a deterministic re-export of
    // the same catalogue must not resurrect what it retired.
    await withdrawMarketplaceRelease({
      indexPath,
      packageKey: first.packageKey,
      version: "1.0.0",
    });
    const rerun = await exportBuiltinPackage({
      repoRoot: root,
      version: "1.0.0",
    });
    expect(rerun.indexAction).toBe("metadata-noop");
    expect(rerun.artifactDigest).toBe(first.artifactDigest);
    let index = await readMarketplaceIndex(indexPath);
    expect(index.packages).toHaveLength(1);
    expect(index.packages[0]).toMatchObject({
      version: "1.0.0",
      artifactDigest: first.artifactDigest,
      state: "withdrawn",
    });
    // A bumped version registers normally: the export still publishes new
    // releases; it never reaches into the lifecycle of existing ones.
    const next = await exportBuiltinPackage({
      repoRoot: root,
      version: "1.1.0",
    });
    expect(next.indexAction).toBe("registered");
    index = await readMarketplaceIndex(indexPath);
    expect(index.packages).toHaveLength(2);
    const byVersion = new Map(
      index.packages.map((entry) => [entry.version, entry] as const),
    );
    expect(byVersion.get("1.0.0")).toMatchObject({ state: "withdrawn" });
    expect(byVersion.get("1.1.0")).toMatchObject({
      state: "published",
      listed: true,
    });
  });

  test("an unlisted release keeps its visibility: listing is a discovery decision, not the export's", async () => {
    await freshRepo();
    await exportBuiltinPackage({ repoRoot: root, version: "1.0.0" });
    // An operator unlists the release (discovery-only, PKG08's listed axis).
    const index = await readMarketplaceIndex(indexPath);
    index.packages[0]!.listed = false;
    await writeMarketplaceIndexAtomic(indexPath, index);
    await exportBuiltinPackage({ repoRoot: root, version: "1.0.0" });
    const after = await readMarketplaceIndex(indexPath);
    expect(after.packages).toHaveLength(1);
    expect(after.packages[0]).toMatchObject({
      state: "published",
      listed: false,
    });
  });
});
