import { z } from "zod";

const snapshotSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      role: z.enum(["user", "assistant"]),
      content: z.string(),
    }),
  ),
  runs: z.array(
    z.object({
      id: z.string(),
      userMessageId: z.string(),
      status: z.enum(["running", "completed", "failed"]),
      pendingApprovals: z.array(z.object({ id: z.string() })).optional(),
      externalOutcome: z
        .enum(["dispatching", "unknown", "executed", "not_dispatched"])
        .optional(),
      stopReason: z
        .enum(["stopped", "access_revoked", "context_revoked"])
        .optional(),
    }),
  ),
});
const inboxSchema = z.object({
  requests: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      action: z.object({
        threadId: z.string().nullable().optional(),
        toolRef: z.string(),
        scope: z.string(),
        args: z.unknown(),
      }),
    }),
  ),
});
const frameSchema = z.object({ type: z.string() });

export type ConversationSnapshot = z.infer<typeof snapshotSchema> & {
  approvals: z.infer<typeof inboxSchema>["requests"];
};
export type PendingTurn = { messageId: string; runId: string; text: string };

export class DirectConversationError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }

  get accessLost() {
    return this.status === 401 || this.status === 403 || this.status === 404;
  }
}

type ConversationResponse = Pick<
  Response,
  "ok" | "status" | "headers" | "json" | "body"
>;
type Request = (
  path: string,
  input?: RequestInit,
) => Promise<ConversationResponse>;
const serverError = z.object({ error: z.string() });
async function checked(response: ConversationResponse) {
  if (response.ok) return response;
  const error = serverError.safeParse(await response.json().catch(() => null));
  throw new DirectConversationError(
    error.success ? error.data.error : `Request failed (${response.status}).`,
    response.status,
  );
}

export function directConversation(
  request: Request,
  { threadId, agentId }: { threadId: string; agentId: string },
) {
  const thread = `/api/copilotkit/threads/${encodeURIComponent(threadId)}`;
  const agent = `/api/copilotkit/agent/${encodeURIComponent(agentId)}`;
  const query = `?agentId=${encodeURIComponent(agentId)}`;
  let position: { runId: string; cursor: number } | undefined;

  function post(path: string, body?: unknown, signal?: AbortSignal) {
    return request(path, {
      method: "POST",
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
      signal,
    }).then(checked);
  }

  return {
    async history(signal?: AbortSignal): Promise<ConversationSnapshot> {
      const response = await checked(
        await request(`${thread}/messages${query}`, { signal }),
      );
      const snapshot = snapshotSchema.parse(await response.json());
      const waiting = snapshot.runs.find((run) => run.status === "running");
      if (!waiting?.pendingApprovals?.length)
        return { ...snapshot, approvals: [] };
      const ids = new Set(waiting.pendingApprovals.map(({ id }) => id));
      const inbox = inboxSchema.parse(
        await (
          await checked(
            await request(
              `/api/approvals?threadId=${encodeURIComponent(threadId)}`,
              { signal },
            ),
          )
        ).json(),
      );
      return {
        ...snapshot,
        approvals: inbox.requests.filter(
          ({ id, status, action }) =>
            status === "pending" && ids.has(id) && action.threadId === threadId,
        ),
      };
    },
    async submit(turn: PendingTurn, signal?: AbortSignal) {
      const response = await post(
        `${agent}/run`,
        {
          threadId,
          runId: turn.runId,
          messages: [{ id: turn.messageId, role: "user", content: turn.text }],
        },
        signal,
      );
      const confirmed = response.headers.get("x-openbot-run-replay");
      await response.body?.cancel().catch(() => undefined);
      if (confirmed !== encodeURIComponent(turn.runId)) {
        throw new Error("The server did not confirm the Run.");
      }
    },
    async stop(runId: string, signal?: AbortSignal) {
      await post(
        `${thread}/runs/${encodeURIComponent(runId)}/stop${query}`,
        undefined,
        signal,
      );
    },
    async reconcile(runId: string, signal?: AbortSignal) {
      await post(
        `${thread}/runs/${encodeURIComponent(runId)}/reconcile${query}`,
        undefined,
        signal,
      );
    },
    async decide(
      id: string,
      decision: "allow_once" | "deny",
      signal?: AbortSignal,
    ) {
      await post(
        `/api/approvals/${encodeURIComponent(id)}/decision`,
        { decision },
        signal,
      );
    },
    async follow(
      runId: string,
      refresh: () => Promise<void>,
      signal: AbortSignal,
    ) {
      if (position?.runId !== runId) position = { runId, cursor: 0 };
      const replay = position;
      const response = await post(
        `${agent}/resume`,
        { threadId, ...replay },
        signal,
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("The Run stream is unavailable.");
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done || signal.aborted) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          let cursor = replay.cursor;
          let changed = false;
          let terminal = false;
          for (
            let end = buffer.indexOf("\n\n");
            end !== -1;
            end = buffer.indexOf("\n\n")
          ) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame.match(/^data: (.+)$/m)?.[1];
            if (!data) {
              changed ||= frame.startsWith(":");
              continue;
            }
            const event = frameSchema.parse(JSON.parse(data));
            const id = frame.match(/^id: (\d+)$/m)?.[1];
            if (id !== undefined) cursor = Math.max(cursor, Number(id));
            // Read the durable projection instead of appending deltas to a snapshot that
            // may already contain them. Heartbeats also refresh quiet approval waits.
            changed = true;
            terminal ||=
              event.type === "RUN_ERROR" || event.type === "RUN_FINISHED";
          }
          if (changed) {
            await refresh();
            if (signal.aborted) return;
            replay.cursor = Math.max(replay.cursor, cursor);
          }
          if (terminal) return;
        }
      } finally {
        signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
  };
}
