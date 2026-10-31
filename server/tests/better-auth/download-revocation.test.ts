// server/tests/better-auth/download-revocation.test.ts
// T06.06（Issue #578，原任务 P15）— 逐 pull 准入的敏感文件下载代理。
//
// 本套件通过真实 HTTP 面（Hono + 真 resolver/gate/附件族门）钉：
//
// - `revocation_blocks_next_batch_even_when_outbox_is_down`：屏障固定顺序，
//   撤权（membership epoch 递增）落库后释放第 2 次 pull 的准入——准入必须
//   当场拒绝，enqueue 计数不再增加（outbox 停不停机都一样：判定是本批
//   事务内的实时 SQL，不是补偿事件）。
// - `preauthorized_batch_and_runtime_buffer_are_bounded`：串行 pull 每批
//   ≤262144 字节、每批恰好一次 enqueue、批数 = ceil(size/262144)。
// - HEAD/单区间 206/多区间 416/越界 416/suffix 206；私有 no-store；
//   撤权后的新 GET/HEAD/Range 一律 canonical 404；无 grant 的同团队成员
//   404；LEGACY/PAUSED 权威态保留 legacy 应答（200，不 fail-closed）；
//   形状外的 fileId 404。
//
// 夹具纪律（BA 岛标准配方）：五个 BA_TEST_* 角色 URL 硬门 + loopback
// openbot_enterprise_* 库；0221–0226 迁移与 GRANT 一律从单源提取，不在
// 本文件重打；清理与种子对称（t0606- 前缀）。不打印任何 DSN。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createClosedCompanyAssurance } from "../../src/auth/company-assurance";
import { createDirectoryAuthority } from "../../src/auth/directory/authority";
import { createDatabase } from "../../src/db/client";
import { createAttachmentService } from "../../src/enterprise/tenancy/attachments";
import {
  type DataDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import { createBaWorkspaceGate } from "../../src/enterprise/tenancy/scope-gate";
import {
  createSensitiveDownloadRoutes,
  SENSITIVE_DOWNLOAD_BATCH_BYTES,
  type SensitiveFileBytes,
  type SensitiveFileSource,
} from "../../src/enterprise/tenancy/sensitive-download";
import { createBaScopeResolver } from "../../src/enterprise/tenancy/store";

const DATABASE_VARIABLE = "BA_TEST_DATABASE_URL";
const BA_URL_VARIABLES = [
  DATABASE_VARIABLE,
  "BA_TEST_DIRECTORY_DATABASE_URL",
  "BA_TEST_DATA_DATABASE_URL",
  "BA_TEST_OPERATOR_DATABASE_URL",
  "BA_TEST_AUTH_WRITER_DATABASE_URL",
] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const MIGRATION_TAGS = [
  "0221_better_auth_directory",
  "0222_better_auth_clocks",
  "0223_better_auth_command_authority",
  "0224_better_auth_authority_sources",
  "0225_better_auth_assurance",
  "0226_better_auth_schema_roles",
] as const;

const BA_TABLES = [
  "auth_company_session_assurances",
  "auth_company_auth_challenges",
  "auth_team_management_grants",
  "auth_provisioning_rules",
  "auth_command_outbox",
  "auth_command_change_keys",
  "auth_command_receipts",
  "auth_authority_states",
  "auth_eligibility_clocks",
  "auth_invitations",
  "auth_team_members",
  "auth_members",
  "auth_team_bindings",
  "auth_teams",
  "auth_organizations",
] as const;

const TENANT = "t0606-tenant";
const WORKSPACE = "t0606-workspace";
const OWNER_USER = "t0606-owner";
const MEMBER_USER = "t0606-member";
const OWNER_PRINCIPAL = "t0606-principal-owner";
const MEMBER_PRINCIPAL = "t0606-principal-member";
const IDENTITY_GENERATION = 4;

const BA_AUTHORITY = {
  authorityVersion: 11,
  phase: "M4",
  directoryAuthority: "ba",
  multiTenantReleased: true,
} as const;
const LEGACY_AUTHORITY = {
  authorityVersion: 3,
  phase: "M1",
  directoryAuthority: "legacy",
  multiTenantReleased: false,
} as const;
const PAUSED_AUTHORITY = {
  authorityVersion: 7,
  phase: "M2",
  directoryAuthority: "paused",
  multiTenantReleased: false,
} as const;

function shapeOf(variable: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} must be a loopback PostgreSQL URL.`);
  }
  let database = "";
  try {
    database = decodeURIComponent(
      url.pathname.replace(/^\//, "").replace(/\/+$/, ""),
    );
  } catch {
    throw new Error(`${variable} carries invalid percent-encoding.`);
  }
  if (
    !/^postgres(?:ql)?:$/.test(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    !/^openbot_enterprise_/.test(database)
  ) {
    throw new Error(
      `${variable} must name a loopback openbot_enterprise_* database.`,
    );
  }
  const host =
    url.hostname === "localhost" || url.hostname === "[::1]"
      ? "127.0.0.1"
      : url.hostname;
  return `${host}:${url.port || "5432"}/${database}`;
}

function readBaUrls(): string {
  let reference: string | undefined;
  for (const variable of BA_URL_VARIABLES) {
    const raw = process.env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `${variable} is required: this suite runs only on its five BA_TEST_* island role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
      );
    }
    const shape = shapeOf(variable, raw);
    reference ??= shape;
    if (shape !== reference) {
      throw new Error(
        `${variable} must name the same PostgreSQL instance and database as ${DATABASE_VARIABLE}.`,
      );
    }
  }
  return process.env[DATABASE_VARIABLE]!.trim();
}

