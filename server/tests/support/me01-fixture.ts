import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { createTool } from "@mastra/core/tools";
import { PostgresStore } from "@mastra/pg";
import { z } from "zod";
import {
  createDisposableDatabase,
  type DisposableDatabase,
  psql,
} from "./pg-container";

/**
 * ME01 (#473) fixtures: a scripted loopback provider, and the smallest Mastra
 * agent stack that exercises a controlled tool loop and a durable
 * suspend/resume. Shared by the parent test and the resume child process; the
 * src compatibility probe keeps its own inline copy on purpose (src must not
 * import from tests), so wire-format changes here must be mirrored there.
 *
 * The disposable restricted-role database comes from the shared pg-container
 * helper (R2-10): one bootstrap for every fixture, not one per ticket.
 *
 * No direct SQL driver is imported: bootstrap DDL and receipt counts go
 * through `docker exec psql` on the local test container, and in-run queries
 * reuse the PostgresStore pool. The suites built on this fixture still join
 * the driven partition (their bun-test-compat import chain cannot load on
 * Node); the audit scripts, not this file, decide that placement.
 */

export const ME01_AGENT_ID = "me01-agent";
export const ME01_TOOL_NAME = "echo_tool";
export const ME01_CHILD_RESULT_PREFIX = "ME01_CHILD_RESULT:";

export type Me01Database = DisposableDatabase;

/**
 * Creates a disposable database plus a restricted login role (NOSUPERUSER,
 * NOBYPASSRLS) that only owns objects it creates in the public schema. The
 * Mastra store connects with that role, never with the admin superuser.
 */
export function createMe01Database(): Promise<Me01Database> {
  return createDisposableDatabase({ label: "me01" });
}

export interface FakeProvider {
  url: string;
  /** Chat-completion requests received, in order (model name + tool name). */
  readonly requests: { model: string; toolCall: string | null }[];
  close(): Promise<void>;
}

/**
 * Scripted OpenAI-compatible loopback: the first turn requests the ME01 tool,
 * the second turn answers from the tool result. Streaming SSE keeps the same
 * wire path the probe already validates.
 */
export function startFakeProvider(
  options: { mode?: "tool-loop" | "bad-frame" } = {},
): Promise<FakeProvider> {
  const requests: { model: string; toolCall: string | null }[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    // A client disconnecting mid-body must not leave the request unhandled:
    // there is nothing to answer, so tear the response down instead of never
    // writing one (which would hang the caller to its own timeout).
    request.on("error", () => response.destroy());
    request.on("end", () => {
      const turn = requests.length;
      // A malformed body must surface as a diagnosable 400, not as an
      // exception escaping the HTTP event handler and crashing the test
      // process.
      let parsedBody: {
        model?: string;
        messages?: {
          role: string;
          tool_calls?: { function?: { name?: string } }[];
        }[];
      };
      try {
        parsedBody = JSON.parse(body);
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: "ME01 fake provider: invalid JSON body" }),
        );
        return;
      }
      // `JSON.parse("null")` is legal JSON with a null value: without this
      // check the `.model` read below would throw inside the HTTP 'end'
      // handler — the exact escape this guard exists to prevent.
      if (parsedBody === null || typeof parsedBody !== "object") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: "ME01 fake provider: non-object JSON body" }),
        );
        return;
      }
      const parsedModel = parsedBody.model ?? "me01-model";
      const lastAssistant = [...(parsedBody.messages ?? [])]
        .reverse()
        .find((message) => message.role === "assistant");
      // Structured check on the already-parsed messages, not a raw-body
      // substring: a user message quoting `"tool_call_id"` (or a future
      // provider script changing its wire shape) must not silently flip this
      // branch into answering "without tool history".
      const toolResultsInHistory = (parsedBody.messages ?? []).some(
        (message) => message.role === "tool",
      );
      requests.push({
        model: parsedModel,
        toolCall: lastAssistant?.tool_calls?.[0]?.function?.name ?? null,
      });
      const id = `chatcmpl-me01-${turn}`;
      const chunks: unknown[] =
        turn === 0
          ? [
              {
                id,
                object: "chat.completion.chunk",
                created: 1,
                model: parsedModel,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_me01_1",
                          type: "function",
                          function: { name: ME01_TOOL_NAME, arguments: "" },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                id,
                object: "chat.completion.chunk",
                created: 1,
                model: parsedModel,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        { index: 0, function: { arguments: '{"value":"hi"}' } },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                id,
                object: "chat.completion.chunk",
                created: 1,
                model: parsedModel,
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              },
            ]
          : [
              {
                id,
                object: "chat.completion.chunk",
                created: 1,
                model: parsedModel,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      content: toolResultsInHistory
                        ? "Second step used the tool result: hi"
                        : "unexpected turn without tool history",
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                id,
                object: "chat.completion.chunk",
                created: 1,
                model: parsedModel,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              },
            ];
      if (options.mode === "bad-frame") {
        // An unparsable SSE frame plus an unknown control directive: the run
        // must surface a stream error instead of fabricating a success.
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          "data: {not-json\n\ndata: [ME01-UNKNOWN-CONTROL]\n\ndata: [DONE]\n\n",
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("fake provider did not bind"));
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

