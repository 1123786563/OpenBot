import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { like } from "drizzle-orm";
import { z } from "zod";
import { EnterpriseApiErrorSchema } from "../../../../shared/enterprise/mobile-schemas";
import { createDatabase } from "../../../src/db/client";
import {
  enterpriseIdentityEvents,
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseSecurityEvents,
  enterpriseTenants,
  enterpriseWorkspaces,
  users,
} from "../../../src/db/schema";
import { createEnterpriseApp } from "../../../src/enterprise/app";
import { createResourceReader } from "../../../src/enterprise/authz/repository";
import { createAuthz } from "../../../src/enterprise/authz/service";
import { createDirectory } from "../../../src/enterprise/tenancy/directory";
import { createPrincipal } from "../../../src/enterprise/tenancy/identity";
import {
  createWorkspace,
  grantRead,
  provisionMember,
  revokeRead,
  suspendMember,
} from "../../../src/enterprise/tenancy/provision";
import { testDatabaseUrlFrom } from "../../support/database";

/*
 * C05 企业 Bot/Channel/Thread 会话子系统验收，依据
 * docs/superpowers/specs/enterprise-conversations-subsystem.md（§3.3 错误语义、§3.5 API 形状、
 * §4.1 表约束、§6 权限矩阵、§7 撤权、§10 N1–N7/N10 门禁）与 plan.md §C05 的四步测试清单。
 *
 * 范围即验收的一部分：只测已授权 Bot 列表与个人 Channel 的创建/分页/详情/归档，threadId 由
 * 服务端生成。消息提交、Run、CHANNEL_ARCHIVED 的写型触发点归 C07（本子系统没有任何写型端点
 * 可以触发它），这里不伪造。
 *
 * fixture 纪律沿用 tenancy/app.test.ts：全部连接指向 TEST_DATABASE_URL 的隔离测试库
 * （openbot_enterprise_test，禁碰 5432 应用库），一个 owner 登录做清理与行级断言，受限
 * 登录承载生产角色，前缀 t5c- 幂等清理。Bot 以 enterprise_resources(kind='bot') 行存在：
 * kind 生产入口不在 C05（规格 §11.6），这里以隔离 fixture 造数据并标注
 * implemented(fixture)/missing(producer)——read grant 走真实的 grantRead（审计 + ACL epoch
 * bump），run grant 无生产授予函数，由 owner 直插并在迁移未放宽 CHECK 时保持缺席
 * （绝不伪造第二行，也绝不让 fixture 抛错把红灯混成环境错误）。
 *
 * 红灯纪律：conversations 路由/服务尚未实现，全部失败必须表现为路由缺失（Hono 默认 404）
 * 或 enterprise_channels 约束缺失，而不是 fixture/环境错误。401/400/403 的边界用例落在
 * scope 中间件层、先于路由解析，它们现在就该绿，作为路由挂载后的回归保护。
 */

const PREFIX = "t5c-";
const TENANT_A = "t5c-tenant-a";
const TENANT_B = "t5c-tenant-b";
const TENANT_NAME_A = "T5C App Tenant A";
const TENANT_NAME_B = "T5C App Tenant B";
const USER_OWNER = "t5c-user-owner";
const USER_OTHER = "t5c-user-other";
const USER_ADMIN = "t5c-user-admin";
const P_OWNER = "t5c-principal-owner"; // member of A and B
const P_OTHER = "t5c-principal-other"; // member of A only
const WS_A = "t5c-ws-a";
const WS_B = "t5c-ws-b";
const BOT_RW = "t5c-bot-rw"; // read + run for P_OWNER in A
const BOT_RO = "t5c-bot-ro"; // read only for P_OWNER in A
const BOT_RUNONLY = "t5c-bot-runonly"; // run only (no read) for P_OWNER in A
const BOT_OTHER = "t5c-bot-other"; // read granted to P_OTHER, not to P_OWNER
const BOT_B = "t5c-bot-b"; // read + run for P_OWNER in tenant B
const OPERATOR = "t5c-operator";
const IDENTITY_OPERATOR = "t5c-idop";
const ORIGIN = "https://t5c.example";

function restrictedLoginUrl(variable: string): string {
  return testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env[variable] });
}

const ownerDatabase = createDatabase(
  testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }),
  { max: 1 },
);
const identityOperatorDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_IDENTITY_OPERATOR_DATABASE_URL"),
  { max: 1 },
);
const operatorDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_OPERATOR_DATABASE_URL"),
  { max: 2 },
);
const directoryLoginDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_DIRECTORY_DATABASE_URL"),
  { max: 2 },
);
const dataDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_DATA_DATABASE_URL"),
  { max: 2 },
);

