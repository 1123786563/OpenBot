// server/tests/multitenancy/package-migration.test.ts
// PKG11（Issue #470，Spec §12 + A08/A09/A12）：存量迁移演练——真实内置包、
// 真实受限角色、真实 dry-run→apply 链路（driven 套件，Bun 运行时）。
//
// 验收事实源（#470 AC 逐条）：
//   AC1 dry-run 默认只读：导出源 ID/内容哈希、映射建议与 unresolved；
//       apply 显式绑定同一 manifest（摘要校验）并在写前 CAS 重验。
//   AC2 只映射"内容哈希完全匹配且范围归属有权威证据"的记录：私人编辑不
//       覆盖、缺 enterprise_bot_ownership 不迁（绝不从 Bot owner 猜公司
//       团队）、connector installs 保持 legacy。
//   AC3 单一写入方：legacy 市场路由不写 enterprise_package_*；迁移 apply
//       不写任何 legacy 表；apply 后影子读取差异被记录（无双写）。
//   AC5/AC6 回退演练：迁移产物就位后，路由面在开关关闭时写入口 503、
//       读取与撤权照常（既有安装治理不随开关暂停）。
//
// 环境契约：显式 enterprise 测试库 + 三个受限角色 URL（与 package 链其余
// 套件同一配方）；缺配置整套显式 skip，绝不回退开发库。内置包来自仓库
// 真实 plugins/marketplace.json + plugins/.artifacts（export-builtin 的产物），
// 不是测试私造 fixture。

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { builtinIndexEntry } from "../../../scripts/plugin-packages/migrate-legacy";
import {
  type ApplyOutcome,
  runApply,
} from "../../../scripts/plugin-packages/migrate-legacy-apply";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type { Database } from "../../src/db/client";
import { createPackageService } from "../../src/enterprise/plugin-packages/install-service";
import { createMarketplaceGate } from "../../src/enterprise/plugin-packages/marketplace-gate";
import { createPluginPackageRoutes } from "../../src/enterprise/plugin-packages/routes";
import {
  CATALOGUE_EXPERTS,
  CATALOGUE_SKILLS,
  type CatalogueSkill,
} from "../../src/marketplace/catalogue";
import {
  BUILTIN_PACKAGE_KEY,
  buildManifest,
  builtinFacts,
  diffShadowRead,
  readLegacyInventory,
  shadowReadForScope,
} from "../../src/marketplace/legacy-migration";
import { createMarketplaceRoutes } from "../../src/marketplace/routes";
import { createMarketplaceStore } from "../../src/marketplace/store";
import { loadPackageCatalogue } from "../../src/plugin-packages/catalogue";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  createPackageInstallFixture,
  type PackageInstallFixture,
} from "./support/package-install";

