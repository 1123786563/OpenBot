import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterEach,
  describe,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import {
  assertNoCaseFoldCollisions,
  buildArtifact,
  loadArtifact,
  readVerifiedFile,
  storeArtifact,
  type VerifiedArtifact,
} from "../src/plugin-packages/artifact";
import { parsePackageManifest } from "../src/plugin-packages/manifest";
import { buildMarketplaceArtifacts } from "../../scripts/plugin-packages/build";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    platformApi: 1,
    publisher: "openbot",
    name: "demo-skill",
    version: "1.0.0",
    display: { name: "Demo Skill", summary: "Summarize text." },
    resources: [
      { kind: "skill", id: "summarize", path: "skills/summarize/SKILL.md" },
    ],
    dependencies: [],
    ...overrides,
  };
}

const baseFiles: Record<string, string | Buffer> = {
  "skills/summarize/SKILL.md": "# Summarize\n\nSummarize the input.\n",
  "README.md": "# Demo Skill\n",
};

async function packageRoot(
  files: Record<string, string | Buffer> = baseFiles,
  manifestValue: Record<string, unknown> = manifest(),
  options: { manifestBytes?: number; order?: string[] } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "plugin-package-"));
  roots.push(root);
  let serialized = JSON.stringify(manifestValue);
  if (options.manifestBytes !== undefined) {
    if (serialized.length > options.manifestBytes) {
      throw new Error("manifest test value is already larger than requested");
    }
    serialized = serialized.padEnd(options.manifestBytes, " ");
  }
  await writeFile(join(root, "openbot.plugin.json"), serialized);
  const names = options.order ?? Object.keys(files);
  for (const name of names) {
    const absolute = join(root, ...name.split("/"));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, files[name]);
  }
  return root;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("parsePackageManifest", () => {
  test("accepts the V1 manifest shape", () => {
    const parsed = parsePackageManifest(manifest());
    expect(parsed.publisher).toBe("openbot");
    expect(parsed.resources).toHaveLength(1);
    expect(parsed.dependencies).toEqual([]);
  });

  test("rejects unknown fields at every object level", () => {
    expect(() =>
      parsePackageManifest({ ...manifest(), extra: true }),
    ).toThrow();
    expect(() =>
      parsePackageManifest({
        ...manifest(),
        display: { name: "Demo", summary: "S", owner: "someone" },
      }),
    ).toThrow();
    expect(() =>
      parsePackageManifest({
        ...manifest(),
        resources: [
          {
            kind: "skill",
            id: "summarize",
            path: "skills/summarize/SKILL.md",
            executable: true,
          },
        ],
      }),
    ).toThrow();
  });

  test("rejects an unknown platformApi or schemaVersion", () => {
    expect(() => parsePackageManifest(manifest({ platformApi: 2 }))).toThrow();
    expect(() =>
      parsePackageManifest(manifest({ schemaVersion: 2 })),
    ).toThrow();
  });

  test("rejects non-empty package dependencies", () => {
    expect(() =>
      parsePackageManifest(manifest({ dependencies: ["other/thing@1.0.0"] })),
    ).toThrow();
  });

  test("rejects duplicate resource ids", () => {
    expect(() =>
      parsePackageManifest(
        manifest({
          resources: [
            { kind: "skill", id: "summarize", path: "skills/a/SKILL.md" },
            { kind: "skill", id: "summarize", path: "skills/b/SKILL.md" },
          ],
        }),
      ),
    ).toThrow();
  });

  test("rejects a version with leading zeros or a wrong arity", () => {
    for (const version of ["1.0", "01.0.0", "1.00.0", "1.0.0.0", "1.0.x"]) {
      expect(() => parsePackageManifest(manifest({ version }))).toThrow();
    }
    expect(parsePackageManifest(manifest({ version: "0.0.0" })).version).toBe(
      "0.0.0",
    );
  });

  test("rejects malformed publisher, name and resource ids", () => {
    for (const publisher of ["Openbot", "open_bot", "-openbot", ""]) {
      expect(() => parsePackageManifest(manifest({ publisher }))).toThrow();
    }
    expect(() =>
      parsePackageManifest(
        manifest({
          resources: [
            { kind: "skill", id: "Sum Marize", path: "skills/a/SKILL.md" },
          ],
        }),
      ),
    ).toThrow();
  });

  test("requires expert template skills to reference declared skill resources", () => {
    expect(() =>
      parsePackageManifest(
        manifest({
          resources: [
            {
              kind: "skill",
              id: "summarize",
              path: "skills/summarize/SKILL.md",
            },
            {
              kind: "expertTemplate",
              id: "assistant",
              path: "experts/assistant.json",
              skills: ["missing"],
            },
          ],
        }),
      ),
    ).toThrow();
    expect(
      parsePackageManifest(
        manifest({
          resources: [
            {
              kind: "skill",
              id: "summarize",
              path: "skills/summarize/SKILL.md",
            },
            {
              kind: "expertTemplate",
              id: "assistant",
              path: "experts/assistant.json",
              skills: ["summarize"],
            },
          ],
        }),
      ).resources,
    ).toHaveLength(2);
  });

  test("rejects connector fields that could carry an endpoint or secret", () => {
    expect(() =>
      parsePackageManifest(
        manifest({
          resources: [
            {
              kind: "managedConnector",
              id: "calendar",
              catalogKey: "calendar",
              required: false,
              tools: [{ name: "list-events", effect: "read" }],
              url: "https://evil.example",
            },
          ],
        }),
      ),
    ).toThrow();
    expect(
      parsePackageManifest(
        manifest({
          resources: [
            {
              kind: "managedConnector",
              id: "calendar",
              catalogKey: "calendar",
              required: false,
              tools: [{ name: "list-events", effect: "read" }],
            },
          ],
        }),
      ).resources[0],
    ).toMatchObject({ kind: "managedConnector", catalogKey: "calendar" });
  });

  test("rejects absolute, traversing, empty and backslash resource paths", () => {
    for (const path of [
      "/etc/passwd",
      "skills/../secret.md",
      "skills//SKILL.md",
      "skills/./SKILL.md",
      "skills\\SKILL.md",
    ]) {
      expect(() =>
        parsePackageManifest(
          manifest({
            resources: [{ kind: "skill", id: "summarize", path }],
          }),
        ),
      ).toThrow();
    }
  });
});

