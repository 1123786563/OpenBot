// server/tests/multitenancy/package-expert.test.ts
// PKG04（Issue #463）：插件包专家实例化——真实受限 PostgreSQL 角色。
//
// 证据面（逐条对应 Task Brief PKG04A acceptance 1–7）：
//   (1) 模板文件 strict JSON 只收 name/summary/systemPrompt/包内 Skill refs；
//       endpoint/auth/remote-runtime/未知字段 → TEMPLATE_FIELD_REJECTED，文件
//       skills 与 manifest 不一致 → 同拒绝（模板依据安装修订的制品 loadArtifact
//       判定，与请求无关）。
//   (2) 创建的 Bot 强制 built_in（SQL 函数层拒绝 endpoint/auth 键与非
//       built_in agentType）；owner/workspace 全部来自受信 scope。
//   (3) profile + ownership + provenance + 初始 Skill grant 在同一个 operator
//       事务提交；事务中途失败（模板引用了未链接资源）→ 四张表零残留。
//   (4) 同 (actor, Idempotency-Key) 重放 → 同一 agentId（created=false）；
//       同键异输入 → IDEMPOTENCY_CONFLICT。
//   (5) 受限创建函数 openbot_create_package_expert：PUBLIC 零 EXECUTE，仅
//       ob_ent_operator 可执行；data 角色调用 42501；伪造 workspace 上下文 /
//       endpoint 配置在函数层响亮拒绝；非 tenant_admin / 跨公司 / 未知安装
//       全部同形拒绝。
//   (6) 无 connector 工具授权、无账号连接、无其他写入（授权行全为 skill，
//       enterprise_plugin_connections 计数不变）。
//   (7) provenance 仅是元数据：存储层无 UPDATE/DELETE 通道；安装推进到
//       revision 2（升级形状）不触碰已创建行。
//   (8) 安装行读取与 CAS 检查在 install advisory lock 之内执行：对手会话持锁
//       并在窗口内推进 revision 2 后释放 → 实例化重读得到 REVISION_CONFLICT，
//       零残留（与 grants.ts 的 grantLockKeys 加锁顺序同形）。
//
// 环境契约：只认显式企业测试库环境变量；缺配置时整套显式 skip（skipped
// 不计为通过），绝不回退开发库。

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createDatabase, type Database } from "../../src/db/client";
import {
  buildArtifact,
  storeArtifact,
} from "../../src/plugin-packages/artifact";
import type {
  PackageCatalogue,
  PackageReleaseFacts,
} from "../../src/plugin-packages/catalogue";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  applyPackageTasks,
  createPackageInstallFixture,
  type PackageInstallFixture,
  thrownMessage,
  thrownSqlState,
} from "./support/package-install";

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `PKG04 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseTestDatabaseUrlFrom(process.env);
    for (const role of ["directory", "data", "operator"] as const) {
      enterpriseRuntimeDatabaseUrlFrom(role, process.env);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Probe packages: real artifacts built and verified by the real artifact code.
// ---------------------------------------------------------------------------

const GOOD_TEMPLATE = {
  name: "Meeting Assistant",
  summary: "Runs meeting follow-ups for the team.",
  systemPrompt: "You are the meeting follow-up assistant.",
  skills: ["summarize"],
};

/** The extra field each probe variant smuggles in (null = the good template). */
const TEMPLATE_VARIANTS: ReadonlyArray<
  readonly [string, Record<string, unknown> | null]
> = [
  ["assistant", GOOD_TEMPLATE],
  ["endpoint", { ...GOOD_TEMPLATE, endpoint: "https://evil.example" }],
  ["auth", { ...GOOD_TEMPLATE, auth: { header: "x-key", value: "secret" } }],
  ["remote-agent-id", { ...GOOD_TEMPLATE, remoteAgentId: "agent-1" }],
  ["unknown-field", { ...GOOD_TEMPLATE, temperature: 0.5 }],
  ["skills-mismatch", { ...GOOD_TEMPLATE, skills: [] }],
];

interface ProbePackage {
  readonly packageKey: string;
  readonly artifactDigest: string;
  readonly manifest: PackageReleaseFacts["manifest"];
  readonly templateRef: string;
}

async function buildProbePackages(): Promise<{
  root: string;
  packages: ReadonlyMap<string, ProbePackage>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pkg04-artifacts-"));
  const packages = new Map<string, ProbePackage>();
  for (const [variant, template] of TEMPLATE_VARIANTS) {
    const name = `pkg04-${variant}`;
    const packageDir = join(root, "build", name);
    await mkdir(join(packageDir, "skills", "summarize"), { recursive: true });
    await mkdir(join(packageDir, "experts"), { recursive: true });
    await writeFile(
      join(packageDir, "openbot.plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        platformApi: 1,
        publisher: "openbot",
        name,
        version: "1.0.0",
        display: {
          name: `PKG04 ${variant}`,
          summary: "The PKG04 probe package.",
        },
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
        dependencies: [],
      }),
    );
    await writeFile(
      join(packageDir, "skills", "summarize", "SKILL.md"),
      "# Summarize\n\nSummarize a long note into a short brief.",
    );
    await writeFile(
      join(packageDir, "experts", "assistant.json"),
      JSON.stringify(template ?? GOOD_TEMPLATE),
    );
    // The real artifact verifier: digest, walk, symlink/escape checks.
    const artifact = await buildArtifact(packageDir);
    await storeArtifact(artifact, root);
    packages.set(variant, {
      packageKey: `openbot/${name}`,
      artifactDigest: artifact.digest,
      manifest: artifact.manifest,
      templateRef: `openbot/${name}/assistant`,
    });
  }
  return { root, packages };
}

/** Catalogue fake over real verified release facts (PKG03 probe pattern). */
function probeCatalogue(
  packages: ReadonlyMap<string, ProbePackage>,
): PackageCatalogue {
  const releaseOf = (packageKey: string): PackageReleaseFacts | null => {
    const probe = [...packages.values()].find(
      (candidate) => candidate.packageKey === packageKey,
    );
    if (!probe) return null;
    return {
      packageKey: probe.packageKey,
      version: "1.0.0",
      artifactDigest: probe.artifactDigest,
      category: "productivity",
      listed: true,
      state: "published",
      verified: true,
      displayName: "PKG04 probe package",
      summary: "The PKG04 probe package.",
      blockers: [],
      manifest: probe.manifest,
    };
  };
  return {
    async list() {
      return {
        items: [],
        nextCursor: null,
      };
    },
    async get() {
      throw new Error("not used");
    },
    async resolveRelease(packageKey, version) {
      return version === "1.0.0" ? releaseOf(packageKey) : null;
    },
  };
}

// ---------------------------------------------------------------------------

let fixture: PackageInstallFixture;
let setup: Database;
let artifactRoot: string;
let packages: ReadonlyMap<string, ProbePackage>;
let seq = 0;
const nextKey = (label: string) => `pkg04-${label}-${++seq}`;

async function seedInstall(input: {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly packageKey: string;
  readonly artifactDigest: string;
  readonly status?: "enabled" | "disabled" | "uninstalled";
}): Promise<string> {
  const installId = `pkg04-install-${crypto.randomUUID()}`;
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${input.tenantId}, true), set_config('app.workspace_id', ${input.workspaceId}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_package_installs
            (tenant_id, id, workspace_id, package_key, current_version, status, installed_by)
          values (${input.tenantId}, ${installId}, ${input.workspaceId}, ${input.packageKey}, '1.0.0', ${input.status ?? "enabled"}, ${input.principalId})`,
    );
    await tx.execute(
      sql`insert into enterprise_package_revisions
            (tenant_id, install_id, revision, release_version, artifact_digest, config, created_by)
          values (${input.tenantId}, ${installId}, 1, '1.0.0', ${input.artifactDigest}, '{}'::jsonb, ${input.principalId})`,
    );
    await tx.execute(
      sql`insert into enterprise_package_resource_links
            (tenant_id, install_id, revision, resource_id, workspace_id, kind)
          values (${input.tenantId}, ${installId}, 1, 'summarize', ${input.workspaceId}, 'skill')`,
    );
  });
  return installId;
}

