import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterEach,
  describe,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import type { PlatformScope } from "../src/enterprise/contracts";
import { buildArtifact, storeArtifact } from "../src/plugin-packages/artifact";
import {
  comparePackageVersions,
  loadPackageCatalogue,
  type PackageCatalogue,
} from "../src/plugin-packages/catalogue";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function scope(overrides: Partial<PlatformScope> = {}): PlatformScope {
  return {
    tenantId: "tenant-1",
    workspaceId: "workspace-1",
    principalId: "principal-1",
    actorId: "actor-1",
    memberEpoch: 1,
    aclEpoch: 1,
    entrypoint: "web",
    ...overrides,
  };
}

interface PackageDefinition {
  name: string;
  displayName?: string;
  summary?: string;
  category?: string;
  listed?: boolean;
  version?: string;
  publisher?: string;
  /** Replaces the default single-skill resource list when present. */
  resources?: Array<Record<string, unknown>>;
  /** Extra files written beside the manifest, keyed by POSIX relative path. */
  files?: Record<string, string>;
}

async function artifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "catalogue-artifacts-"));
  roots.push(root);
  return root;
}

async function storePackage(
  destination: string,
  definition: PackageDefinition,
): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "catalogue-source-"));
  roots.push(source);
  const manifest = {
    schemaVersion: 1,
    platformApi: 1,
    publisher: definition.publisher ?? "openbot",
    name: definition.name,
    version: definition.version ?? "1.0.0",
    display: {
      name: definition.displayName ?? `${definition.name} tool`,
      summary: definition.summary ?? `The ${definition.name} package.`,
    },
    resources: definition.resources ?? [
      {
        kind: "skill",
        id: "summarize",
        path: "skills/summarize/SKILL.md",
      },
    ],
    dependencies: [],
  };
  await writeFile(
    join(source, "openbot.plugin.json"),
    JSON.stringify(manifest),
  );
  const skillPath = join(source, "skills", "summarize", "SKILL.md");
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(skillPath, `# ${definition.name}\n`);
  for (const [path, content] of Object.entries(definition.files ?? {})) {
    const absolute = join(source, ...path.split("/"));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  const artifact = await buildArtifact(source);
  await storeArtifact(artifact, destination);
  return artifact.digest;
}

function entry(
  packageKey: string,
  digest: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    packageKey,
    version: "1.0.0",
    artifactDigest: digest,
    category: "productivity",
    listed: true,
    ...overrides,
  };
}

interface Fixture {
  artifactRoot: string;
  catalogue: PackageCatalogue;
  digests: Record<string, string>;
  missingDigest: string;
  brokenDigest: string;
  unsupportedDigest: string;
}

async function fixture(): Promise<Fixture> {
  const root = await artifactRoot();
  const alpha = await storePackage(root, {
    name: "alpha",
    displayName: "Alpha Tool",
    summary: "Plans the week.",
    category: "productivity",
  });
  const beta = await storePackage(root, {
    name: "beta",
    displayName: "Beta Tool",
    summary: "Takes meeting notes.",
    category: "meetings",
  });
  const gamma = await storePackage(root, {
    name: "gamma",
    displayName: "Gamma Tool",
    summary: "Drafts messages.",
    category: "productivity",
  });
  const hidden = await storePackage(root, {
    name: "hidden",
    displayName: "Hidden Tool",
    summary: "Not listed.",
    listed: false,
  });
  const other = await storePackage(root, {
    name: "other",
    displayName: "Other Tool",
    summary: "Identity mismatch fixture.",
  });
  const brokenDigest = "b".repeat(64);
  const brokenDirectory = join(root, "sha256", brokenDigest);
  await mkdir(brokenDirectory, { recursive: true });
  await writeFile(join(brokenDirectory, "openbot.plugin.json"), "{ not json");
  const missingDigest = "a".repeat(64);
  const index = {
    schemaVersion: 1,
    packages: [
      entry("openbot/alpha", alpha),
      entry("openbot/beta", beta, { category: "meetings" }),
      entry("openbot/gamma", gamma),
      entry("openbot/hidden", hidden, { listed: false }),
      entry("openbot/missing", missingDigest),
      entry("openbot/broken", brokenDigest),
      entry("openbot/unsupported", other),
    ],
  };
  const catalogue = await loadPackageCatalogue({
    index,
    artifactRoot: root,
  });
  return {
    artifactRoot: root,
    catalogue,
    digests: { alpha, beta, gamma, hidden, other },
    missingDigest,
    brokenDigest,
    unsupportedDigest: other,
  };
}