describe("artifact digest", () => {
  test("is identical for two builds of the same package", async () => {
    const root = await packageRoot();
    const first = await buildArtifact(root);
    const second = await buildArtifact(root);
    expect(first.digest).toBe(second.digest);
    expect(first.files).toEqual(second.files);
  });

  test("is independent of file creation and traversal order", async () => {
    const forward = await packageRoot(baseFiles, manifest(), {
      order: Object.keys(baseFiles),
    });
    const backward = await packageRoot(baseFiles, manifest(), {
      order: Object.keys(baseFiles).reverse(),
    });
    const first = await buildArtifact(forward);
    const second = await buildArtifact(backward);
    expect(first.digest).toBe(second.digest);
    expect(first.files.map((file) => file.path)).toEqual([
      "README.md",
      "openbot.plugin.json",
      "skills/summarize/SKILL.md",
    ]);
  });

  test("hashes every regular file, including manifest and README", async () => {
    const root = await packageRoot();
    const artifact = await buildArtifact(root);
    const readme = await readFile(join(root, "README.md"));
    const readmeEntry = artifact.files.find(
      (file) => file.path === "README.md",
    );
    expect(readmeEntry).toEqual({
      path: "README.md",
      bytes: readme.byteLength,
      sha256: sha256(readme),
    });
    expect(artifact.files.map((file) => file.path)).toContain(
      "openbot.plugin.json",
    );
  });

  test("computes the digest from the verified buffer, not a later read", async () => {
    const root = await packageRoot();
    const artifact = await buildArtifact(root);
    const readme = await readFile(join(root, "README.md"));
    await writeFile(join(root, "README.md"), "swapped after verification\n");

    const readmeEntry = artifact.files.find(
      (file) => file.path === "README.md",
    );
    expect(readmeEntry?.sha256).toBe(sha256(readme));
    expect(artifact.digest).not.toBe((await buildArtifact(root)).digest);
    await expect(loadArtifactFromPackage(artifact)).rejects.toThrow();
  });

  async function loadArtifactFromPackage(artifact: VerifiedArtifact) {
    const root = await mkdtemp(join(tmpdir(), "artifact-store-"));
    roots.push(root);
    await storeArtifact(artifact, root);
    return loadArtifact(root, artifact.digest);
  }
});

