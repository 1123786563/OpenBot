import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import { describe, expect, it } from "../../tests/support/bun-test-compat";
import {
  builtInAgentConfiguration,
  setBuiltinExecutionEngine,
  setMastraConversationRuntime,
  setMastraMemoryContext,
} from "../src/copilot";
import type { GovernedModelRequest } from "../src/enterprise/runs/governed-execution";
import { MEMORY_UNAVAILABLE_NOTICE } from "../src/memory-service/context";
import { carrier, sse } from "./support/me04-harness";

/*
 * #729 接线：记忆服务装载器装上后，普通对话在服务故障时继续并提示未使用
 * 记忆，依赖记忆的任务暂停。纯函数语义在 memory-service-degradation.test.ts
 * （node 原生）覆盖，这里证明工厂确实用它。#732：旧 #395 装载器已随旧引擎
 * 退出，不再有"旧装载器不被读"的对照臂——该事实由 memory-service-no-legacy
 * 套件的结构断言覆盖。
 */

const MEMORY_TOOL: GrantedTool = {
  name: "recall_personal_memory",
  description: "recall memory",
  parameters: z.object({}),
  execute: async () => "unused",
};

interface DialRecord {
  systemText: string;
}

function engineOn() {
  setBuiltinExecutionEngine(() => "mastra");
  setMastraConversationRuntime({
    loadExecutionInput: async (_scope: unknown, input: RunAgentInput) => input,
    persistExecutionMessages: async () => {},
  } as never);
}

function engineOff() {
  setBuiltinExecutionEngine(undefined);
  setMastraConversationRuntime(undefined);
  setMastraMemoryContext(undefined);
}

async function driveFactory(options: {
  governedModel: GovernedModelRequest;
  tools?: GrantedTool[];
}): Promise<BaseEvent[]> {
  const config = builtInAgentConfiguration(
    {
      id: "bot-a",
      name: "Bot A",
      type: "built_in" as const,
      systemPrompt: "Follow the registered Bot instructions.",
      expertSource: "tenant_package" as const,
    },
    { provider: "openai", defaultModel: "me01-model", plan: {} as never },
    null,
    options.tools ?? [],
    undefined,
    [],
    null,
    undefined,
    undefined,
    options.governedModel,
    { userId: "actor-a" },
    undefined,
  ) as {
    type: string;
    factory: (context: {
      input: unknown;
      abortSignal: AbortSignal;
    }) => AsyncGenerator<BaseEvent>;
  };
  const events: BaseEvent[] = [];
  for await (const event of config.factory({
    input: {
      threadId: "thread-1",
      runId: "client-run-1",
      messages: [{ id: "msg-1", role: "user" as const, content: "hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    },
    abortSignal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

async function answerRunCarrier(dials: DialRecord[]) {
  return carrier({
    ceiling: 4096,
    onDial: (body) => {
      const messages = (body.messages ?? []) as {
        role: string;
        content: unknown;
      }[];
      const system = messages.find((message) => message.role === "system");
      dials.push({
        systemText: typeof system?.content === "string" ? system.content : "",
      });
    },
    fetch: () =>
      sse([
        { content: "answered" },
        { finish: "stop" },
        { usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
      ]),
  });
}

const UNAVAILABLE = {
  content: "",
  result: {
    state: "unavailable" as const,
    memories: [],
    unavailableReasons: ["memory_service_unavailable"],
  },
};

describe("memory service degradation on the Mastra execution path", () => {
  it("plain_chat_continues_on_the_service_notice", async () => {
    const dials: DialRecord[] = [];
    const harness = await answerRunCarrier(dials);
    engineOn();
    try {
      setMastraMemoryContext(async () => UNAVAILABLE);
      const events = await driveFactory({
        governedModel: harness.governedModel,
      });
      expect(events.map((event) => event.type).at(-1)).toBe("RUN_FINISHED");
      expect(dials[0]!.systemText).toContain(MEMORY_UNAVAILABLE_NOTICE);
    } finally {
      engineOff();
    }
  });

  it("a_memory_dependent_run_pauses_instead_of_running_without_memory", async () => {
    const dials: DialRecord[] = [];
    const harness = await answerRunCarrier(dials);
    engineOn();
    try {
      setMastraMemoryContext(async () => UNAVAILABLE);
      let thrown: unknown = null;
      try {
        await driveFactory({
          governedModel: harness.governedModel,
          tools: [MEMORY_TOOL],
        });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as Error | null)?.message).toBe("MEMORY_UNAVAILABLE");
      // 暂停发生在任何模型调用之前。
      expect(dials).toHaveLength(0);
    } finally {
      engineOff();
    }
  });

  it("available_content_reaches_the_model_through_the_service_loader", async () => {
    const dials: DialRecord[] = [];
    const harness = await answerRunCarrier(dials);
    engineOn();
    try {
      setMastraMemoryContext(async () => ({
        content: "- ME729-SERVICE prefers concise answers.",
        result: {
          state: "available" as const,
          memories: [],
          unavailableReasons: [],
        },
      }));
      const events = await driveFactory({
        governedModel: harness.governedModel,
      });
      expect(events.map((event) => event.type).at(-1)).toBe("RUN_FINISHED");
      expect(dials[0]!.systemText).toContain(
        "ME729-SERVICE prefers concise answers.",
      );
    } finally {
      engineOff();
    }
  });
});