async function countRows(
  table: string,
  where: string,
  binds: readonly (string | number)[],
): Promise<number> {
  const rows = (await setup.$client.unsafe(
    `select count(*)::int as n from ${table} where ${where}`,
    [...binds],
  )) as Array<Record<string, unknown>>;
  return Number(rows[0]?.n ?? 0);
}

async function scalarRows(
  query: string,
): Promise<Array<Record<string, unknown>>> {
  return (await setup.$client.unsafe(query)) as Array<Record<string, unknown>>;
}

async function expertService() {
  const { createPackageService } = await import(
    "../../src/enterprise/plugin-packages/install-service"
  );
  return createPackageService({
    catalogue: probeCatalogue(packages),
    readStore: fixture.readStore,
    mutation: fixture.mutation,
    artifactRoot,
  });
}

async function connectionCount(tenantId: string): Promise<number> {
  const rows = (await setup.$client.unsafe(
    "select count(*)::int as n from enterprise_plugin_connections where tenant_id = $1",
    [tenantId],
  )) as Array<Record<string, unknown>>;
  return Number(rows[0]?.n ?? 0);
}

describeDb("PKG04 package expert instantiation (real restricted roles)", () => {
  const companyA = () => fixture.tenantOf("company-a");
  const teamA1 = () => fixture.teamOf("company-a", "team-a1");
  const adminPrincipal = () =>
    fixture.principalOf("company-admin", "company-a");
  let goodInstallId: string;

  beforeAll(async () => {
    await applyPackageTasks();
    fixture = await createPackageInstallFixture();
    setup = fixture.setup;
    const built = await buildProbePackages();
    // Reuses of the SAME verified release under distinct package keys: the
    // install unique index is per (tenant, workspace, package_key), so every
    // test that seeds its own install of the good release needs its own key
    // or the suite collides on enterprise_package_install_scope_key_uq.
    //   - assistantUpgrade: the provenance-immutability (upgrade shape) test;
    //   - assistantAtomic: the mid-transaction rollback test;
    //   - assistantDisabled: the PACKAGE_UNSUPPORTED (disabled install) test.
    const catalogueEntries = new Map(built.packages);
    const good = built.packages.get("assistant")!;
    for (const alias of [
      "assistantUpgrade",
      "assistantAtomic",
      "assistantDisabled",
      "assistantSerialize",
    ] as const) {
      catalogueEntries.set(alias, {
        ...good,
        packageKey: `${good.packageKey}-${alias.replace("assistant", "").toLowerCase()}`,
        templateRef: `${good.packageKey}-${alias.replace("assistant", "").toLowerCase()}/assistant`,
      });
    }
    artifactRoot = built.root;
    packages = catalogueEntries;
    await fixture.addTeamMember(
      "company-admin",
      "company-a",
      "company-admin",
      "team-a1",
    );
    // a1-member is already on team-a1 by the base fixture's seeded plan.
    goodInstallId = await seedInstall({
      tenantId: companyA(),
      workspaceId: teamA1(),
      principalId: adminPrincipal(),
      packageKey: packages.get("assistant")!.packageKey,
      artifactDigest: packages.get("assistant")!.artifactDigest,
    });
  });

  afterAll(async () => {
    if (artifactRoot) {
      await rm(artifactRoot, { recursive: true, force: true }).catch(() => {});
    }
    if (fixture) await fixture.dispose();
  });

  itDb(
    "applies the PKG04 task after PKG03 through the real migration tool",
    async () => {
      expect(
        await fixture.probes.tableExists("enterprise_package_experts"),
      ).toBe(true);
      const flags = await fixture.probes.rlsFlags("enterprise_package_experts");
      expect(flags.relrowsecurity).toBe(true);
      expect(flags.relforcerowsecurity).toBe(true);
      const columns = await fixture.probes.columnsOf(
        "enterprise_package_experts",
      );
      for (const column of [
        "tenant_id",
        "workspace_id",
        "agent_id",
        "install_id",
        "revision",
        "resource_id",
        "expert_template_ref",
        "created_by",
        "created_at",
      ]) {
        expect(columns).toContain(column);
      }
      // The changes action CHECK now admits createExpert receipts.
      const rows = (await setup.$client.unsafe(
        `select pg_get_constraintdef(oid) as def from pg_constraint
         where conname = 'enterprise_package_change_action'`,
      )) as Array<{ def: string }>;
      expect(rows[0]?.def).toContain("'createExpert'");
      // R4-4: the appended hardening step published the recursive,
      // case-insensitive key scanner — the live function body is the evidence.
      const fnBody = (await setup.$client.unsafe(
        `select prosrc from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'openbot_create_package_expert'`,
      )) as Array<{ prosrc: string }>;
      expect(fnBody[0]?.prosrc).toContain("$.**");
      expect(fnBody[0]?.prosrc).toContain("keyvalue()");
      expect(fnBody[0]?.prosrc).toContain('flag "i"');
    },
  );

  itDb(
    "the provenance table exposes the minimal privilege shape (no UPDATE/DELETE)",
    async () => {
      expect(
        await fixture.probes.hasPrivilege(
          "enterprise_package_experts",
          "ob_ent_data",
          "SELECT",
        ),
      ).toBe(true);
      for (const privilege of ["INSERT", "UPDATE", "DELETE"] as const) {
        expect(
          await fixture.probes.hasPrivilege(
            "enterprise_package_experts",
            "ob_ent_data",
            privilege,
          ),
        ).toBe(false);
      }
      expect(
        await fixture.probes.hasPrivilege(
          "enterprise_package_experts",
          "ob_ent_operator",
          "SELECT",
        ),
      ).toBe(true);
      expect(
        await fixture.probes.hasPrivilege(
          "enterprise_package_experts",
          "ob_ent_operator",
          "INSERT",
        ),
      ).toBe(true);
      for (const privilege of ["UPDATE", "DELETE"] as const) {
        expect(
          await fixture.probes.hasPrivilege(
            "enterprise_package_experts",
            "ob_ent_operator",
            privilege,
          ),
        ).toBe(false);
      }
      for (const privilege of [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
      ] as const) {
        expect(
          await fixture.probes.hasPrivilege(
            "enterprise_package_experts",
            "ob_ent_directory",
            privilege,
          ),
        ).toBe(false);
      }
    },
  );

  itDb(
    "the restricted creation function is operator-EXECUTE only, PUBLIC revoked",
    async () => {
      const signature =
        "openbot_create_package_expert(text,text,text,text,text,jsonb)";
      const probe = async (role: string) => {
        const rows = (await setup.$client.unsafe(
          "select has_function_privilege($1, $2, 'EXECUTE') as allowed",
          [role, signature],
        )) as Array<{ allowed: boolean }>;
        return Boolean(rows[0]?.allowed);
      };
      expect(await probe("ob_ent_operator")).toBe(true);
      // PostgreSQL has no "PUBLIC" role for has_function_privilege; the
      // revoked default grant reads as: no grantee-0 EXECUTE row in the
      // function's resolved ACL (a missing proacl would fall back to the
      // default ACL, where PUBLIC holds EXECUTE — also covered).
      const publicRows = (await setup.$client.unsafe(
        `select exists (
           select 1
           from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           where a.grantee = 0 and a.privilege_type = 'EXECUTE'
         ) as allowed
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.oid = $1::regprocedure`,
        [signature],
      )) as Array<{ allowed: boolean }>;
      expect(publicRows.length).toBe(1);
      expect(Boolean(publicRows[0]?.allowed)).toBe(false);
      expect(await probe("ob_ent_data")).toBe(false);
      expect(await probe("ob_ent_directory")).toBe(false);
    },
  );

  itDb(
    "instantiates a scoped Bot from the installed revision's template (atomic, forced built_in)",
    async () => {
      const service = await expertService();
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const key = nextKey("create");
      const result = await service.instantiateExpert(
        scope,
        admin,
        {
          installId: goodInstallId,
          resourceId: "assistant",
          expectedRevision: 1,
          name: "PKG04 Expert Bot",
        },
        key,
      );
      expect(result.created).toBe(true);
      expect(result.expert.agentId).toMatch(/^pkg-expert-/);
      expect(result.expert.expertTemplateRef).toBe(
        packages.get("assistant")!.templateRef,
      );
      expect(result.expert.resources).toEqual([
        { resourceId: "summarize", kind: "skill" },
      ]);
      expect(result.expert.grantRevision).toBe(1);

      // Ownership row: forced built_in config, server-resolved owner/team.
      const ownership = await scalarRows(
        `select owner_principal_id, workspace_id, display_name, default_config::text as config,
                status from enterprise_bot_ownership
         where tenant_id = '${companyA()}' and agent_id = '${result.expert.agentId}'`,
      );
      expect(ownership.length).toBe(1);
      const config = JSON.parse(String(ownership[0]!.config)) as Record<
        string,
        unknown
      >;
      expect(config.agentType).toBe("built_in");
      expect(config.systemPrompt).toBe(GOOD_TEMPLATE.systemPrompt);
      expect(config.summary).toBe(GOOD_TEMPLATE.summary);
      for (const forbidden of ["endpoint", "auth", "remoteAgentId"]) {
        expect(config).not.toHaveProperty(forbidden);
      }
      expect(ownership[0]!.owner_principal_id).toBe(adminPrincipal());
      expect(ownership[0]!.workspace_id).toBe(teamA1());
      expect(ownership[0]!.display_name).toBe("PKG04 Expert Bot");
      expect(ownership[0]!.status).toBe("active");

      // Provenance row: exactly one, pinned to the install revision.
      const provenance = await scalarRows(
        `select install_id, revision, resource_id, expert_template_ref, created_by
         from enterprise_package_experts
         where tenant_id = '${companyA()}' and agent_id = '${result.expert.agentId}'`,
      );
      expect(provenance.length).toBe(1);
      expect(provenance[0]!.install_id).toBe(goodInstallId);
      expect(Number(provenance[0]!.revision)).toBe(1);
      expect(provenance[0]!.resource_id).toBe("assistant");
      expect(provenance[0]!.expert_template_ref).toBe(
        packages.get("assistant")!.templateRef,
      );
      expect(provenance[0]!.created_by).toBe(adminPrincipal());

      // Initial Skill grant rows: skill kind only, generation 1.
      const grants = await scalarRows(
        `select resource_id, generation, resource_kind, tool_ref, revoked_at
         from enterprise_package_grants
         where tenant_id = '${companyA()}' and bot_id = '${result.expert.agentId}'`,
      );
      expect(grants.length).toBe(1);
      expect(grants[0]!.resource_id).toBe("summarize");
      expect(Number(grants[0]!.generation)).toBe(1);
      expect(grants[0]!.resource_kind).toBe("skill");
      expect(grants[0]!.tool_ref).toBe("");
      expect(grants[0]!.revoked_at).toBeNull();

      // The change receipt records the creation under the idempotency key.
      const receipts = await scalarRows(
        `select action, result_json::text as result from enterprise_package_changes
         where tenant_id = '${companyA()}' and idempotency_key = '${key}'`,
      );
      expect(receipts.length).toBe(1);
      expect(receipts[0]!.action).toBe("createExpert");
      const receipt = JSON.parse(String(receipts[0]!.result)) as {
        agentId: string;
      };
      expect(receipt.agentId).toBe(result.expert.agentId);
    },
  );

  itDb(
    "replays the same (actor, idempotency key) to the SAME agentId; key reuse with other input conflicts",
    async () => {
      const service = await expertService();
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const input = {
        installId: goodInstallId,
        resourceId: "assistant",
        expectedRevision: 1,
        name: "PKG04 Expert Bot",
      };
      const key = nextKey("replay-same");
      const original = await service.instantiateExpert(
        scope,
        admin,
        input,
        key,
      );
      expect(original.created).toBe(true);
      const replayed = await service.instantiateExpert(
        scope,
        admin,
        input,
        key,
      );
      expect(replayed.created).toBe(false);
      expect(replayed.expert.agentId).toBe(original.expert.agentId);
      const conflict = await thrownMessage(
        service.instantiateExpert(
          scope,
          admin,
          { ...input, name: "Different Name" },
          key,
        ),
      );
      expect(conflict).toContain("IDEMPOTENCY_CONFLICT");
    },
  );

  itDb(
    "rejects template files carrying endpoint/auth/remote-runtime/unknown fields or drifting skills",
    async () => {
      const service = await expertService();
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      for (const variant of [
        "endpoint",
        "auth",
        "remote-agent-id",
        "unknown-field",
        "skills-mismatch",
      ]) {
        const probe = packages.get(variant)!;
        const installId = await seedInstall({
          tenantId: companyA(),
          workspaceId: teamA1(),
          principalId: adminPrincipal(),
          packageKey: probe.packageKey,
          artifactDigest: probe.artifactDigest,
        });
        const rejected = await thrownMessage(
          service.instantiateExpert(
            scope,
            admin,
            {
              installId,
              resourceId: "assistant",
              expectedRevision: 1,
              name: "PKG04 Rejected",
            },
            nextKey(`reject-${variant}`),
          ),
        );
        expect(rejected).toContain("TEMPLATE_FIELD_REJECTED");
        // No ghost Bot: the rejection happened before any write.
        expect(
          await countRows(
            "enterprise_package_experts",
            "tenant_id = $1 and install_id = $2",
            [companyA(), installId],
          ),
        ).toBe(0);
        expect(
          await countRows(
            "enterprise_bot_ownership",
            "tenant_id = $1 and display_name = 'PKG04 Rejected'",
            [companyA()],
          ),
        ).toBe(0);
      }
    },
  );

  itDb(
    "unknown install and cross-company install answer the same 404 shape",
    async () => {
      const service = await expertService();
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const unknown = await thrownMessage(
        service.instantiateExpert(
          scope,
          admin,
          {
            installId: "pkg04-install-missing",
            resourceId: "assistant",
            expectedRevision: 1,
            name: "PKG04 Expert Bot",
          },
          nextKey("unknown"),
        ),
      );
      expect(unknown).toContain("RESOURCE_NOT_FOUND");
      // company-b's admin against companyA's install: the base plan has no
      // company-b admin identity, so promote the existing b1 member through
      // the disclosed stand-in and resolve the context via the REAL authorizer.
      await fixture.promoteToCompanyAdmin("b1-member", "company-b");
      const scopeB = await fixture.scopeFor("b1-member", "team-b1");
      const adminB = await fixture.adminContextOf("b1-member", "company-b");
      const crossCompany = await thrownMessage(
        service.instantiateExpert(
          scopeB,
          adminB,
          {
            installId: goodInstallId,
            resourceId: "assistant",
            expectedRevision: 1,
            name: "PKG04 Expert Bot",
          },
          nextKey("cross"),
        ),
      );
      expect(crossCompany).toContain("RESOURCE_NOT_FOUND");
    },
  );

  itDb(
    "a non-admin member and a stale revision are refused; a disabled install is unsupported",
    async () => {
      const service = await expertService();
      // A plain member never gains a company admin context: the real MT006
      // authorizer refuses before any service code runs.
      await fixture.scopeFor("a1-member", "team-a1");
      const notAdmin = await thrownMessage(
        fixture.adminContextOf("a1-member", "company-a"),
      );
      expect(notAdmin).toContain("TENANT_ADMIN_REQUIRED");

      const adminScope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const stale = await thrownMessage(
        service.instantiateExpert(
          adminScope,
          admin,
          {
            installId: goodInstallId,
            resourceId: "assistant",
            expectedRevision: 2,
            name: "PKG04 Expert Bot",
          },
          nextKey("stale"),
        ),
      );
      expect(stale).toContain("REVISION_CONFLICT");

      // Own package key: goodInstallId already occupies (tenant, workspace,
      // assistant package key) — a disabled install is a distinct install row.
      const disabledProbe = packages.get("assistantDisabled")!;
      const disabledInstallId = await seedInstall({
        tenantId: companyA(),
        workspaceId: teamA1(),
        principalId: adminPrincipal(),
        packageKey: disabledProbe.packageKey,
        artifactDigest: disabledProbe.artifactDigest,
        status: "disabled",
      });
      const disabled = await thrownMessage(
        service.instantiateExpert(
          adminScope,
          admin,
          {
            installId: disabledInstallId,
            resourceId: "assistant",
            expectedRevision: 1,
            name: "PKG04 Expert Bot",
          },
          nextKey("disabled"),
        ),
      );
      expect(disabled).toContain("PACKAGE_UNSUPPORTED");
    },
  );

  itDb(
    "serializes on the install lock: an upgrade committed while the instantiation waits re-fails the CAS",
    async () => {
      // The install row read + CAS checks must run UNDER the install advisory
      // lock (grants.ts `grantLockKeys` shape). A rival session holds the
      // lock, moves the install to revision 2 while the instantiation waits,
      // and only then releases: the instantiation must re-read the moved row
      // and answer REVISION_CONFLICT — never write a revision-1 expert over
      // the moved install.
      const probe = packages.get("assistantSerialize")!;
      const installId = await seedInstall({
        tenantId: companyA(),
        workspaceId: teamA1(),
        principalId: adminPrincipal(),
        packageKey: probe.packageKey,
        artifactDigest: probe.artifactDigest,
      });
      const installLockKey = JSON.stringify([
        "enterprise",
        "package-install",
        companyA(),
        installId,
      ]);
      // A dedicated single-connection rival plays the concurrent upgrade
      // writer: a SESSION-level advisory lock (the service takes the xact
      // one), so it can commit inside the window and release by hand. The
      // fixture's operator pool is max 1, so the rival must be its own
      // connection or the two transactions could never actually contend.
      const rival = createDatabase(enterpriseTestDatabaseUrlFrom(), {
        max: 1,
      });
      try {
        await rival.$client.unsafe(
          "select pg_advisory_lock(hashtextextended($1, 0))",
          [installLockKey],
        );
        const service = await expertService();
        const scope = await fixture.scopeFor("company-admin", "team-a1");
        const admin = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const attempt = service.instantiateExpert(
          scope,
          admin,
          {
            installId,
            resourceId: "assistant",
            expectedRevision: 1,
            name: "PKG04 Serialized",
          },
          nextKey("serialize"),
        );
        // Deterministic interleaving: while the rival still holds the lock,
        // the instantiation must NOT settle (it is serialized behind the
        // lock — pre-transaction template resolution already finished, so a
        // settle here would mean it never blocked). The 300ms window also
        // pins the ordering for any future regression that reads the row
        // before taking the lock: such a read would have completed here,
        // satisfying its stale CAS and sailing through after the release —
        // the final REVISION_CONFLICT below is what fails.
        const settled = await Promise.race([
          attempt.then(
            () => "done" as const,
            () => "done" as const,
          ),
          Bun.sleep(300).then(() => "waiting" as const),
        ]);
        expect(settled).toBe("waiting");
        // The upgrade lands (new immutable revision row + install CAS move,
        // the PKG06 upgrade shape) while the lock is still held, then the
        // rival releases and the waiting instantiation proceeds.
        await rival.$client.unsafe(
          `insert into enterprise_package_revisions
             (tenant_id, install_id, revision, release_version, artifact_digest, config, created_by)
           values ($1, $2, 2, '1.0.0', $3, '{}'::jsonb, $4)`,
          [companyA(), installId, probe.artifactDigest, adminPrincipal()],
        );
        await rival.$client.unsafe(
          `update enterprise_package_installs
           set revision = 2, updated_at = now()
           where tenant_id = $1 and id = $2`,
          [companyA(), installId],
        );
        await rival.$client.unsafe(
          "select pg_advisory_unlock(hashtextextended($1, 0))",
          [installLockKey],
        );
        const rejected = await thrownMessage(attempt);
        expect(rejected).toContain("REVISION_CONFLICT");
        // Nothing was written over the moved install.
        expect(
          await countRows(
            "enterprise_package_experts",
            "tenant_id = $1 and install_id = $2",
            [companyA(), installId],
          ),
        ).toBe(0);
        expect(
          await countRows(
            "enterprise_bot_ownership",
            "tenant_id = $1 and display_name = 'PKG04 Serialized'",
            [companyA()],
          ),
        ).toBe(0);
      } finally {
        // Closing the session releases any lock the failure paths left held.
        await rival.$client.close().catch(() => {});
      }
    },
  );

  itDb(
    "a mid-transaction failure leaves zero rows (no ghost Bot)",
    async () => {
      // The template references a skill the install's current revision does
      // not link: ownership and provenance are already written when the grant
      // seam validates resources — the whole transaction must roll back.
      const { instantiateExpertWithin } = await import(
        "../../src/enterprise/plugin-packages/experts"
      );
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      // Own package key: the upgrade-shape test below seeds another install of
      // the same release, and the install unique index is per package key.
      const probe = packages.get("assistantAtomic")!;
      const installId = await seedInstall({
        tenantId: companyA(),
        workspaceId: teamA1(),
        principalId: adminPrincipal(),
        packageKey: probe.packageKey,
        artifactDigest: probe.artifactDigest,
      });
      const ownershipBefore = await countRows(
        "enterprise_bot_ownership",
        "tenant_id = $1 and display_name = 'PKG04 Ghost'",
        [companyA()],
      );
      const failed = await thrownMessage(
        fixture.mutation.transaction(scope, admin, async (tx) =>
          instantiateExpertWithin(
            tx,
            scope,
            {
              installId,
              resourceId: "assistant",
              expectedRevision: 1,
              name: "PKG04 Ghost",
            },
            nextKey("atomic"),
            {
              release: {
                packageKey: probe.packageKey,
                version: "1.0.0",
                artifactDigest: probe.artifactDigest,
                category: "productivity",
                listed: true,
                verified: true,
                displayName: "PKG04 probe package",
                summary: "The PKG04 probe package.",
                blockers: [],
                manifest: probe.manifest,
              },
              template: { ...GOOD_TEMPLATE, skills: ["translate"] },
            },
            () => new Date(),
          ),
        ),
      );
      expect(failed).toContain("RESOURCE_NOT_FOUND");
      expect(
        await countRows(
          "enterprise_bot_ownership",
          "tenant_id = $1 and display_name = 'PKG04 Ghost'",
          [companyA()],
        ),
      ).toBe(ownershipBefore);
      expect(
        await countRows(
          "enterprise_package_experts",
          "tenant_id = $1 and install_id = $2",
          [companyA(), installId],
        ),
      ).toBe(0);
      expect(
        await countRows(
          "enterprise_package_changes",
          "tenant_id = $1 and install_id = $2",
          [companyA(), installId],
        ),
      ).toBe(0);
      expect(
        await countRows(
          "enterprise_package_grants",
          "tenant_id = $1 and install_id = $2",
          [companyA(), installId],
        ),
      ).toBe(0);
    },
  );

  itDb(
    "nothing else is written: no connector tool grants, no account connections, no preferences",
    async () => {
      const service = await expertService();
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const connectionsBefore = await connectionCount(companyA());
      const result = await service.instantiateExpert(
        scope,
        admin,
        {
          installId: goodInstallId,
          resourceId: "assistant",
          expectedRevision: 1,
          name: "PKG04 Minimal Bot",
        },
        nextKey("minimal"),
      );
      expect(result.created).toBe(true);
      expect(result.expert.resources).toEqual([
        { resourceId: "summarize", kind: "skill" },
      ]);
      // Every grant row written for the Bot is a skill row; no connectorTool.
      const grantKinds = await scalarRows(
        `select distinct resource_kind, tool_ref from enterprise_package_grants
         where tenant_id = '${companyA()}' and bot_id = '${result.expert.agentId}'`,
      );
      for (const row of grantKinds) {
        expect(row.resource_kind).toBe("skill");
        expect(row.tool_ref).toBe("");
      }
      expect(await connectionCount(companyA())).toBe(connectionsBefore);
      expect(
        await countRows(
          "enterprise_bot_preferences",
          "tenant_id = $1 and agent_id = $2",
          [companyA(), result.expert.agentId],
        ),
      ).toBe(0);
    },
  );

  itDb(
    "provenance is metadata only: a revision bump (upgrade shape) does not touch created rows",
    async () => {
      const service = await expertService();
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const probe = packages.get("assistantUpgrade")!;
      const installId = await seedInstall({
        tenantId: companyA(),
        workspaceId: teamA1(),
        principalId: adminPrincipal(),
        packageKey: probe.packageKey,
        // A distinct (tenant, workspace, package_key) install of the SAME
        // verified release; revision rows may repeat digests.
        artifactDigest: probe.artifactDigest,
      });
      const created = await service.instantiateExpert(
        scope,
        admin,
        {
          installId,
          resourceId: "assistant",
          expectedRevision: 1,
          name: "PKG04 Upgrade Bot",
        },
        nextKey("upgrade"),
      );
      expect(created.created).toBe(true);
      const before = await scalarRows(
        `select agent_id, install_id, revision, resource_id, expert_template_ref, created_by
         from enterprise_package_experts
         where tenant_id = '${companyA()}' and agent_id = '${created.expert.agentId}'`,
      );
      const ownershipBefore = await scalarRows(
        `select to_jsonb(row) from (
           select owner_principal_id, display_name, default_config, status, revision, acl_epoch
           from enterprise_bot_ownership
           where tenant_id = '${companyA()}' and agent_id = '${created.expert.agentId}'
         ) row`,
      );
      const grantsBefore = await scalarRows(
        `select to_jsonb(row) from (
           select bot_id, resource_id, generation, revoked_at, resource_kind
           from enterprise_package_grants
           where tenant_id = '${companyA()}' and bot_id = '${created.expert.agentId}'
           order by resource_id
         ) row`,
      );

      // The PKG06-shaped upgrade advance: a new immutable revision plus the
      // install CAS move. The expert surface writes none of this; the point
      // is that nothing cascades into the created rows.
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA()}, true), set_config('app.workspace_id', ${teamA1()}, true)`,
        );
        await tx.execute(
          sql`insert into enterprise_package_revisions
                (tenant_id, install_id, revision, release_version, artifact_digest, config, created_by)
              values (${companyA()}, ${installId}, 2, '1.0.0', ${probe.artifactDigest}, '{}'::jsonb, ${adminPrincipal()})`,
        );
        await tx.execute(
          sql`update enterprise_package_installs
              set revision = 2, updated_at = now()
              where tenant_id = ${companyA()} and id = ${installId}`,
        );
      });

      const after = await scalarRows(
        `select agent_id, install_id, revision, resource_id, expert_template_ref, created_by
         from enterprise_package_experts
         where tenant_id = '${companyA()}' and agent_id = '${created.expert.agentId}'`,
      );
      expect(after).toEqual(before);
      const ownershipAfter = await scalarRows(
        `select to_jsonb(row) from (
           select owner_principal_id, display_name, default_config, status, revision, acl_epoch
           from enterprise_bot_ownership
           where tenant_id = '${companyA()}' and agent_id = '${created.expert.agentId}'
         ) row`,
      );
      expect(ownershipAfter).toEqual(ownershipBefore);
      const grantsAfter = await scalarRows(
        `select to_jsonb(row) from (
           select bot_id, resource_id, generation, revoked_at, resource_kind
           from enterprise_package_grants
           where tenant_id = '${companyA()}' and bot_id = '${created.expert.agentId}'
           order by resource_id
         ) row`,
      );
      expect(grantsAfter).toEqual(grantsBefore);
    },
  );

  itDb(
    "the creation function refuses forged context and remote config; the data role cannot execute it",
    async () => {
      // Workspace mismatch: the function re-proves the app.* binding.
      const contextMismatch = await thrownMessage(
        fixture.operator.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.tenant_id', ${companyA()}, true), set_config('app.workspace_id', ${teamA1()}, true)`,
          );
          await tx.execute(
            sql`select public.openbot_create_package_expert(${companyA()}, 'pkg-expert-forged-1', 'some-other-workspace', ${adminPrincipal()}, 'Forged', '{"agentType":"built_in"}'::jsonb)`,
          );
        }),
      );
      expect(contextMismatch).toContain("PKG_EXPERT_CONTEXT_MISMATCH");

      // Remote configuration is refused at the SQL layer (managed
      // configuration can never turn a package Bot remote).
      const remoteConfig = await thrownMessage(
        fixture.operator.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.tenant_id', ${companyA()}, true), set_config('app.workspace_id', ${teamA1()}, true)`,
          );
          await tx.execute(
            sql`select public.openbot_create_package_expert(${companyA()}, 'pkg-expert-forged-2', ${teamA1()}, ${adminPrincipal()}, 'Remote', '{"agentType":"built_in","endpoint":"https://evil.example"}'::jsonb)`,
          );
        }),
      );
      expect(remoteConfig).toContain("PKG_EXPERT_REMOTE_FORBIDDEN");

      const remoteType = await thrownMessage(
        fixture.operator.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.tenant_id', ${companyA()}, true), set_config('app.workspace_id', ${teamA1()}, true)`,
          );
          await tx.execute(
            sql`select public.openbot_create_package_expert(${companyA()}, 'pkg-expert-forged-3', ${teamA1()}, ${adminPrincipal()}, 'Remote', '{"agentType":"remote_ag_ui"}'::jsonb)`,
          );
        }),
      );
      expect(remoteType).toContain("PKG_EXPERT_REMOTE_FORBIDDEN");
      expect(
        await countRows(
          "enterprise_bot_ownership",
          "tenant_id = $1 and agent_id like 'pkg-expert-forged%'",
          [companyA()],
        ),
      ).toBe(0);

      // The restricted data role has no EXECUTE on the function.
      const sqlState = await thrownSqlState(
        fixture.base.data.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.tenant_id', ${companyA()}, true), set_config('app.workspace_id', ${teamA1()}, true)`,
          );
          await tx.execute(
            sql`select public.openbot_create_package_expert(${companyA()}, 'pkg-expert-forged-4', ${teamA1()}, ${adminPrincipal()}, 'Data', '{"agentType":"built_in"}'::jsonb)`,
          );
        }),
      );
      expect(sqlState).toBe("42501");
    },
  );

  itDb(
    "R4-4: the hardened function rejects nested and case-shifted sensitive keys, normal templates still create",
    async () => {
      // Each of these sailed through the pre-R4-4 defense: the top-level `?|`
      // probe only saw root keys and was case-sensitive, so a nested
      // endpoint, a case-shifted Token and a nested apiKey all passed.
      const smugglers: ReadonlyArray<
        readonly [string, Record<string, unknown>]
      > = [
        ["nested-endpoint", { remote: { endpoint: "https://evil.example" } }],
        ["case-shifted-token", { Token: "x" }],
        ["nested-api-key", { nested: { apiKey: "x" } }],
      ];
      for (const [slug, sensitive] of smugglers) {
        const agentId = `pkg-expert-r44-bad-${slug}`;
        // The JSON literal is inlined (sql.raw): Bun SQL JSON-encodes jsonb-
        // typed parameters, so a bound string would arrive as a jsonb scalar
        // and trip PKG_EXPERT_CONFIG_INVALID instead of the probe under test.
        const configLiteral = sql.raw(
          `'${JSON.stringify({ agentType: "built_in", ...sensitive })}'::jsonb`,
        );
        const refused = await thrownMessage(
          fixture.operator.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('app.tenant_id', ${companyA()}, true), set_config('app.workspace_id', ${teamA1()}, true)`,
            );
            await tx.execute(
              sql`select public.openbot_create_package_expert(${companyA()}, ${agentId}, ${teamA1()}, ${adminPrincipal()}, 'R4-4 Refused', ${configLiteral})`,
            );
          }),
        );
        expect(refused).toContain("PKG_EXPERT_REMOTE_FORBIDDEN");
        expect(refused).not.toContain("PKG_EXPERT_INPUT_INVALID");
      }
      // No ghost Bot: every refusal happened before any write.
      expect(
        await countRows(
          "enterprise_bot_ownership",
          "tenant_id = $1 and agent_id like 'pkg-expert-r44-bad-%'",
          [companyA()],
        ),
      ).toBe(0);

      // The positive control: a plain built_in template still creates through
      // the hardened function with its non-secret config intact.
      const agentId = `pkg-expert-r44-ok-${crypto.randomUUID()}`;
      const created = await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA()}, true), set_config('app.workspace_id', ${teamA1()}, true)`,
        );
        return (await tx.execute(
          sql`select public.openbot_create_package_expert(${companyA()}, ${agentId}, ${teamA1()}, ${adminPrincipal()}, 'R4-4 Normal', '{"agentType":"built_in","skill":"summarize"}'::jsonb) as agent_id`,
        )) as unknown as Array<{ agent_id: string }>;
      });
      expect(created[0]?.agent_id).toBe(agentId);
      const ownership = await scalarRows(
        `select default_config::text as config, status
         from enterprise_bot_ownership
         where tenant_id = '${companyA()}' and agent_id = '${agentId}'`,
      );
      expect(ownership.length).toBe(1);
      expect(ownership[0]!.status).toBe("active");
      expect(JSON.parse(String(ownership[0]!.config))).toEqual({
        agentType: "built_in",
        skill: "summarize",
      });
    },
  );

  itDb(
    "RLS: another company's data role sees zero provenance rows; the owning company sees its own",
    async () => {
      const companyB = fixture.tenantOf("company-b");
      const teamB1 = fixture.teamOf("company-b", "team-b1");
      const ownRows = (await fixture.base.data.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA()}, true), set_config('app.workspace_id', ${teamA1()}, true)`,
        );
        return tx.execute(
          sql`select count(*)::int as n from enterprise_package_experts where tenant_id = ${companyA()}`,
        );
      })) as unknown as Array<{ n: number }>;
      expect(Number(ownRows[0]?.n ?? 0)).toBeGreaterThan(0);
      const foreignRows = (await fixture.base.data.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyB}, true), set_config('app.workspace_id', ${teamB1}, true)`,
        );
        return tx.execute(
          sql`select count(*)::int as n from enterprise_package_experts where tenant_id = ${companyA()}`,
        );
      })) as unknown as Array<{ n: number }>;
      expect(Number(foreignRows[0]?.n ?? 0)).toBe(0);
    },
  );
});