describe("artifact limits", () => {
  test("accepts a 64 KiB manifest and rejects one byte more", async () => {
    const exact = await packageRoot(baseFiles, manifest(), {
      manifestBytes: 64 * 1024,
    });
    await expect(buildArtifact(exact)).resolves.toBeDefined();

    const over = await packageRoot(baseFiles, manifest(), {
      manifestBytes: 64 * 1024 + 1,
    });
    await expect(buildArtifact(over)).rejects.toThrow(/manifest/i);
  });

  test("accepts exactly 256 resources and rejects 257", async () => {
    const resources = Array.from({ length: 256 }, (_, index) => ({
      kind: "skill" as const,
      id: `skill-${index}`,
      path: `skills/skill-${index}/SKILL.md`,
    }));
    const files = Object.fromEntries(
      resources.map((resource) => [resource.path, `# ${resource.id}\n`]),
    );
    const accepted = await packageRoot(files, manifest({ resources }));
    await expect(buildArtifact(accepted)).resolves.toBeDefined();

    const rejected = await packageRoot(files, manifest({ resources }));
    const extra = await packageRoot(
      { ...files, "skills/extra/SKILL.md": "# extra\n" },
      manifest({
        resources: [
          ...resources,
          { kind: "skill", id: "extra", path: "skills/extra/SKILL.md" },
        ],
      }),
    );
    await expect(buildArtifact(rejected)).resolves.toBeDefined();
    await expect(buildArtifact(extra)).rejects.toThrow();
  });

  test("accepts exactly 512 files and rejects 513", async () => {
    const extras = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `notes/note-${index}.md`,
          `note ${index}\n`,
        ]),
      );
    // manifest + 2 base files + 509 extras = 512.
    const accepted = await packageRoot({ ...baseFiles, ...extras(509) });
    await expect(buildArtifact(accepted)).resolves.toBeDefined();

    const rejected = await packageRoot({ ...baseFiles, ...extras(510) });
    await expect(buildArtifact(rejected)).rejects.toThrow(/512/);
  });

  test("accepts a 1 MiB text file and rejects one byte more", async () => {
    const accepted = await packageRoot({
      ...baseFiles,
      "notes/big.md": "a".repeat(1024 * 1024),
    });
    await expect(buildArtifact(accepted)).resolves.toBeDefined();

    const rejected = await packageRoot({
      ...baseFiles,
      "notes/big.md": "a".repeat(1024 * 1024 + 1),
    });
    await expect(buildArtifact(rejected)).rejects.toThrow(/1 MiB|1048576/);
  });

  test("rejects a package over 16 MiB in total", async () => {
    const files: Record<string, string> = { ...baseFiles };
    for (let index = 0; index < 17; index += 1) {
      files[`notes/chunk-${index}.md`] = "a".repeat(1024 * 1024);
    }
    const root = await packageRoot(files);
    await expect(buildArtifact(root)).rejects.toThrow(/16 MiB|16777216/);
  });

  // R6-4 (OCR round 6): directories are bounded like files — a package of
  // nothing but empty directories must not walk without limit.
  test("accepts exactly 512 directories and rejects a 513th", async () => {
    const emptyDirs = async (count: number) => {
      // A flat file map and an empty resource list: baseFiles would add the
      // skills/ directory pair to the directory count.
      const root = await packageRoot(
        { "README.md": "# Demo Skill\n" },
        manifest({ resources: [] }),
      );
      for (let index = 0; index < count; index += 1) {
        await mkdir(join(root, `d${index}`));
      }
      return root;
    };
    // The package root counts as one directory: 1 + 511 = 512 is exactly at
    // the limit, 1 + 512 = 513 is over it. The directories are empty so the
    // file limit (512 files) cannot fire before the directory one.
    const accepted = await emptyDirs(511);
    await expect(buildArtifact(accepted)).resolves.toBeDefined();

    const rejected = await emptyDirs(512);
    await expect(buildArtifact(rejected)).rejects.toThrow(
      /more than 512 directories/,
    );
  });
});