function loadMigrationSql(tag: string): string {
  const path = join(import.meta.dirname, `../../drizzle/${tag}.sql`);
  if (!existsSync(path)) {
    throw new Error(
      `${tag}.sql does not exist: the stack this suite pins is the integrated target behavior, not an environment problem.`,
    );
  }
  return readFileSync(path, "utf8");
}

import { TASKS } from "../../scripts/multitenancy/migrate-test";

function statementsFromTasks(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const task of TASKS.values()) {
    for (const step of task.steps) {
      for (const statement of step.statements) {
        if (pattern.test(statement) && !found.includes(statement)) {
          found.push(statement);
        }
      }
    }
  }
  return found;
}

const WORKSPACE_MEMBERSHIP_GRANT = statementsFromTasks(
  /^GRANT SELECT ON TABLE "enterprise_workspace_memberships" TO /,
);
if (WORKSPACE_MEMBERSHIP_GRANT.length !== 1) {
  throw new Error(
    `the migrate-test single source no longer carries exactly one workspace-membership grant statement (${WORKSPACE_MEMBERSHIP_GRANT.length} found): update this suite's extraction before running it, never re-type the SQL here.`,
  );
}

const cleanupSql = async (sql: postgres.Sql): Promise<void> => {
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${BA_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  await sql`DELETE FROM enterprise_resource_grants WHERE tenant_id LIKE 't0606-%'`;
  await sql`DELETE FROM enterprise_resources WHERE tenant_id LIKE 't0606-%'`;
  await sql`DELETE FROM enterprise_workspace_memberships WHERE tenant_id LIKE 't0606-%'`;
  await sql`DELETE FROM enterprise_memberships WHERE tenant_id LIKE 't0606-%'`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id LIKE 't0606-%'`;
  await sql`DELETE FROM enterprise_principals WHERE id LIKE 't0606-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0606-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0606-%'`;
  await sql.unsafe(
    `REVOKE SELECT ON TABLE "enterprise_workspace_memberships" FROM ob_ent_directory, ob_ent_data, ob_ent_operator`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_principals" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_tenants" DROP CONSTRAINT IF EXISTS "enterprise_tenant_status"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_tenants" ADD CONSTRAINT "enterprise_tenant_status" CHECK ("status" in ('active','suspended'))`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_credentials" DROP COLUMN IF EXISTS "owner_identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_credentials" DROP COLUMN IF EXISTS "owner_company_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_credential_actions" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_credential_actions" DROP COLUMN IF EXISTS "company_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_credential_actions" DROP COLUMN IF EXISTS "source_team_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "billing_company_finance_grants" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "billing_company_finance_grants" DROP COLUMN IF EXISTS "company_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "access_grants" DROP COLUMN IF EXISTS "principal_id"`,
  );
  await sql.unsafe(
    `ALTER TABLE "access_grants" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "gateway_virtual_keys" DROP COLUMN IF EXISTS "source_identity_generation"`,
  );
};

async function withGuardsDisabled(
  sql: postgres.Sql,
  triggers: ReadonlyArray<readonly [string, string]>,
  work: () => Promise<void>,
): Promise<void> {
  for (const [table, trigger] of triggers) {
    await sql.unsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
  }
  try {
    await work();
  } finally {
    for (const [table, trigger] of triggers) {
      await sql
        .unsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`)
        .catch(() => {});
    }
  }
}