function probeEnvironment():
  | { ok: true; urls: URLs }
  | { ok: false; reason: string } {
  try {
    enterpriseTestDatabaseUrlFrom(process.env);
    for (const role of ["directory", "data", "operator"] as const) {
      enterpriseRuntimeDatabaseUrlFrom(role, process.env);
    }
    return {
      ok: true,
      urls: {
        setup: enterpriseTestDatabaseUrlFrom(process.env),
        directory: enterpriseRuntimeDatabaseUrlFrom("directory", process.env),
        data: enterpriseRuntimeDatabaseUrlFrom("data", process.env),
        operator: enterpriseRuntimeDatabaseUrlFrom("operator", process.env),
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

interface URLs {
  readonly setup: string;
  readonly directory: string;
  readonly data: string;
  readonly operator: string;
}

const ENV = probeEnvironment();
const describeDb = ENV.ok ? describe : describe.skip;

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const INDEX_PATH = join(REPO_ROOT, "plugins/marketplace.json");
const ARTIFACT_ROOT = join(REPO_ROOT, "plugins/.artifacts");

/** The two catalogue entries the drill uses; hashes come from the constants. */
const PRISTINE_SKILL = CATALOGUE_SKILLS.find((s) => s.slug === "code-review");
const EDITED_SKILL = CATALOGUE_SKILLS.find((s) => s.slug === "api-design");
const EXPERT = CATALOGUE_EXPERTS.find((e) => e.slug === "fullstack-engineer");

let fixture: PackageInstallFixture;
let setup: Database;
let urls: URLs;
let tenantA: string;
let teamA1: string;
let adminUserId: string;

/** Legacy seed: expert-installed Bot (agents + agent_profiles + receipt). */
async function seedLegacyBot(input: {
  slug: string;
  ownerUserId: string;
  /** Privatize the profile so the content hash must diverge. */
  edited?: boolean;
  /** OCR-fix-F2 H-C: managed-Bot shape — the route persists no systemPrompt. */
  managed?: boolean;
  /** OCR-fix-F2 H-C: hand-altered systemPrompt, profile fields untouched. */
  promptEdited?: boolean;
}): Promise<string> {
  const agentId = `pkg11-bot-${randomUUID()}`;
  const expert = CATALOGUE_EXPERTS.find((e) => e.slug === input.slug);
  if (!expert) throw new Error(`unknown expert slug ${input.slug}`);
  const roleDescription = input.edited
    ? `${expert.roleDescription}\n\n（私改过）`
    : expert.roleDescription;
  await setup.$client.unsafe(
    `insert into agents (id, name, type, configuration)
     values ($1, $2, $3, $4::jsonb)`,
    [
      agentId,
      expert.name,
      input.managed ? "remote_ag_ui" : "built_in",
      input.managed
        ? // The managed-Bot shape: configuration = { endpoint }, no prompt —
          // exactly what the install route writes when a managed Bot exists.
          JSON.stringify({ endpoint: "https://managed.example.test/ag-ui" })
        : JSON.stringify({
            systemPrompt: input.promptEdited
              ? `${roleDescription}（私改提示词）`
              : roleDescription,
          }),
    ],
  );
  await setup.$client.unsafe(
    `insert into agent_profiles (agent_id, owner_user_id, title, role_description, avatar_seed, visibility)
     values ($1, $2, $3, $4, 'seed', 'private')`,
    [agentId, input.ownerUserId, expert.name, roleDescription],
  );
  await setup.$client.unsafe(
    `insert into expert_installs (id, expert_slug, agent_id, owner_user_id)
     values ($1, $2, $3, $4)`,
    [`pkg11-ei-${randomUUID()}`, input.slug, agentId, input.ownerUserId],
  );
  return agentId;
}

/** The authority the migration trusts — never derived from ownerUserId. */
async function seedOwnership(agentId: string): Promise<void> {
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${tenantA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_bot_ownership
            (tenant_id, agent_id, workspace_id, owner_principal_id, display_name, default_config)
          values (${tenantA}, ${agentId}, ${teamA1}, ${fixture.principalOf("a1-member", "company-a")}, 'PKG11 legacy bot', '{}'::jsonb)`,
    );
  });
}

/**
 * F-T12-1: the slug-held stock a LIVE legacy install leaves in a shared
 * library — the acceptance demo's expert install wrote exactly these rows.
 * Same write shape the plugin store's installSkill uses (the slug is the row
 * id) and the marketplace's own rule that a slug somebody already holds is
 * never re-grabbed: on conflict nothing is written, so whichever holder came
 * first — the demo, or this staging on an earlier run — keeps the slug.
 */
async function seedHeldSkillRow(
  entry: CatalogueSkill,
  ownerUserId: string | null,
): Promise<void> {
  await setup.$client.unsafe(
    `insert into skills (id, owner_user_id, slug, title, summary, instructions, origin, icon, category, installed_by)
     values ($1, $2, $3, $4, $5, $6, 'catalogue', $7, $8, $9)
     on conflict (slug) do nothing`,
    [
      entry.slug,
      ownerUserId,
      entry.slug,
      entry.title,
      entry.summary,
      entry.instructions,
      entry.icon,
      entry.category,
      ownerUserId ?? "deployment",
    ],
  );
}

async function seedSkillRow(
  slug: string,
  ownerUserId: string | null,
  edited: boolean,
): Promise<void> {
  const entry = CATALOGUE_SKILLS.find((s) => s.slug === slug);
  if (!entry) throw new Error(`unknown skill slug ${slug}`);
  const instructions = edited
    ? `${entry.instructions}\n（私改过）`
    : entry.instructions;
  // F-T12-1: stage the way the real install path writes, never by blind
  // insert. The marketplace route reads the slug's holder first and a held
  // slug is never re-grabbed (Spec §8); a free slug gets this suite's own
  // row (pkg11- id, removed on rerun), while a held slug keeps its id and
  // owner and only its content converges to this scenario — the same field
  // set installSkill's upsert refreshes — so the drill classifies the one
  // row the slug actually has, whoever holds it.
  const held = (await setup.$client.unsafe(
    `select id from skills where slug = $1`,
    [entry.slug],
  )) as Array<{ id: string }>;
  if (held.length > 0) {
    await setup.$client.unsafe(
      `update skills set title = $2, summary = $3, instructions = $4, icon = $5, category = $6, updated_at = now()
       where slug = $1`,
      [
        entry.slug,
        entry.title,
        entry.summary,
        instructions,
        entry.icon,
        entry.category,
      ],
    );
    return;
  }
  await setup.$client.unsafe(
    `insert into skills (id, owner_user_id, slug, title, summary, instructions, origin, icon, category, installed_by)
     values ($1, $2, $3, $4, $5, $6, 'catalogue', $7, $8, $9)`,
    [
      `pkg11-skill-${randomUUID()}`,
      ownerUserId,
      entry.slug,
      entry.title,
      entry.summary,
      instructions,
      entry.icon,
      entry.category,
      ownerUserId,
    ],
  );
}

async function seedLegacyGrant(ref: string, agentId: string): Promise<void> {
  await setup.$client.unsafe(
    `insert into plugin_grants (kind, ref, agent_id, granted_by)
     values ('skill', $1, $2, $3)`,
    [ref, agentId, adminUserId],
  );
}

/** A user for the legacy side that is NOT the enterprise admin. */
let legacyUserId: string;
/** Pristine expert-installed Bot WITH ownership (maps). */
let pristineAgentId: string;
/** Privately edited Bot WITH ownership (stays legacy). */
let editedAgentId: string;
/** Pristine Bot WITHOUT ownership (stays legacy — scope unproven). */
let unownedAgentId: string;
/** OCR-fix-F2 H-C: managed-Bot shape fresh install WITH ownership (maps). */
let managedAgentId: string;
/** OCR-fix-F2 H-C: hand-edited systemPrompt WITH ownership (stays legacy). */
let promptEditedAgentId: string;

async function countRows(sqlText: string): Promise<number> {
  const rows = (await setup.$client.unsafe(
    `select count(*)::int as n ${sqlText}`,
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function packageInstallCount(): Promise<number> {
  const rows = (await setup.$client.unsafe(
    `select count(*)::int as n from enterprise_package_installs
     where tenant_id = $1 and workspace_id = $2 and package_key = $3`,
    [tenantA, teamA1, BUILTIN_PACKAGE_KEY],
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  if (!ENV.ok) throw new Error(ENV.reason);
  urls = ENV.urls;
  fixture = await createPackageInstallFixture();
  setup = fixture.setup;
  tenantA = fixture.tenantOf("company-a");
  teamA1 = fixture.teamOf("company-a", "team-a1");
  const identities = fixture.base.isolation.identities;
  adminUserId =
    identities["company-admin"].kind === "human"
      ? (identities["company-admin"] as { userId?: string }).userId!
      : "";

  // The migrating actor is a REAL team member promoted to company admin via
  // the disclosed arrangement stand-in; every apply then runs through the
  // real authorizer under restricted roles.
  await fixture
    .addTeamMember("company-admin", "company-a", "a1-member", "team-a1")
    .catch((error: unknown) => {
      // A rerun against a primed library: the membership already exists.
      if (
        error instanceof Error &&
        error.message === "TEAM_MEMBER_ALREADY_EXISTS"
      )
        return;
      throw error;
    });
  await fixture.promoteToCompanyAdmin("a1-member", "company-a");
  legacyUserId = (identities["a1-member"] as { userId?: string }).userId!;

  // -- A rerun against the same physical test library must not trip over
  // the previous run's seed rows (superuser setup channel, disclosed).
  await setup.$client.unsafe(
    `delete from enterprise_bot_ownership where agent_id like 'pkg11-bot-%'`,
  );
  await setup.$client.unsafe(
    `delete from enterprise_package_experts where agent_id like 'pkg11-bot-%'`,
  );
  await setup.$client.unsafe(
    `delete from expert_installs where id like 'pkg11-ei-%' or owner_user_id = $1`,
    [legacyUserId],
  );
  await setup.$client.unsafe(
    `delete from skills where id like 'pkg11-skill-%'`,
  );
  await setup.$client.unsafe(`delete from agents where id like 'pkg11-bot-%'`);

  // -- Legacy stock (the world before PKG11). -----------------------------
  pristineAgentId = await seedLegacyBot({
    slug: EXPERT!.slug,
    ownerUserId: legacyUserId,
  });
  editedAgentId = await seedLegacyBot({
    slug: "data-analyst",
    ownerUserId: legacyUserId,
    edited: true,
  });
  unownedAgentId = await seedLegacyBot({
    slug: "ui-designer",
    ownerUserId: legacyUserId,
  });
  // OCR-fix-F2 H-C stock: the managed-Bot shape a deployment with a managed
  // AG-UI Bot writes on install (same profile, no persisted systemPrompt),
  // and a hand-altered systemPrompt over a pristine profile.
  managedAgentId = await seedLegacyBot({
    slug: "investment-analyst",
    ownerUserId: legacyUserId,
    managed: true,
  });
  promptEditedAgentId = await seedLegacyBot({
    slug: "learning-coach",
    ownerUserId: legacyUserId,
    promptEdited: true,
  });
  await seedOwnership(pristineAgentId);
  await seedOwnership(editedAgentId);
  await seedOwnership(managedAgentId);
  await seedOwnership(promptEditedAgentId);
  // unownedAgentId deliberately gets NO ownership row.
  // Slug-held stock from before PKG11 (F-T12-1): a deployment-wide row on
  // the pristine skill and another company member's private row on the
  // edited one — the two holder shapes the live legacy install path leaves.
  // Every run now drills over held slugs, the state a shared library
  // actually presents to a production migration.
  await seedHeldSkillRow(PRISTINE_SKILL!, null);
  await seedHeldSkillRow(
    EDITED_SKILL!,
    (fixture.base.isolation.identities["b1-member"] as { userId?: string })
      .userId!,
  );
  await seedSkillRow(PRISTINE_SKILL!.slug, legacyUserId, false);
  await seedSkillRow(EDITED_SKILL!.slug, legacyUserId, true);
  await seedSkillRow("chart-reading", legacyUserId, false);
  await seedLegacyGrant(PRISTINE_SKILL!.slug, pristineAgentId);
  await seedLegacyGrant(EDITED_SKILL!.slug, pristineAgentId);
  await seedLegacyGrant("chart-reading", unownedAgentId);
});

afterAll(async () => {
  if (fixture) await fixture.dispose();
});

// OCR-fix-G1 (R6-H2 同族): the migration's reference release comes from the
// index alone, so this arm needs no database.
describe("PKG11 built-in baseline selection (index only)", () => {
  const release = (version: string, state: "published" | "withdrawn") => ({
    packageKey: BUILTIN_PACKAGE_KEY,
    version,
    artifactDigest: "a".repeat(64),
    category: "productivity",
    listed: true,
    state,
  });

  async function indexWith(
    ...packages: ReturnType<typeof release>[]
  ): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pkg11-baseline-"));
    const indexPath = join(root, "marketplace.json");
    await writeFile(
      indexPath,
      `${JSON.stringify({ schemaVersion: 1, packages })}\n`,
    );
    return indexPath;
  }

  test("a withdrawn release is never the baseline, even when it is the newest", async () => {
    const indexPath = await indexWith(
      release("1.0.0", "published"),
      release("2.0.0", "withdrawn"),
    );
    expect((await builtinIndexEntry(indexPath))?.version).toBe("1.0.0");
  });

  test("every release withdrawn leaves no baseline (apply refuses BUILTIN_MISSING)", async () => {
    const indexPath = await indexWith(release("2.0.0", "withdrawn"));
    expect(await builtinIndexEntry(indexPath)).toBeNull();
  });
});

describeDb("PKG11 legacy migration drill (real restricted roles)", () => {
  test("the built-in package is registered and loadable from the shipped index", async () => {
    const entry = await builtinIndexEntry(INDEX_PATH);
    expect(entry?.packageKey).toBe(BUILTIN_PACKAGE_KEY);
    const catalogue = await loadPackageCatalogue({
      index: JSON.parse(await readFile(INDEX_PATH, "utf8")),
      artifactRoot: ARTIFACT_ROOT,
    });
    const page = await catalogue.list(
      await fixture.scopeFor("a1-member", "team-a1"),
      { limit: 50 },
    );
    expect(
      page.items.some((item) => item.packageKey === BUILTIN_PACKAGE_KEY),
    ).toBe(true);
  });

  test("dry-run is read-only and classifies every source record", async () => {
    const before = await packageInstallCount();
    const manifest = buildManifest(
      builtinFacts(await builtinIndexEntry(INDEX_PATH)),
      await readLegacyInventory(
        setup,
        setup,
        builtinFacts(await builtinIndexEntry(INDEX_PATH)),
      ),
    );
    // Read-only: no package rows appeared.
    expect(await packageInstallCount()).toBe(before);

    const pristine = manifest.sources.expertInstalls.find(
      (r) => r.agentId === pristineAgentId,
    );

    expect(pristine?.unresolved).toBeNull();
    expect(pristine?.mapping).toEqual({
      packageKey: BUILTIN_PACKAGE_KEY,
      resourceId: EXPERT!.slug,
    });
    expect(pristine?.ownership).toEqual({
      tenantId: tenantA,
      workspaceId: teamA1,
      ownerPrincipalId: fixture.principalOf("a1-member", "company-a"),
    });

    const edited = manifest.sources.expertInstalls.find(
      (r) => r.agentId === editedAgentId,
    );
    expect(edited?.unresolved).toBe("PRIVATE_EDIT");
    expect(edited?.mapping).toBeNull();

    const unowned = manifest.sources.expertInstalls.find(
      (r) => r.agentId === unownedAgentId,
    );
    expect(unowned?.unresolved).toBe("SCOPE_UNPROVEN");
    expect(unowned?.mapping).toBeNull();

    // OCR-fix-F2 H-C: the managed-Bot shape persists no configuration
    // .systemPrompt — the same content must classify as undrifted (the
    // pre-fix reference hash turned every such install into PRIVATE_EDIT),
    // and a hand-edited systemPrompt over a pristine profile stays a
    // private edit.
    const managed = manifest.sources.expertInstalls.find(
      (r) => r.agentId === managedAgentId,
    );
    expect(managed?.unresolved).toBeNull();
    expect(managed?.mapping).toEqual({
      packageKey: BUILTIN_PACKAGE_KEY,
      resourceId: "investment-analyst",
    });

    const promptEdited = manifest.sources.expertInstalls.find(
      (r) => r.agentId === promptEditedAgentId,
    );
    expect(promptEdited?.unresolved).toBe("PRIVATE_EDIT");
    expect(promptEdited?.mapping).toBeNull();

    const grants = manifest.sources.grants.filter(
      (r) => r.agentId === pristineAgentId,
    );
    expect(
      grants.find((r) => r.ref === PRISTINE_SKILL!.slug)?.unresolved,
    ).toBeNull();
    expect(grants.find((r) => r.ref === EDITED_SKILL!.slug)?.unresolved).toBe(
      "PRIVATE_EDIT",
    );
    const unownedGrant = manifest.sources.grants.find(
      (r) => r.agentId === unownedAgentId,
    );
    expect(unownedGrant?.unresolved).toBe("SCOPE_UNPROVEN");

    const editedRow = manifest.sources.skillRows.find(
      (r) => r.slug === EDITED_SKILL!.slug,
    );
    expect(editedRow?.matchesBuiltin).toBe(false);
    expect(editedRow?.unresolved).toBe("PRIVATE_EDIT");

    // Connector inventory stays legacy in V1 (no declaring package).
    expect(
      manifest.sources.connectorInstalls.every(
        (r) => r.unresolved === "NO_DECLARING_PACKAGE" && r.mapping === null,
      ),
    ).toBe(true);

    expect(manifest.counts.mappedExpertInstalls).toBe(2);
    expect(manifest.counts.mappedGrants).toBe(1);
    expect(manifest.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("apply refuses a source that changed since the dry-run (CAS)", async () => {
    const builtin = builtinFacts(await builtinIndexEntry(INDEX_PATH));
    const manifest = buildManifest(
      builtin,
      await readLegacyInventory(setup, setup, builtin),
    );
    // Concurrent source change AFTER the dry-run.
    await setup.$client.unsafe(
      `update skills set instructions = instructions || '（并发改）' where slug = $1`,
      [PRISTINE_SKILL!.slug],
    );
    const path = `/tmp/pkg11-cas-${randomUUID()}.json`;
    await writeFile(path, JSON.stringify(manifest));
    const outcome = await runApply({
      manifestPath: path,
      expectedDigest: manifest.manifestDigest,
      scope: { tenantId: tenantA, workspaceId: teamA1 },
      actorUserId: (
        fixture.base.isolation.identities["a1-member"] as { userId: string }
      ).userId,
      indexPath: INDEX_PATH,
      artifactRoot: ARTIFACT_ROOT,
      urls: {
        legacyUrl: urls.setup,
        setupUrl: urls.setup,
        directoryUrl: urls.directory,
        dataUrl: urls.data,
        operatorUrl: urls.operator,
      },
    });
    expect(outcome.refused).toBe(true);
    expect((outcome as { code: string }).code).toBe("SOURCE_CHANGED");
    // Nothing was written by the refused apply (this run's tenant only —
    // the shared library carries other suites' installs).
    const casRows = (await setup.$client.unsafe(
      `select count(*)::int as n from enterprise_package_installs where tenant_id = $1`,
      [tenantA],
    )) as Array<{ n: number }>;
    expect(casRows[0]?.n).toBe(0);

    // Restore the concurrent edit for the happy-path drill below.
    await setup.$client.unsafe(
      `update skills set instructions = $2 where slug = $1`,
      [PRISTINE_SKILL!.slug, PRISTINE_SKILL!.instructions],
    );
  });

  test("apply refuses a wrong bound digest (explicit manifest binding)", async () => {
    const builtin = builtinFacts(await builtinIndexEntry(INDEX_PATH));
    const manifest = buildManifest(
      builtin,
      await readLegacyInventory(setup, setup, builtin),
    );
    const path = `/tmp/pkg11-bind-${randomUUID()}.json`;
    await writeFile(path, JSON.stringify(manifest));
    const outcome = await runApply({
      manifestPath: path,
      expectedDigest: "0".repeat(64),
      scope: { tenantId: tenantA, workspaceId: teamA1 },
      actorUserId: (
        fixture.base.isolation.identities["a1-member"] as { userId: string }
      ).userId,
      indexPath: INDEX_PATH,
      artifactRoot: ARTIFACT_ROOT,
      urls: {
        legacyUrl: urls.setup,
        setupUrl: urls.setup,
        directoryUrl: urls.directory,
        dataUrl: urls.data,
        operatorUrl: urls.operator,
      },
    });
    expect(outcome.refused).toBe(true);
    expect((outcome as { code: string }).code).toBe("MANIFEST_DIGEST_MISMATCH");
  });

  // OCR-fix-E (R4-H5): an install the administrator disabled or uninstalled
  // must refuse the apply as a typed machine-readable receipt BEFORE any
  // write — the old guard reused a disabled install (provenance landed, then
  // the grant step threw: half-applied) and replanned over an uninstalled
  // tombstone (PACKAGE_UNSUPPORTED mid-apply, no receipt at all). Re-enabling
  // is an administrator lifecycle action the migration must not take over.
  // OCR-fix-G1 (R6-H2): the same refusal covers an ENABLED install that runs
  // a different release than the manifest bound — reusing it writes
  // provenance (and would grant) against a release the manifest never mapped.
  // Seeded via the superuser setup channel (the suite's disclosed
  // arrangement); removed in finally so the happy-path drill below still
  // starts from no install even when this arm goes red.
  async function refuseInstallRow(input: {
    status: "disabled" | "uninstalled" | "enabled";
    /** The seeded row's release; defaults to the one the manifest bound. */
    currentVersion?: string;
    code: "MIGRATION_INSTALL_NOT_ENABLED" | "BUILTIN_DRIFT";
  }): Promise<void> {
    const currentVersion = input.currentVersion;
    const builtin = builtinFacts(await builtinIndexEntry(INDEX_PATH));
    const manifest = buildManifest(
      builtin,
      await readLegacyInventory(setup, setup, builtin),
    );
    const installId = `pkg11-arm-${randomUUID()}`;
    await setup.$client.unsafe(
      `insert into enterprise_package_installs
         (tenant_id, id, workspace_id, package_key, current_version, status, installed_by)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tenantA,
        installId,
        teamA1,
        BUILTIN_PACKAGE_KEY,
        currentVersion ?? builtin.version,
        input.status,
        fixture.principalOf("a1-member", "company-a"),
      ],
    );
    try {
      const path = `/tmp/pkg11-arm-${input.status}-${randomUUID()}.json`;
      await writeFile(path, JSON.stringify(manifest));
      const outcome = await runApply({
        manifestPath: path,
        expectedDigest: manifest.manifestDigest,
        scope: { tenantId: tenantA, workspaceId: teamA1 },
        actorUserId: (
          fixture.base.isolation.identities["a1-member"] as { userId: string }
        ).userId,
        indexPath: INDEX_PATH,
        artifactRoot: ARTIFACT_ROOT,
        urls: {
          legacyUrl: urls.setup,
          setupUrl: urls.setup,
          directoryUrl: urls.directory,
          dataUrl: urls.data,
          operatorUrl: urls.operator,
        },
      });
      expect(outcome.refused).toBe(true);
      expect((outcome as { code: string }).code).toBe(input.code);
      // Zero partial writes: no expert provenance, no grants, and the
      // install row itself untouched (status, version and revision as seeded).
      expect(
        await countRows(
          `from enterprise_package_experts where tenant_id = '${tenantA}'`,
        ),
      ).toBe(0);
      expect(
        await countRows(
          `from enterprise_package_grants where tenant_id = '${tenantA}'`,
        ),
      ).toBe(0);
      const [row] = (await setup.$client.unsafe(
        `select status, revision, current_version from enterprise_package_installs
         where tenant_id = $1 and workspace_id = $2 and package_key = $3`,
        [tenantA, teamA1, BUILTIN_PACKAGE_KEY],
      )) as Array<{
        status: string;
        revision: number;
        current_version: string;
      }>;
      expect(row?.status).toBe(input.status);
      expect(row?.revision).toBe(1);
      expect(row?.current_version).toBe(currentVersion ?? builtin.version);
    } finally {
      await setup.$client.unsafe(
        `delete from enterprise_package_experts where tenant_id = $1`,
        [tenantA],
      );
      await setup.$client.unsafe(
        `delete from enterprise_package_grants where tenant_id = $1`,
        [tenantA],
      );
      await setup.$client.unsafe(
        `delete from enterprise_package_installs where tenant_id = $1 and id = $2`,
        [tenantA, installId],
      );
    }
  }

  test("apply refuses a disabled install with a typed receipt and zero writes", async () => {
    await refuseInstallRow({
      status: "disabled",
      code: "MIGRATION_INSTALL_NOT_ENABLED",
    });
  });

  test("apply refuses an uninstalled tombstone with a typed receipt and zero writes", async () => {
    await refuseInstallRow({
      status: "uninstalled",
      code: "MIGRATION_INSTALL_NOT_ENABLED",
    });
  });

  test("apply refuses an enabled install of a different release with a typed receipt and zero writes", async () => {
    await refuseInstallRow({
      status: "enabled",
      currentVersion: "9.9.9",
      code: "BUILTIN_DRIFT",
    });
  });

  test("apply migrates only proven records and never writes legacy rows", async () => {
    const builtin = builtinFacts(await builtinIndexEntry(INDEX_PATH));
    const manifest = buildManifest(
      builtin,
      await readLegacyInventory(setup, setup, builtin),
    );
    const path = `/tmp/pkg11-apply-${randomUUID()}.json`;
    await writeFile(path, JSON.stringify(manifest));

    const legacyExpertRows = await countRows("from expert_installs");
    const legacyGrantRows = await countRows("from plugin_grants");
    const editedBotProfile = (await setup.$client.unsafe(
      `select role_description from agent_profiles where agent_id = $1`,
      [editedAgentId],
    )) as Array<{ role_description: string }>;
    const editedSkill = (await setup.$client.unsafe(
      `select instructions from skills where slug = $1`,
      [EDITED_SKILL!.slug],
    )) as Array<{ instructions: string }>;

    const outcome: ApplyOutcome = await runApply({
      manifestPath: path,
      expectedDigest: manifest.manifestDigest,
      scope: { tenantId: tenantA, workspaceId: teamA1 },
      actorUserId: (
        fixture.base.isolation.identities["a1-member"] as { userId: string }
      ).userId,
      indexPath: INDEX_PATH,
      artifactRoot: ARTIFACT_ROOT,
      urls: {
        legacyUrl: urls.setup,
        setupUrl: urls.setup,
        directoryUrl: urls.directory,
        dataUrl: urls.data,
        operatorUrl: urls.operator,
      },
    });
    expect(outcome.refused).toBe(false);
    if (outcome.refused) return;
    expect(outcome.install.created).toBe(true);
    // OCR-fix-F2 H-C: the managed-shape install maps too, so its provenance
    // row is written alongside the pristine one (botsGranted stays 1 — the
    // managed Bot carries no legacy skill grants).
    expect(outcome.provenanceWritten).toBe(2);
    expect(outcome.botsGranted).toBe(1);

    // Exactly one install, one provenance row per mapped Bot, one grant set.
    expect(await packageInstallCount()).toBe(1);
    expect(
      await countRows(
        `from enterprise_package_experts where agent_id = '${pristineAgentId}'`,
      ),
    ).toBe(1);
    expect(
      await countRows(
        `from enterprise_package_experts where agent_id = '${managedAgentId}'`,
      ),
    ).toBe(1);
    expect(
      await countRows(
        `from enterprise_package_experts where agent_id = '${editedAgentId}' or agent_id = '${unownedAgentId}' or agent_id = '${promptEditedAgentId}'`,
      ),
    ).toBe(0);
    // OCR-fix-C (R2-H4): expert provenance records the install's actual
    // revision — the authoritative step-6 value, never a fallback.
    const [revisionPair] = (await setup.$client.unsafe(
      `select (select revision from enterprise_package_experts
                where tenant_id = $1 and workspace_id = $2 and agent_id = $3) as expert_revision,
              (select revision from enterprise_package_installs
                where tenant_id = $1 and workspace_id = $2 and id = $4) as install_revision`,
      [tenantA, teamA1, pristineAgentId, outcome.install.installId],
    )) as Array<{
      expert_revision: number;
      install_revision: number;
    }>;
    expect(revisionPair?.expert_revision).toBe(revisionPair?.install_revision);
    const grants = (await setup.$client.unsafe(
      `select resource_id from enterprise_package_grants
       where tenant_id = $1 and workspace_id = $2 and bot_id = $3 and revoked_at is null`,
      [tenantA, teamA1, pristineAgentId],
    )) as Array<{ resource_id: string }>;
    expect(grants.map((row) => row.resource_id).sort()).toEqual([
      PRISTINE_SKILL!.slug,
    ]);

    // Single writer, no private-edit overwrite: every legacy row identical.
    expect(await countRows("from expert_installs")).toBe(legacyExpertRows);
    expect(await countRows("from plugin_grants")).toBe(legacyGrantRows);
    const afterProfile = (await setup.$client.unsafe(
      `select role_description from agent_profiles where agent_id = $1`,
      [editedAgentId],
    )) as Array<{ role_description: string }>;
    expect(afterProfile[0]?.role_description).toBe(
      editedBotProfile[0]?.role_description,
    );
    const afterSkill = (await setup.$client.unsafe(
      `select instructions from skills where slug = $1`,
      [EDITED_SKILL!.slug],
    )) as Array<{ instructions: string }>;
    expect(afterSkill[0]?.instructions).toBe(editedSkill[0]?.instructions);
  });

  test("apply replay is a no-op (idempotent convergence)", async () => {
    const builtin = builtinFacts(await builtinIndexEntry(INDEX_PATH));
    const manifest = buildManifest(
      builtin,
      await readLegacyInventory(setup, setup, builtin),
    );
    const path = `/tmp/pkg11-replay-${randomUUID()}.json`;
    await writeFile(path, JSON.stringify(manifest));
    const outcome = await runApply({
      manifestPath: path,
      expectedDigest: manifest.manifestDigest,
      scope: { tenantId: tenantA, workspaceId: teamA1 },
      actorUserId: (
        fixture.base.isolation.identities["a1-member"] as { userId: string }
      ).userId,
      indexPath: INDEX_PATH,
      artifactRoot: ARTIFACT_ROOT,
      urls: {
        legacyUrl: urls.setup,
        setupUrl: urls.setup,
        directoryUrl: urls.directory,
        dataUrl: urls.data,
        operatorUrl: urls.operator,
      },
    });
    expect(outcome.refused).toBe(false);
    if (outcome.refused) return;
    expect(outcome.install.created).toBe(false);
    expect(outcome.provenanceWritten).toBe(0);
    expect(outcome.botsGranted).toBe(0);
    expect(await packageInstallCount()).toBe(1);
  });

  test("shadow read records the same-scope diff without writing", async () => {
    const report = await shadowReadForScope(
      setup,
      setup,
      { tenantId: tenantA, workspaceId: teamA1 },
      builtinFacts(await builtinIndexEntry(INDEX_PATH)),
    );
    // The migrated expert and its granted skill are visible on BOTH sides.
    expect(report.matched).toContain(`expert:${EXPERT!.slug}`);
    expect(report.matched).toContain(`skill:${PRISTINE_SKILL!.slug}`);
    // What stayed legacy reads as legacy-only: the privately-edited expert
    // (data-analyst) and the privately-edited skill grant.
    expect(report.legacyOnly).toContain("expert:data-analyst");
    expect(report.legacyOnly).toContain(`skill:${EDITED_SKILL!.slug}`);
    // The unowned bot's grant is invisible to BOTH read paths — no
    // enterprise scope ever claimed it, so it migrates nowhere and appears
    // in neither set (范围归属不可证 ⇒ 不迁).
    expect(report.legacyVisible).not.toContain("skill:chart-reading");
    expect(report.packageVisible).not.toContain("skill:chart-reading");
    // The diff helper itself is exact and order-independent.
    expect(
      diffShadowRead(["expert:a", "skill:b"], ["expertTemplate:a", "skill:c"]),
    ).toEqual({
      matched: ["expert:a"],
      legacyOnly: ["skill:b"],
      packageOnly: ["skill:c"],
    });
  });

  test("the legacy marketplace route never writes package tables (single writer)", async () => {
    const app = new Hono();
    const before = await countRows(`from enterprise_package_installs`);
    const legacyInstalls = await countRows("from expert_installs");
    app.route(
      "/api/marketplace",
      createMarketplaceRoutes({
        installs: createMarketplaceStore(setup),
        // Minimal agent seam: the route's own Bot-creation path is not under
        // test; the RECEIPT write is. No skillWrites/grants: the route then
        // only writes expert_installs — exactly the legacy-side writer.
        agents: {
          create: async (_actor, input: { name: string }) => {
            const id = `pkg11-route-bot-${randomUUID()}`;
            await setup.$client.unsafe(
              `insert into agents (id, name, type, configuration)
               values ($1, $2, 'built_in', '{"systemPrompt":"seed"}'::jsonb)`,
              [id, input.name],
            );
            return { id };
          },
          softDelete: async () => {},
        },
        requireUser: (async (context, next) => {
          context.set("actor", {
            id: legacyUserId,
            role: "user" as const,
            email: "pkg11@example.invalid",
          });
          await next();
        }) as never,
      }),
    );
    const slug = CATALOGUE_EXPERTS.find((e) => e.slug === "tech-writer")!.slug;
    const response = await app.request(
      `/api/marketplace/experts/${slug}/install`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(201);
    expect(await countRows("from expert_installs")).toBe(legacyInstalls + 1);
    expect(await countRows(`from enterprise_package_installs`)).toBe(before);
  });

  test("rollback drill: gate closed keeps reads/revoke alive and writes refused", async () => {
    // The REAL route surface over the REAL service (restricted channels),
    // mounted with the deployment switch OFF — the documented rollback move.
    const catalogue = await loadPackageCatalogue({
      index: JSON.parse(await readFile(INDEX_PATH, "utf8")),
      artifactRoot: ARTIFACT_ROOT,
    });
    const service = createPackageService({
      catalogue,
      readStore: fixture.readStore,
      mutation: fixture.mutation,
    });
    const app = new Hono();
    app.route(
      "/api/enterprise/plugin-packages",
      createPluginPackageRoutes({
        gate: createMarketplaceGate({ enabled: false, pilotWorkspaces: [] }),
        catalogue,
        service,
        resolveScope: async (request) =>
          fixture.base.scopeFor("a1-member", {
            tenantId: request.headers.get("x-openbot-tenant") ?? tenantA,
            workspaceId: teamA1,
          }),
        resolveAdmin: async () =>
          fixture.adminContextOf("a1-member", "company-a"),
      }),
    );
    const headers = {
      "content-type": "application/json",
      "x-openbot-tenant": tenantA,
      "idempotency-key": "pkg11-rollback-1",
    };

    // Reads keep answering with the migrated install.
    const list = await app.request("/api/enterprise/plugin-packages", {
      headers,
    });
    expect(list.status).toBe(200);
    const installRows = (await setup.$client.unsafe(
      `select id from enterprise_package_installs
       where tenant_id = $1 and workspace_id = $2 and package_key = $3`,
      [tenantA, teamA1, BUILTIN_PACKAGE_KEY],
    )) as Array<{ id: string }>;
    const detail = await app.request(
      `/api/enterprise/plugin-packages/installs/${installRows[0]!.id}`,
      { headers },
    );
    expect(detail.status).toBe(200);

    // New writes refuse with the closed-entry body.
    const plan = await app.request("/api/enterprise/plugin-packages/plans", {
      method: "POST",
      headers,
      body: JSON.stringify({
        operation: "install",
        packageKey: BUILTIN_PACKAGE_KEY,
        version: "1.0.0",
        expectedRevision: null,
        config: {},
        connectorInstalls: {},
      }),
    });
    expect(plan.status).toBe(503);
    expect(
      ((await plan.json()) as { error: { code: string } }).error.code,
    ).toBe("MARKETPLACE_ENTRY_DISABLED");
  });
});
