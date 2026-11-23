import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ManagedModel } from "../managed-model";

export const REFLECT_MODEL_CALLBACK_PATH =
  "/internal/hindsight/v1/chat/completions";

type Completion = Parameters<ManagedModel["complete"]>[0];
type RunScope = Omit<Completion["scope"], "source">;

const callbackBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string(),
      }),
    )
    .min(2)
    .max(64),
  response_format: z.object({
    type: z.literal("json_schema"),
    json_schema: z.object({ schema: z.record(z.string(), z.unknown()) }),
  }),
});
const marker = /^\[OpenBot Reflect ([0-9a-f-]{36})\]\n/;
const failure = (status: number) =>
  Response.json(
    { error: { message: "Reflect model unavailable" } },
    { status },
  );

export function createReflectModelGateway({
  model,
  route,
  token,
}: {
  model: ManagedModel;
  route: string;
  token: string;
}) {
  const sessions = new Map<
    string,
    {
      scope: RunScope;
      canDispatch: () => Promise<boolean>;
      calls: Map<string, Promise<string | null>>;
      failed: boolean;
    }
  >();
  const expected = Buffer.from(`Bearer ${token}`);

  return {
    async reflect<T>({
      query,
      scope,
      canDispatch,
      request,
    }: {
      query: string;
      scope: RunScope;
      canDispatch: () => Promise<boolean>;
      request: (query: string) => Promise<T | null>;
    }): Promise<T | null> {
      const key = randomUUID();
      const session = {
        scope,
        canDispatch,
        calls: new Map<string, Promise<string | null>>(),
        failed: false,
      };
      sessions.set(key, session);
      try {
        const result = await request(`[OpenBot Reflect ${key}]\n${query}`);
        if (result === null || session.failed || !session.calls.size)
          return null;
        const completions = await Promise.all(session.calls.values());
        return completions.every(Boolean) && !session.failed ? result : null;
      } finally {
        sessions.delete(key);
      }
    },

    async complete(request: Request): Promise<Response> {
      const supplied = Buffer.from(request.headers.get("authorization") ?? "");
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return failure(401);

      const parsed = callbackBody.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) return failure(400);
      const { messages, response_format } = parsed.data;
      const first = messages.find((message) => message.role === "user");
      const key = first?.content.match(marker)?.[1];
      const session = key && sessions.get(key);
      if (!key || !first || !session || session.failed) return failure(403);

      const prompt = messages.map(({ role, content }) => ({
        role,
        content: content.replaceAll(`[OpenBot Reflect ${key}]\n`, ""),
      }));
      const schema = JSON.stringify(response_format.json_schema.schema);
      prompt.unshift({
        role: "system",
        content: `Return only JSON conforming to this schema:\n${schema}`,
      });
      const payload = JSON.stringify(prompt);
      if (payload.length > 150_000) {
        session.failed = true;
        return failure(413);
      }
      const digest = createHash("sha256").update(payload).digest("hex");
      let completion = session.calls.get(digest);
      if (!completion) {
        if (session.calls.size >= 6) {
          session.failed = true;
          return failure(429);
        }
        completion = model
          .complete({
            scope: { ...session.scope, source: "hindsight" },
            step: `reflect-${digest}`,
            route,
            messages: prompt,
            beforeDispatch: async () =>
              sessions.has(key) &&
              !session.failed &&
              (await session.canDispatch()) &&
              sessions.has(key) &&
              !session.failed,
          })
          .then((result) => (result.state === "completed" ? result.text : null))
          .catch(() => null);
        session.calls.set(digest, completion);
      }

      const text = await completion;
      if (!text || !sessions.has(key)) {
        session.failed = true;
        return failure(503);
      }
      // A completion can finish or be retried after its evidence is withdrawn.
      const authorized = await session.canDispatch().catch(() => false);
      if (!authorized || !sessions.has(key) || session.failed) {
        session.failed = true;
        return failure(403);
      }
      return Response.json({
        id: `chatcmpl-${digest}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1_000),
        model: route,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        // Billing uses authoritative usage from the managed control plane.
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    },
  };
}

export type ReflectModelGateway = ReturnType<typeof createReflectModelGateway>;
