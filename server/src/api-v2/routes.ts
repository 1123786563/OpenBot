import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import { parsePageLimit } from "../paging";
import { routineDto } from "../routines/routes";
import type { RoutineStore } from "../routines/store";

type Env = { Variables: AppVariables };
type C = Context<Env>;
type Json = Record<string, unknown>;
type Dispatch = (
  request: Request,
  env: unknown,
) => Response | Promise<Response>;
type Target = string | ((context: C) => string);
type Project = (body: Json, context: C) => unknown;

const organization = "default";
const prefix = "/organizations/:organizationId";
const object = z.record(z.string(), z.unknown());
const rows = z.array(object);

function problem(status: number, detail: string, code?: string) {
  return Response.json(
    {
      type: "about:blank",
      title: detail,
      status,
      detail,
      ...(code && { code }),
    },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

function segment(context: C, name: string) {
  return encodeURIComponent(context.req.param(name) ?? "");
}

function botNames(row: Json) {
  const { agentId, agentName, ...rest } = row;
  return {
    ...rest,
    ...(agentId !== undefined && { botId: agentId }),
    ...(agentName !== undefined && { botName: agentName }),
  };
}

function nativeDeliveryId(channelId: string, id: string) {
  const hash = createHash("sha256")
    .update(JSON.stringify([channelId, id]))
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function conversation(row: Json) {
  const { agentIds, lastMessageAgentId, work, ...rest } = row;
  return {
    ...rest,
    botIds: agentIds,
    ...(lastMessageAgentId !== undefined && {
      lastMessageBotId: lastMessageAgentId,
    }),
    ...(Array.isArray(work) && { work: rows.parse(work).map(botNames) }),
  };
}

function page(context: C, entries: Json[], field: string, maximum = 200) {
  const limit = parsePageLimit(context.req.query("limit") ?? null, maximum);
  if (!limit.ok) return problem(400, limit.error);
  const cursor = context.req.query("cursor");
  const start =
    cursor === undefined
      ? 0
      : entries.findIndex(
          (entry) =>
            typeof entry.id === "string" &&
            Buffer.from(entry.id).toString("base64url") === cursor,
        ) + 1;
  if (cursor !== undefined && start === 0)
    return problem(400, "Invalid cursor.");
  const slice = entries.slice(start, start + (limit.limit ?? 50));
  const last = slice.at(-1)?.id;
  return {
    [field]: slice,
    nextCursor:
      start + slice.length < entries.length && typeof last === "string"
        ? Buffer.from(last).toString("base64url")
        : null,
  };
}

const sendInput = z.object({
  id: z.string().min(1).max(160),
  text: z.string().trim().min(1).max(16_000),
  botId: z.string().min(1).max(200).nullish(),
});

export function createApiV2Routes({
  dispatch,
  requireUser,
  routineStore,
  deployment,
}: {
  dispatch: Dispatch;
  requireUser: MiddlewareHandler<Env>;
  routineStore?: Pick<RoutineStore, "listFor">;
  deployment: {
    builtInBots: boolean;
    isolatedBots: boolean;
    botComputers: boolean;
  };
}) {
  const routes = new Hono<Env>();
  routes.use("*", async (context, next) => {
    await next();
    context.header("Cache-Control", "private, no-store");
  });
  routes.onError((_error, _context) => {
    if (_error instanceof z.ZodError || _error instanceof SyntaxError)
      return problem(400, "Supply a valid request.");
    return problem(500, "OpenBot could not answer this request.");
  });

  function forward(
    target: Target,
    project?: Project,
    options: {
      method?: string;
      body?: (context: C) => unknown | Promise<unknown>;
      query?: (url: URL, context: C) => void;
    } = {},
  ) {
    return async (context: C) => {
      const path = typeof target === "string" ? target : target(context);
      const url = new URL(context.req.url);
      url.pathname = path;
      // URL normalizes dot segments. Never dispatch to a different route as a result.
      if (url.pathname !== path) return problem(400, "Invalid resource id.");
      options.query?.(url, context);
      const headers = new Headers(context.req.raw.headers);
      const method = options.method ?? context.req.method;
      let body: BodyInit | null | undefined = context.req.raw.body;
      if (options.body) {
        body = JSON.stringify(await options.body(context));
        headers.delete("content-length");
        headers.set("content-type", "application/json");
      }
      // Run the existing route with the same connection binding so its authorization, edition
      // and enterprise policy all apply to the versioned address.
      const result = await dispatch(
        new Request(url, {
          method,
          headers,
          body,
          signal: context.req.raw.signal,
        }),
        context.env,
      );
      if (!result.ok) {
        const error = object.safeParse(await result.json().catch(() => null));
        const detail = error.success ? error.data.error : null;
        return problem(
          result.status,
          typeof detail === "string"
            ? detail
            : result.statusText || "Request refused.",
        );
      }
      if (!project || result.status === 204) return result;
      const parsed = object.safeParse(await result.json().catch(() => null));
      if (!parsed.success)
        return problem(502, "OpenBot returned an invalid response.");
      let answer: unknown;
      try {
        answer = project(parsed.data, context);
      } catch (error) {
        if (error instanceof z.ZodError)
          return problem(502, "OpenBot returned an invalid response.");
        throw error;
      }
      return answer instanceof Response
        ? answer
        : Response.json(answer, { status: result.status });
    };
  }

  routes.use(`${prefix}/*`, async (context, next) => {
    const named = context.req.param("organizationId");
    const header = context.req.header("OpenBot-Organization");
    if (named !== organization || (header && header !== named))
      return problem(404, "Organization not found.", "ORGANIZATION_NOT_FOUND");
    await next();
  });
  routes.get(
    `${prefix}/deployment`,
    forward("/api/capabilities", (body) => ({
      ...body,
      ...deployment,
      api: ["v2"],
    })),
  );
  routes.use("/organizations/*", requireUser);
  routes.use("/people/me/organizations", requireUser);
  routes.use(
    `${prefix}/*`,
    bodyLimit({
      maxSize: 64 * 1024,
      onError: () => problem(413, "Request body is too large."),
    }),
  );

  routes.get("/people/me/organizations", (context) =>
    context.json({
      organizations: [
        {
          id: organization,
          slug: organization,
          name: "OpenBot",
          personal: false,
          role: context.var.actor.role === "admin" ? "admin" : "member",
          active: true,
        },
      ],
      canCreate: false,
      nextCursor: null,
    }),
  );

  routes.use(`${prefix}/people/:personId/*`, async (context, next) => {
    const person = context.req.param("personId");
    if (person !== "me" && person !== context.var.actor.id)
      return problem(404, "Person not found.");
    await next();
  });
  // The fork enforces its deployment-wide SSO rule during Better Auth sign-in.
  routes.get(
    `${prefix}/people/:personId/company-sign-in`,
    forward("/api/capabilities", (body) => ({
      required: body.ssoRequired === true,
      met: true,
      providers: [],
    })),
  );

  routes.get(
    `${prefix}/conversations`,
    forward(
      "/api/channels",
      (body) => ({
        conversations: rows.parse(body.channels).map(conversation),
        nextCursor: body.nextCursor,
      }),
      {
        query: (url, context) => {
          url.search = "";
          const { limit, cursor, botId } = context.req.query();
          if (limit !== undefined) url.searchParams.set("limit", limit);
          if (cursor !== undefined) url.searchParams.set("cursor", cursor);
          if (botId !== undefined) url.searchParams.set("botId", botId);
        },
      },
    ),
  );
  const channel = (context: C) => segment(context, "conversationId");
  routes.get(
    `${prefix}/conversations/:conversationId`,
    forward(
      (context) => `/api/channels/${channel(context)}`,
      (body) => ({ conversation: conversation(object.parse(body.channel)) }),
    ),
  );
  routes.get(
    `${prefix}/conversations/:conversationId/messages`,
    forward(
      (context) => `/api/delivery/conversations/${channel(context)}/history`,
      (body, context) => {
        const history = object.parse(body.history);
        const botId = context.req.query("botId") ?? null;
        const messages = rows
          .parse(history.messages)
          .map((message) => ({
            id: message.id,
            role: message.role,
            personId: message.role === "user" ? context.var.actor.id : null,
            botId: message.role === "assistant" ? botId : null,
            text: typeof message.content === "string" ? message.content : "",
            status: "completed",
            createdAt:
              typeof message.createdAt === "string" ? message.createdAt : null,
          }))
          .reverse();
        return page(context, messages, "messages");
      },
      {
        query: (url, context) =>
          url.searchParams.set("agentId", context.req.query("botId") ?? ""),
      },
    ),
  );
  routes.post(
    `${prefix}/conversations/:conversationId/messages`,
    forward(
      (context) => `/api/delivery/conversations/${channel(context)}/messages`,
      (body) => body,
      {
        body: async (context) => {
          const input = sendInput
            .extend({ botId: z.string().min(1).max(200) })
            .parse(await context.req.json());
          return {
            externalId: nativeDeliveryId(channel(context), input.id),
            text: input.text,
            agentId: input.botId,
          };
        },
        method: "POST",
      },
    ),
  );

  const bot = (context: C) => segment(context, "botId");
  routes.get(
    `${prefix}/bots/:botId`,
    forward(
      (context) => `/api/agents/${bot(context)}`,
      (body) => ({ bot: body.agent }),
    ),
  );
  for (const action of ["lifecycle", "pause", "resume"]) {
    routes.on(
      action === "lifecycle" ? "GET" : "POST",
      `${prefix}/bots/:botId/${action}`,
      forward(
        (context) => `/api/bots/${bot(context)}/${action}`,
        (body) => {
          const lifecycle = botNames(object.parse(body.lifecycle));
          return action === "pause"
            ? { lifecycle, stoppedTurns: body.stoppedTurns }
            : lifecycle;
        },
      ),
    );
  }

  routes.get(
    `${prefix}/people/:personId/devices`,
    forward("/api/delivery/devices", (body, context) => {
      const devices = rows
        .parse(body.devices)
        .sort(
          (a, b) =>
            String(a.createdAt).localeCompare(String(b.createdAt)) ||
            String(a.id).localeCompare(String(b.id)),
        );
      return page(context, devices, "devices");
    }),
  );
  routes.put(
    `${prefix}/people/:personId/devices/:deviceId`,
    forward(
      "/api/delivery/devices",
      (body) => {
        const { id, platform, createdAt } = object.parse(body.device);
        return Response.json({ device: { id, platform, createdAt } });
      },
      {
        method: "POST",
        body: async (context) => ({
          ...object.parse(await context.req.json()),
          id: context.req.param("deviceId"),
        }),
      },
    ),
  );
  routes.delete(
    `${prefix}/people/:personId/devices/:deviceId`,
    forward(
      (context) => `/api/delivery/devices/${segment(context, "deviceId")}`,
    ),
  );

  const routine = (context: C) =>
    `/api/routines/${segment(context, "routineId")}`;
  routes.get(`${prefix}/routines`, async (context) => {
    if (!routineStore) return problem(503, "Routines are unavailable.");
    const botId = context.req.query("botId");
    const routines = (await routineStore.listFor(context.var.actor.id))
      .filter((routine) => !botId || routine.agentId === botId)
      .map((routine) => {
        const { agentId, channel, ...summary } = routineDto(routine);
        return {
          ...summary,
          botId: agentId,
          conversation: channel,
          cron: routine.cron,
          goalId: routine.goalId,
          createdAt: routine.createdAt.toISOString(),
        };
      });
    const answer = page(context, routines, "routines");
    return answer instanceof Response ? answer : context.json(answer);
  });
  routes.get(
    `${prefix}/routines/:routineId/runs`,
    forward(
      (context) => `${routine(context)}/runs`,
      (body, context) => page(context, rows.parse(body.runs), "runs"),
    ),
  );
  routes.post(
    `${prefix}/routines/:routineId/run`,
    forward((context) => `${routine(context)}/run`),
  );
  routes.delete(
    `${prefix}/routines/:routineId`,
    forward(routine, () => new Response(null, { status: 204 })),
  );
  for (const enabled of [true, false]) {
    routes.post(
      `${prefix}/routines/:routineId/${enabled ? "resume" : "pause"}`,
      forward((context) => `${routine(context)}/enabled`, undefined, {
        method: "PUT",
        body: () => ({ enabled }),
      }),
    );
  }

  const person = `${prefix}/people/:personId`;
  routes.get(
    `${person}/memories`,
    forward("/api/memory", (body, context) =>
      page(context, rows.parse(body.memories), "memories"),
    ),
  );
  routes.post(
    `${person}/memories`,
    forward("/api/memory", (body) => body.memory),
  );
  const memory = (context: C) => `/api/memory/${segment(context, "memoryId")}`;
  routes.patch(
    `${person}/memories/:memoryId`,
    forward(memory, (body) => body.memory),
  );
  routes.delete(
    `${person}/memories/:memoryId`,
    forward(memory, () => new Response(null, { status: 204 })),
  );

  const task = ({ channelId, ...row }: Json) => ({
    ...botNames(row),
    conversationId: channelId,
    originConversationId: row.originConversationId ?? null,
  });
  routes.get(
    `${prefix}/tasks`,
    forward("/api/tasks", (body, context) =>
      page(context, rows.parse(body.tasks).map(task), "tasks"),
    ),
  );
  routes.get(
    `${prefix}/tasks/:taskId`,
    forward(
      (context) => `/api/tasks/${segment(context, "taskId")}`,
      (body) => ({ task: task(object.parse(body.task)) }),
    ),
  );
  const checkInItem = ({
    settingId,
    ownerUserId: _owner,
    runId: _run,
    ...row
  }: Json) => ({ ...botNames(row), checkInId: settingId });
  routes.get(
    `${prefix}/check-in-items`,
    forward("/api/proactive/suggestions", (body, context) => {
      const botId = context.req.query("botId");
      return page(
        context,
        rows
          .parse(body.suggestions)
          .filter((row) => !botId || row.agentId === botId)
          .map(checkInItem),
        "checkInItems",
      );
    }),
  );
  const suggestion = (context: C) =>
    `/api/proactive/suggestions/${segment(context, "checkInItemId")}`;
  routes.post(
    `${prefix}/check-in-items/:checkInItemId/dismiss`,
    forward(
      (context) => `${suggestion(context)}/dismiss`,
      (body) => ({ checkInItem: checkInItem(object.parse(body.suggestion)) }),
    ),
  );
  routes.post(
    `${prefix}/check-in-items/:checkInItemId/work-on`,
    forward(
      (context) => `${suggestion(context)}/start`,
      (body) => {
        const task = object.parse(body.task);
        return {
          checkInItem: checkInItem(object.parse(body.suggestion)),
          conversation: null,
          task: { id: task.id, conversationId: task.channelId },
        };
      },
    ),
  );

  routes.get(
    `${prefix}/bots`,
    forward("/api/agents", (body, context) =>
      page(context, rows.parse(body.agents), "bots"),
    ),
  );

  const inbox = "/api/approvals";
  for (const [resource, source] of [
    ["approvals", "requests"],
    ["questions", "questions"],
    ["approval-rules", "rules"],
  ]) {
    const field = resource === "approval-rules" ? "approvalRules" : resource;
    routes.get(
      `${person}/${resource}`,
      forward(inbox, (body, context) =>
        page(context, rows.parse(body[source]).map(botNames), field),
      ),
    );
  }
  routes.get(
    `${prefix}/approval-rules`,
    forward(inbox, (body, context) =>
      page(context, rows.parse(body.teamRules), "approvalRules"),
    ),
  );
  routes.get(
    `${prefix}/approval-settings`,
    forward(inbox, (body) => body.team),
  );
  routes.get(
    `${person}/approval-preferences`,
    forward(inbox, (body) => ({
      ...object.parse(body.preferences),
      effectiveHostCommands: body.hostCommands,
    })),
  );
  routes.patch(
    `${person}/approval-preferences`,
    forward("/api/approvals/preferences"),
  );
  routes.post(
    `${person}/approval-rules`,
    forward("/api/approvals/rules", (body) => body.rule),
  );
  const rule = (context: C) =>
    `/api/approvals/rules/${segment(context, "approvalRuleId")}`;
  routes.patch(
    `${person}/approval-rules/:approvalRuleId`,
    forward(rule, (body) => body.rule),
  );
  routes.delete(
    `${person}/approval-rules/:approvalRuleId`,
    forward(rule, () => new Response(null, { status: 204 })),
  );
  routes.post(
    `${person}/approvals/:approvalId/decide`,
    forward(
      (context) => `/api/approvals/${segment(context, "approvalId")}/decision`,
    ),
  );
  routes.post(
    `${person}/questions/:questionId/respond`,
    forward(
      (context) =>
        `/api/approvals/questions/${segment(context, "questionId")}/respond`,
    ),
  );

  routes.get(
    `${prefix}/skills`,
    forward("/api/plugins", (body, context) =>
      page(
        context,
        rows.parse(body.skills).map((skill) => ({ ...skill, id: skill.slug })),
        "skills",
      ),
    ),
  );
  routes.get(
    `${prefix}/bots/:botId/grants`,
    forward(
      (context) => `/api/plugins/for/${bot(context)}`,
      (body, context) => {
        const skills = rows
          .parse(body.skills)
          .map(({ slug, title, summary }) => ({
            id: `skill:${slug}`,
            kind: "skill",
            ref: slug,
            skill: { slug, title, summary },
            action: null,
          }));
        const tools = rows
          .parse(body.tools)
          .flatMap(({ ref, description, effect }) => {
            if (typeof ref !== "string") return [];
            const separator = ref.indexOf("/");
            if (separator < 1) return [];
            const appId = ref.slice(0, separator);
            const name = ref.slice(separator + 1);
            return [
              {
                id: `action:${appId}:${name}`,
                kind: "action",
                ref,
                skill: null,
                action: {
                  appId,
                  name,
                  description,
                  read: effect === "read",
                  destructive: effect === "destructive",
                },
              },
            ];
          });
        return page(
          context,
          [...skills, ...tools].sort((a, b) => a.id.localeCompare(b.id)),
          "grants",
        );
      },
    ),
  );
  const skillGrant = (context: C) => {
    const id = context.req.param("grantId") ?? "";
    if (!id.startsWith("skill:") || !id.slice(6).trim()) return null;
    return {
      id,
      kind: "skill",
      ref: id.slice(6),
      agentId: context.req.param("botId"),
    };
  };
  routes.put(`${prefix}/bots/:botId/grants/:grantId`, (context) => {
    const grant = skillGrant(context);
    return grant
      ? forward(
          "/api/plugins/grants",
          () => ({
            id: grant.id,
            kind: grant.kind,
            ref: grant.ref,
            skill: null,
            action: null,
          }),
          {
            method: "POST",
            body: () => ({
              kind: grant.kind,
              ref: grant.ref,
              agentId: grant.agentId,
            }),
          },
        )(context)
      : problem(400, "Supply a skill grant id.");
  });
  routes.delete(`${prefix}/bots/:botId/grants/:grantId`, (context) => {
    const grant = skillGrant(context);
    return grant
      ? forward(
          "/api/plugins/grants",
          () => new Response(null, { status: 204 }),
          {
            query: (url) => {
              url.search = "";
              url.searchParams.set("kind", grant.kind);
              url.searchParams.set("ref", grant.ref);
              url.searchParams.set("agentId", grant.agentId ?? "");
            },
          },
        )(context)
      : problem(400, "Supply a skill grant id.");
  });

  routes.use(`${prefix}/computers/:botId/*`, async (_context, next) => {
    if (!deployment.botComputers)
      return problem(503, "Bot computers are unavailable.");
    await next();
  });
  const computer = (context: C) => `/api/computers/${bot(context)}`;
  for (const suffix of ["screenshot", "control"]) {
    routes.get(
      `${prefix}/computers/:botId/${suffix}`,
      forward((context) => `${computer(context)}/${suffix}`),
    );
  }
  for (const suffix of ["request", "release", "take", "secret"]) {
    routes.post(
      `${prefix}/computers/:botId/control/${suffix}`,
      forward((context) => `${computer(context)}/control/${suffix}`),
    );
  }
  for (const kind of ["click", "type", "key", "scroll", "secret"]) {
    routes.post(
      `${prefix}/computers/:botId/human-input/${kind}`,
      forward((context) => `${computer(context)}/human/${kind}`),
    );
  }

  routes.all("*", () => problem(404, "This API operation is unavailable."));
  return routes;
}
