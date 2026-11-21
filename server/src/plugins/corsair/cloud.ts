import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../../auth/guards";

const pluginSlug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);
const tenantId = z.string().trim().min(1).max(200);
const operation = z.string().regex(/^[a-zA-Z0-9_.-]{1,200}$/);
const entityType = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const entityMethod = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const instanceKey = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
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
  managementBaseUrl?: string;
  instanceKey?: string;
  fetch?: typeof fetch;
};

function projectSlug(apiKey: string) {
  const match = /^ck_cloud_([a-z0-9]+)\./.exec(apiKey);
  if (!match) throw new Error("CORSAIR_CLOUD_KEY has an invalid format.");
  const slug = match[1];
  if (!slug) throw new Error("CORSAIR_CLOUD_KEY has an invalid format.");
  return slug;
}

function cloudBaseUrl(apiKey: string, baseUrl?: string) {
  if (baseUrl) return baseUrl.replace(/\/$/, "");
  return `https://api.corsair.cloud/${encodeURIComponent(projectSlug(apiKey))}/api/corsair`;
}

export function createCorsairCloudClient(config: CorsairCloudConfig) {
  const transport = config.fetch ?? fetch;
  const baseUrl = cloudBaseUrl(config.apiKey, config.baseUrl);
  const managementBaseUrl =
    config.managementBaseUrl?.replace(/\/$/, "") ??
    `${new URL(baseUrl).origin}/v1/projects/${encodeURIComponent(projectSlug(config.apiKey))}`;
  const configuredInstance = config.instanceKey
    ? instanceKey.parse(config.instanceKey)
    : null;

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

  async function managementRequest<T extends z.ZodType>(
    path: string,
    init: RequestInit,
    schema: T,
  ) {
    return requestFrom(`${managementBaseUrl}${path}`, init, schema);
  }

  async function requestFrom<T extends z.ZodType>(
    url: string,
    init: RequestInit,
    schema: T,
  ) {
    const response = await transport(url, {
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

  function requireInstance() {
    if (!configuredInstance)
      throw new Error(
        "Corsair Cloud webhook management requires CORSAIR_CLOUD_INSTANCE.",
      );
    return configuredInstance;
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
    callEntity: (
      tenant: string,
      plugin: string,
      type: string,
      method: string,
      args: unknown[] = [],
    ) =>
      request(
        `/${encodeURIComponent(tenantId.parse(tenant))}/${encodeURIComponent(pluginSlug.parse(plugin))}/db/${encodeURIComponent(entityType.parse(type))}/${encodeURIComponent(entityMethod.parse(method))}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ args }),
        },
        json,
      ),
    listWebhooks: () =>
      managementRequest(
        `/webhooks?instance=${encodeURIComponent(requireInstance())}`,
        { method: "GET" },
        json,
      ),
    createWebhook: (plugin: string, signingSecret?: string) =>
      managementRequest(
        "/webhooks",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instance: requireInstance(),
            integration: pluginSlug.parse(plugin),
            ...(signingSecret ? { signing_secret: signingSecret } : {}),
          }),
        },
        json,
      ),
    getWebhook: (plugin: string) =>
      managementRequest(
        `/webhooks/${encodeURIComponent(pluginSlug.parse(plugin))}?instance=${encodeURIComponent(requireInstance())}`,
        { method: "GET" },
        json,
      ),
    deleteWebhook: (plugin: string) =>
      managementRequest(
        `/webhooks/${encodeURIComponent(pluginSlug.parse(plugin))}?instance=${encodeURIComponent(requireInstance())}`,
        { method: "DELETE" },
        json,
      ),
    rotateWebhookSecret: (plugin: string, signingSecret: string) =>
      managementRequest(
        `/webhooks/${encodeURIComponent(pluginSlug.parse(plugin))}/rotate-secret`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instance: requireInstance(),
            signing_secret: signingSecret,
          }),
        },
        json,
      ),
    listWebhookDeliveries: (plugin: string) =>
      managementRequest(
        `/webhooks/${encodeURIComponent(pluginSlug.parse(plugin))}/deliveries?instance=${encodeURIComponent(requireInstance())}`,
        { method: "GET" },
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
  const adminOnly: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  };
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
  routes.post("/db", async (context) => {
    const body = z
      .object({
        plugin: pluginSlug,
        entityType,
        method: entityMethod,
        args: z.array(z.unknown()).default([]),
      })
      .parse(await context.req.json());
    return context.json(
      await client.callEntity(
        context.var.actor.id,
        body.plugin,
        body.entityType,
        body.method,
        body.args,
      ),
    );
  });
  routes.get("/webhooks", adminOnly, async (context) =>
    context.json(await client.listWebhooks()),
  );
  routes.post("/webhooks", adminOnly, async (context) => {
    const body = z
      .object({
        plugin: pluginSlug,
        signingSecret: z.string().min(1).max(500).optional(),
      })
      .parse(await context.req.json());
    return context.json(
      await client.createWebhook(body.plugin, body.signingSecret),
    );
  });
  routes.get("/webhooks/:plugin", adminOnly, async (context) =>
    context.json(await client.getWebhook(context.req.param("plugin"))),
  );
  routes.delete("/webhooks/:plugin", adminOnly, async (context) =>
    context.json(await client.deleteWebhook(context.req.param("plugin"))),
  );
  routes.post("/webhooks/:plugin/rotate-secret", adminOnly, async (context) => {
    const body = z
      .object({ signingSecret: z.string().min(1).max(500) })
      .parse(await context.req.json());
    return context.json(
      await client.rotateWebhookSecret(
        context.req.param("plugin"),
        body.signingSecret,
      ),
    );
  });
  routes.get("/webhooks/:plugin/deliveries", adminOnly, async (context) =>
    context.json(
      await client.listWebhookDeliveries(context.req.param("plugin")),
    ),
  );
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
