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
} from "./types";

export class CodeSandboxTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The sandbox run exceeded its ${timeoutMs}ms budget.`);
    this.name = "CodeSandboxTimeoutError";
  }
}

export type SandboxClientOptions = {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
};

export type SandboxClient = {
  createSession(title: string): Promise<string>;
  sendMessage(
    sessionId: string,
    text: string,
    options: SandboxSendMessageOptions,
  ): Promise<SandboxRunResult>;
  listFiles(): Promise<string[]>;
  readFile(path: string, maxBytes: number): Promise<{ path: string; size: number; content: string; truncated: boolean }>;
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
      const bytes = Buffer.byteLength(raw, "utf8");
      return {
        path,
        size: bytes,
        content: bytes > maxBytes ? raw.slice(0, maxBytes) : raw,
        truncated: bytes > maxBytes,
      };
    },
  };
}