type AuthorityRow =
  | typeof BA_AUTHORITY
  | typeof LEGACY_AUTHORITY
  | typeof PAUSED_AUTHORITY;

async function setAuthority(
  sql: postgres.Sql,
  row: AuthorityRow,
): Promise<void> {
  await sql`
    UPDATE auth_authority_states
       SET authority_version = ${row.authorityVersion},
           phase = ${row.phase},
           directory_authority = ${row.directoryAuthority},
           multi_tenant_released = ${row.multiTenantReleased},
           updated_at = now()
     WHERE id = 1`;
}

async function seedFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO enterprise_tenants (id, name, policy_revision) VALUES
      (${TENANT}, 'T06.06 company', 'workspace-v1')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${OWNER_USER}, 't0606-owner@example.test'),
      (${MEMBER_USER}, 't0606-member@example.test')`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id, identity_generation) VALUES
      (${OWNER_PRINCIPAL}, ${OWNER_USER}, ${IDENTITY_GENERATION}),
      (${MEMBER_PRINCIPAL}, ${MEMBER_USER}, ${IDENTITY_GENERATION})`;
  await sql`
    INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES
      (${TENANT}, ${WORKSPACE}, 'T06.06 team')`;
  await sql`
    INSERT INTO enterprise_memberships (tenant_id, principal_id, role, epoch) VALUES
      (${TENANT}, ${OWNER_PRINCIPAL}, 'member', 1),
      (${TENANT}, ${MEMBER_PRINCIPAL}, 'member', 1)`;
  await sql`
    INSERT INTO enterprise_workspace_memberships
      (tenant_id, workspace_id, principal_id, epoch)
    VALUES
      (${TENANT}, ${WORKSPACE}, ${OWNER_PRINCIPAL}, 1),
      (${TENANT}, ${WORKSPACE}, ${MEMBER_PRINCIPAL}, 1)`;
  await withGuardsDisabled(
    sql,
    [
      ["auth_organizations", "auth_directory_dml_guard"],
      ["auth_teams", "auth_directory_dml_guard"],
      ["auth_team_bindings", "auth_directory_dml_guard"],
      ["auth_members", "auth_directory_dml_guard"],
      ["auth_team_members", "auth_directory_dml_guard"],
    ],
    async () => {
      await sql`
        INSERT INTO auth_organizations (id, name, slug) VALUES
          (${TENANT}, 'T06.06 company', 't0606-company')`;
      await sql`
        INSERT INTO auth_teams (id, organization_id, name) VALUES
          ('t0606-team', ${TENANT}, 'T06.06 team')`;
      await sql`
        INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id) VALUES
          (${TENANT}, ${WORKSPACE}, 't0606-team')`;
      await sql`
        INSERT INTO auth_members (id, organization_id, user_id, role) VALUES
          ('t0606-ba-owner', ${TENANT}, ${OWNER_USER}, 'member'),
          ('t0606-ba-member', ${TENANT}, ${MEMBER_USER}, 'member')`;
      await sql`
        INSERT INTO auth_team_members (id, team_id, user_id) VALUES
          ('t0606-ba-team-owner', 't0606-team', ${OWNER_USER}),
          ('t0606-ba-team-member', 't0606-team', ${MEMBER_USER})`;
    },
  );
  await sql`
    INSERT INTO auth_eligibility_clocks
      (tenant_id, principal_id, kind, scope_id, epoch, generation, tombstone, last_command_id)
    VALUES
      (${TENANT}, ${OWNER_PRINCIPAL}, 'company', ${TENANT}, 1, 1, false, 't0606-c0'),
      (${TENANT}, ${OWNER_PRINCIPAL}, 'team', ${WORKSPACE}, 1, 1, false, 't0606-c0'),
      (${TENANT}, ${MEMBER_PRINCIPAL}, 'company', ${TENANT}, 1, 1, false, 't0606-c0'),
      (${TENANT}, ${MEMBER_PRINCIPAL}, 'team', ${WORKSPACE}, 1, 1, false, 't0606-c0')`;
}

