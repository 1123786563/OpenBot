import {
  ProxiedCopilotRuntimeAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { DIRECT_CHAT_REPLAY_HEADER } from "@openbot/shared/direct-chat-replay";
import { useEffect } from "react";
import { z } from "zod";

const threadInput = z.object({ threadId: z.string().min(1) });
const frameEvent = z.object({
  type: z.string(),
  messageId: z.string().optional(),
  messages: z.array(z.object({ id: z.string(), role: z.string() })).optional(),
});
const maxAttempts = 12;

type AgentFetch = (url: string, init: RequestInit) => Promise<Response>;

function threadOf(body: RequestInit["body"]) {
  if (typeof body !== "string") return undefined;
  try {
    return threadInput.parse(JSON.parse(body)).threadId;
  } catch {
    return undefined;
  }
}

function eventOf(frame: string) {
  const data = frame.split("\n").find((line) => line.startsWith("data: "));
  return data ? frameEvent.parse(JSON.parse(data.slice(6))) : undefined;
}

export function withDirectChatReconnect(fetchAgent: AgentFetch): AgentFetch {
  return async (url, init) => {
    const initial = await fetchAgent(url, init);
    const canonicalRun = initial.headers.get(DIRECT_CHAT_REPLAY_HEADER);
    if (!canonicalRun || !initial.body || !url.endsWith("/run")) return initial;
    const threadId = threadOf(init.body);
    if (!threadId) return initial;
    const runId = decodeURIComponent(canonicalRun);
    const resumeUrl = `${url.slice(0, -"run".length)}resume`;
    const lifetime = new AbortController();
    const signal = init.signal
      ? AbortSignal.any([init.signal, lifetime.signal])
      : lifetime.signal;
    const encoder = new TextEncoder();
    const textBoundary = (
      type: "TEXT_MESSAGE_START" | "TEXT_MESSAGE_END",
      messageId: string,
    ) => encoder.encode(`data: ${JSON.stringify({ type, messageId })}\n\n`);
    let cursor = 0;
    let runStarted = false;
    let snapshotText = new Set<string>();
    const activeText = new Set<string>();

    async function* frames(first: ReadableStream<Uint8Array>) {
      let body = first;
      for (let attempt = 0; !signal.aborted; ) {
        const reader = body.getReader();
        const cancelReader = () => void reader.cancel().catch(() => undefined);
        signal.addEventListener("abort", cancelReader, { once: true });
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!signal.aborted) {
            const read = await reader.read().catch(() => undefined);
            signal.throwIfAborted();
            if (!read || read.done) break;
            buffer += decoder.decode(read.value, { stream: true });
            let end = buffer.indexOf("\n\n");
            while (end !== -1) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              end = buffer.indexOf("\n\n");
              const event = eventOf(frame);
              if (event && event.type === "RUN_STARTED") {
                if (runStarted) continue;
                runStarted = true;
              }
              if (event && event.type === "MESSAGES_SNAPSHOT") {
                for (const id of activeText) {
                  yield textBoundary("TEXT_MESSAGE_END", id);
                }
                activeText.clear();
                snapshotText = new Set(
                  event.messages
                    ?.filter((message) => message.role === "assistant")
                    .map((message) => message.id),
                );
              }
              if (event?.messageId) {
                const id = event.messageId;
                if (event.type === "TEXT_MESSAGE_START") activeText.add(id);
                if (
                  event.type === "TEXT_MESSAGE_CONTENT" ||
                  event.type === "TEXT_MESSAGE_END"
                ) {
                  // The verifier needs a text start even when the snapshot already restored its message.
                  if (!activeText.has(id) && snapshotText.has(id)) {
                    activeText.add(id);
                    yield textBoundary("TEXT_MESSAGE_START", id);
                  }
                  if (event.type === "TEXT_MESSAGE_END") {
                    activeText.delete(id);
                    snapshotText.delete(id);
                  }
                }
              }
              const position = frame.match(/^id: (\d+)$/m)?.[1];
              if (position !== undefined && Number(position) > cursor) {
                cursor = Number(position);
                attempt = 0;
              }
              yield encoder.encode(`${frame}\n\n`);
              if (
                event &&
                (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR")
              )
                return;
            }
          }
        } finally {
          signal.removeEventListener("abort", cancelReader);
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }

        let resumed: ReadableStream<Uint8Array> | undefined;
        while (!signal.aborted && attempt < maxAttempts) {
          await delay(Math.min(250 * 2 ** attempt++, 5_000), signal);
          signal.throwIfAborted();
          const response = await fetchAgent(resumeUrl, {
            ...init,
            signal,
            body: JSON.stringify({ threadId, runId, cursor }),
          }).catch(() => undefined);
          if (!response) continue;
          if (
            response.ok &&
            response.body &&
            response.headers.get(DIRECT_CHAT_REPLAY_HEADER) === canonicalRun
          ) {
            resumed = response.body;
            break;
          }
          await response.body?.cancel();
          if (response.status < 500 && response.status !== 429) {
            throw new Error("The Bot run is unavailable.");
          }
        }
        signal.throwIfAborted();
        if (!resumed) throw new Error("Could not reconnect to the Bot run.");
        body = resumed;
      }
    }

    const iterator = frames(initial.body);
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        async cancel() {
          lifetime.abort();
          await iterator.return(undefined);
          if (!initial.body?.locked)
            await initial.body?.cancel().catch(() => undefined);
        },
      }),
      { status: initial.status, headers: initial.headers },
    );
  };
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

export function DirectChatReconnect() {
  const { copilotkit } = useCopilotKit();
  useEffect(() => {
    const wrapped = new WeakSet<ProxiedCopilotRuntimeAgent["fetch"]>();
    const subscription = copilotkit.subscribe({
      onAgentRunStarted({ agent }) {
        if (
          !(agent instanceof ProxiedCopilotRuntimeAgent) ||
          wrapped.has(agent.fetch)
        )
          return;
        agent.fetch = withDirectChatReconnect(agent.fetch);
        wrapped.add(agent.fetch);
      },
    });
    return () => subscription.unsubscribe();
  }, [copilotkit]);
  return null;
}