/*
 * The one fixed authenticated identity, switched per test block: the same app instance serves the
 * owner, the second member and the platform admin by swapping what getSession answers. The auth
 * boundary itself (Better Auth) is out of scope here — everything behind it (directory, scope,
 * grants, RLS) is the real chain over the isolated database.
 */
let currentSession: { user: { id: string; email: string } } | null = null;
const sessionAuth = {
  handler: async () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => currentSession,
  },
};

const liveApp = createEnterpriseApp({
  auth: sessionAuth,
  directory: createDirectory(directoryLoginDatabase),
  resources: createResourceReader(dataDatabase, createAuthz()),
  authz: createAuthz(),
  allowedOrigins: new Set([ORIGIN]),
  authRoutes: new Set<string>(),
  logRedactedSecurityError: () => {},
  isDraining: () => false,
  ready: async () => true,
});

function asUser(userId: string | null): void {
  currentSession =
    userId === null
      ? null
      : { user: { id: userId, email: `${userId}@t5c.invalid` } };
}

/* The conversation the create block established; later blocks assert against it. */
let ownerConversation: PersonalConversation | undefined;

function conversationOf(): PersonalConversation {
  if (ownerConversation === undefined) {
    throw new Error("the owner conversation has not been created yet");
  }
  return ownerConversation;
}

const tenantHeader = (tenantId: string) => ({
  "x-openbot-tenant": tenantId,
});

async function get(path: string, tenantId: string): Promise<Response> {
  return await liveApp.request(path, { headers: tenantHeader(tenantId) });
}

/** Asserts the status first, so a missing route fails as a status mismatch, never as a JSON parse. */
async function jsonOf(response: Response, status = 200): Promise<unknown> {
  expect(response.status).toBe(status);
  return await response.json();
}

