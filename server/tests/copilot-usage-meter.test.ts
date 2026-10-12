import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LLMock } from "@copilotkit/aimock";
import {
  CreditGateError,
  resolveRuntimeAgents,
  runtimeModelForEnvironment,
  setModelUsageGate,
  setModelUsageMeter,
} from "../src/copilot";
import { loadTenantPackage } from "../src/tenant-package";
import { testEnvironment } from "./support/environment";

const packagePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "examples",
  "fintech",
);

// A stand-in provider credential, assembled rather than literal, referenced everywhere and
// expected to appear nowhere (the same convention the billing tests use).
const STUB_MODEL_KEY = `synthetic-${"model-key"}`;

/**
 * The metering chain end to end, against the real model wiring: an LLMock backend answers with a
 * usage block, the runtime's real stream runs through the middleware this module wraps models in,
 * and the meter wired for the test records what fell out of the finish chunk. The billing service
 * and the provider behind it are each other's tests; here the contract under test is "a model call
 * delivers its token counts to the meter" — the one link only a real stream can prove.
 */
describe("the model usage meter", () => {
  test("two completed model calls report distinct event ids and their own token counts", async () => {
    const environment = {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    };
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const recorder = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    const seen: {
      eventId: string | undefined;
      occurredAt: Date | undefined;
      inputTokens: number | undefined;
      outputTokens: number | undefined;
    }[] = [];
    try {
      process.env.OPENAI_BASE_URL = await recorder.start();
      recorder.onMessage(
        /Complete the first fixture request\./,
        { type: "text", content: "Metered fixture completed." },
        {
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            total_tokens: 150,
          },
        },
      );
      recorder.onMessage(
        /Complete the second fixture request\./,
        { type: "text", content: "Metered fixture completed again." },
        {
          usage: {
            prompt_tokens: 220,
            completion_tokens: 40,
            total_tokens: 260,
          },
        },
      );
      // Wired before the agents are built: the meter wraps the model at configuration time, which
      // is also the production order — index.ts wires the billing seam before any agent is built.
      setModelUsageMeter((usage) => {
        seen.push({
          eventId: (usage as { eventId?: string }).eventId,
          occurredAt: (usage as { occurredAt?: Date }).occurredAt,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
      });
      const agents = await resolveRuntimeAgents(
        () => [
          {
            id: "general-assistant",
            name: "General Assistant",
            type: "built_in" as const,
            systemPrompt: "Be helpful.",
          },
        ],
        model,
        async () => STUB_MODEL_KEY,
      );
      const first = agents["general-assistant"]?.clone();
      const second = agents["general-assistant"]?.clone();
      if (!first || !second) throw new Error("Expected General Assistant.");
      first.addMessage({
        id: "usage-meter-request-1",
        role: "user",
        content: "Complete the first fixture request.",
      });
      await first.runAgent();
      second.addMessage({
        id: "usage-meter-request-2",
        role: "user",
        content: "Complete the second fixture request.",
      });
      await second.runAgent();
      expect(first.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "Metered fixture completed.",
      });
      expect(second.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "Metered fixture completed again.",
      });
      expect(seen).toHaveLength(2);
      expect(seen[0]?.eventId).toBeTruthy();
      expect(seen[1]?.eventId).toBeTruthy();
      expect(seen[0]?.eventId).not.toBe(seen[1]?.eventId);
      expect(seen[0]?.occurredAt).toBeInstanceOf(Date);
      expect(seen[1]?.occurredAt).toBeInstanceOf(Date);
      expect(seen[0]?.inputTokens ?? 0).toBeGreaterThan(0);
      expect(seen[1]?.inputTokens ?? 0).toBeGreaterThan(0);
      expect(seen[0]?.outputTokens ?? 0).toBeGreaterThan(0);
      expect(seen[1]?.outputTokens ?? 0).toBeGreaterThan(0);
      expect(
        new Set(seen.map((entry) => `${entry.inputTokens}:${entry.outputTokens}`))
          .size,
      ).toBe(2);
    } finally {
      setModelUsageMeter(undefined);
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await recorder.stop();
    }
  });

  test("no wired meter costs nothing: the run completes unobserved", async () => {
    const environment = {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    };
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const recorder = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    try {
      process.env.OPENAI_BASE_URL = await recorder.start();
      recorder.onMessage(/.*/, {
        type: "text",
        content: "Unmetered fixture completed.",
      });
      const agents = await resolveRuntimeAgents(
        () => [
          {
            id: "general-assistant",
            name: "General Assistant",
            type: "built_in" as const,
            systemPrompt: "Be helpful.",
          },
        ],
        model,
        async () => STUB_MODEL_KEY,
      );
      const agent = agents["general-assistant"]?.clone();
      if (!agent) throw new Error("Expected General Assistant.");
      agent.addMessage({
        id: "unmetered-request",
        role: "user",
        content: "Complete the fixture request.",
      });
      await agent.runAgent();
      expect(agent.messages.at(-1)).toMatchObject({
        content: "Unmetered fixture completed.",
      });
    } finally {
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await recorder.stop();
    }
  });

  test("a refusing gate fails the run with the credit sentinel before any token streams", async () => {
    const environment = {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    };
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const recorder = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    let gateCalls = 0;
    try {
      process.env.OPENAI_BASE_URL = await recorder.start();
      // The gate refuses every call — the shape index.ts wires when the balance is zero.
      setModelUsageGate(async () => {
        gateCalls += 1;
        throw new CreditGateError();
      });
      const agents = await resolveRuntimeAgents(
        () => [
          {
            id: "general-assistant",
            name: "General Assistant",
            type: "built_in" as const,
            systemPrompt: "Be helpful.",
          },
        ],
        model,
        async () => STUB_MODEL_KEY,
      );
      const agent = agents["general-assistant"]?.clone();
      if (!agent) throw new Error("Expected General Assistant.");
      agent.addMessage({
        id: "gate-refusal-request",
        role: "user",
        content: "This call must be refused by the gate.",
      });
      // The run fails (the stream never starts) with OUR sentinel in the chain — not a
      // generic transport error the reader cannot act on.
      let refusal: unknown;
      try {
        await agent.runAgent();
      } catch (error) {
        refusal = error;
      }
      expect(gateCalls).toBeGreaterThanOrEqual(1);
      expect(refusal).toBeDefined();
      const chain: string[] = [];
      for (let e = refusal; e instanceof Error && chain.length < 5; ) {
        chain.push(`${e.name}: ${e.message}`);
        e = (e.cause ?? e) as Error;
      }
      expect(chain.join(" | ")).toMatch(
        /CreditGateError|credits_exhausted|no credits left/,
      );
    } finally {
      setModelUsageGate(undefined);
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await recorder.stop();
    }
  });
});
