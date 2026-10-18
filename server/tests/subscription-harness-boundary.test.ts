import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  billingMethodForModel,
  builtInAgentConfiguration,
  type ModelBillingAuditEvent,
  setModelBillingAudit,
  setModelUsageGate,
  setModelUsageMeter,
  runtimeModelForEnvironment,
} from "../src/copilot";
import { CreditInsufficientError } from "../src/billing/payer-binding";
import { PlanModel, planModelForEnvironment } from "../src/agents/plan-model";
import { loadTenantPackage } from "../src/tenant-package";
import { testEnvironment } from "./support/environment";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packagePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "examples",
  "fintech",
);

// A stand-in provider credential, assembled rather than literal, referenced
// everywhere and expected to appear nowhere (the same convention the billing
// tests use).
const STUB_MODEL_KEY = `synthetic-${"model-key"}`;

const AGENT = {
  id: "general-assistant",
  name: "General Assistant",
  type: "built_in" as const,
  systemPrompt: "Be helpful.",
};

/**
 * The subscription-harness environment: a Claude Code subscription credential
 * riding the deployment's own installed harness (the shape plan-model.ts
 * admits). The chatgpt variant is asserted beside it.
 */
const CLAUDE_SUBSCRIPTION_ENV = {
  CLAUDE_CODE_OAUTH_TOKEN: "subscription-oauth-token",
  PICKED_HARNESS_SOURCE: "installed",
  PICKED_HARNESS_IMAGE: "ghcr.io/copilotkit/openbot/agent-claude-sdk:0.0.13",
  PICKED_HARNESS_URL: "http://127.0.0.1:9876/ag-ui",
  MANAGED_AGENT_TOKEN: "owned",
};

const CHATGPT_SUBSCRIPTION_ENV = {
  CHATGPT_AUTH_FILE: "/owned/auth.json",
  PICKED_HARNESS_SOURCE: "installed",
  PICKED_HARNESS_IMAGE:
    "ghcr.io/copilotkit/openbot/agent-langgraph-agui:0.0.13",
  PICKED_HARNESS_URL: "http://127.0.0.1:9876/ag-ui",
  MANAGED_AGENT_TOKEN: "owned",
};

/**
 * 09.4 — the subscription harness boundary. The plan-model path (Claude Code /
 * Codex subscriptions riding the deployment's own harness) is billed by that
 * subscription, not by Bifrost credits: its billing method is marked and
 * queryable, it never enters credit admission, and a credit exhaustion never
 * re-resolves a run onto it.
 */