describe("loadPackageCatalogue", () => {
  test("rejects duplicate exact index entries", async () => {
    const root = await artifactRoot();
    const digest = await storePackage(root, { name: "alpha" });
    const duplicate = entry("openbot/alpha", digest);
    await expect(
      loadPackageCatalogue({
        index: { schemaVersion: 1, packages: [duplicate, duplicate] },
        artifactRoot: root,
      }),
    ).rejects.toThrow(/duplicate/i);
  });

  test("rejects the same version with a different digest", async () => {
    const root = await artifactRoot();
    const first = await storePackage(root, { name: "alpha" });
    const second = await storePackage(root, {
      name: "alpha",
      summary: "Different content, same version.",
    });
    expect(second).not.toBe(first);
    await expect(
      loadPackageCatalogue({
        index: {
          schemaVersion: 1,
          packages: [
            entry("openbot/alpha", first),
            entry("openbot/alpha", second),
          ],
        },
        artifactRoot: root,
      }),
    ).rejects.toThrow(/duplicate|digest/i);
  });

  test("rejects an invalid index shape", async () => {
    const root = await artifactRoot();
    await expect(
      loadPackageCatalogue({
        index: { schemaVersion: 2, packages: [] },
        artifactRoot: root,
      }),
    ).rejects.toThrow();
    await expect(
      loadPackageCatalogue({
        index: {
          schemaVersion: 1,
          packages: [
            {
              packageKey: "openbot/alpha",
              version: "1.0.0",
              artifactDigest: "not-a-digest",
              category: "productivity",
              listed: true,
            },
          ],
        },
        artifactRoot: root,
      }),
    ).rejects.toThrow();
  });
});