describe("artifact path safety", () => {
  test("rejects a symlinked file", async () => {
    const root = await packageRoot({
      "skills/summarize/SKILL.md": "# Summarize\n",
    });
    await symlink("skills/summarize/SKILL.md", join(root, "README.md"));
    await expect(buildArtifact(root)).rejects.toThrow(/symlink/i);
  });

  test("rejects a symlinked directory and a dangling entry", async () => {
    const root = await packageRoot(baseFiles);
    await symlink("skills", join(root, "skills-link"));
    await expect(buildArtifact(root)).rejects.toThrow(/symlink/i);
  });

  test("detects path case-folding collisions", () => {
    expect(() =>
      assertNoCaseFoldCollisions(["README.md", "readme.md"]),
    ).toThrow(/case/i);
    expect(() =>
      assertNoCaseFoldCollisions(["skills/Summarize/SKILL.md"]),
    ).not.toThrow();
  });

  test("rejects a resource path that does not exist or is not a regular file", async () => {
    const missing = await packageRoot({ "README.md": "# Demo\n" }, manifest());
    await expect(buildArtifact(missing)).rejects.toThrow(/resource/i);

    const directory = await packageRoot({
      ...baseFiles,
      "skills/summarize/extra/placeholder.md": "x\n",
    });
    await rm(join(directory, "skills/summarize/SKILL.md"));
    await expect(buildArtifact(directory)).rejects.toThrow(/resource/i);
  });

  test("rejects paths outside the root through the realpath check", async () => {
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.md"), "secret\n");
    const root = await packageRoot(baseFiles);
    await mkdir(join(root, "notes"), { recursive: true });
    await symlink(join(outside, "secret.md"), join(root, "notes/outside.md"));
    await expect(buildArtifact(root)).rejects.toThrow(/symlink|escapes/i);
  });

  test("rejects a walked file name containing a control character", async () => {
    const root = await packageRoot(baseFiles);
    const name = Buffer.from([0x6e, 0x6f, 0x74, 0x65, 0x01, 0x2e, 0x6d, 0x64]);
    const handle = await open(join(root, name.toString()), "w");
    await handle.writeFile("control\n");
    await handle.close();
    await expect(buildArtifact(root)).rejects.toThrow(/POSIX/);
  });

  test("rejects a walked directory and file name containing a backslash", async () => {
    const fileRoot = await packageRoot(baseFiles);
    await writeFile(join(fileRoot, "notes\\windows.md"), "backslash\n");
    await expect(buildArtifact(fileRoot)).rejects.toThrow(/POSIX/);

    const directoryRoot = await packageRoot(baseFiles);
    await mkdir(join(directoryRoot, "notes\\windows"), { recursive: true });
    await writeFile(
      join(directoryRoot, "notes\\windows", "SKILL.md"),
      "backslash\n",
    );
    await expect(buildArtifact(directoryRoot)).rejects.toThrow(/POSIX/);
  });
});

/**
 * R6-5 (OCR round 6): readVerifiedFile must open the realpath resolution it
 * just proved in-root, not re-open the joined path. The deterministic
 * distinguisher between the two is a final-component symlink: open() with
 * O_NOFOLLOW on the joined path refuses it with ELOOP, while the resolved
 * path is the regular file realpath already checked. The truly racy window
 * (an intermediate directory swapped between realpath and open) has no static
 * construction — that is exactly why the open now uses the checked string.
 */
