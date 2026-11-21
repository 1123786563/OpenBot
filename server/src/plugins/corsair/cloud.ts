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
const operationMetadata = z
  .object({
    name: z.string().max(200).optional(),
    operation: z.string().max(200).optional(),
    path: z.string().max(200).optional(),
    op: z.string().max(200).optional(),
    description: z.string().max(4_000).optional(),
    riskLevel: z.string().max(40).optional(),
    effect: z.string().max(40).optional(),
    destructive: z.boolean().optional(),
    inputSchema: z.unknown().optional(),
    outputSchema: z.unknown().optional(),
    schema: z.unknown().optional(),
  })
  .passthrough();
const operationsResponse = z.object({
  plugins: z.record(
    z.string(),
    z.array(z.union([operation, operationMetadata])),
  ),
});

function safeSchema(
  value: unknown,
  depth = 0,
): Record<string, unknown> | undefined {
  if (
    depth > 16 ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return undefined;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (key.length > 100) continue;
    if (
      key === "properties" &&
      child &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      const properties: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(
        child as Record<string, unknown>,
      )) {
        const parsed = safeSchema(property, depth + 1);
        if (parsed) properties[name] = parsed;
      }
      output.properties = properties;
      continue;
    }
    if (
      ["items", "additionalProperties", "not", "if", "then", "else"].includes(
        key,
      )
    ) {
      const parsed = safeSchema(child, depth + 1);
      if (parsed) output[key] = parsed;
      else if (typeof child === "boolean") output[key] = child;
      continue;
    }
    if (
      ["type", "title", "description", "$schema", "$ref", "format"].includes(
        key,
      )
    ) {
      if (typeof child === "string" && child.length <= 4_000)
        output[key] = child;
      continue;
    }
    if (["required", "enum"].includes(key) && Array.isArray(child)) {
      output[key] = child
        .slice(0, 200)
        .filter(
          (item) =>
            typeof item === "string" ||
            typeof item === "number" ||
            typeof item === "boolean",
        );
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export type CorsairOperation = {
  plugin: string;
  operation: string;
  /** Corsair defaults unannotated operations to writes. Keep that fail-closed default. */
  riskLevel: "read" | "write" | "destructive";
  approvalRequired: boolean;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

export type CorsairIntegration = {
  id: string;
  authType: string | null;
  configured: boolean;
  missingFields: string[];
  oauth: Record<string, unknown> | null;
};

export type CorsairCloudConfig = {
  apiKey: string;
  baseUrl?: string;
  managementBaseUrl?: string;
  instanceKey?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
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
    listPlugins: async (): Promise<CorsairIntegration[]> => {
      const payload = await request("/plugins", { method: "GET" }, json);
      if (!Array.isArray(payload)) return [];
      return payload.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          return [];
        const row = entry as Record<string, unknown>;
        if (typeof row.id !== "string" || !pluginSlug.safeParse(row.id).success)
          return [];
        return [
          {
            id: row.id,
            authType: typeof row.authType === "string" ? row.authType : null,
            configured: row.configured === true,
            missingFields: Array.isArray(row.missingFields)
              ? row.missingFields.filter(
                  (field): field is string => typeof field === "string",
                )
              : [],
            oauth:
              row.oauth &&
              typeof row.oauth === "object" &&
              !Array.isArray(row.oauth)
                ? (row.oauth as Record<string, unknown>)
                : null,
          },
        ];
      });
    },
    listOperations: async (): Promise<CorsairOperation[]> => {
      const result = await request(
        "/call",
        { method: "GET" },
        operationsResponse,
      );
      const entries = Object.entries(result.plugins)
        .filter(([plugin]) => pluginSlug.safeParse(plugin).success)
        .flatMap(([plugin, entries]) =>
          entries.flatMap((entry) => {
            const metadata = typeof entry === "string" ? undefined : entry;
            const name =
              typeof entry === "string"
                ? entry
                : (entry.name ?? entry.operation ?? entry.path ?? entry.op);
            if (!name || !operation.safeParse(name).success) return [];
            const riskLevel: CorsairOperation["riskLevel"] =
              metadata?.riskLevel === "read" && metadata.destructive !== true
                ? "read"
                : metadata?.riskLevel === "destructive" ||
                    metadata?.destructive === true
                  ? "destructive"
                  : metadata?.effect === "read"
                    ? "read"
                    : "write";
            const schema = metadata?.inputSchema ?? metadata?.schema;
            return [
              {
                plugin,
                operation: name,
                riskLevel,
                approvalRequired: riskLevel !== "read",
                ...(metadata?.description
                  ? { description: metadata.description }
                  : {}),
                ...(safeSchema(schema)
                  ? { inputSchema: safeSchema(schema) }
                  : {}),
                ...(safeSchema(metadata?.outputSchema)
                  ? { outputSchema: safeSchema(metadata?.outputSchema) }
                  : {}),
              },
            ];
          }),
        );
      const unique = new Map<string, CorsairOperation>();
      for (const entry of entries) {
        const key = `${entry.plugin}.${entry.operation}`;
        const previous = unique.get(key);
        if (
          !previous ||
          (previous.description === undefined &&
            entry.description !== undefined)
        )
          unique.set(key, entry);
      }
      return [...unique.values()].sort((left, right) =>
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