describe("version selection", () => {
  test("compares numeric version parts beyond Number precision", () => {
    expect(
      comparePackageVersions("9007199254740993.0.0", "9007199254740992.0.0"),
    ).toBeGreaterThan(0);
    expect(
      comparePackageVersions("1.9007199254740993.0", "1.9007199254740992.0"),
    ).toBeGreaterThan(0);
    expect(
      comparePackageVersions("1.0.9007199254740992", "1.0.9007199254740993"),
    ).toBeLessThan(0);
    expect(comparePackageVersions("1.2.3", "1.2.3")).toBe(0);
    expect(comparePackageVersions("2.0.0", "10.0.0")).toBeLessThan(0);
  });

  test("serves the newest listed version over a newer unlisted one", async () => {
    const root = await artifactRoot();
    const listed = await storePackage(root, {
      name: "alpha",
      version: "1.0.0",
      displayName: "Alpha One",
    });
    const unlisted = await storePackage(root, {
      name: "alpha",
      version: "2.0.0",
      displayName: "Alpha Two",
    });
    const catalogue = await loadPackageCatalogue({
      index: {
        schemaVersion: 1,
        packages: [
          entry("openbot/alpha", listed, { version: "1.0.0" }),
          entry("openbot/alpha", unlisted, {
            version: "2.0.0",
            listed: false,
          }),
        ],
      },
      artifactRoot: root,
    });

    const page = await catalogue.list(scope(), {});
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      packageKey: "openbot/alpha",
      version: "1.0.0",
      displayName: "Alpha One",
      installable: true,
    });

    const detail = await catalogue.get(scope(), "openbot", "alpha");
    expect(detail).toMatchObject({
      version: "1.0.0",
      displayName: "Alpha One",
      installable: true,
    });
  });

  test("prefers a listed verified version over a newer broken listed one", async () => {
    const root = await artifactRoot();
    const verified = await storePackage(root, {
      name: "alpha",
      version: "1.0.0",
      displayName: "Alpha One",
    });
    const catalogue = await loadPackageCatalogue({
      index: {
        schemaVersion: 1,
        packages: [
          entry("openbot/alpha", verified, { version: "1.0.0" }),
          entry("openbot/alpha", "c".repeat(64), { version: "2.0.0" }),
        ],
      },
      artifactRoot: root,
    });

    const page = await catalogue.list(scope(), {});
    expect(page.items).toEqual([
      expect.objectContaining({
        packageKey: "openbot/alpha",
        version: "1.0.0",
        installable: true,
        blockers: [],
      }),
    ]);

    const detail = await catalogue.get(scope(), "openbot", "alpha");
    expect(detail.version).toBe("1.0.0");
    expect(detail.installable).toBe(true);
  });

  test("serves the newest listed version when no listed version verifies", async () => {
    const root = await artifactRoot();
    const catalogue = await loadPackageCatalogue({
      index: {
        schemaVersion: 1,
        packages: [
          entry("openbot/alpha", "c".repeat(64), { version: "1.0.0" }),
          entry("openbot/alpha", "d".repeat(64), { version: "2.0.0" }),
        ],
      },
      artifactRoot: root,
    });

    const page = await catalogue.list(scope(), {});
    expect(page.items).toEqual([
      expect.objectContaining({
        packageKey: "openbot/alpha",
        version: "2.0.0",
        installable: false,
        blockers: [{ code: "ARTIFACT_MISSING" }],
      }),
    ]);
    const detail = await catalogue.get(scope(), "openbot", "alpha");
    expect(detail).toMatchObject({
      version: "2.0.0",
      installable: false,
      blockers: [{ code: "ARTIFACT_MISSING" }],
    });
  });

  test("hides an unlisted-only package from list and detail", async () => {
    const root = await artifactRoot();
    const unlisted = await storePackage(root, {
      name: "alpha",
      version: "2.0.0",
    });
    const catalogue = await loadPackageCatalogue({
      index: {
        schemaVersion: 1,
        packages: [
          entry("openbot/alpha", unlisted, {
            version: "2.0.0",
            listed: false,
          }),
        ],
      },
      artifactRoot: root,
    });

    const page = await catalogue.list(scope(), {});
    expect(page.items).toEqual([]);
    await expect(catalogue.get(scope(), "openbot", "alpha")).rejects.toThrow(
      /RESOURCE_NOT_FOUND/,
    );

    const included = await catalogue.list(
      scope(),
      {},
      {
        includeUnlisted: true,
      },
    );
    expect(included.items).toEqual([
      expect.objectContaining({
        packageKey: "openbot/alpha",
        version: "2.0.0",
        installable: false,
        blockers: [{ code: "PACKAGE_UNLISTED" }],
      }),
    ]);
  });

  test("selects versions past 2^53 as distinct releases", async () => {
    const root = await artifactRoot();
    const older = await storePackage(root, {
      name: "alpha",
      version: "9007199254740992.0.0",
    });
    const newer = await storePackage(root, {
      name: "alpha",
      version: "9007199254740993.0.0",
    });
    const catalogue = await loadPackageCatalogue({
      index: {
        schemaVersion: 1,
        packages: [
          entry("openbot/alpha", older, { version: "9007199254740992.0.0" }),
          entry("openbot/alpha", newer, { version: "9007199254740993.0.0" }),
        ],
      },
      artifactRoot: root,
    });
    const detail = await catalogue.get(scope(), "openbot", "alpha");
    expect(detail.version).toBe("9007199254740993.0.0");
  });
});

describe("catalogue resource availability", () => {
  test("marks managed connectors unavailable and blocks a required one", async () => {
    const root = await artifactRoot();
    const digest = await storePackage(root, {
      name: "connector",
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
        {
          kind: "managedConnector",
          id: "calendar",
          catalogKey: "calendar",
          required: true,
          tools: [{ name: "list-events", effect: "read" }],
        },
        {
          kind: "managedConnector",
          id: "drive",
          catalogKey: "drive",
          required: false,
          tools: [],
        },
      ],
      files: { "experts/assistant.json": '{"name":"assistant"}\n' },
    });
    const catalogue = await loadPackageCatalogue({
      index: {
        schemaVersion: 1,
        packages: [entry("openbot/connector", digest)],
      },
      artifactRoot: root,
    });

    const detail = await catalogue.get(scope(), "openbot", "connector");
    expect(detail.installable).toBe(false);
    expect(detail.blockers).toEqual([
      { code: "RESOURCE_UNAVAILABLE", resourceId: "calendar" },
    ]);
    expect(detail.resources).toEqual([
      { id: "summarize", kind: "skill", available: true },
      { id: "assistant", kind: "expertTemplate", available: true },
      { id: "calendar", kind: "managedConnector", available: false },
      { id: "drive", kind: "managedConnector", available: false },
    ]);
  });

  test("keeps a package with only optional connectors installable", async () => {
    const root = await artifactRoot();
    const digest = await storePackage(root, {
      name: "optional",
      resources: [
        {
          kind: "skill",
          id: "summarize",
          path: "skills/summarize/SKILL.md",
        },
        {
          kind: "managedConnector",
          id: "drive",
          catalogKey: "drive",
          required: false,
          tools: [],
        },
      ],
    });
    const catalogue = await loadPackageCatalogue({
      index: {
        schemaVersion: 1,
        packages: [entry("openbot/optional", digest)],
      },
      artifactRoot: root,
    });
    const detail = await catalogue.get(scope(), "openbot", "optional");
    expect(detail.installable).toBe(true);
    expect(detail.blockers).toEqual([]);
  });
});