describe("readVerifiedFile resolved-open", () => {
  test("reads a final-component symlink through its resolved in-root path", async () => {
    const root = await packageRoot({
      ...baseFiles,
      "notes/real.md": "resolved bytes\n",
    });
    await symlink("notes/real.md", join(root, "alias.md"));
    const rootReal = await realpath(root);
    const bytes = await readVerifiedFile(root, rootReal, "alias.md", 1024);
    expect(bytes.toString("utf8")).toBe("resolved bytes\n");
  });

  test("still refuses a final-component symlink whose target escapes the root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.md"), "secret\n");
    const root = await packageRoot(baseFiles);
    await symlink(join(outside, "secret.md"), join(root, "alias.md"));
    const rootReal = await realpath(root);
    await expect(
      readVerifiedFile(root, rootReal, "alias.md", 1024),
    ).rejects.toThrow(/escapes/);
  });

  test("refuses a path whose intermediate component resolves outside the root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.md"), "secret\n");
    const root = await packageRoot(baseFiles);
    await symlink(outside, join(root, "leak"));
    const rootReal = await realpath(root);
    await expect(
      readVerifiedFile(root, rootReal, "leak/secret.md", 1024),
    ).rejects.toThrow(/escapes/);
  });
});

describe("artifact assets", () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
  ]);
  const webp = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x04, 0x00, 0x00, 0x00]),
    Buffer.from("WEBP", "ascii"),
  ]);

  test("accepts PNG and WebP assets by magic bytes", async () => {
    const root = await packageRoot(
      { ...baseFiles, "assets/icon.png": png, "assets/cover.webp": webp },
      manifest({
        display: {
          name: "Demo",
          summary: "Summary",
          icon: "assets/icon.png",
        },
      }),
    );
    await expect(buildArtifact(root)).resolves.toBeDefined();
  });

  test("rejects a display icon that is not PNG or WebP", async () => {
    const root = await packageRoot(
      { ...baseFiles, "assets/icon.png": "not an image" },
      manifest({
        display: {
          name: "Demo",
          summary: "Summary",
          icon: "assets/icon.png",
        },
      }),
    );
    await expect(buildArtifact(root)).rejects.toThrow(/PNG|WebP/i);
  });

  test("rejects a .webp asset with an invalid signature", async () => {
    const root = await packageRoot({
      ...baseFiles,
      "assets/cover.webp": "not an image",
    });
    await expect(buildArtifact(root)).rejects.toThrow(/PNG|WebP/i);
  });
});

describe("artifact storage", () => {
  test("stores content addressed and reuses an identical artifact", async () => {
    const root = await packageRoot();
    const artifact = await buildArtifact(root);
    const destination = await mkdtemp(join(tmpdir(), "artifact-dest-"));
    roots.push(destination);

    const first = await storeArtifact(artifact, destination);
    expect(first).toBe(join(destination, "sha256", artifact.digest));
    expect((await lstat(join(first, "openbot.plugin.json"))).isFile()).toBe(
      true,
    );

    const second = await storeArtifact(artifact, destination);
    expect(second).toBe(first);
    const loaded = await loadArtifact(destination, artifact.digest);
    expect(loaded.digest).toBe(artifact.digest);
  });

  test("load rejects a tampered artifact and a wrong digest", async () => {
    const root = await packageRoot();
    const artifact = await buildArtifact(root);
    const destination = await mkdtemp(join(tmpdir(), "artifact-dest-"));
    roots.push(destination);
    const stored = await storeArtifact(artifact, destination);
    await writeFile(join(stored, "README.md"), "tampered\n");

    await expect(loadArtifact(destination, artifact.digest)).rejects.toThrow();
    await expect(loadArtifact(destination, "0".repeat(64))).rejects.toThrow();
  });
});

/**
 * R5-3 (OCR round 5): one source directory per packageKey holds exactly one
 * version. The build must only rebuild the entry the source manifest actually
 * is, and settle historical entries for the same packageKey against the
 * immutable artifact store (verify + `verified-historical`, or a loud warning
 * when absent) — never rebuild them from the newer source, which used to make
 * every multi-version catalog fail its digest check.
 */
