/**
 * How the server talks to a sandbox, over the token-gated proxy the agent-sandbox service fronts.
 *
 * Four verbs only, matching the proxy's allow-list. Usage parsing is deliberately tolerant about
 * where opencode puts the token counts: the counts are billing inputs, and a shape drift should
 * lose the meter reading, not the run.
 */
import type {
  SandboxRunResult,
  SandboxSendMessageOptions,
  SandboxUsage,
  TranslatedEvent,
  TranslatedEventFamily,
} from "./types";

export class CodeSandboxTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The sandbox run exceeded its ${timeoutMs}ms budget.`);
    this.name = "CodeSandboxTimeoutError";
  }
}

export class CodeSandboxActivityTimeoutError extends Error {
  constructor(activityTimeoutMs: number) {
    super(`The sandbox stream was silent for ${activityTimeoutMs}ms.`);
    this.name = "CodeSandboxActivityTimeoutError";
  }
}

export type SandboxClientOptions = {
  baseUrl: string;
  token: string;
  /** Which Bot's workspace every request targets; the proxy routes on `x-openbot-bot-id`. */
  botId: string;
  fetchImpl?: typeof fetch;
};

export type SandboxClient = {
  capabilities: {
    enforceableTokenBudget: boolean;
  };
  createSession(title: string): Promise<string>;
  sendMessage(
    sessionId: string,
    text: string,
    options: SandboxSendMessageOptions,
  ): Promise<SandboxRunResult>;
  listFiles(): Promise<string[]>;
  readFile(path: string, maxBytes: number): Promise<{ path: string; size: number; content: string; truncated: boolean }>;
  /**
   * Writes one text file into this Bot's workspace (workshop uploads). The proxy's allow-list
   * carries POST /file from the S2 batch; until then a deployment without it answers 404 and
   * the upload path reports the failure rather than pretending.
   */
  writeFile(path: string, content: string): Promise<{ path: string; size: number }>;
  /** Wipes this Bot's workspace through the governed reset endpoint. */
  resetWorkspace(): Promise<void>;
  /**
   * Aborts the session's in-flight turn (S5's forwarded endpoint). The upstream's own semantics
   * apply; the client adds nothing but the token and bot headers.
   */
  abortSession(sessionId: string): Promise<void>;
  /**
   * The workshop's stream: /events (S2), family-labelled by the wrapper. The iterable ends when
   * the upstream closes; the `: keepalive` comments never surface here.
   */
  subscribeEvents(onEvent: (event: TranslatedEvent) => void): Promise<{ stop(): void }>;
};

export function parseUsage(message: unknown): SandboxUsage | undefined {
  const container = message as
    | { info?: { tokens?: unknown }; tokens?: unknown }
    | undefined;
  const raw = (container?.info?.tokens ?? container?.tokens) as
    | { input?: unknown; output?: unknown }
    | undefined;
  if (typeof raw?.input === "number" && typeof raw?.output === "number")
    return { inputTokens: raw.input, outputTokens: raw.output };
  return undefined;
}

export function createSandboxClient(options: SandboxClientOptions): SandboxClient {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");

  const request = async (
    path: string,
    init: RequestInit = {},
    timeoutMs?: number,
  ): Promise<Response> => {
    // A plain map, not a Headers instance: callers and tests read these back by property.
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    headers["x-sandbox-token"] = options.token;
    headers["x-openbot-bot-id"] = options.botId;
    const budgetMs = timeoutMs ?? 0;
    const signal = budgetMs > 0 ? AbortSignal.timeout(budgetMs) : undefined;
    let response: Response;
    try {
      const call = doFetch(`${base}${path}`, { ...init, headers, signal });
      if (!signal) {
        response = await call;
      } else {
        // Race so the budget holds even when a fetchImpl ignores `signal` (the platform fetch
        // aborts on its own; injected test fetches need not). The losing promise gets a no-op
        // catch so its rejection is never unhandled.
        call.catch(() => undefined);
        response = await Promise.race([
          call,
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new CodeSandboxTimeoutError(budgetMs)),
            );
          }),
        ]);
      }
    } catch (error) {
      if (signal?.aborted && !(error instanceof CodeSandboxTimeoutError))
        throw new CodeSandboxTimeoutError(budgetMs);
      throw error;
    }
    if (!response.ok)
      throw new Error(`Sandbox ${path} answered ${response.status}.`);
    return response;
  };

  return {
    capabilities: {
      enforceableTokenBudget: false,
    },
    async createSession(title: string) {
      const response = await request("/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const body = (await response.json()) as { id?: string };
      if (!body.id) throw new Error("The sandbox session response carried no id.");
      return body.id;
    },

    async sendMessage(sessionId, text, options) {
      const timeoutMs = options.timeoutMs ?? 120_000;
      const response = await request(
        `/session/${encodeURIComponent(sessionId)}/message`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: { providerID: "openbot", modelID: options.modelId },
            parts: [{ type: "text", text }],
          }),
        },
        timeoutMs,
      );
      const message = (await response.json()) as {
        parts?: Array<{ type: string; text?: string }>;
      };
      const textOut = (message.parts ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
      return {
        sessionId,
        text: textOut,
        usage: parseUsage(message),
      };
    },

    async listFiles() {
      const response = await request("/file?path=.");
      const body = (await response.json()) as unknown;
      if (Array.isArray(body))
        return body.map((entry) =>
          typeof entry === "string" ? entry : String((entry as { path?: unknown }).path ?? ""),
        ).filter((path) => path.length > 0);
      return [];
    },

    async readFile(path, maxBytes) {
      const response = await request(
        `/file/content?path=${encodeURIComponent(path)}`,
      );
      const raw = await response.text();
      // opencode answers /file/content with a JSON envelope ({type:"text", content}) for text
      // files; a plain body means the endpoint passed the bytes through. Unwrap when the envelope
      // is what came back, so an artifact's content is the file, not the wrapper around it.
      let text = raw;
      try {
        const parsed = JSON.parse(raw) as { type?: unknown; content?: unknown };
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          parsed.type === "text" &&
          typeof parsed.content === "string"
        )
          text = parsed.content;
      } catch {
        // Not JSON: the raw body is the content.
      }
      const bytes = Buffer.byteLength(text, "utf8");
      return {
        path,
        size: bytes,
        content: bytes > maxBytes ? text.slice(0, maxBytes) : text,
        truncated: bytes > maxBytes,
      };
    },

    async resetWorkspace() {
      await request("/workspace/reset", { method: "POST" });
    },

    async abortSession(sessionId) {
      await request(`/session/${encodeURIComponent(sessionId)}/abort`, {
        method: "POST",
      });
    },

    async subscribeEvents(onEvent) {
      // A raw SSE read against /events. The wrapper labels each block with its family in the
      // `event:` line (S2); a block without one degrades to "unknown" rather than being
      // dropped — the stream stays visible, never silently lossy here.
      const doFetch = options.fetchImpl ?? fetch;
      const headers: Record<string, string> = {
        "x-sandbox-token": options.token,
        "x-openbot-bot-id": options.botId,
      };
      const response = await doFetch(`${base}/events`, { headers });
      if (!response.ok || !response.body) {
        throw new Error(`Sandbox /events answered ${response.status}.`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let stopped = false;

      const pump = async (): Promise<void> => {
        while (!stopped) {
          const chunk = await reader.read();
          if (chunk.done) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const familyLine = block
              .split("\n")
              .find((line) => line.startsWith("event:"));
            const dataLine = block
              .split("\n")
              .find((line) => line.startsWith("data:"));
            if (!dataLine) continue;
            const family = (familyLine?.slice("event:".length).trim() ??
              "unknown") as TranslatedEventFamily;
            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(dataLine.slice("data:".length).trim()) as Record<string, unknown>;
            } catch {
              payload = {};
            }
            onEvent({ family, eventId: String(payload.id ?? ""), payload });
          }
        }
        await reader.cancel().catch(() => undefined);
      };
      void pump();
      return {
        stop: () => {
          stopped = true;
          void reader.cancel().catch(() => undefined);
        },
      };
    },

    async writeFile(path, content) {
      const response = await request(
        `/file?path=${encodeURIComponent(path)}`,
        {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: content,
        },
      );
      if (!response.ok && response.status !== 201) {
        throw new Error(`Sandbox /file answered ${response.status}.`);
      }
      return { path, size: Buffer.byteLength(content, "utf8") };
    },
  };
}
