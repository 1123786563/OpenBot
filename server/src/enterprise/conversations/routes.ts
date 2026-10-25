import { Hono } from "hono";
import type {
  AppendMessageInput,
  ConversationDTO,
  ConversationService,
  PlatformScope,
  ScopeResolver,
} from "../contracts";

function errorResponse(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "INTERNAL";
  const storageCode =
    typeof code === "string"
      ? code
      : message.startsWith("MASTRA_STORAGE_") ||
          message.startsWith("TENANT_STORAGE_")
        ? message
        : undefined;
  // Only genuinely transient storage faults answer 503: configuration or
  // authorization defects (BINDING_STALE, FORBIDDEN, REGISTRY_CORRUPT,
  // CREDENTIAL_MISSING…) are 500s — retrying them cannot help, and folding
  // them into "unavailable" hides them from operators (OCR R10).
  const transientStorageCodes = new Set([
    "MASTRA_STORAGE_UNAVAILABLE",
    "MASTRA_STORAGE_CLOSING",
    "MASTRA_MEMORY_STORAGE_UNAVAILABLE",
    "TENANT_STORAGE_UNAVAILABLE",
    "TENANT_STORAGE_CLOSING",
    "TENANT_STORAGE_STATEMENT_TIMEOUT_CONFLICT",
  ]);
  if (storageCode !== undefined && transientStorageCodes.has(storageCode))
    return {
      status: 503,
      body: {
        error: {
          code: "unavailable",
          message: "Conversation storage unavailable.",
        },
      },
    };
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
  if (message === "AUTH_REQUIRED")
    return {
      status: 401,
      body: { error: { code: "unauthenticated", message } },
    };
  if (
    [
      "CONVERSATION_NOT_FOUND",
      "RESOURCE_NOT_FOUND",
      "THREAD_SCOPE_NOT_FOUND",
      "THREAD_SCOPE_AMBIGUOUS",
    ].includes(message)
  )
    return {
      status: 404,
      body: {
        error: { code: "not_found", message: "Conversation not found." },
      },
    };
  if (message === "DATA_DATABASE_UNAVAILABLE")
    return {
      status: 503,
      body: {
        error: {
          code: "unavailable",
          message: "Conversation storage unavailable.",
        },
      },
    };
  if (message === "LEGACY_HISTORY_READ_ONLY")
    return {
      status: 409,
      body: {
        error: {
          code: "read_only",
          message: "Legacy conversation history is read-only.",
        },
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
        response.status as 400 | 401 | 403 | 404 | 409 | 500 | 503,
      );
    }
  });
  routes.post("/", async (context) => {
    try {
      const scope = await scopes.resolve(context.req.raw);
      const input = await jsonObject(context.req.raw);
      if (
        Object.keys(input).some((key) => key !== "title") ||
        (input.title !== undefined && typeof input.title !== "string")
      )
        throw new Error("INVALID_REQUEST");
      return context.json(
        await service.getOrCreate(
          scope,
          typeof input.title === "string" ? { title: input.title } : {},
        ),
        201,
      );
    } catch (error) {
      const response = errorResponse(error);
      return context.json(
        response.body,
        response.status as 400 | 401 | 403 | 404 | 409 | 500 | 503,
      );
    }
  });
  /*
   * FIX-OCR3 (O3-H1): the answer-basis re-export a browser restoring a transcript reads.
   * The platform's own thread-history DTO carries no per-message metadata, so the basis
   * rows the live stream stamped would vanish on refresh; this answers the same pointers
   * from THIS store's rows, keyed by engine message id. A refresh merges it into the
   * platform's messages; a failure there draws no basis and changes nothing else.
   */
  routes.get("/:threadId/answer-basis", async (context) => {
    try {
      const scope = await scopes.resolveForThread(
        context.req.raw,
        context.req.param("threadId"),
      );
      const threadId = context.req.param("threadId");
      const basis: Record<string, { id: string; kind: string }[]> = {};
      let beforeSeq: number | null = null;
      // One whole-history walk, capped at the model context's own ceiling: a thread longer
      // than this has basis rows the refresh could not pair anyway.
      for (let pages = 0; pages < 50; pages += 1) {
        const page = await service.history(scope, {
          threadId,
          beforeSeq,
          limit: 100,
        });
        for (const item of page.items) {
          if (item.basis !== undefined && item.engineMessageId !== undefined)
            basis[item.engineMessageId] = [...item.basis];
        }
        if (page.nextBeforeSeq === null) break;
        beforeSeq = page.nextBeforeSeq;
      }
      return context.json({ basis });
    } catch (error) {
      const response = errorResponse(error);
      return context.json(
        response.body,
        response.status as 400 | 401 | 403 | 404 | 409 | 500 | 503,
      );
    }
  });
  routes.get("/:threadId/messages", async (context) => {
    try {
      const scope = await scopes.resolveForThread(
        context.req.raw,
        context.req.param("threadId"),
      );
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
        response.status as 400 | 401 | 403 | 404 | 409 | 500 | 503,
      );
    }
  });
  routes.post("/:threadId/messages", async (context) => {
    try {
      const scope = await scopes.resolveForThread(
        context.req.raw,
        context.req.param("threadId"),
      );
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
        response.status as 400 | 401 | 403 | 404 | 409 | 500 | 503,
      );
    }
  });
  return routes;
}

export function createUnavailableConversationRoutes() {
  const routes = new Hono();
  routes.all("*", (context) =>
    context.json(
      {
        error: {
          code: "unavailable",
          message: "Enterprise storage unavailable.",
        },
      },
      503,
    ),
  );
  return routes;
}

/*
 * MT124 (Issue #167): the enterprise entry's unified assembly shares this exact
 * mapping — exported so the assembled routes and these routes can never drift
 * apart on a status code or a wire shape.
 */
export { errorResponse as enterpriseConversationErrorResponse };
