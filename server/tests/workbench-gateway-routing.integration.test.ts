import { describe, expect, test } from "../../tests/support/e2e-compat";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LLMock } from "@copilotkit/aimock";
import {
  builtInAgentConfiguration,
  CreditGateError,
  type ModelUsageGateLifecycle,
  resolveRuntimeAgents,
  runtimeModelForEnvironment,
  setModelUsageGate,
  setModelUsageMeter,
  setWorkbenchGatewayModel,
  UnmeterableModelError,
} from "../src/copilot";
import { loadTenantPackage } from "../src/tenant-package";
import { testEnvironment } from "./support/environment";
import { withUsageOrigin } from "../src/usage-origin";

const packagePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "examples",
  "fintech",
);

// A stand-in credential, assembled rather than literal, referenced everywhere and expected
// to appear nowhere (the same convention the billing tests use).
const STUB_MODEL_KEY = `synthetic-${"model-key"}`;

// Nothing should ever connect here: a provider-direct dial against it fails loudly, which
// is exactly what makes "the provider saw zero requests" observable without a second mock.
const UNROUTABLE = "http://127.0.0.1:9";

function builtInRow(id: string) {
  return {
    id,
    name: "General Assistant",
    type: "built_in" as const,
    systemPrompt: "Be helpful.",
  };
}

/**
 * Bifrost #286 (09.1): the built-in workbench's ordinary model calls go through the gateway.
 *
 * The workbench model surface used to dial whatever `OPENAI_BASE_URL` named — a provider, or
 * anything else an operator pointed at — and the string-form models escaped through the runtime's
 * own provider resolution entirely. What this ticket wires instead is one transport seam: when the
 * deployment has a model gateway, EVERY ordinary built-in Bot call dials the gateway endpoint, for
 * both providers, streaming and not, and there is no provider-direct branch left on this surface.
 * The seam refusing is the run refusing (fail-closed, the same sentinel the unprovable wirings
 * already raise) — never a silent fallback to the provider.
 *
 * The mock here stands in for the gateway. The "provider" is `OPENAI_BASE_URL` pointed at an
 * unroutable address: the assertion that matters is that the run succeeds while that dial is never
 * made — provider-direct requests end the run at zero.
 */
