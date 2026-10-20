// MT124（Issue #167）共享夹具：企业入口装配接入统一上下文与授权。
//
// 契约：专用企业测试库（openbot_enterprise_*、仅回环），缺显式 env 由调用方
// 整套显式 skip，绝不回退开发库、skipped 不计通过。夹具用真实受限通道
// （directory/data 双验证连接）构造 **同一个** DeploymentEntryContextFactory
// 与企业作用域 resolver（AC2：同一 authenticate 闭包、同一成员资格重验），
// 并把同一 service 实例同时交给旧装配（createConversationRoutes）与统一装配
// （createEnterpriseConversationEntryRoutes）——AC3 对照测试的两半由此构造
// 性同源。会话事实用真实 enterprise_conversations 行（owner 通道种入，
// 受限 data 通道经 service 读取——RLS 是读取路径的真实边界）。

import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createDatabase, type Database } from "../../../src/db/client";
import { users } from "../../../src/db/schema/core";
import { enterpriseConversations as conversationsTable } from "../../../src/db/schema/enterprise-conversations";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
  enterpriseWorkspaces,
} from "../../../src/db/schema/enterprise-tenancy";
import { createConversationRoutes } from "../../../src/enterprise/conversations/routes";
import { createConversationService } from "../../../src/enterprise/conversations/service";
import { createEnterpriseConversationEntryRoutes } from "../../../src/enterprise/tenancy/assembly-enterprise";
import {
  type DataDatabase,
  type DirectoryDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
} from "../../../src/enterprise/tenancy/connections";
import { createDeploymentEntryContextFactory } from "../../../src/enterprise/tenancy/entry-context";
import { createScopeResolver } from "../../../src/enterprise/tenancy/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseSetupDatabaseVariable,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** 环境探针：调用方据此显式 skip（缺 env 绝不回退开发库）。 */
export function probeAssemblyEnvironment():
  | { ok: true }
  | { ok: false; reason: string } {
  const required = [
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (
    missing.length > 0 ||
    !process.env[enterpriseSetupDatabaseVariable()]?.trim()
  ) {
    return {
      ok: false,
      reason: `MT124 requires ${enterpriseSetupDatabaseVariable()} and the directory/data role URLs (dedicated openbot_enterprise_* test database) — no dev-database fallback`,
    };
  }
  return { ok: true };
}

export type AssemblyIdentity = "a-member" | "b-member";

export type AssemblyRequestInput = Readonly<{
  method: string;
  path: string;
  body?: unknown;
  /** undefined = 不带选择头；null 会话 = 未认证请求。 */
  tenantId?: string;
  workspaceId?: string;
  /** 省略 = 无会话（authenticate 返回 null）。 */
  session?: AssemblyIdentity;
}>;

export type AssemblyFixture = Readonly<{
  readonly ids: Readonly<Record<string, string>>;
  /** 统一装配路由（挂 /api/enterprise/conversations）。 */
  unified: Hono;
  /** 旧装配路由（同 service、同 resolver 构造——对照半边）。 */
  legacy: Hono;
  /** 两半共享的同一个工厂（AC2 的实物）。 */
  readonly factory: ReturnType<typeof createDeploymentEntryContextFactory>;
  /** 真实服务（真实 store 事务 + RLS 读取）。 */
  readonly service: ReturnType<typeof createConversationService>;
  /** 以某身份向某个装配发起 HTTP-shaped 请求。 */
  requestAs(
    assembly: "unified" | "legacy",
    input: AssemblyRequestInput,
  ): Promise<Response>;
  /** owner 通道直种一条 platform 会话行（事实底座）。 */
  seedConversation(input: {
    tenantKey: "company-a" | "company-b";
    owner: AssemblyIdentity;
    threadId: string;
    title: string;
  }): Promise<void>;
  dispose(): Promise<void>;
}>;

export async function createAssemblyFixture(): Promise<AssemblyFixture> {
  const setup = createDatabase(enterpriseTestDatabaseUrlFrom(), { max: 10 });
  const openVerified = async (
    verify: (database: Database) => Promise<DirectoryDatabase | DataDatabase>,
    role: "directory" | "data",
  ) => {
    const candidate = createDatabase(enterpriseRuntimeDatabaseUrlFrom(role), {
      max: 1,
    });
    try {
      return await verify(candidate);
    } catch (error) {
      await candidate.$client.close();
      throw error;
    }
  };
  const directory = (await openVerified(
    verifyDirectoryDatabase,
    "directory",
  )) as DirectoryDatabase;
  const data = (await openVerified(verifyDataDatabase, "data")) as DataDatabase;

  const run = `mt124-${randomUUID().slice(0, 8)}`;
  const ids: Record<string, string> = {
    "company-a": `${run}-company-a`,
    "company-b": `${run}-company-b`,
    "team-a1": `${run}-team-a1`,
    "team-b1": `${run}-team-b1`,
  };
  const identities: readonly AssemblyIdentity[] = ["a-member", "b-member"];
  for (const identity of identities) {
    ids[`user-${identity}`] = `${run}-user-${identity}`;
    ids[`principal-${identity}`] = `${run}-principal-${identity}`;
  }
  const tenantOf = (identity: AssemblyIdentity) =>
    identity === "a-member" ? ids["company-a"] : ids["company-b"];
  const workspaceOf = (identity: AssemblyIdentity) =>
    identity === "a-member" ? ids["team-a1"] : ids["team-b1"];

  // ---- 身份与成员资格（owner 通道置备；读取走受限通道）。 ----
  await setup.insert(users).values(
    identities.map((identity) => ({
      id: ids[`user-${identity}`],
      email: `${run}-${identity}@mt124.test`,
    })),
  );
  await setup.insert(enterprisePrincipals).values(
    identities.map((identity) => ({
      id: ids[`principal-${identity}`],
      userId: ids[`user-${identity}`],
    })),
  );
  await setup.insert(enterpriseTenants).values([
    { id: ids["company-a"], name: "MT124 Company A" },
    { id: ids["company-b"], name: "MT124 Company B" },
  ]);
  await setup.insert(enterpriseWorkspaces).values([
    { tenantId: ids["company-a"], id: ids["team-a1"], name: "MT124 A1" },
    { tenantId: ids["company-b"], id: ids["team-b1"], name: "MT124 B1" },
  ]);
  await setup.insert(enterpriseMemberships).values(
    identities.map((identity) => ({
      tenantId: tenantOf(identity),
      principalId: ids[`principal-${identity}`],
      role: "member",
    })),
  );
  // 工作范围资格是服务器端事实（MT005）：选中的 team 需要活跃的
  // workspace-membership 行，头里的值不构成资格。
  await setup.insert(enterpriseWorkspaceMemberships).values(
    identities.map((identity) => ({
      tenantId: tenantOf(identity),
      workspaceId: workspaceOf(identity),
      principalId: ids[`principal-${identity}`],
    })),
  );

  // ---- 同一 authenticate 闭包：两个入口、一个工厂、一个 resolver。 ----
  const actorOf = (request: Request): string | null => {
    const identity = request.headers.get("x-mt124-identity");
    if (!identity || !identities.includes(identity as AssemblyIdentity))
      return null;
    return ids[`user-${identity}`];
  };
  const authenticate = async (request: Request) => {
    const userId = actorOf(request);
    return userId ? { actorId: userId, entrypoint: "web" as const } : null;
  };
  const selectTenant = (request: Request) =>
    request.headers.get("x-openbot-tenant");
  const selectWorkspace = (request: Request) =>
    request.headers.get("x-openbot-workspace");

  const factory = createDeploymentEntryContextFactory({
    directory,
    data,
    authenticate,
  });
  const scopes = createScopeResolver(directory, {
    data,
    authenticate,
    selectTenant,
    selectWorkspace,
  });
  const service = createConversationService({ data });

  const unifiedRoutes = createEnterpriseConversationEntryRoutes({
    factory,
    service,
  });
  const legacyRoutes = createConversationRoutes(service, scopes);
  const unified = new Hono().route(
    "/api/enterprise/conversations",
    unifiedRoutes,
  );
  const legacy = new Hono().route(
    "/api/enterprise/conversations",
    legacyRoutes,
  );
  const assemblies = { unified, legacy } as const;

  return {
    ids,
    unified,
    legacy,
    factory,
    service,
    async requestAs(assembly, input) {
      const headers: Record<string, string> = {};
      if (input.session) headers["x-mt124-identity"] = input.session;
      if (input.tenantId !== undefined)
        headers["x-openbot-tenant"] = input.tenantId;
      if (input.workspaceId !== undefined)
        headers["x-openbot-workspace"] = input.workspaceId;
      const init: RequestInit = { method: input.method, headers };
      if (input.body !== undefined && input.method !== "GET") {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(input.body);
      }
      return assemblies[assembly].request(input.path, init);
    },
    async seedConversation({ tenantKey, owner, threadId, title }) {
      const tenantId = ids[tenantKey];
      await setup.insert(conversationsTable).values({
        tenantId,
        workspaceId: workspaceOf(owner),
        principalId: ids[`principal-${owner}`],
        threadId,
        title,
        storageBackend: "platform",
      });
    },
    async dispose() {
      // 先事实后身份，按前缀清扫；本夹具只种 platform 会话行。
      await setup.execute(
        sql`delete from enterprise_message_parts where tenant_id like ${`${run}%`}`,
      );
      await setup.execute(
        sql`delete from enterprise_messages where tenant_id like ${`${run}%`}`,
      );
      await setup
        .delete(conversationsTable)
        .where(like(conversationsTable.tenantId, `${run}%`));
      await setup
        .delete(enterpriseWorkspaceMemberships)
        .where(like(enterpriseWorkspaceMemberships.tenantId, `${run}%`));
      await setup
        .delete(enterpriseMemberships)
        .where(like(enterpriseMemberships.tenantId, `${run}%`));
      await setup
        .delete(enterpriseWorkspaces)
        .where(like(enterpriseWorkspaces.tenantId, `${run}%`));
      await setup
        .delete(enterpriseTenants)
        .where(like(enterpriseTenants.id, `${run}%`));
      await setup
        .delete(enterprisePrincipals)
        .where(like(enterprisePrincipals.id, `${run}%`));
      await setup.delete(users).where(like(users.id, `${run}%`));
      await data.$client.close();
      await directory.$client.close();
      await setup.$client.close();
    },
  };
}