describe("the subscription harness billing boundary", () => {
  test("the subscription path is marked subscription; the ordinary path credit", async () => {
    const tenantPackage = await loadTenantPackage(packagePath);

    const subscription = runtimeModelForEnvironment(tenantPackage.model, {
      ...testEnvironment(),
      ...CLAUDE_SUBSCRIPTION_ENV,
    });
    expect(subscription.plan).toBeDefined();
    expect(subscription.plan?.billing).toBe("subscription");
    expect(billingMethodForModel(subscription)).toBe("subscription");

    const chatgpt = runtimeModelForEnvironment(tenantPackage.model, {
      ...testEnvironment(),
      ...CHATGPT_SUBSCRIPTION_ENV,
    });
    expect(chatgpt.plan?.billing).toBe("subscription");
    expect(billingMethodForModel(chatgpt)).toBe("subscription");

    const credit = runtimeModelForEnvironment(tenantPackage.model, {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    });
    expect(credit.plan).toBeUndefined();
    expect(billingMethodForModel(credit)).toBe("credit");

    // The marker is on the config type itself, so any surface — the admin
    // readout, a route, a screen — reads the same word the runtime builds from.
    expect(planModelForEnvironment(CLAUDE_SUBSCRIPTION_ENV)?.billing).toBe(
      "subscription",
    );
  });

  test("the subscription path never enters credit admission and is never metered as credits", async () => {
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, {
      ...testEnvironment(),
      ...CLAUDE_SUBSCRIPTION_ENV,
    });
    const planConfig = model.plan;
    if (!planConfig) throw new Error("Expected a plan model.");
    const planModel = new PlanModel(planConfig, AGENT.id, {
      threadId: "boundary-thread",
    });

    // Wired to fail the test if reached: the subscription path must not touch
    // the credit ledger, in either direction (no admission, no metering).
    setModelUsageGate(async () => {
      throw new Error("The subscription path must not enter credit admission.");
    });
    setModelUsageMeter(async () => {
      throw new Error("The subscription path must not be metered as credits.");
    });
    try {
      const config = builtInAgentConfiguration(
        AGENT,
        model,
        null,
        [],
        undefined,
        undefined,
        undefined,
        planModel,
      ) as { model?: unknown; apiKey?: unknown };
      // Reference equality: the model handed to the runtime IS the plan model,
      // not a metering wrapper dressed up around it.
      expect(config.model).toBe(planModel);
      // And the provider credential is not attached to the plan build: the
      // harness dial carries its own subscription credential.
      expect(config.apiKey).toBeUndefined();
    } finally {
      setModelUsageGate(undefined);
      setModelUsageMeter(undefined);
    }
  });

  test("a credit exhaustion refuses the run finally and never re-resolves onto the subscription harness", async () => {
    const tenantPackage = await loadTenantPackage(packagePath);
    // No subscription credential in this deployment's environment: the credit
    // path is the only path, and its refusal must be the end of the run.
    const model = runtimeModelForEnvironment(tenantPackage.model, {
      ...testEnvironment(),
      OPENAI_API_KEY: STUB_MODEL_KEY,
    });
    expect(billingMethodForModel(model)).toBe("credit");

    let gateCalls = 0;
    const audit: ModelBillingAuditEvent[] = [];
    setModelBillingAudit((event) => audit.push(event));
    // The gate refuses with the one insufficiency semantics (AC13): the bound
    // account is short, nothing is switched.
    setModelUsageGate(async () => {
      gateCalls += 1;
      throw new CreditInsufficientError({
        payerKind: "company",
        availableCents: 0,
      });
    });
    try {
      const config = builtInAgentConfiguration(
        AGENT,
        model,
        STUB_MODEL_KEY,
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        // A wired gateway dial (09.1): the ordinary workbench surface.
        { baseURL: "http://127.0.0.1:9/v1", apiKey: STUB_MODEL_KEY },
      ) as { model?: { doStream?: (params: unknown) => Promise<unknown> } };
      const doStream = config.model?.doStream;
      if (!doStream) throw new Error("Expected a callable model.");

      let refusal: unknown;
      try {
        await doStream({});
      } catch (error) {
        refusal = error;
      }
      // The refusal is the credit sentinel, not a fallback's success and not a
      // generic transport error.
      expect(refusal).toBeInstanceOf(CreditInsufficientError);
      expect((refusal as { code?: string }).code).toBe("credits_exhausted");
      // One refusal, one admission: a fallback onto another path would have
      // entered admission a second time (and the run would have continued).
      expect(gateCalls).toBe(1);
      // The refusal itself is on the audit trail, with the boundary as data:
      // nothing was switched to.
      expect(audit).toContainEqual(
        expect.objectContaining({
          kind: "credit_refused",
          code: "credits_exhausted",
          fallback: "none",
        }),
      );
    } finally {
      setModelUsageGate(undefined);
      setModelBillingAudit(undefined);
    }
  });

  test("a run on the subscription path is marked on the audit trail", async () => {
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, {
      ...testEnvironment(),
      ...CLAUDE_SUBSCRIPTION_ENV,
    });
    const planConfig = model.plan;
    if (!planConfig) throw new Error("Expected a plan model.");
    const planModel = new PlanModel(planConfig, AGENT.id, {
      threadId: "boundary-thread-2",
    });

    const audit: ModelBillingAuditEvent[] = [];
    setModelBillingAudit((event) => audit.push(event));
    try {
      builtInAgentConfiguration(
        AGENT,
        model,
        null,
        [],
        undefined,
        undefined,
        undefined,
        planModel,
        undefined,
        undefined,
        undefined,
        { userId: "person-1" },
      );
      expect(audit).toContainEqual(
        expect.objectContaining({
          kind: "subscription_path_used",
          billing: "subscription",
          provider: "claude",
          botId: AGENT.id,
          userId: "person-1",
        }),
      );
    } finally {
      setModelBillingAudit(undefined);
    }
  });
});
