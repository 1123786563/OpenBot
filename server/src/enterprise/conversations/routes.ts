import { Hono } from "hono";
import type {
  AppendMessageInput,
  ConversationDTO,
  ConversationInput,
  ConversationService,
  PlatformScope,
  ScopeResolver,
} from "../contracts";

function errorResponse(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "message_conflict")
    return {
      status: 409,
      body: {
        error: {
          code,
          message: "Message key conflicts with existing content.",
        },
      },
    };
  const message = error instanceof Error ? error.message : "INTERNAL";
  if (message === "AUTH_REQUIRED")
    return {
      status: 401,
      body: { error: { code: "unauthenticated", message } },
    };
  if (["CONVERSATION_NOT_FOUND", "RESOURCE_NOT_FOUND"].includes(message))
    return {
      status: 404,
      body: {
        error: { code: "not_found", message: "Conversation not found." },
      },
    };
  if (
    [
      "SCOPE_REVOKED",
      "TENANT_FORBIDDEN",
      "CHANNEL_FORBIDDEN",
      "ATTACHMENT_FORBIDDEN",
      "UNVERIFIED_SCOPE",
    ].includes(message)
  )
    return {
      status: 403,
      body: { error: { code: "forbidden", message: "Access denied." } },
    };
  if (message === "INVALID_REQUEST" || message.startsWith("INVALID_"))
    return {
      status: 400,
      body: { error: { code: "invalid_request", message } },
    };
  console.error("Enterprise conversation request failed", error);
  return {
    status: 500,
    body: { error: { code: "internal", message: "Request failed." } },
  };
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new Error("INVALID_REQUEST");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("INVALID_REQUEST");
  return value as Record<string, unknown>;
}

export function createConversationRoutes(
  service: ConversationService & {
    list(scope: PlatformScope): Promise<ConversationDTO[]>;
  },
  scopes: ScopeResolver,
) {
  const routes = new Hono();
  routes.get("/", async (context) => {
    try {
      const scope = await scopes.resolve(context.req.raw);
      return context.json(await service.list(scope));
    } catch (error) {
      const response = errorResponse(error);
      return context.json(
        response.body,
        response.status as 400 | 401 | 403 | 404 | 409 | 500,
      );
    }
  });
  routes.post("/", async (context) => {
    try {
      const scope = await scopes.resolve(context.req.raw);
      const input = await jsonObject(context.req.raw);
      if (
        (input.threadId !== undefined && typeof input.threadId !== "string") ||
        (input.title !== undefined && typeof input.title !== "string")
      )
        throw new Error("INVALID_REQUEST");
      return context.json(
        await service.getOrCreate(scope, input as ConversationInput),
        201,
      );
    } catch (error) {
      const response = errorResponse(error);
      return context.json(
        response.body,
        response.status as 400 | 401 | 403 | 404 | 409 | 500,
      );
    }
  });
  routes.get("/:threadId/messages", async (context) => {
    try {
      const scope = await scopes.resolve(context.req.raw);
      const before = context.req.query("before_seq");
      const limit = context.req.query("limit");
      return context.json(
        await service.history(scope, {
          threadId: context.req.param("threadId"),
          beforeSeq: before === undefined ? null : Number(before),
          limit: limit === undefined ? 50 : Number(limit),
        }),
      );
    } catch (error) {
      const response = errorResponse(error);
      return context.json(
        response.body,
        response.status as 400 | 401 | 403 | 404 | 409 | 500,
      );
    }
  });
  routes.post("/:threadId/messages", async (context) => {
    try {
      const scope = await scopes.resolve(context.req.raw);
      const body = await jsonObject(context.req.raw);
      if (
        typeof body.clientMessageKey !== "string" ||
        typeof body.content !== "string" ||
        !Array.isArray(body.attachments) ||
        body.attachments.some((id) => typeof id !== "string")
      )
        throw new Error("INVALID_REQUEST");
      const input: AppendMessageInput = {
        threadId: context.req.param("threadId"),
        clientMessageKey: body.clientMessageKey,
        content: body.content,
        attachments: body.attachments as string[],
      };
      return context.json(await service.append(scope, input), 201);
    } catch (error) {
      const response = errorResponse(error);
      return context.json(
        response.body,
        response.status as 400 | 401 | 403 | 404 | 409 | 500,
      );
    }
  });
  return routes;
}