/** 种一个可见附件（owner 上传者 grant 语义：visibility NULL + read grant）。 */
async function seedAttachment(
  sql: postgres.Sql,
  attachmentId: string,
): Promise<void> {
  await sql`
    INSERT INTO enterprise_resources
      (tenant_id, id, workspace_id, kind, display_name)
    VALUES
      (${TENANT}, ${attachmentId}, ${WORKSPACE}, 'attachment', 'T06.06 sensitive file')`;
  await sql`
    INSERT INTO enterprise_resource_grants
      (tenant_id, resource_id, principal_id, action)
    VALUES
      (${TENANT}, ${attachmentId}, ${OWNER_PRINCIPAL}, 'read')`;
}

interface Harness {
  readonly sql: postgres.Sql;
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly resolver: ReturnType<typeof createBaScopeResolver>;
  readonly gate: ReturnType<typeof createBaWorkspaceGate>;
  readonly realAuthorize: SensitiveFileSource["authorize"];
  setAuthority(row: AuthorityRow): Promise<void>;
  close(): Promise<void>;
}

let state: Harness | undefined;

async function createHarness(): Promise<Harness> {
  const setupUrl = readBaUrls();
  const sql = postgres(setupUrl, {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });
  try {
    await cleanupSql(sql);
    for (const tag of MIGRATION_TAGS) {
      await sql.unsafe(loadMigrationSql(tag));
    }
    for (const statement of WORKSPACE_MEMBERSHIP_GRANT) {
      await sql.unsafe(statement);
    }
    await seedFixture(sql);
    await setAuthority(sql, BA_AUTHORITY);

    const db = createDatabase(setupUrl, { max: 3 });
    const dataRoleUrl = new URL(process.env.BA_TEST_DATA_DATABASE_URL!.trim());
    dataRoleUrl.searchParams.set("options", "-c role=ob_ent_data");
    const data = (await verifyDataDatabase(
      createDatabase(dataRoleUrl.href, { max: 2 }),
    )) as DataDatabase;
    const operatorRoleUrl = new URL(
      process.env.BA_TEST_OPERATOR_DATABASE_URL!.trim(),
    );
    operatorRoleUrl.searchParams.set("options", "-c role=ob_ent_operator");
    const operator = (await verifyOperatorDatabase(
      createDatabase(operatorRoleUrl.href, { max: 2 }),
    )) as OperatorDatabase;

    const authority = createDirectoryAuthority();
    const assurance = createClosedCompanyAssurance({
      policy: { requiresProof: async () => false },
    });
    const resolver = createBaScopeResolver(db, {
      authenticate: (request) => {
        const actorId = request.headers.get("x-test-user");
        return Promise.resolve(
          actorId ? { actorId, entrypoint: "web" as const } : null,
        );
      },
      selectTenant: (request) => request.headers.get("x-openbot-tenant"),
      selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
      data: db,
      authority,
      assurance,
    });
    const gate = createBaWorkspaceGate(db, { authority, assurance });
    const attachments = createAttachmentService({
      data,
      operator,
      signingKey: "t0606-signing-key-0123456789",
    });
    const close = async () => {
      try {
        await cleanupSql(sql);
      } finally {
        await db.$client.close?.();
        await data.$client.close?.();
        await operator.$client.close?.();
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    };
    return {
      sql,
      data,
      operator,
      resolver,
      gate,
      realAuthorize: (scope, fileId) =>
        attachments
          .authorizeContent(scope, fileId)
          .then((verdict) =>
            verdict.outcome === "allow"
              ? { storageKey: verdict.storageKey }
              : null,
          ),
      setAuthority: (row) => setAuthority(sql, row),
      close,
    };
  } catch (error) {
    await cleanupSql(sql).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

function harness(): Harness {
  if (!state) throw new Error("download-revocation harness is not initialized");
  return state;
}

// ---------------------------------------------------------------------------
// 受控字节源与屏障
// ---------------------------------------------------------------------------

/** 受控字节源：记录每次 read 的 (offset,length)；大小任意，不碰磁盘。 */
function controlledBytes(sizeBytes: number): {
  readonly bytes: SensitiveFileBytes;
  readonly reads: { offset: number; length: number }[];
} {
  const backing = new Uint8Array(sizeBytes);
  for (let index = 0; index < sizeBytes; index += 1) {
    backing[index] = index % 251;
  }
  const reads: { offset: number; length: number }[] = [];
  return {
    reads,
    bytes: {
      sizeBytes,
      async read(offset, maxBytes) {
        const length = Math.max(0, Math.min(maxBytes, sizeBytes - offset));
        reads.push({ offset, length });
        return backing.subarray(offset, offset + length);
      },
    },
  };
}

function callAs(
  app: Hono,
  userId: string,
  path: string,
  init?: { readonly method?: string; readonly range?: string },
): Promise<Response> {
  return app.request(path, {
    method: init?.method ?? "GET",
    headers: {
      "x-test-user": userId,
      "x-openbot-tenant": TENANT,
      "x-openbot-workspace": WORKSPACE,
      ...(init?.range ? { range: init.range } : {}),
    },
  });
}

describe("T06.06 sensitive download proxy (pull-gated revocable streams)", () => {
  beforeAll(async () => {
    state = await createHarness();
  });

  afterAll(async () => {
    const current = state;
    state = undefined;
    await current?.close();
  });

  test("preauthorized_batch_and_runtime_buffer_are_bounded", async () => {
    const { resolver, gate, realAuthorize } = harness();
    const attachmentId = "t0606-att-bounded";
    await seedAttachment(harness().sql, attachmentId);
    const size = SENSITIVE_DOWNLOAD_BATCH_BYTES * 2 + 75712; // 3 批
    const { bytes, reads } = controlledBytes(size);
    const app = new Hono();
    app.route(
      "/",
      createSensitiveDownloadRoutes({
        resolveScope: resolver,
        gate,
        source: { authorize: realAuthorize, open: async () => bytes },
      }),
    );

    const response = await callAs(
      app,
      OWNER_USER,
      `/api/enterprise/files/${attachmentId}/content`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");

    const chunks: Uint8Array[] = [];
    const reader = response.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const received = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    expect(received).toBe(size);
    // 批界：每个运行时缓冲块 ≤ 262144（enqueue 一次一批）。
    const maxBufferedBytes = Math.max(
      ...chunks.map((chunk) => chunk.byteLength),
    );
    expect(maxBufferedBytes).toBeLessThanOrEqual(
      SENSITIVE_DOWNLOAD_BATCH_BYTES,
    );
    // 批数与准入次数一一对应：ceil(600000/262144) = 3。
    expect(reads.length).toBe(3);
    for (const read of reads) {
      expect(read.length).toBeLessThanOrEqual(SENSITIVE_DOWNLOAD_BATCH_BYTES);
    }
  });

  test("revocation_blocks_next_batch_even_when_outbox_is_down", async () => {
    const { resolver, gate, realAuthorize, sql } = harness();
    const attachmentId = "t0606-att-revocation";
    await seedAttachment(sql, attachmentId);
    const size = SENSITIVE_DOWNLOAD_BATCH_BYTES * 3;
    const { bytes, reads } = controlledBytes(size);

    // 屏障：第 2 次准入先挂起，撤权落库后才放行——保证真判定发生在
    // 撤权之后（固定顺序，不靠客户端缓存字节猜测）。
    let authorizeCalls = 0;
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const source: SensitiveFileSource = {
      async authorize(scope, fileId) {
        authorizeCalls += 1;
        if (authorizeCalls === 3) await barrier; // 第3次=批2的 pull 准入（1=响应前，2=批1）
        return realAuthorize(scope, fileId);
      },
      open: async () => bytes,
    };
    const app = new Hono();
    app.route(
      "/",
      createSensitiveDownloadRoutes({ resolveScope: resolver, gate, source }),
    );

    const response = await callAs(
      app,
      OWNER_USER,
      `/api/enterprise/files/${attachmentId}/content`,
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value!.byteLength).toBeLessThanOrEqual(
      SENSITIVE_DOWNLOAD_BATCH_BYTES,
    );

    try {
      // 撤权：成员资格 epoch 递增（outbox 无关——判定是本批事务的实时读）。
      await sql`UPDATE enterprise_memberships SET epoch = 2 WHERE tenant_id = ${TENANT} AND principal_id = ${OWNER_PRINCIPAL}`;
      const beforeCount = reads.length;
      releaseBarrier();
      const second = (await Promise.race([
        reader.read(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("read2 stall")), 3000),
        ),
      ])) as { done: boolean };
      expect(second.done).toBe(true);

      // 撤权后的下一次 pull 被准入拒绝：enqueue 计数不再增加。
      expect(reads.length).toBe(beforeCount);
      expect(first.value!.byteLength).toBe(SENSITIVE_DOWNLOAD_BATCH_BYTES);
    } finally {
      await sql`UPDATE enterprise_memberships SET epoch = 1 WHERE tenant_id = ${TENANT} AND principal_id = ${OWNER_PRINCIPAL}`;
    }
  });

  test("head_answers_headers_without_a_body", async () => {
    const { resolver, gate, realAuthorize, sql } = harness();
    const attachmentId = "t0606-att-head";
    await seedAttachment(sql, attachmentId);
    const { bytes } = controlledBytes(300000);
    const app = new Hono();
    app.route(
      "/",
      createSensitiveDownloadRoutes({
        resolveScope: resolver,
        gate,
        source: { authorize: realAuthorize, open: async () => bytes },
      }),
    );
    const response = await callAs(
      app,
      OWNER_USER,
      `/api/enterprise/files/${attachmentId}/content`,
      {
        method: "HEAD",
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("300000");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toBe("");
  });

  test("single_range_answers_206_with_content_range", async () => {
    const { resolver, gate, realAuthorize, sql } = harness();
    const attachmentId = "t0606-att-range";
    await seedAttachment(sql, attachmentId);
    const { bytes } = controlledBytes(700000);
    const app = new Hono();
    app.route(
      "/",
      createSensitiveDownloadRoutes({
        resolveScope: resolver,
        gate,
        source: { authorize: realAuthorize, open: async () => bytes },
      }),
    );
    const response = await callAs(
      app,
      OWNER_USER,
      `/api/enterprise/files/${attachmentId}/content`,
      {
        range: "bytes=100-199",
      },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 100-199/700000");
    expect((await response.arrayBuffer()).byteLength).toBe(100);
  });

  test("suffix_range_answers_206_from_the_tail", async () => {
    const { resolver, gate, realAuthorize, sql } = harness();
    const attachmentId = "t0606-att-suffix";
    await seedAttachment(sql, attachmentId);
    const { bytes } = controlledBytes(700000);
    const app = new Hono();
    app.route(
      "/",
      createSensitiveDownloadRoutes({
        resolveScope: resolver,
        gate,
        source: { authorize: realAuthorize, open: async () => bytes },
      }),
    );
    const response = await callAs(
      app,
      OWNER_USER,
      `/api/enterprise/files/${attachmentId}/content`,
      {
        range: "bytes=-100",
      },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      "bytes 699900-699999/700000",
    );
    expect((await response.arrayBuffer()).byteLength).toBe(100);
  });

  test("multi_range_and_unsatisfiable_range_answer_416", async () => {
    const { resolver, gate, realAuthorize, sql } = harness();
    const attachmentId = "t0606-att-416";
    await seedAttachment(sql, attachmentId);
    const { bytes } = controlledBytes(700000);
    const app = new Hono();
    app.route(
      "/",
      createSensitiveDownloadRoutes({
        resolveScope: resolver,
        gate,
        source: { authorize: realAuthorize, open: async () => bytes },
      }),
    );
    const multi = await callAs(
      app,
      OWNER_USER,
      `/api/enterprise/files/${attachmentId}/content`,
      {
        range: "bytes=0-99,200-299",
      },
    );
    expect(multi.status).toBe(416);
    const beyond = await callAs(
      app,
      OWNER_USER,
      `/api/enterprise/files/${attachmentId}/content`,
      {
        range: "bytes=700000-700005",
      },
    );
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe("bytes */700000");
  });

  test("revoked_caller_gets_canonical_not_found_on_every_verb", async () => {
    const { resolver, gate, realAuthorize, sql } = harness();
    const attachmentId = "t0606-att-revoked";
    await seedAttachment(sql, attachmentId);
    const { bytes } = controlledBytes(300000);
    const app = new Hono();
    app.route(
      "/",
      createSensitiveDownloadRoutes({
        resolveScope: resolver,
        gate,
        source: { authorize: realAuthorize, open: async () => bytes },
      }),
    );
    try {
      await sql`UPDATE enterprise_memberships SET epoch = 5 WHERE tenant_id = ${TENANT} AND principal_id = ${OWNER_PRINCIPAL}`;
      for (const init of [
        {},
        { method: "HEAD" },
        { range: "bytes=0-99" },
      ] as const) {
        const response = await callAs(
          app,
          OWNER_USER,
          `/api/enterprise/files/${attachmentId}/content`,
          init,
        );
        expect(response.status).toBe(404);
        expect(response.headers.get("content-type")).toContain(
          "application/json",
        );
      }
    } finally {
      await sql`UPDATE enterprise_memberships SET epoch = 1 WHERE tenant_id = ${TENANT} AND principal_id = ${OWNER_PRINCIPAL}`;
    }
  });

  test("ungranted_same_team_member_is_not_found", async () => {
    const { resolver, gate, realAuthorize, sql } = harness();
    const attachmentId = "t0606-att-ungranted";
    await seedAttachment(sql, attachmentId);
    const { bytes } = controlledBytes(300000);
    const app = new Hono();
    app.route(
      "/",
      createSensitiveDownloadRoutes({
        resolveScope: resolver,
        gate,
        source: { authorize: realAuthorize, open: async () => bytes },
      }),
    );
    const response = await callAs(
      app,
      MEMBER_USER,
      `/api/enterprise/files/${attachmentId}/content`,
    );
    expect(response.status).toBe(404);
  });

  test("legacy_and_paused_authority_keep_the_legacy_answer", async () => {
    const { resolver, gate, realAuthorize, sql, setAuthority } = harness();
    const attachmentId = "t0606-att-authority";
    await seedAttachment(sql, attachmentId);
    const { bytes } = controlledBytes(300000);
    const app = new Hono();
    app.route(
      "/",
      createSensitiveDownloadRoutes({
        resolveScope: resolver,
        gate,
        source: { authorize: realAuthorize, open: async () => bytes },
      }),
    );
    try {
      // authority 与 release 分开（根 Spec）：legacy/paused 态保留 legacy
      // 读写与 DTO——成员事实为真时应答照常（200），新 gate 只在 ba 态
      // 收紧；不 fail-closed 成 404。
      for (const row of [LEGACY_AUTHORITY, PAUSED_AUTHORITY] as const) {
        await setAuthority(row);
        const response = await callAs(
          app,
          OWNER_USER,
          `/api/enterprise/files/${attachmentId}/content`,
        );
        expect(response.status).toBe(200);
      }
    } finally {
      await setAuthority(BA_AUTHORITY);
    }
  });

  test("malformed_file_id_is_not_found", async () => {
    const { resolver, gate, realAuthorize } = harness();
    const { bytes } = controlledBytes(16);
    const app = new Hono();
    app.route(
      "/",
      createSensitiveDownloadRoutes({
        resolveScope: resolver,
        gate,
        source: { authorize: realAuthorize, open: async () => bytes },
      }),
    );
    const response = await callAs(
      app,
      OWNER_USER,
      `/api/enterprise/files/not%20a%20ref/content`,
    );
    expect(response.status).toBe(404);
  });
});