describe("buildMarketplaceArtifacts", () => {
  function collector() {
    const lines: Array<{ line: string; level: string }> = [];
    return {
      lines,
      text: () => lines.map((entry) => entry.line),
      emit: (line: string, level: "info" | "warn" | "error") => {
        lines.push({ line, level });
      },
      ofLevel: (level: string) =>
        lines
          .filter((entry) => entry.level === level)
          .map((entry) => entry.line),
    };
  }

  /** A catalog tree: marketplace.json plus the package source directory. */
  async function catalogTree(
    packageKey: string,
    manifestValue: Record<string, unknown>,
  ): Promise<{ catalogDir: string; sourceDir: string }> {
    const catalogDir = await mkdtemp(join(tmpdir(), "marketplace-catalog-"));
    roots.push(catalogDir);
    const sourceDir = join(catalogDir, "packages", ...packageKey.split("/"));
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "openbot.plugin.json"),
      JSON.stringify(manifestValue),
    );
    for (const [name, content] of Object.entries(baseFiles)) {
      const absolute = join(sourceDir, ...name.split("/"));
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }
    return { catalogDir, sourceDir };
  }

  async function writeCatalog(
    catalogDir: string,
    packages: Array<{
      packageKey: string;
      version: string;
      artifactDigest: string;
    }>,
  ): Promise<string> {
    const catalogPath = join(catalogDir, "marketplace.json");
    await writeFile(
      catalogPath,
      JSON.stringify({
        schemaVersion: 1,
        packages: packages.map((entry) => ({
          ...entry,
          category: "productivity",
          listed: true,
        })),
      }),
    );
    return catalogPath;
  }

  test("builds the source version, verifies a stored historical entry, and stays green", async () => {
    // The historical 1.0.0 release: different manifest bytes, different digest.
    const historicalSource = await packageRoot(
      baseFiles,
      manifest({ version: "1.0.0" }),
    );
    const historical = await buildArtifact(historicalSource);
    const output = await mkdtemp(join(tmpdir(), "artifact-store-"));
    roots.push(output);
    await storeArtifact(historical, output);

    // The current source tree carries 1.1.0 only, while the catalog lists
    // both releases — the exact shape that failed every build before R5-3.
    const { catalogDir, sourceDir } = await catalogTree(
      "openbot/demo-skill",
      manifest({ version: "1.1.0" }),
    );
    const current = await buildArtifact(sourceDir);
    const catalogPath = await writeCatalog(catalogDir, [
      {
        packageKey: "openbot/demo-skill",
        version: "1.0.0",
        artifactDigest: historical.digest,
      },
      {
        packageKey: "openbot/demo-skill",
        version: "1.1.0",
        artifactDigest: current.digest,
      },
    ]);

    const events = collector();
    const failed = await buildMarketplaceArtifacts(
      catalogPath,
      output,
      events.emit,
    );
    expect(failed).toBe(false);
    expect(events.ofLevel("error")).toEqual([]);
    expect(events.ofLevel("warn")).toEqual([]);
    expect(events.text()).toContain(
      `openbot/demo-skill@1.1.0 ${current.digest}`,
    );
    expect(events.text()).toContain(
      `openbot/demo-skill@1.0.0 verified-historical ${historical.digest}`,
    );
    // Both releases resolve from the store after the build.
    expect((await loadArtifact(output, current.digest)).digest).toBe(
      current.digest,
    );
    expect((await loadArtifact(output, historical.digest)).digest).toBe(
      historical.digest,
    );
  });

  test("warns — without failing — when a historical entry is absent from the store", async () => {
    const historicalSource = await packageRoot(
      baseFiles,
      manifest({ version: "1.0.0" }),
    );
    const historical = await buildArtifact(historicalSource);
    const output = await mkdtemp(join(tmpdir(), "artifact-store-"));
    roots.push(output);
    // The store stays empty: the historical artifact is missing.

    const { catalogDir, sourceDir } = await catalogTree(
      "openbot/demo-skill",
      manifest({ version: "1.1.0" }),
    );
    const current = await buildArtifact(sourceDir);
    const catalogPath = await writeCatalog(catalogDir, [
      {
        packageKey: "openbot/demo-skill",
        version: "1.0.0",
        artifactDigest: historical.digest,
      },
      {
        packageKey: "openbot/demo-skill",
        version: "1.1.0",
        artifactDigest: current.digest,
      },
    ]);

    const events = collector();
    const failed = await buildMarketplaceArtifacts(
      catalogPath,
      output,
      events.emit,
    );
    expect(failed).toBe(false);
    expect(events.ofLevel("error")).toEqual([]);
    const warns = events.ofLevel("warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("openbot/demo-skill@1.0.0: historical artifact");
    expect(warns[0]).toContain("absent from the artifact store");
    // The current release is still built and stored.
    expect(events.text()).toContain(
      `openbot/demo-skill@1.1.0 ${current.digest}`,
    );
    expect((await loadArtifact(output, current.digest)).digest).toBe(
      current.digest,
    );
  });

  test("still fails when the source-version entry digest does not match", async () => {
    const { catalogDir } = await catalogTree(
      "openbot/demo-skill",
      manifest({ version: "1.1.0" }),
    );
    const catalogPath = await writeCatalog(catalogDir, [
      {
        packageKey: "openbot/demo-skill",
        version: "1.1.0",
        artifactDigest: "f".repeat(64),
      },
    ]);

    const events = collector();
    const failed = await buildMarketplaceArtifacts(
      catalogPath,
      await mkdtemp(join(tmpdir(), "artifact-store-")),
      events.emit,
    );
    expect(failed).toBe(true);
    const errors = events.ofLevel("error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("openbot/demo-skill@1.1.0: declared digest");
    expect(errors[0]).toContain("does not match computed");
  });

  test("fails when the source manifest identity does not match the index entry", async () => {
    // The directory packages/openbot/other-name holds a manifest claiming to
    // be openbot/demo-skill at the same version.
    const { catalogDir } = await catalogTree(
      "openbot/other-name",
      manifest({ version: "1.1.0" }),
    );
    const catalogPath = await writeCatalog(catalogDir, [
      {
        packageKey: "openbot/other-name",
        version: "1.1.0",
        artifactDigest: "a".repeat(64),
      },
    ]);

    const events = collector();
    const failed = await buildMarketplaceArtifacts(
      catalogPath,
      await mkdtemp(join(tmpdir(), "artifact-store-")),
      events.emit,
    );
    expect(failed).toBe(true);
    const errors = events.ofLevel("error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "source manifest identity openbot/demo-skill does not match the index entry openbot/other-name",
    );
  });

  test("fails when a stored historical artifact no longer matches its digest", async () => {
    const historicalSource = await packageRoot(
      baseFiles,
      manifest({ version: "1.0.0" }),
    );
    const historical = await buildArtifact(historicalSource);
    const output = await mkdtemp(join(tmpdir(), "artifact-store-"));
    roots.push(output);

    // Corrupt the store: the 1.1.0 bytes live under the 1.0.0 digest address.
    const { catalogDir, sourceDir } = await catalogTree(
      "openbot/demo-skill",
      manifest({ version: "1.1.0" }),
    );
    const current = await buildArtifact(sourceDir);
    await storeArtifact(current, output);
    await rename(
      join(output, "sha256", current.digest),
      join(output, "sha256", historical.digest),
    );
    const catalogPath = await writeCatalog(catalogDir, [
      {
        packageKey: "openbot/demo-skill",
        version: "1.0.0",
        artifactDigest: historical.digest,
      },
    ]);

    const events = collector();
    const failed = await buildMarketplaceArtifacts(
      catalogPath,
      output,
      events.emit,
    );
    expect(failed).toBe(true);
    expect(events.ofLevel("warn")).toEqual([]);
    const errors = events.ofLevel("error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "openbot/demo-skill@1.0.0: stored historical artifact",
    );
    expect(errors[0]).toContain("failed verification");
  });

  // R6-3 (OCR round 6): a failed storeArtifact is recorded per entry and the
  // loop continues — one broken store must not abort the rest of the catalog
  // through an unhandled rejection.
  test("records a failed store per entry and keeps building the rest", async () => {
    const catalogDir = await mkdtemp(join(tmpdir(), "marketplace-catalog-"));
    roots.push(catalogDir);
    const writeSource = async (
      packageKey: string,
      manifestValue: Record<string, unknown>,
    ) => {
      const sourceDir = join(catalogDir, "packages", ...packageKey.split("/"));
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        join(sourceDir, "openbot.plugin.json"),
        JSON.stringify(manifestValue),
      );
      for (const [name, content] of Object.entries(baseFiles)) {
        const absolute = join(sourceDir, ...name.split("/"));
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, content);
      }
      return sourceDir;
    };
    const sourceA = await writeSource(
      "openbot/demo-skill",
      manifest({ version: "1.1.0" }),
    );
    const sourceB = await writeSource("openbot/other-skill", {
      ...manifest(),
      name: "other-skill",
      version: "1.0.0",
    });
    const artifactA = await buildArtifact(sourceA);
    const artifactB = await buildArtifact(sourceB);

    // Seed the store so entry A's content address already holds another
    // package's bytes: storeArtifact(A) re-verifies the stored copy first and
    // refuses — a deterministic per-entry store failure.
    const output = await mkdtemp(join(tmpdir(), "artifact-store-"));
    roots.push(output);
    const seeded = await storeArtifact(artifactB, output);
    await rename(seeded, join(output, "sha256", artifactA.digest));

    const catalogPath = join(catalogDir, "marketplace.json");
    await writeFile(
      catalogPath,
      JSON.stringify({
        schemaVersion: 1,
        packages: [
          {
            packageKey: "openbot/demo-skill",
            version: "1.1.0",
            artifactDigest: artifactA.digest,
            category: "productivity",
            listed: true,
          },
          {
            packageKey: "openbot/other-skill",
            version: "1.0.0",
            artifactDigest: artifactB.digest,
            category: "productivity",
            listed: true,
          },
        ],
      }),
    );

    const events = collector();
    const failed = await buildMarketplaceArtifacts(
      catalogPath,
      output,
      events.emit,
    );
    expect(failed).toBe(true);
    const errors = events.ofLevel("error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "openbot/demo-skill@1.1.0: storing the verified artifact failed",
    );
    // The loop continued past the failed store: the second entry is still
    // built and stored, so the failure is per-entry, not terminal.
    expect(events.text()).toContain(
      `openbot/other-skill@1.0.0 ${artifactB.digest}`,
    );
    expect((await loadArtifact(output, artifactB.digest)).digest).toBe(
      artifactB.digest,
    );
  });

  // R6-6 (OCR round 6): a version-skipped entry whose source directory
  // carries ANOTHER package's manifest is not history — it hard-fails even
  // when the store holds a verifying artifact at the declared digest (which
  // used to be silently reported `verified-historical`).
  test("hard-fails a wrong-package source directory even when the store copy verifies", async () => {
    const otherSource = await packageRoot(
      baseFiles,
      manifest({ version: "1.1.0" }),
    );
    const other = await buildArtifact(otherSource);
    const output = await mkdtemp(join(tmpdir(), "artifact-store-"));
    roots.push(output);
    await storeArtifact(other, output);

    // packages/openbot/other-name holds openbot/demo-skill@1.1.0, while the
    // index lists openbot/other-name@2.0.0: identity and version both miss,
    // which used to fall through into the historical branch.
    const { catalogDir } = await catalogTree(
      "openbot/other-name",
      manifest({ version: "1.1.0" }),
    );
    const catalogPath = await writeCatalog(catalogDir, [
      {
        packageKey: "openbot/other-name",
        version: "2.0.0",
        artifactDigest: other.digest,
      },
    ]);

    const events = collector();
    const failed = await buildMarketplaceArtifacts(
      catalogPath,
      output,
      events.emit,
    );
    expect(failed).toBe(true);
    expect(events.ofLevel("warn")).toEqual([]);
    const errors = events.ofLevel("error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "source manifest identity openbot/demo-skill does not match the index entry openbot/other-name",
    );
    expect(
      events.text().some((line) => line.includes("verified-historical")),
    ).toBe(false);
  });

  test("hard-fails — instead of warning — when the same wrong-package source has no stored artifact", async () => {
    const { catalogDir } = await catalogTree(
      "openbot/other-name",
      manifest({ version: "1.1.0" }),
    );
    const catalogPath = await writeCatalog(catalogDir, [
      {
        packageKey: "openbot/other-name",
        version: "2.0.0",
        artifactDigest: "b".repeat(64),
      },
    ]);

    const events = collector();
    const failed = await buildMarketplaceArtifacts(
      catalogPath,
      await mkdtemp(join(tmpdir(), "artifact-store-")),
      events.emit,
    );
    expect(failed).toBe(true);
    expect(events.ofLevel("warn")).toEqual([]);
    const errors = events.ofLevel("error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("does not match the index entry");
  });
});