describe("the workbench model gateway routing (09.1)", () => {
  test("an ordinary built-in model call dials the gateway, and the provider sees zero requests", async () => {
    const environment = {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    };
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const gateway = new LLMock();
    const gatewayUrl = await gateway.start();
    gateway.onMessage(
      /Route me through the gateway\./,
      { type: "text", content: "Answered through the gateway." },
      {
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      },
    );
    const originalBase = process.env.OPENAI_BASE_URL;
    try {
      process.env.OPENAI_BASE_URL = UNROUTABLE;
      setWorkbenchGatewayModel(async () => ({
        baseURL: gatewayUrl,
        apiKey: STUB_MODEL_KEY,
      }));
      const agents = await resolveRuntimeAgents(
        () => [builtInRow("general-assistant")],
        model,
        async () => STUB_MODEL_KEY,
      );
      const agent = agents["general-assistant"]?.clone();
      if (!agent) throw new Error("Expected General Assistant.");
      agent.addMessage({
        id: "gateway-routing-request-1",
        role: "user",
        content: "Route me through the gateway.",
      });
      await agent.runAgent();
      expect(agent.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "Answered through the gateway.",
      });
      // The run's model traffic landed on the gateway endpoint, and the run still
      // succeeded with the provider-direct dial pointing somewhere unroutable: zero
      // provider requests is not an assertion here, it is the reason the run worked.
      expect(gateway.journal.size).toBeGreaterThan(0);
    } finally {
      setWorkbenchGatewayModel(undefined);
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await gateway.stop();
    }
  });

  test("an anthropic-provider built-in model goes through the gateway too, not the provider", async () => {
    const gateway = new LLMock();
    const gatewayUrl = await gateway.start();
    gateway.onMessage(
      /Anthropic through the gateway\./,
      { type: "text", content: "Answered through the gateway." },
      {
        usage: { prompt_tokens: 90, completion_tokens: 20, total_tokens: 110 },
      },
    );
    const originalBase = process.env.OPENAI_BASE_URL;
    const originalAnthropicBase = process.env.ANTHROPIC_BASE_URL;
    try {
      process.env.OPENAI_BASE_URL = UNROUTABLE;
      process.env.ANTHROPIC_BASE_URL = UNROUTABLE;
      setWorkbenchGatewayModel(async () => ({
        baseURL: gatewayUrl,
        apiKey: STUB_MODEL_KEY,
      }));
      const agents = await resolveRuntimeAgents(
        () => [builtInRow("general-assistant")],
        { provider: "anthropic", defaultModel: "claude-sonnet-4-5" },
        async () => STUB_MODEL_KEY,
      );
      const agent = agents["general-assistant"]?.clone();
      if (!agent) throw new Error("Expected General Assistant.");
      agent.addMessage({
        id: "gateway-routing-request-2",
        role: "user",
        content: "Anthropic through the gateway.",
      });
      await agent.runAgent();
      expect(agent.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "Answered through the gateway.",
      });
      expect(gateway.journal.size).toBeGreaterThan(0);
    } finally {
      setWorkbenchGatewayModel(undefined);
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      if (originalAnthropicBase === undefined)
        delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = originalAnthropicBase;
      await gateway.stop();
    }
  });

  test("streaming settles through the meter and non-streaming dials the gateway too", async () => {
    const environment = {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    };
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const gateway = new LLMock();
    const gatewayUrl = await gateway.start();
    gateway.onMessage(
      /Stream and generate through the gateway\./,
      { type: "text", content: "Answered through the gateway." },
      {
        usage: { prompt_tokens: 60, completion_tokens: 15, total_tokens: 75 },
      },
    );
    const originalBase = process.env.OPENAI_BASE_URL;
    const meters: { inputTokens?: number; outputTokens?: number }[] = [];
    try {
      process.env.OPENAI_BASE_URL = UNROUTABLE;
      setWorkbenchGatewayModel(async () => ({
        baseURL: gatewayUrl,
        apiKey: STUB_MODEL_KEY,
      }));

      // The non-streaming path first, with no meter wired so the model instance is the
      // configured one unwrapped: the same construction the deployment dials with, and
      // its doGenerate must land on the gateway too. The dial is passed exactly as the
      // resolver hands it to the configuration.
      const configured = builtInAgentConfiguration(
        builtInRow("general-assistant"),
        model,
        STUB_MODEL_KEY,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        // tools … attribution fill positions 4–11; the dial is the 12th and tail seat.
        { baseURL: gatewayUrl, apiKey: STUB_MODEL_KEY },
      ) as {
        model: {
          doGenerate: (params: unknown) => Promise<{ finishReason: string }>;
        };
      };
      const generated = await configured.model.doGenerate({
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Stream and generate through the gateway.",
              },
            ],
          },
        ],
      });
      expect(generated.finishReason).toBeDefined();
      expect(gateway.journal.size).toBe(1);

      // The agent run IS the streaming path: the runtime consumes the model's stream.
      setModelUsageMeter((usage) => {
        meters.push({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
      });
      const agents = await resolveRuntimeAgents(
        () => [builtInRow("general-assistant")],
        model,
        async () => STUB_MODEL_KEY,
      );
      const agent = agents["general-assistant"]?.clone();
      if (!agent) throw new Error("Expected General Assistant.");
      agent.addMessage({
        id: "gateway-routing-request-3",
        role: "user",
        content: "Stream and generate through the gateway.",
      });
      await agent.runAgent();
      expect(agent.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "Answered through the gateway.",
      });
      expect(gateway.journal.size).toBe(2);
      // The usage fact came from the finished stream the gateway delivered — the same
      // settlement shape a direct dial produced, not a local estimate.
      expect(meters).toHaveLength(1);
      expect(meters[0]?.inputTokens ?? 0).toBeGreaterThan(0);
      expect(meters[0]?.outputTokens ?? 0).toBeGreaterThan(0);
    } finally {
      setModelUsageMeter(undefined);
      setWorkbenchGatewayModel(undefined);
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await gateway.stop();
    }
  });

  test("a wired gateway that cannot serve the model refuses the run before anything dials", async () => {
    const environment = {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    };
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const gateway = new LLMock();
    await gateway.start();
    const originalBase = process.env.OPENAI_BASE_URL;
    try {
      process.env.OPENAI_BASE_URL = UNROUTABLE;
      // The gateway transport is wired but answers "this deployment cannot serve the
      // model through me" — the run must refuse with the unmeterable sentinel, never
      // fall back to the provider dial (the unroutable OPENAI_BASE_URL would fail loudly).
      setWorkbenchGatewayModel(async () => null);
      const agents = await resolveRuntimeAgents(
        () => [builtInRow("general-assistant")],
        model,
        async () => STUB_MODEL_KEY,
      );
      const agent = agents["general-assistant"]?.clone();
      if (!agent) throw new Error("Expected General Assistant.");
      agent.addMessage({
        id: "gateway-routing-request-4",
        role: "user",
        content: "This run must be refused.",
      });
      await expect(agent.runAgent()).rejects.toBeInstanceOf(UnmeterableModelError);
      expect(gateway.journal.size).toBe(0);
    } finally {
      setWorkbenchGatewayModel(undefined);
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await gateway.stop();
    }
  });

  test("a wired gateway whose transport throws refuses the run with that reason, and nothing dials", async () => {
    const environment = {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    };
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const gateway = new LLMock();
    await gateway.start();
    const originalBase = process.env.OPENAI_BASE_URL;
    try {
      process.env.OPENAI_BASE_URL = UNROUTABLE;
      // A readiness/admission refusal rides the same seam as a thrown error: the run
      // fails with THAT reason (fail-closed), not with a provider dial against a
      // fallback base URL.
      const readiness = Object.assign(
        new Error("gateway-not-ready-for-test"),
        { name: "GatewayNotReadyError" },
      );
      setWorkbenchGatewayModel(async () => {
        throw readiness;
      });
      // The transport's throw happens where the dial is resolved — at the build, before any
      // Bot exists — so the refusal is the resolution failing, with THAT reason, and nothing
      // has been dialed anywhere.
      await expect(
        resolveRuntimeAgents(
          () => [builtInRow("general-assistant")],
          model,
          async () => STUB_MODEL_KEY,
        ),
      ).rejects.toBe(readiness);
      expect(gateway.journal.size).toBe(0);
    } finally {
      setWorkbenchGatewayModel(undefined);
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await gateway.stop();
    }
  });

  test("the credit gate still refuses before the gateway is dialed, naming who ran it and on which Bot", async () => {
    const environment = {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    };
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const gateway = new LLMock();
    await gateway.start();
    const originalBase = process.env.OPENAI_BASE_URL;
    const seen: {
      client?: string;
      botId?: string | null;
      userId?: string | null;
    }[] = [];
    try {
      process.env.OPENAI_BASE_URL = UNROUTABLE;
      setWorkbenchGatewayModel(async () => ({
        baseURL: UNROUTABLE,
        apiKey: STUB_MODEL_KEY,
      }));
      setModelUsageGate(async (input): Promise<ModelUsageGateLifecycle> => {
        seen.push({
          client: input.client,
          botId: input.attribution?.botId ?? null,
          userId: input.attribution?.userId ?? null,
        });
        throw new CreditGateError();
      });
      // The attribution rides the resolver's 20th position; observation was appended after it
      // (dd49f2486), so the trailing seat is the observation's now. Typed-indexed so a parameter
      // insertion upstream cannot silently shift it one slot over.
      const args = [
        () => [builtInRow("general-assistant")],
        model,
        async () => STUB_MODEL_KEY,
      ] as unknown as Parameters<typeof resolveRuntimeAgents>;
      args[19] = { userId: "user-091" };
      const agents = await resolveRuntimeAgents(...args);
      const agent = agents["general-assistant"]?.clone();
      if (!agent) throw new Error("Expected General Assistant.");
      agent.addMessage({
        id: "gateway-routing-request-6",
        role: "user",
        content: "Admission must refuse this.",
      });
      await expect(
        withUsageOrigin("web", () => agent.runAgent()),
      ).rejects.toBeInstanceOf(CreditGateError);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.client).toBe("web");
      // The consumption record's attribution (AC): the person who initiated the call
      // and the Bot that ran it.
      expect(seen[0]?.userId).toBe("user-091");
      expect(seen[0]?.botId).toBe("general-assistant");
      // Refused before anything was dialed: no gateway request, no provider request.
      expect(gateway.journal.size).toBe(0);
    } finally {
      setModelUsageGate(undefined);
      setWorkbenchGatewayModel(undefined);
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await gateway.stop();
    }
  });

  test("without the gateway seam the workbench builds exactly as before", async () => {
    const environment = {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    };
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const originalBase = process.env.OPENAI_BASE_URL;
    try {
      // Legacy deployment, no gateway seam installed: the named base URL still builds
      // the instance (the meter tests hold this path's behavior), and the string form
      // stays fail-closed under a wired gate.
      process.env.OPENAI_BASE_URL = UNROUTABLE;
      const configured = builtInAgentConfiguration(
        builtInRow("general-assistant"),
        model,
        STUB_MODEL_KEY,
      ) as { model?: unknown };
      expect(typeof configured.model).toBe("object");
    } finally {
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
    }
  });
});