describe("catalogue list", () => {
  test("returns listed verified packages sorted by packageKey", async () => {
    const { catalogue } = await fixture();
    const page = await catalogue.list(scope(), {});
    expect(page.items.map((item) => item.packageKey)).toEqual([
      "openbot/alpha",
      "openbot/beta",
      "openbot/broken",
      "openbot/gamma",
      "openbot/missing",
      "openbot/unsupported",
    ]);
    const alpha = page.items[0];
    expect(alpha).toMatchObject({
      packageKey: "openbot/alpha",
      version: "1.0.0",
      displayName: "Alpha Tool",
      summary: "Plans the week.",
      category: "productivity",
      install: null,
      installable: true,
      blockers: [],
    });
    expect(page.nextCursor).toBeNull();
  });

  test("marks missing and invalid artifacts unavailable with blockers", async () => {
    const { catalogue } = await fixture();
    const page = await catalogue.list(scope(), {});
    const missing = page.items.find(
      (item) => item.packageKey === "openbot/missing",
    );
    const broken = page.items.find(
      (item) => item.packageKey === "openbot/broken",
    );
    const unsupported = page.items.find(
      (item) => item.packageKey === "openbot/unsupported",
    );
    expect(missing).toMatchObject({
      installable: false,
      blockers: [{ code: "ARTIFACT_MISSING" }],
    });
    expect(broken).toMatchObject({
      installable: false,
      blockers: [{ code: "ARTIFACT_INVALID" }],
    });
    expect(unsupported).toMatchObject({
      installable: false,
      blockers: [{ code: "PACKAGE_UNSUPPORTED" }],
    });
  });

  test("hides unlisted packages unless explicitly included", async () => {
    const { catalogue } = await fixture();
    const hidden = await catalogue.list(scope(), {});
    expect(hidden.items.map((item) => item.packageKey)).not.toContain(
      "openbot/hidden",
    );

    const included = await catalogue.list(
      scope(),
      {},
      { includeUnlisted: true },
    );
    const item = included.items.find(
      (candidate) => candidate.packageKey === "openbot/hidden",
    );
    expect(item).toMatchObject({
      installable: false,
      blockers: [{ code: "PACKAGE_UNLISTED" }],
    });
  });

  test("searches packageKey, display name and summary case-insensitively", async () => {
    const { catalogue } = await fixture();
    const byKey = await catalogue.list(scope(), { search: "GAMMA" });
    expect(byKey.items.map((item) => item.packageKey)).toEqual([
      "openbot/gamma",
    ]);
    const byDisplay = await catalogue.list(scope(), { search: "beta tool" });
    expect(byDisplay.items.map((item) => item.packageKey)).toEqual([
      "openbot/beta",
    ]);
    const bySummary = await catalogue.list(scope(), { search: "week" });
    expect(bySummary.items.map((item) => item.packageKey)).toEqual([
      "openbot/alpha",
    ]);
  });

  test("filters by exact category", async () => {
    const { catalogue } = await fixture();
    const page = await catalogue.list(scope(), { category: "meetings" });
    expect(page.items.map((item) => item.packageKey)).toEqual(["openbot/beta"]);
    const none = await catalogue.list(scope(), { category: "MeetingS" });
    expect(none.items).toHaveLength(0);
  });

  test("pages with an opaque stable key cursor", async () => {
    const { catalogue } = await fixture();
    const first = await catalogue.list(scope(), { limit: 2 });
    expect(first.items.map((item) => item.packageKey)).toEqual([
      "openbot/alpha",
      "openbot/beta",
    ]);
    expect(first.nextCursor).toBeTruthy();
    expect(first.nextCursor).not.toContain("openbot");

    const rest: string[] = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await catalogue.list(scope(), { limit: 2, cursor });
      rest.push(...page.items.map((item) => item.packageKey));
      cursor = page.nextCursor;
    }
    expect(rest).toEqual([
      "openbot/broken",
      "openbot/gamma",
      "openbot/missing",
      "openbot/unsupported",
    ]);
  });

  test("applies the default limit of 20 and validates limits", async () => {
    const { catalogue } = await fixture();
    for (const limit of [0, 101, 2.5, Number.NaN]) {
      await expect(catalogue.list(scope(), { limit })).rejects.toThrow(
        /INPUT_INVALID/,
      );
    }
    await expect(catalogue.list(scope(), { limit: 20 })).resolves.toBeDefined();
    await expect(
      catalogue.list(scope(), { limit: 100 }),
    ).resolves.toBeDefined();
  });

  test("rejects an invalid cursor and an over-long search", async () => {
    const { catalogue } = await fixture();
    await expect(
      catalogue.list(scope(), { cursor: "%%%not-base64%%%" }),
    ).rejects.toThrow(/INPUT_INVALID/);
    await expect(
      catalogue.list(scope(), { search: "x".repeat(201) }),
    ).rejects.toThrow(/INPUT_INVALID/);
  });

  test("never leaks filesystem paths or secrets", async () => {
    const { catalogue, artifactRoot: root } = await fixture();
    const serialized = JSON.stringify(await catalogue.list(scope(), {}));
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("openbot.plugin.json");
    expect(serialized).not.toContain("sha256");
    expect(serialized).not.toContain("skills/summarize");
    expect(serialized).not.toContain("tenant-1");
    expect(serialized).not.toContain("workspace-1");
  });
});