async function post(
  path: string,
  body: unknown,
  tenantId: string,
): Promise<Response> {
  return await liveApp.request(path, {
    method: "POST",
    headers: {
      ...tenantHeader(tenantId),
      origin: ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** The exact §3.2 PersonalConversation DTO, transcribed verbatim from the frozen spec. */
const PersonalConversationShape = z
  .object({
    channelId: z.string().min(1),
    botId: z.string().min(1),
    threadId: z.string().min(1),
    mode: z.literal("single"),
    status: z.enum(["active", "archived"]),
  })
  .strict();

type PersonalConversation = z.infer<typeof PersonalConversationShape>;

/** Bun's PostgresError carries the SQLSTATE in `errno`; its `code` is the driver class. */
function isSqlState(error: unknown, state: string): boolean {
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate?.errno === state || candidate?.code === state;
}

/** The §3.3 error envelope: only the code is pinned per case, the shape is always validated. */
async function expectError(
  response: Response,
  status: number,
  code: string,
): Promise<{ error: { code: string; request_id: string; summary: string } }> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as unknown;
  /* The frozen envelope contract, validated through the shared schema itself (a nested
   * z.object across the shared/server zod copies is not portable; direct safeParse is). */
  expect(Object.keys(body as object).sort()).toEqual(["error"]);
  const error = (body as { error: unknown }).error;
  expect(EnterpriseApiErrorSchema.safeParse(error).success).toBe(true);
  expect((error as { code: string }).code).toBe(code);
  return body as {
    error: { code: string; request_id: string; summary: string };
  };
}

/**
 * One channel row as the owner connection sees it (superuser, RLS-irrelevant): the data-plane
 * facts the route answers must be built on. Runs only after a route assertion already passed, so
 * a missing table can never surface as a fixture error — the red light stays a missing-route one.
 */
async function channelRows(tenantId: string) {
  return ownerDatabase.$client.unsafe<
    {
      id: string;
      owner_principal_id: string;
      bot_resource_id: string;
      thread_id: string;
      client_request_id: string;
      status: string;
      archived_at: Date | null;
    }[]
  >(
    `select id, owner_principal_id, bot_resource_id, thread_id, client_request_id, status, archived_at
       from enterprise_channels where tenant_id = $1 order by id`,
    [tenantId],
  );
}

async function botAclEpoch(
  tenantId: string,
  resourceId: string,
): Promise<number> {
  const rows = await ownerDatabase.$client.unsafe<{ acl_epoch: number }[]>(
    "select acl_epoch from enterprise_resources where tenant_id = $1 and id = $2",
    [tenantId, resourceId],
  );
  expect(rows).toHaveLength(1);
  return rows[0].acl_epoch;
}

/**
 * Inserts the `run` grant the conversations-v1 migration will admit. While the grants CHECK still
 * only allows 'read' (spec §6.2 widening not yet applied) the insert is a 23514: the grant stays
 * absent and the run-dependent cases fail on their own assertions — never as fixture errors,
 * never as a faked success.
 */
async function grantRunFixture(
  tenantId: string,
  resourceId: string,
  principalId: string,
): Promise<void> {
  try {
    await ownerDatabase.$client.unsafe(
      "insert into enterprise_resource_grants (tenant_id, resource_id, principal_id, action) values ($1, $2, $3, 'run')",
      [tenantId, resourceId, principalId],
    );
  } catch (error) {
    if (isSqlState(error, "23514")) {
      return;
    }
    throw error;
  }
}

/** Cleans the conversations table if the C05 migration exists yet; a missing table is fine. */
async function cleanupChannels(): Promise<void> {
  try {
    await ownerDatabase.$client.unsafe(
      `delete from enterprise_channels where tenant_id like '${PREFIX}%'`,
    );
  } catch (error) {
    if (isSqlState(error, "42P01")) {
      return;
    }
    throw error;
  }
}

beforeAll(async () => {
  await cleanupChannels();
  /* Idempotent teardown in foreign-key order, scoped to this file's prefix. */
  await ownerDatabase
    .delete(enterpriseResourceGrants)
    .where(like(enterpriseResourceGrants.tenantId, `${PREFIX}%`));
  await ownerDatabase
    .delete(enterpriseResources)
    .where(like(enterpriseResources.tenantId, `${PREFIX}%`));
  await ownerDatabase
    .delete(enterpriseWorkspaces)
    .where(like(enterpriseWorkspaces.tenantId, `${PREFIX}%`));
  await ownerDatabase
    .delete(enterpriseSecurityEvents)
    .where(like(enterpriseSecurityEvents.tenantId, `${PREFIX}%`));
  await ownerDatabase
    .delete(enterpriseMemberships)
    .where(like(enterpriseMemberships.tenantId, `${PREFIX}%`));
  await ownerDatabase
    .delete(enterpriseIdentityEvents)
    .where(like(enterpriseIdentityEvents.id, `${PREFIX}%`));
  await ownerDatabase
    .delete(enterprisePrincipals)
    .where(like(enterprisePrincipals.id, `${PREFIX}%`));
  await ownerDatabase
    .delete(enterpriseTenants)
    .where(like(enterpriseTenants.id, `${PREFIX}%`));
  await ownerDatabase.delete(users).where(like(users.id, `${PREFIX}%`));

  await ownerDatabase
    .insert(users)
    .values([
      { id: USER_OWNER, email: `${USER_OWNER}@t5c.invalid` },
      { id: USER_OTHER, email: `${USER_OTHER}@t5c.invalid` },
      { id: USER_ADMIN, email: `${USER_ADMIN}@t5c.invalid` },
    ])
    .onConflictDoNothing();

  await createPrincipal(identityOperatorDatabase, {
    principalId: P_OWNER,
    userId: USER_OWNER,
    operator: IDENTITY_OPERATOR,
    operationId: "t5c-op-idp-owner",
  });
  await createPrincipal(identityOperatorDatabase, {
    principalId: P_OTHER,
    userId: USER_OTHER,
    operator: IDENTITY_OPERATOR,
    operationId: "t5c-op-idp-other",
  });

  for (const [tenantId, tenantName] of [
    [TENANT_A, TENANT_NAME_A],
    [TENANT_B, TENANT_NAME_B],
  ] as const) {
    await provisionMember(operatorDatabase, {
      tenantId,
      tenantName,
      principalId: P_OWNER,
      userId: USER_OWNER,
      role: "member",
      operator: OPERATOR,
      operationId: `t5c-op-open-owner-${tenantId}`,
    });
    await createWorkspace(operatorDatabase, {
      tenantId,
      workspaceId: tenantId === TENANT_A ? WS_A : WS_B,
      name: `T5C Workspace ${tenantId}`,
      operator: OPERATOR,
      operationId: `t5c-op-ws-${tenantId}`,
    });
  }
  await provisionMember(operatorDatabase, {
    tenantId: TENANT_A,
    tenantName: TENANT_NAME_A,
    principalId: P_OTHER,
    userId: USER_OTHER,
    role: "member",
    operator: OPERATOR,
    operationId: "t5c-op-open-other-a",
  });

  /* Bot rows: kind='bot' has no producer domain yet (spec §11.6), so the fixture writes the
   * resource rows directly as the owner. */
  await ownerDatabase.insert(enterpriseResources).values(
    (
      [
        [TENANT_A, BOT_RW, WS_A],
        [TENANT_A, BOT_RO, WS_A],
        [TENANT_A, BOT_RUNONLY, WS_A],
        [TENANT_A, BOT_OTHER, WS_A],
        [TENANT_B, BOT_B, WS_B],
      ] as const
    ).map(([tenantId, botId, workspaceId]) => ({
      tenantId,
      id: botId,
      workspaceId,
      kind: "bot",
    })),
  );

  for (const [tenantId, botId, principalId] of [
    [TENANT_A, BOT_RW, P_OWNER],
    [TENANT_A, BOT_RO, P_OWNER],
    [TENANT_A, BOT_OTHER, P_OTHER],
    [TENANT_B, BOT_B, P_OWNER],
  ] as const) {
    await grantRead(operatorDatabase, {
      tenantId,
      resourceId: botId,
      principalId,
      operator: OPERATOR,
      operationId: `t5c-op-grant-${botId}`,
    });
  }
  await grantRunFixture(TENANT_A, BOT_RW, P_OWNER);
  await grantRunFixture(TENANT_A, BOT_RUNONLY, P_OWNER);
  await grantRunFixture(TENANT_B, BOT_B, P_OWNER);
});

afterAll(async () => {
  await Promise.allSettled([
    ownerDatabase.$client.close(),
    identityOperatorDatabase.$client.close(),
    operatorDatabase.$client.close(),
    directoryLoginDatabase.$client.close(),
    dataDatabase.$client.close(),
  ]);
});

describe("C05 conversations: the rejection surface and the admin boundary (spec N1/N2)", () => {
  test("no session is 401 AUTH_REQUIRED on every conversations endpoint", async () => {
    asUser(null);
    const body = await expectError(
      await get("/api/enterprise/v1/bots", TENANT_A),
      401,
      "AUTH_REQUIRED",
    );
    expect(body.error.summary).toBe("请求未获允许");
    await expectError(
      await post(
        "/api/enterprise/v1/channels",
        { botId: BOT_RW, clientRequestId: "t5c-key-unauth" },
        TENANT_A,
      ),
      401,
      "AUTH_REQUIRED",
    );
  });

  test("a missing or malformed tenant selector is 400 TENANT_REQUIRED", async () => {
    asUser(USER_OWNER);
    for (const selector of [undefined, "", "../escape", "x".repeat(129)]) {
      const headers: Record<string, string> = {};
      if (selector !== undefined) {
        headers["x-openbot-tenant"] = selector;
      }
      const response = await liveApp.request("/api/enterprise/v1/bots", {
        headers,
      });
      await expectError(response, 400, "TENANT_REQUIRED");
    }
  });

  test("a non-member tenant selection is 403 TENANT_FORBIDDEN, never a resource answer", async () => {
    asUser(USER_OWNER);
    await expectError(
      await get("/api/enterprise/v1/bots", "t5c-tenant-zz"),
      403,
      "TENANT_FORBIDDEN",
    );
    await expectError(
      await get("/api/enterprise/v1/channels", "t5c-tenant-zz"),
      403,
      "TENANT_FORBIDDEN",
    );
  });

  test("a platform admin gets no implicit tenant business access (spec N2)", async () => {
    asUser(USER_ADMIN);
    const chooser = await liveApp.request("/api/enterprise/v1/tenants");
    expect(chooser.status).toBe(200);
    expect(await chooser.json()).toEqual({ items: [] });
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await expectError(
        await get("/api/enterprise/v1/bots", tenantId),
        403,
        "TENANT_FORBIDDEN",
      );
      await expectError(
        await get("/api/enterprise/v1/channels", tenantId),
        403,
        "TENANT_FORBIDDEN",
      );
      await expectError(
        await post(
          "/api/enterprise/v1/channels",
          { botId: BOT_RW, clientRequestId: "t5c-key-admin" },
          tenantId,
        ),
        403,
        "TENANT_FORBIDDEN",
      );
    }
    asUser(USER_OWNER);
  });
});

describe("C05 conversations: the authorized-bot list (spec N3/N9)", () => {
  test("GET /bots lists exactly the read-granted active bots of the selected tenant", async () => {
    asUser(USER_OWNER);
    const response = await get("/api/enterprise/v1/bots", TENANT_A);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: unknown[];
      nextCursor: string | null;
    };
    /* The page envelope is frozen (StringCursorPageSchema): exactly items + nextCursor. */
    expect(Object.keys(body).sort()).toEqual(["items", "nextCursor"]);
    expect(
      typeof body.nextCursor === "string" || body.nextCursor === null,
    ).toBe(true);
    /* Item DTOs are not frozen yet (spec §3.5); identity is asserted by id, never by count alone.
     * BOT_OTHER (granted to P_OTHER) and BOT_B (other tenant) must never appear. */
    const text = JSON.stringify(body.items);
    expect(text).toContain(BOT_RW);
    expect(text).toContain(BOT_RO);
    expect(text).not.toContain(BOT_OTHER);
    expect(text).not.toContain(BOT_B);
    expect(text).not.toContain(TENANT_NAME_A);
    expect(text).not.toContain(TENANT_NAME_B);
  });

  test("a second member sees only their own grants, not the owner's bots", async () => {
    asUser(USER_OTHER);
    const response = await get("/api/enterprise/v1/bots", TENANT_A);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    const text = JSON.stringify(body.items);
    expect(text).toContain(BOT_OTHER);
    expect(text).not.toContain(BOT_RW);
    expect(text).not.toContain(BOT_RO);
    asUser(USER_OWNER);
  });

  test("cross-tenant bots never cross the tenant boundary in either direction", async () => {
    asUser(USER_OWNER);
    const inA = JSON.stringify(
      await jsonOf(await get("/api/enterprise/v1/bots", TENANT_A)),
    );
    expect(inA).not.toContain(BOT_B);
    const inB = JSON.stringify(
      await jsonOf(await get("/api/enterprise/v1/bots", TENANT_B)),
    );
    expect(inB).toContain(BOT_B);
    expect(inB).not.toContain(BOT_RW);
    expect(inB).not.toContain(BOT_RO);
  });
});

describe("C05 conversations: create, idempotency, detail, archive (spec N4/N5/N6)", () => {
  const KEY_1 = "t5c-key-1";
  const KEY_2 = "t5c-key-2";

  test("POST /channels creates a personal conversation with a server-generated threadId", async () => {
    asUser(USER_OWNER);
    const response = await post(
      "/api/enterprise/v1/channels",
      { botId: BOT_RW, clientRequestId: KEY_1 },
      TENANT_A,
    );
    expect(response.status).toBe(200);
    const parsed = PersonalConversationShape.safeParse(await response.json());
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    if (!parsed.success) {
      throw new Error("unreachable: the create answer must parse");
    }
    ownerConversation = parsed.data;
    expect(ownerConversation.botId).toBe(BOT_RW);
    expect(ownerConversation.mode).toBe("single");
    expect(ownerConversation.status).toBe("active");
    expect(ownerConversation.channelId.length).toBeGreaterThan(0);
    expect(ownerConversation.threadId.length).toBeGreaterThan(0);
  });

  test("a replayed create with the same clientRequestId and bot reads back the same conversation", async () => {
    asUser(USER_OWNER);
    const before = await channelRows(TENANT_A);
    expect(before).toHaveLength(1);
    const response = await post(
      "/api/enterprise/v1/channels",
      { botId: BOT_RW, clientRequestId: KEY_1 },
      TENANT_A,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(conversationOf());
    expect(await channelRows(TENANT_A)).toHaveLength(1);
  });

  test("the same clientRequestId with a different bot is a 409 SUBMISSION_CONFLICT", async () => {
    asUser(USER_OWNER);
    const response = await post(
      "/api/enterprise/v1/channels",
      { botId: BOT_RO, clientRequestId: KEY_1 },
      TENANT_A,
    );
    await expectError(response, 409, "SUBMISSION_CONFLICT");
    expect(await channelRows(TENANT_A)).toHaveLength(1);
  });

  test("a different clientRequestId creates a new conversation with a new threadId", async () => {
    asUser(USER_OWNER);
    const response = await post(
      "/api/enterprise/v1/channels",
      { botId: BOT_RW, clientRequestId: KEY_2 },
      TENANT_A,
    );
    expect(response.status).toBe(200);
    const body = PersonalConversationShape.parse(await response.json());
    expect(body.channelId).not.toBe(conversationOf().channelId);
    expect(body.threadId).not.toBe(conversationOf().threadId);
    const rows = await channelRows(TENANT_A);
    expect(rows).toHaveLength(2);
  });

  test("GET /channels pages the owner's conversations in a stable envelope", async () => {
    asUser(USER_OWNER);
    const first = await get("/api/enterprise/v1/channels", TENANT_A);
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      items: unknown[];
      nextCursor: string | null;
    };
    expect(Object.keys(body).sort()).toEqual(["items", "nextCursor"]);
    for (const item of body.items) {
      expect(PersonalConversationShape.safeParse(item).success).toBe(true);
    }
    const text = JSON.stringify(body.items);
    expect(text).toContain(conversationOf().channelId);
    expect(text).not.toContain(BOT_B);
    /* Cursor stability: an immediate repeat answers byte-identically. Multi-page cursor
     * negotiation is not frozen yet (spec §3.5 freezes only the envelope), so it is not guessed. */
    const second = await get("/api/enterprise/v1/channels", TENANT_A);
    expect(JSON.stringify(await second.json())).toBe(JSON.stringify(body));
  });

  test("GET /channels/:id returns the authoritative conversation equal to the create answer", async () => {
    asUser(USER_OWNER);
    const response = await get(
      `/api/enterprise/v1/channels/${conversationOf().channelId}`,
      TENANT_A,
    );
    expect(response.status).toBe(200);
    const body = PersonalConversationShape.parse(await response.json());
    expect(body).toEqual(conversationOf());
  });

  test("POST /channels/:id/archive flips the status and keeps every identity field", async () => {
    asUser(USER_OWNER);
    const response = await post(
      `/api/enterprise/v1/channels/${conversationOf().channelId}/archive`,
      {},
      TENANT_A,
    );
    expect(response.status).toBe(200);
    const body = PersonalConversationShape.parse(await response.json());
    expect(body.status).toBe("archived");
    expect(body.channelId).toBe(conversationOf().channelId);
    expect(body.threadId).toBe(conversationOf().threadId);
    expect(body.botId).toBe(BOT_RW);

    const detail = PersonalConversationShape.parse(
      await (
        await get(
          `/api/enterprise/v1/channels/${conversationOf().channelId}`,
          TENANT_A,
        )
      ).json(),
    );
    expect(detail.status).toBe("archived");
  });

  test("a repeated archive is idempotent with no second side effect", async () => {
    asUser(USER_OWNER);
    const before = (await channelRows(TENANT_A)).find(
      (row) => row.id === conversationOf().channelId,
    );
    expect(before?.status).toBe("archived");
    const response = await post(
      `/api/enterprise/v1/channels/${conversationOf().channelId}/archive`,
      {},
      TENANT_A,
    );
    expect(response.status).toBe(200);
    const body = PersonalConversationShape.parse(await response.json());
    expect(body.status).toBe("archived");
    const after = (await channelRows(TENANT_A)).find(
      (row) => row.id === conversationOf().channelId,
    );
    expect(after?.archived_at?.getTime()).toBe(before?.archived_at?.getTime());
  });

  test("the channel row records its owner, its bot ACL reference and the server thread (spec N5/N8)", async () => {
    const rows = await channelRows(TENANT_A);
    const row = rows.find((entry) => entry.id === conversationOf().channelId);
    expect(row).toBeDefined();
    expect(row?.owner_principal_id).toBe(P_OWNER);
    expect(row?.bot_resource_id).toBe(BOT_RW);
    expect(row?.thread_id).toBe(conversationOf().threadId);
    expect(row?.client_request_id).toBe(KEY_1);
    expect(row?.status).toBe("archived");
  });
});

describe("C05 conversations: read and run are separate grants (spec N3, §6.2)", () => {
  test("a read-only bot is listed but refuses creation with 403 TENANT_FORBIDDEN", async () => {
    asUser(USER_OWNER);
    /* Visible by read alone (the list case above covers the full set; this pins the single bot). */
    const list = JSON.stringify(
      await jsonOf(await get("/api/enterprise/v1/bots", TENANT_A)),
    );
    expect(list).toContain(BOT_RO);

    /* The refusal code follows spec §6.2's recommendation (TENANT_FORBIDDEN, no new code;
     * open question §11.5 is resolved in the recommended direction). */
    await expectError(
      await post(
        "/api/enterprise/v1/channels",
        { botId: BOT_RO, clientRequestId: "t5c-key-ro" },
        TENANT_A,
      ),
      403,
      "TENANT_FORBIDDEN",
    );
    expect(await channelRows(TENANT_A)).toHaveLength(2);
  });

  test("a run-only bot without read is invisible and its creation is a closed 404", async () => {
    asUser(USER_OWNER);
    const list = JSON.stringify(
      await jsonOf(await get("/api/enterprise/v1/bots", TENANT_A)),
    );
    expect(list).not.toContain(BOT_RUNONLY);
    await expectError(
      await post(
        "/api/enterprise/v1/channels",
        { botId: BOT_RUNONLY, clientRequestId: "t5c-key-runonly" },
        TENANT_A,
      ),
      404,
      "RESOURCE_NOT_FOUND",
    );
  });

  test("read and run grants never imply each other in either direction", async () => {
    /* BOT_RO holds a read row and no run row: listed, not runnable.
     * BOT_RUNONLY holds a run row and no read row: not listed, not addressable. */
    const rows = await ownerDatabase.$client.unsafe<
      { resource_id: string; action: string }[]
    >(
      "select resource_id, action from enterprise_resource_grants where tenant_id = $1 and resource_id in ($2, $3) and principal_id = $4 order by resource_id, action",
      [TENANT_A, BOT_RO, BOT_RUNONLY, P_OWNER],
    );
    expect(rows).toEqual([
      { resource_id: BOT_RO, action: "read" },
      { resource_id: BOT_RUNONLY, action: "run" },
    ]);
  });
});

describe("C05 conversations: non-owner and cross-tenant channel isolation without leakage (spec N1)", () => {
  test("a same-tenant non-owner gets a closed 404 that leaks nothing", async () => {
    asUser(USER_OTHER);
    const response = await get(
      `/api/enterprise/v1/channels/${conversationOf().channelId}`,
      TENANT_A,
    );
    const body = await expectError(response, 404, "RESOURCE_NOT_FOUND");
    const text = JSON.stringify(body);
    expect(text).not.toContain(conversationOf().channelId);
    expect(text).not.toContain(conversationOf().threadId);
    expect(text).not.toContain(BOT_RW);
    expect(text).not.toContain(P_OWNER);
    asUser(USER_OWNER);
  });

  test("the owner's channels never appear in another member's list", async () => {
    asUser(USER_OTHER);
    const response = await get("/api/enterprise/v1/channels", TENANT_A);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(JSON.stringify(body)).not.toContain(conversationOf().channelId);
    asUser(USER_OWNER);
  });

  test("a cross-tenant read of the channel is the same closed 404, leaking nothing", async () => {
    asUser(USER_OWNER);
    const response = await get(
      `/api/enterprise/v1/channels/${conversationOf().channelId}`,
      TENANT_B,
    );
    const body = await expectError(response, 404, "RESOURCE_NOT_FOUND");
    const text = JSON.stringify(body);
    expect(text).not.toContain(conversationOf().channelId);
    expect(text).not.toContain(conversationOf().threadId);
    expect(text).not.toContain(TENANT_NAME_A);
  });

  test("archiving someone else's channel is a closed 404, not a status change", async () => {
    asUser(USER_OTHER);
    const response = await post(
      `/api/enterprise/v1/channels/${conversationOf().channelId}/archive`,
      {},
      TENANT_A,
    );
    await expectError(response, 404, "RESOURCE_NOT_FOUND");
    const rows = await channelRows(TENANT_A);
    expect(
      rows.find((row) => row.id === conversationOf().channelId)?.status,
    ).toBe("archived");
    asUser(USER_OWNER);
  });
});

describe("C05 conversations: the client never owns identity or server fields (spec §3.2/§8)", () => {
  test("forged identity and server-owned fields are refused as shape failures (400)", async () => {
    asUser(USER_OWNER);
    for (const extra of [
      "threadId",
      "channelId",
      "principalId",
      "tenantId",
      "scope",
      "token",
      "mode",
      "status",
    ]) {
      const body: Record<string, unknown> = {
        botId: BOT_RW,
        clientRequestId: `t5c-key-forge-${extra}`,
      };
      body[extra] = "t5c-forged-value";
      const response = await post(
        "/api/enterprise/v1/channels",
        body,
        TENANT_A,
      );
      /* The envelope shape is the contract; the specific 400 code for a schema refusal is not
       * frozen by the spec (§3.3), so only the status and envelope are pinned here. */
      expect(response.status, `extra field: ${extra}`).toBe(400);
      const parsed = (await response.json()) as unknown;
      expect(
        EnterpriseApiErrorSchema.safeParse((parsed as { error: unknown }).error)
          .success,
      ).toBe(true);
    }
    expect(await channelRows(TENANT_A)).toHaveLength(2);
  });

  test("empty or oversized client inputs are refused as shape failures (400)", async () => {
    asUser(USER_OWNER);
    for (const body of [
      { botId: "", clientRequestId: "t5c-key-empty-bot" },
      { botId: BOT_RW, clientRequestId: "" },
      { botId: BOT_RW, clientRequestId: "k".repeat(129) },
      { clientRequestId: "t5c-key-no-bot" },
      { botId: BOT_RW },
    ]) {
      const response = await post(
        "/api/enterprise/v1/channels",
        body,
        TENANT_A,
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("C05 conversations: the tenant/channel/bot/thread composite constraints (spec §4.1/N5)", () => {
  test("the enterprise_channels table exists with the frozen columns", async () => {
    const columns = await ownerDatabase.$client.unsafe<
      { column_name: string; is_nullable: string }[]
    >(
      "select column_name, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'enterprise_channels' order by column_name",
    );
    const names = columns.map((column) => column.column_name).sort();
    expect(names).toEqual(
      [
        "archived_at",
        "bot_resource_id",
        "client_request_id",
        "created_at",
        "id",
        "owner_principal_id",
        "status",
        "tenant_id",
        "thread_id",
      ].sort(),
    );
    expect(
      columns.find((column) => column.column_name === "thread_id")?.is_nullable,
    ).toBe("NO");
  });

  test("the composite key constraints exist as table constraints", async () => {
    const constraints = await ownerDatabase.$client.unsafe<
      { contype: string; definition: string }[]
    >(
      `select contype, pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid = to_regclass('public.enterprise_channels')
        order by contype, definition`,
    );
    const definitions = constraints.map((constraint) => constraint.definition);
    const has = (fragment: string) =>
      definitions.some((definition) => definition.includes(fragment));

    /* PK (tenant_id, id) — the same composite pattern as enterprise_resources. */
    expect(has("PRIMARY KEY (tenant_id, id)")).toBe(true);
    /* The idempotency linearization point. */
    expect(
      has("UNIQUE (tenant_id, owner_principal_id, client_request_id)"),
    ).toBe(true);
    /* The bot reference is a same-tenant composite FK into the ACL-owned resources. */
    expect(
      has(
        "FOREIGN KEY (tenant_id, bot_resource_id) REFERENCES enterprise_resources(tenant_id, id)",
      ),
    ).toBe(true);
    /* The owner is a member of the same tenant. */
    expect(
      has(
        "FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES enterprise_memberships(tenant_id, principal_id)",
      ),
    ).toBe(true);
    /* The archived/active status pair. */
    expect(
      definitions.some((definition) =>
        /status.*active.*archived|status.*archived.*active/.test(definition),
      ),
    ).toBe(true);
  });

  test("no channel can outlive its bot grant rows — the ACL reference is enforced, not copied", async () => {
    /* Deleting the bot resource must be impossible while a channel references it: the FK is the
     * enforcement, proving the row records a live ACL reference rather than a denormalized copy. */
    const rows = await channelRows(TENANT_A);
    expect(rows.length).toBeGreaterThan(0);
    const bot = rows[0].bot_resource_id;
    let refused = false;
    try {
      await ownerDatabase.$client.unsafe(
        "delete from enterprise_resources where tenant_id = $1 and id = $2",
        [TENANT_A, bot],
      );
    } catch (error) {
      refused = isSqlState(error, "23503");
    }
    expect(refused).toBe(true);
    expect(await botAclEpoch(TENANT_A, bot)).toBeGreaterThan(0);
  });
});

describe("C05 conversations: revocation is immediate (spec N7, §7)", () => {
  test("revoking the bot's read grant removes it from the list and closes creation, with the ACL epoch bumped", async () => {
    asUser(USER_OWNER);
    const epochBefore = await botAclEpoch(TENANT_A, BOT_RW);

    await revokeRead(operatorDatabase, {
      tenantId: TENANT_A,
      resourceId: BOT_RW,
      principalId: P_OWNER,
      operator: OPERATOR,
      operationId: "t5c-op-revoke-rw",
    });

    const epochAfter = await botAclEpoch(TENANT_A, BOT_RW);
    expect(epochAfter).toBeGreaterThan(epochBefore);

    const list = JSON.stringify(
      await jsonOf(await get("/api/enterprise/v1/bots", TENANT_A)),
    );
    expect(list).not.toContain(BOT_RW);

    await expectError(
      await post(
        "/api/enterprise/v1/channels",
        { botId: BOT_RW, clientRequestId: "t5c-key-post-revoke" },
        TENANT_A,
      ),
      404,
      "RESOURCE_NOT_FOUND",
    );
    /* Existing channels are never cascade-deleted; access is closed at the authorization layer. */
    expect(await channelRows(TENANT_A)).toHaveLength(2);
  });

  test("a suspended membership loses every conversations endpoint on its next request, tenant A keeps working", async () => {
    asUser(USER_OWNER);
    await suspendMember(operatorDatabase, {
      tenantId: TENANT_B,
      principalId: P_OWNER,
      operator: OPERATOR,
      operationId: "t5c-op-suspend-b",
    });

    await expectError(
      await get("/api/enterprise/v1/bots", TENANT_B),
      403,
      "TENANT_FORBIDDEN",
    );
    await expectError(
      await get("/api/enterprise/v1/channels", TENANT_B),
      403,
      "TENANT_FORBIDDEN",
    );
    await expectError(
      await post(
        "/api/enterprise/v1/channels",
        { botId: BOT_B, clientRequestId: "t5c-key-suspended" },
        TENANT_B,
      ),
      403,
      "TENANT_FORBIDDEN",
    );
    const chooserBody = (await jsonOf(
      await liveApp.request("/api/enterprise/v1/tenants"),
    )) as { items: Array<{ id: string }> };
    expect(chooserBody.items.map((item) => item.id)).toEqual([TENANT_A]);

    /* The untouched tenant keeps answering under the same session: the revocation is scoped,
     * never a logout. (SCOPE_REVOKED, the in-flight window, is covered by the transaction-layer
     * tests that own that mechanism.) */
    await jsonOf(await get("/api/enterprise/v1/bots", TENANT_A));
  });
});
