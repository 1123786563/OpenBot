import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LLMock } from "@copilotkit/aimock";
import {
  resolveRuntimeAgents,
  runtimeModelForEnvironment,
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
  test("a completed model call reports its token counts to the wired meter", async () => {
    const environment = {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    };
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const recorder = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    const seen: {
      inputTokens: number | undefined;
      outputTokens: number | undefined;
    }[] = [];
    try {
      process.env.OPENAI_BASE_URL = await recorder.start();
      recorder.onMessage(
        /.*/,
        { type: "text", content: "Metered fixture completed." },
        {
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            total_tokens: 150,
          },
        },
      );
      // Wired before the agents are built: the meter wraps the model at configuration time, which
      // is also the production order — index.ts wires the billing seam before any agent is built.
      setModelUsageMeter((usage) => {
        seen.push(usage);
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
        id: "usage-meter-request",
        role: "user",
        content: "Complete the fixture request.",
      });
      await agent.runAgent();
      expect(agent.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "Metered fixture completed.",
      });
      // One report per model call, carrying positive counts. Not the fixture's own numbers: the
      // middleware reads the chat-completions stream's real usage block, whose prompt portion
      // counts the actual messages the runtime assembled — larger than the fixture's example.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.inputTokens ?? 0).toBeGreaterThan(0);
      expect(seen[0]?.outputTokens ?? 0).toBeGreaterThan(0);
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
});