export interface CountingControlledModel {
  /** The LanguageModelV3 handed to the Agent; every step must pass through here. */
  readonly model: ReturnType<ReturnType<typeof createOpenAI>["chat"]>;
  doStreamCalls(): number;
}

/** Wraps the loopback-backed chat model so every model step is observable. */
export function createCountingControlledModel(
  providerUrl: string,
): CountingControlledModel {
  const inner = createOpenAI({
    apiKey: "me01-synthetic-key",
    baseURL: `${providerUrl}/v1`,
  }).chat("me01-model");
  let doStreamCalls = 0;
  const model = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "doStream") {
        return (options: unknown) => {
          doStreamCalls += 1;
          return target.doStream(options as never);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    model: model as CountingControlledModel["model"],
    doStreamCalls: () => doStreamCalls,
  };
}

export async function countReceipts(
  dbName: string,
  runId: string,
): Promise<number> {
  const escaped = runId.replace(/'/g, "''");
  const count = await psql(
    dbName,
    `SELECT count(*) FROM me01_tool_receipts WHERE run_id = '${escaped}'`,
  );
  return Number(count);
}

export interface Me01Stack {
  mastra: Mastra;
  agent: Agent;
  store: PostgresStore;
  controlled: CountingControlledModel;
}

/**
 * The single construction every process uses: same agent id, same tool, same
 * controlled model wrapper, storage-backed Mastra so suspended runs persist.
 * The receipt table is created through the store's own pool with the runtime
 * role, so the restricted account owns what it writes.
 */
export async function buildMe01Stack(options: {
  providerUrl: string;
  dbUrl: string;
  /** Route tool calls through the durable approval step (suspends before execute). */
  requireApproval?: boolean;
}): Promise<Me01Stack> {
  const controlled = createCountingControlledModel(options.providerUrl);
  const store = new PostgresStore({
    id: `me01-${randomUUID().slice(0, 8)}`,
    connectionString: options.dbUrl,
  });
  try {
    // The receipt table lives in the same disposable database and is created
    // with the restricted runtime role, so the store owns what it writes.
    await store.pool.query(`CREATE TABLE IF NOT EXISTS me01_tool_receipts (
         id serial PRIMARY KEY,
         run_id text NOT NULL,
         tool_call_id text NOT NULL,
         args_digest text NOT NULL,
         executed_at timestamptz NOT NULL DEFAULT now()
       )`);
    const echoTool = createTool({
      id: ME01_TOOL_NAME,
      description: "Echo the given value back once.",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ echo: z.string() }),
      suspendSchema: z.object({ question: z.string() }),
      resumeSchema: z.object({ approved: z.boolean() }),
      // Approval-gated tools run inside the durable toolCallStep, where a
      // suspend before execute persists to storage and survives process exit.
      ...(options.requireApproval ? { requireApproval: true as const } : {}),
      execute: async (input, context) => {
        const value = (input as { value: string }).value;
        await store.pool.query(
          `INSERT INTO me01_tool_receipts (run_id, tool_call_id, args_digest) VALUES ($1, $2, $3)`,
          [
            process.env.ME01_RUN_ID ?? "unknown",
            String(
              (context as { toolCallId?: string } | undefined)?.toolCallId ??
                "missing",
            ),
            value,
          ],
        );
        return { echo: value };
      },
    });
    const agent = new Agent({
      id: ME01_AGENT_ID,
      name: "ME01 Agent",
      instructions:
        "Use the echo tool when asked, then answer briefly from its result.",
      model: controlled.model,
      tools: { [ME01_TOOL_NAME]: echoTool },
    });
    const mastra = new Mastra({
      agents: { [ME01_AGENT_ID]: agent },
      storage: store,
    });
    return { mastra, agent, store, controlled };
  } catch (error) {
    // Construction failed after the store connected (the realistic point is
    // the DDL query above): close the pool before rethrowing, or the idle
    // TCP handles keep the process alive and the caller — which never
    // received the store reference — hangs instead of failing.
    await store.close().catch(() => undefined);
    throw error;
  }
}
