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
import {
  IndexOperationError,
  readMarketplaceIndex,
  withIndexLock,
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
