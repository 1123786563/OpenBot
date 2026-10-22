import type { Server } from "node:http";
import { createServer } from "node:http";
import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { PostgresStore } from "@mastra/pg";
import { createFrontendBridgeTools } from "../../src/mastra/frontend-tools";

/*
 * ME06 (#478) fixtures: the frontend (client-participation) tool stack — the
 * REAL pinned engine driving an INERT bridge for the browser tool, over a
 * scripted loopback provider, with the ME05-pattern durable stack (a
 * PostgresStore the toolCallStep persists suspension snapshots into).
 *
 * Shared by the unit suite (mastra-computer-tools.test.ts), the integration
 * suite (mastra-frontend-tool-participation.integration.test.ts) and the
 * resume child process (me06-child.ts): every process that rebuilds the
 * suspended loop uses THIS construction, so the resumed step is the same
 * agent id, the same bridge, and the same loop cap the suspension wrote.
 */

export const ME06_AGENT_ID = "me06-agent";
export const ME06_CHILD_RESULT_PREFIX = "ME06_CHILD_RESULT:";
// One store secret across every process (the ME05 posture): production mints
// and consumes claim HMACs under the SAME server secret.
export const ME06_STORE_SECRET = "me06-participation-secret";
export const ME06_INSTRUCTIONS =
  "Use the computer when asked, then answer briefly from the tool result.";
export const ME06_TOOL_NAME = "computer_navigate";
export const ME06_TOOL_DEFINITION = {
  name: ME06_TOOL_NAME,
  description: "Open a web page on your own computer.",
  parameters: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
} as const;

export interface FrontendProvider {
  url: string;
  readonly requests: { messages: { role: string }[] }[];
  close(): Promise<void>;
}

/**
 * Scripted loopback: turn 0 calls the frontend tool with the example.com
 * arguments; any later turn answers from the tool result when one is in the
 * history (the resumed round), or says so when it is not.
 */
export function startFrontendProvider(
  toolName = ME06_TOOL_NAME,
): Promise<FrontendProvider> {
  const requests: { messages: { role: string }[] }[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    // A client disconnecting mid-body must not leave the request unhandled.
    request.on("error", () => response.destroy());
    request.on("end", () => {
      let parsed: { messages?: { role: string }[] } = {};
      try {
        parsed = JSON.parse(body) as { messages?: { role: string }[] };
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      requests.push({ messages: parsed.messages ?? [] });
      const turn = requests.length - 1;
      const hasToolResult = (parsed.messages ?? []).some(
        (message) => message.role === "tool",
      );
      const id = `chatcmpl-me06-${turn}`;
      const chunks: unknown[] =
        turn === 0
          ? [
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_fe_1",
                          type: "function",
                          function: { name: toolName, arguments: "" },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          function: {
                            arguments: '{"url":"https://example.com"}',
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              },
            ]
          : [
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      content: hasToolResult
                        ? "answered from the client tool result"
                        : "no tool result in history",
                    },
                    finish_reason: null,
                  },
                ],
              },
              { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
            ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `${chunks
          .map(
            (chunk) =>
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created: 1,
                model: "me06-model",
                ...(chunk as object),
              })}\n\n`,
          )
          .join("")}data: [DONE]\n\n`,
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("frontend provider did not bind"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

export interface Me06FrontendStack {
  mastra: Mastra;
  agent: Agent;
  store: PostgresStore;
  model: unknown;
  tools: Record<string, unknown>;
}

/**
 * The durable frontend stack every process uses for the participation loop:
 * same agent id (the execution path mounts `openbot-<botId>`; a child passes
 * the SAME bot id), same inert bridge, storage-backed Mastra so the
 * suspension persists and a fresh process can resume it.
 */
export async function buildMe06FrontendStack(options: {
  providerUrl: string;
  dbUrl: string;
  agentId?: string;
}): Promise<Me06FrontendStack> {
  const agentId = options.agentId ?? ME06_AGENT_ID;
  const store = new PostgresStore({
    id: `me06-${agentId}-${Math.random().toString(36).slice(2, 8)}`,
    connectionString: options.dbUrl,
  });
  try {
    const openai = createOpenAI({
      apiKey: "me06-synthetic-key",
      baseURL: `${options.providerUrl}/v1`,
    });
    const bridges = createFrontendBridgeTools([ME06_TOOL_DEFINITION]);
    const agent = new Agent({
      id: agentId,
      name: "ME06 Agent",
      instructions: ME06_INSTRUCTIONS,
      model: openai.chat("me06-model") as never,
      tools: bridges as never,
    });
    const mastra = new Mastra({
      agents: { [agentId]: agent },
      storage: store,
    });
    return {
      mastra,
      agent,
      store,
      model: openai.chat("me06-model"),
      tools: bridges as never,
    };
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
}
