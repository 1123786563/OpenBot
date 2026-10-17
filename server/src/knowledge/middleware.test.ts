import { describe, expect, test } from "../../../tests/support/e2e-compat";
import type { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import { firstValueFrom, of } from "rxjs";
import { KnowledgeRetrievalMiddleware } from "./middleware";
import type { KnowledgeRetriever, RetrievalOutcome } from "./retrieval";

/** 记录 run 实际收到的 input：断言注入/放行全靠它。 */
function stubAgent() {
  const received: RunAgentInput[] = [];
  const agent = {
    run(receivedInput: RunAgentInput) {
      received.push(receivedInput);
      return of({ type: "RUN_STARTED" } as unknown as BaseEvent);
    },
  } as unknown as AbstractAgent;
  return { agent, received };
}

function baseInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "t1",
    runId: "r1",
    messages: [{ id: "m1", role: "user", content: "什么是风险准备金率？" }],
    tools: [],
    context: [],
    ...overrides,
  } as RunAgentInput;
}

const hitOutcome: RetrievalOutcome = {
  status: "hit",
  chunks: [
    {
      index: 1,
      kbId: "kb1",
      chunkId: "c1",
      docId: "d1",
      title: "手册",
      source: "file",
      score: 0.9,
      content: "风险准备金率是……",
    },
  ],
  block: "[检索资料] mock block",
};

function retrieverReturning(outcome: RetrievalOutcome): KnowledgeRetriever {
  return { retrieve: async () => outcome };
}

function failingRetriever(): KnowledgeRetriever {
  return {
    retrieve: async () => {
      throw new Error("upstream exploded");
    },
  };
}

describe("knowledge retrieval middleware", () => {
  test("hit: injects a system message and a context entry, and dedups an older copy of both", async () => {
    const { agent, received } = stubAgent();
    const middleware = new KnowledgeRetrievalMiddleware("bot-1", async () =>
      retrieverReturning(hitOutcome),
    );
    // 历史里已带着上一轮的注入（id 与 description 相同）：必须先被过滤再补新的。
    const input = baseInput({
      messages: [
        {
          id: "openbot:knowledge-retrieval",
          role: "system",
          content: "[检索资料] 上一轮的旧块",
        },
        { id: "m1", role: "user", content: "什么是风险准备金率？" },
      ],
      context: [
        { description: "OpenBot knowledge retrieval", value: "旧条目" },
      ],
    } as Partial<RunAgentInput>);
    await firstValueFrom(middleware.run(input, agent));
    const passed = received[0];
    if (!passed) throw new Error("next agent never ran");
    expect(passed.messages.length).toBe(2);
    expect(passed.messages[0]?.id).toBe("openbot:knowledge-retrieval");
    expect(passed.messages[0]?.content).toBe("[检索资料] mock block");
    expect(
      passed.messages.filter((m) => m.id === "openbot:knowledge-retrieval")
        .length,
    ).toBe(1);
    expect(passed.context.length).toBe(1);
    expect(passed.context[0]?.description).toBe("OpenBot knowledge retrieval");
    expect(passed.context[0]?.value).toBe("[检索资料] mock block");
  });

  test("miss: passes the original input through untouched", async () => {
    const { agent, received } = stubAgent();
    const middleware = new KnowledgeRetrievalMiddleware("bot-1", async () =>
      retrieverReturning({ status: "miss" }),
    );
    const input = baseInput();
    await firstValueFrom(middleware.run(input, agent));
    expect(received[0]).toBe(input);
  });

  test("degraded (circuit-open): passes the original input through untouched", async () => {
    const { agent, received } = stubAgent();
    const middleware = new KnowledgeRetrievalMiddleware("bot-1", async () =>
      retrieverReturning({ status: "degraded", reason: "circuit-open" }),
    );
    const input = baseInput();
    await firstValueFrom(middleware.run(input, agent));
    expect(received[0]).toBe(input);
  });

  test("load returning null (feature off for this actor): passthrough", async () => {
    const { agent, received } = stubAgent();
    const middleware = new KnowledgeRetrievalMiddleware(
      "bot-1",
      async () => null,
    );
    const input = baseInput();
    await firstValueFrom(middleware.run(input, agent));
    expect(received[0]).toBe(input);
  });

  test("load throwing: run still proceeds with the original input", async () => {
    const { agent, received } = stubAgent();
    const middleware = new KnowledgeRetrievalMiddleware("bot-1", async () => {
      throw new Error("config store down");
    });
    const input = baseInput();
    await firstValueFrom(middleware.run(input, agent));
    expect(received[0]).toBe(input);
  });

  test("retrieve throwing: run still proceeds with the original input", async () => {
    const { agent, received } = stubAgent();
    const middleware = new KnowledgeRetrievalMiddleware("bot-1", async () =>
      failingRetriever(),
    );
    const input = baseInput();
    await firstValueFrom(middleware.run(input, agent));
    expect(received[0]).toBe(input);
  });

  test("no user message: passthrough without calling the retriever", async () => {
    const { agent, received } = stubAgent();
    let called = 0;
    const middleware = new KnowledgeRetrievalMiddleware("bot-1", async () => {
      called += 1;
      return {
        retrieve: async () => {
          called += 1;
          return hitOutcome;
        },
      };
    });
    const input = baseInput({
      messages: [{ id: "m1", role: "assistant", content: "好的" }],
    } as Partial<RunAgentInput>);
    await firstValueFrom(middleware.run(input, agent));
    // load 被调（retriever 解析），retrieve 不该被调（没有 query）。
    expect(called).toBe(1);
    expect(received[0]).toBe(input);
  });

  test("query is the LAST user message's text, capped at 512 chars", async () => {
    const { agent } = stubAgent();
    const queries: string[] = [];
    const middleware = new KnowledgeRetrievalMiddleware("bot-1", async () => ({
      retrieve: async (query) => {
        queries.push(query);
        return hitOutcome;
      },
    }));
    const long = "长".repeat(600);
    await firstValueFrom(
      middleware.run(
        baseInput({
          messages: [
            { id: "m1", role: "user", content: "第一轮的问题" },
            { id: "m2", role: "assistant", content: "上一轮回答" },
            { id: "m3", role: "user", content: long },
          ],
        } as Partial<RunAgentInput>),
        agent,
      ),
    );
    expect(queries.length).toBe(1);
    expect(queries[0]).toBe(long.slice(0, 512));
  });

  test("structured content parts are read via textOf", async () => {
    const { agent } = stubAgent();
    const queries: string[] = [];
    const middleware = new KnowledgeRetrievalMiddleware("bot-1", async () => ({
      retrieve: async (query) => {
        queries.push(query);
        return { status: "miss" };
      },
    }));
    await firstValueFrom(
      middleware.run(
        baseInput({
          messages: [
            {
              id: "m1",
              role: "user",
              content: [{ type: "text", text: "结构化内容的问题" }],
            },
          ],
        } as Partial<RunAgentInput>),
        agent,
      ),
    );
    expect(queries).toEqual(["结构化内容的问题"]);
  });

  test("botId is handed to the loader", async () => {
    const seen: string[] = [];
    const middleware = new KnowledgeRetrievalMiddleware(
      "bot-42",
      async (botId) => {
        seen.push(botId);
        return null;
      },
    );
    await firstValueFrom(middleware.run(baseInput(), stubAgent().agent));
    expect(seen).toEqual(["bot-42"]);
  });
});