describe("catalogue detail", () => {
  test("returns the current version with resource summaries", async () => {
    const { catalogue } = await fixture();
    const detail = await catalogue.get(scope(), "openbot", "alpha");
    expect(detail).toMatchObject({
      packageKey: "openbot/alpha",
      version: "1.0.0",
      displayName: "Alpha Tool",
      summary: "Plans the week.",
      category: "productivity",
      publisher: "openbot",
      name: "alpha",
      installable: true,
      blockers: [],
    });
    expect(detail.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.resources).toEqual([
      { id: "summarize", kind: "skill", available: true },
    ]);
  });

  test("reports unavailable artifacts without claiming installability", async () => {
    const { catalogue } = await fixture();
    const detail = await catalogue.get(scope(), "openbot", "missing");
    expect(detail.installable).toBe(false);
    expect(detail.blockers).toEqual([{ code: "ARTIFACT_MISSING" }]);
    expect(detail.resources).toEqual([]);
  });

  test("answers RESOURCE_NOT_FOUND for an unlisted-only package", async () => {
    const { catalogue } = await fixture();
    await expect(catalogue.get(scope(), "openbot", "hidden")).rejects.toThrow(
      /RESOURCE_NOT_FOUND/,
    );
  });

  test("answers unknown packages identically for every scope", async () => {
    const { catalogue } = await fixture();
    await expect(catalogue.get(scope(), "openbot", "unknown")).rejects.toThrow(
      /RESOURCE_NOT_FOUND/,
    );
    await expect(
      catalogue.get(
        scope({ tenantId: "tenant-2", workspaceId: "workspace-2" }),
        "openbot",
        "unknown",
      ),
    ).rejects.toThrow(/RESOURCE_NOT_FOUND/);
    await expect(catalogue.get(scope(), "other", "alpha")).rejects.toThrow(
      /RESOURCE_NOT_FOUND/,
    );
  });

  test("does not leak paths in detail JSON", async () => {
    const { catalogue, artifactRoot: root } = await fixture();
    const serialized = JSON.stringify(
      await catalogue.get(scope(), "openbot", "alpha"),
    );
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("openbot.plugin.json");
    expect(serialized).not.toContain("sha256");
  });
});
