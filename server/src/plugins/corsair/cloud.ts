import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../../auth/guards";

const pluginSlug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);
const tenantId = z.string().trim().min(1).max(200);
const operation = z.string().regex(/^[a-zA-Z0-9_.-]{1,200}$/);
const json = z.unknown();
const operationsResponse = z.object({
  plugins: z.record(z.string(), z.array(operation)),
});

export type CorsairOperation = {
  plugin: string;
  operation: string;
  /** Corsair defaults unannotated operations to writes. Keep that fail-closed default. */
  riskLevel: "write";
  approvalRequired: true;
};

export type CorsairCloudConfig = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
};

function cloudBaseUrl(apiKey: string, baseUrl?: string) {
  if (baseUrl) return baseUrl.replace(/\/$/, "");
  const match = /^ck_cloud_([^.]+)\./.exec(apiKey);
  if (!match) throw new Error("CORSAIR_CLOUD_KEY has an invalid format.");
  return `https://api.corsair.cloud/${encodeURIComponent(match[1])}/api/corsair`;
}

export function createCorsairCloudClient(config: CorsairCloudConfig) {
  const transport = config.fetch ?? fetch;
  const baseUrl = cloudBaseUrl(config.apiKey, config.baseUrl);

  async function request<T extends z.ZodType>(
    path: string,
    init: RequestInit,
    schema: T,
  ) {
    const response = await transport(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok)
      throw new Error(
        `Corsair Cloud request failed with status ${response.status}.`,
      );
    return schema.parse(payload);
  }

  return {
    baseUrl,
    listPlugins: () => request("/plugins", { method: "GET" }, json),
    listOperations: async (): Promise<CorsairOperation[]> => {
      const result = await request(
        "/call",
        { method: "GET" },
        operationsResponse,
      );
      return Object.entries(result.plugins)
        .flatMap(([plugin, operations]) =>
          operations.map((name) => ({
            plugin,
            operation: name,
            riskLevel: "write" as const,
            approvalRequired: true as const,
          })),
        )
        .sort((left, right) =>
          `${left.plugin}.${left.operation}`.localeCompare(
            `${right.plugin}.${right.operation}`,
          ),
        );
    },
    getPlugin: (plugin: string) =>
      request(
        `/plugins/${encodeURIComponent(pluginSlug.parse(plugin))}`,
        { method: "GET" },
        json,
      ),
    connectionStatus: (tenant: string) =>
      request(
        `/connection-status?tenantId=${encodeURIComponent(tenantId.parse(tenant))}`,
        { method: "GET" },
        json,
      ),
    createConnectLink: (plugin: string, tenant: string) =>
      request(
        "/connect/link",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plugin: pluginSlug.parse(plugin),
            tenantId: tenantId.parse(tenant),
          }),
        },
        json,
      ),
    call: (tenant: string, plugin: string, action: string, args: unknown) =>
      request(
        `/${encodeURIComponent(tenantId.parse(tenant))}/${encodeURIComponent(pluginSlug.parse(plugin))}/call/${encodeURIComponent(operation.parse(action))}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ args }),
        },
        json,
      ),
  };
}

export type CorsairCloudClient = ReturnType<typeof createCorsairCloudClient>;

export function createCorsairCloudRoutes({
  client,
  requireUser,
}: {
  client: CorsairCloudClient;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.get("/plugins", async (context) =>
    context.json(await client.listPlugins()),
  );
  routes.get("/operations", async (context) =>
    context.json(await client.listOperations()),
  );
  routes.get("/plugins/:plugin", async (context) =>
    context.json(await client.getPlugin(context.req.param("plugin"))),
  );
  routes.get("/connection-status", async (context) =>
    context.json(await client.connectionStatus(context.var.actor.id)),
  );
  routes.post("/connect/link", async (context) => {
    const body = z
      .object({ plugin: pluginSlug })
      .parse(await context.req.json());
    return context.json(
      await client.createConnectLink(body.plugin, context.var.actor.id),
    );
  });
  routes.post("/call", async (context) => {
    const body = z
      .object({ plugin: pluginSlug, operation, args: z.unknown().default({}) })
      .parse(await context.req.json());
    return context.json(
      await client.call(
        context.var.actor.id,
        body.plugin,
        body.operation,
        body.args,
      ),
    );
  });
  routes.onError((error, context) =>
    context.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Corsair Cloud request failed.",
      },
      502,
    ),
  );
  return routes;
}
