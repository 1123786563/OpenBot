// F7D — the remote budget CONTRACT, tested from the seams the dial actually runs on (R3-02).
//
// The finding's test half: F6D's four cases drove the dial through a STAND-IN gate, so nothing
// proved the wiring a deployment really installs. These cases drive the real factories the boot
// wiring composes — `createRemoteBudgetContractResolver`, `createRemoteRunBudgetGate`,
// `verifyRemoteBudgetReceipt`, and the `REMOTE_BUDGET_CONTRACT_*` config block — so the
// endpoint/token/ceiling rules, the credit hold and the receipt arithmetic are pinned where they
// live. The end-to-end shape (a real agent-langgraph process behind a real OpenBot dial) is in
// `remote-budget-smoke.test.ts`; the delivery-time middleware rules are in
// `remote-budget-dial.test.ts`.

import { createHmac } from "node:crypto";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  canonicalRemoteEndpoint,
  createRemoteBudgetContractResolver,
  createRemoteRunBudgetGate,
  remoteBudgetCaps,
  verifyRemoteBudgetReceipt,
} from "../src/ai-observability/remote-run";
import { canonicalAgentEndpoint, loadConfig } from "../src/config";
import type { RemoteBudgetContractCaps } from "../src/copilot";

const SECRET = "synthetic-managed-token";
const ENDPOINT = "https://risk.test/ag-ui";
const POLICY_TOKENS = 1_000_000n;
const CAPS = remoteBudgetCaps(POLICY_TOKENS, 8) as RemoteBudgetContractCaps;

/** The receipt's MAC, signed the way the endpoint does — see the literal pinned below. */
function mac(body: {
  runId: string;
  caps: RemoteBudgetContractCaps;
  usage: {
    modelSteps: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  status: "ok" | "budget_exceeded";
}): string {
  // Purpose-derived key (OCR R5 handoff): HMAC(secret, label) — the token also
  // travels as the dial's Bearer, so the raw secret never keys the MAC directly.
  const macKey = createHmac("sha256", SECRET)
    .update("openbot-budget-receipt-mac-v1")
    .digest("hex");
  return createHmac("sha256", macKey)
    .update(
      [
        "openbot-budget-receipt",
        "v=1",
        `runId=${body.runId}`,
        `caps=${body.caps.modelSteps}|${body.caps.inputTokens}|${body.caps.outputTokens}|${body.caps.totalTokens}`,
        `usage=${body.usage.modelSteps}|${body.usage.inputTokens}|${body.usage.outputTokens}|${body.usage.totalTokens}`,
        `status=${body.status}`,
      ].join("\n"),
    )
    .digest("hex");
}

function receipt(
  overrides: Partial<{
    runId: string;
    caps: RemoteBudgetContractCaps;
    usage: {
      modelSteps: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
    status: "ok" | "budget_exceeded";
    mac: string;
  }> = {},
) {
  const body = {
    kind: "openbot-budget-receipt",
    v: 1,
    runId: overrides.runId ?? "run-1",
    caps: overrides.caps ?? CAPS,
    usage: overrides.usage ?? {
      modelSteps: 1,
      inputTokens: 900,
      outputTokens: 90,
      totalTokens: 990,
    },
    status: overrides.status ?? ("ok" as const),
  };
  return { ...body, mac: overrides.mac ?? mac(body) };
}

const resolver = (
  overrides: Partial<
    Parameters<typeof createRemoteBudgetContractResolver>[0]
  > = {},
) =>
  createRemoteBudgetContractResolver({
    endpoints: new Set([ENDPOINT]),
    sharedSecret: SECRET,
    maximumTokens: POLICY_TOKENS,
    maxModelSteps: 8,
    ...overrides,
  });

const agUiRequest = (
  overrides: Partial<Parameters<ReturnType<typeof resolver>>[0]> = {},
) => ({
  type: "remote_ag_ui" as const,
  endpoint: ENDPOINT,
  agentToken: SECRET,
  ...overrides,
});

describe("the contract resolver: which endpoints may be held to a budget", () => {
  test("an operator-named endpoint the deployment itself runs gets the policy's caps", () => {
    const contract = resolver()(agUiRequest());
    expect(contract).toBeDefined();
    expect(contract?.caps).toEqual(CAPS);
    // The caps carry the policy's ceiling for every kind and the configured step limit, so the
    // contract and the hold are derived from the SAME approved number.
    expect(CAPS).toEqual({
      modelSteps: 8,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 1_000_000,
    });
  });

  test("a third fact missing is a refusal, not a guess", () => {
    const supported = resolver();
    // Not declared by the operator:
    expect(
      supported(agUiRequest({ endpoint: "https://elsewhere.test/ag-ui" })),
    ).toBeUndefined();
    // Not dialled with the deployment's own token:
    expect(
      supported(agUiRequest({ agentToken: "some-customer-token" })),
    ).toBeUndefined();
    expect(supported(agUiRequest({ agentToken: undefined }))).toBeUndefined();
    // A deployment with no managed token cannot verify anybody's receipt:
    expect(
      resolver({ sharedSecret: undefined })(agUiRequest()),
    ).toBeUndefined();
    // A ceiling that cannot be represented exactly supports nobody:
    expect(
      resolver({ maximumTokens: BigInt(Number.MAX_SAFE_INTEGER) + 1n })(
        agUiRequest(),
      ),
    ).toBeUndefined();
  });

  test("a Mastra endpoint is not contract-capable, because the bridge carries no contract", () => {
    expect(resolver()(agUiRequest({ type: "remote_mastra" }))).toBeUndefined();
  });

  test("an endpoint is identified canonically, the same way the registry identifies managed ones", () => {
    const supported = resolver();
    // A trailing slash is the same endpoint, on both sides of the comparison.
    expect(supported(agUiRequest({ endpoint: `${ENDPOINT}/` }))).toBeDefined();
    // And the same rule the config block canonicalises with — repeated here as the pin that
    // keeps the two copies agreeing.
    for (const spelling of [
      "https://risk.test/ag-ui",
      "https://risk.test/ag-ui/",
      "https://risk.test/ag-ui///",
    ]) {
      expect(canonicalRemoteEndpoint(spelling)).toBe(
        canonicalAgentEndpoint(spelling),
      );
    }
    // But a different path is a different endpoint, and a query is not erased either.
    expect(
      supported(agUiRequest({ endpoint: "https://risk.test/other" })),
    ).toBeUndefined();
    expect(canonicalRemoteEndpoint("https://risk.test/ag-ui?x=1")).toBe(
      "https://risk.test/ag-ui?x=1",
    );
  });
});

describe("the receipt check: what one receipt proves, and what it does not", () => {
  const verify = (value: unknown, runId = "run-1") =>
    verifyRemoteBudgetReceipt({ runId, caps: CAPS, secret: SECRET }, value);

  test("a signed receipt inside its caps is verified", () => {
    const check = verify(receipt());
    expect(check).toEqual({
      state: "verified",
      status: "ok",
      usage: {
        modelSteps: 1,
        inputTokens: 900,
        outputTokens: 90,
        totalTokens: 990,
      },
    });
  });

  test("an honest budget stop is verified even though the last call overshot", () => {
    // The endpoint stopped the loop — the receipt says so — so input past its cap is the
    // enforced stop, not a breach. A run claiming `ok` may not show the same numbers.
    const check = verify(
      receipt({
        status: "budget_exceeded",
        usage: {
          modelSteps: 3,
          inputTokens: CAPS.inputTokens + 500,
          outputTokens: 60,
          totalTokens: CAPS.inputTokens + 560,
        },
      }),
    );
    expect(check.state).toBe("verified");
  });

  test("a receipt that claims success past its caps is an overrun", () => {
    expect(
      verify(
        receipt({
          usage: {
            modelSteps: 2,
            inputTokens: CAPS.inputTokens + 1,
            outputTokens: 10,
            totalTokens: CAPS.inputTokens + 11,
          },
        }),
      ),
    ).toMatchObject({ state: "overrun", reason: "usage.inputTokens" });
    expect(
      verify(
        receipt({
          usage: {
            modelSteps: 2,
            inputTokens: 10,
            outputTokens: CAPS.outputTokens + 1,
            totalTokens: CAPS.outputTokens + 11,
          },
        }),
      ),
    ).toMatchObject({ state: "overrun", reason: "usage.outputTokens" });
    expect(
      verify(
        receipt({
          usage: {
            modelSteps: 2,
            // Inside each per-kind cap, past the run's total: only the sum binds, and a
            // receipt has to add up to be a receipt at all.
            inputTokens: CAPS.inputTokens,
            outputTokens: 11,
            totalTokens: CAPS.totalTokens + 11,
          },
        }),
      ),
    ).toMatchObject({ state: "overrun", reason: "usage.totalTokens" });
  });

  test("steps are never allowed past the cap, whatever the status claims", () => {
    // Steps are counted before a call, so no honest receipt exceeds them at all — not even
    // one that says the run stopped at its budget.
    expect(
      verify(
        receipt({
          status: "budget_exceeded",
          usage: {
            modelSteps: CAPS.modelSteps + 1,
            inputTokens: 10,
            outputTokens: 10,
            totalTokens: 20,
          },
        }),
      ),
    ).toMatchObject({ state: "overrun", reason: "usage.modelSteps" });
  });

  test("a receipt from outside this contract is refused by name", () => {
    // Signed by a different key:
    expect(verify(receipt({ mac: "f".repeat(64) }))).toMatchObject({
      state: "invalid",
      reason: "signature",
    });
    // For a different run:
    expect(verify(receipt(), "another-run")).toMatchObject({
      state: "invalid",
      reason: "run",
    });
    // Under caps this run was not dialled with:
    expect(
      verify(receipt({ caps: { ...CAPS, totalTokens: CAPS.totalTokens + 1 } })),
    ).toMatchObject({ state: "invalid", reason: "caps.totalTokens" });
    // Arithmetic that does not add up:
    expect(
      verify(
        receipt({
          usage: {
            modelSteps: 1,
            inputTokens: 900,
            outputTokens: 90,
            totalTokens: 991,
          },
        }),
      ),
    ).toMatchObject({ state: "invalid", reason: "usage.totalTokens" });
    // Not a receipt at all:
    expect(verify("nope")).toMatchObject({ state: "invalid", reason: "shape" });
    expect(verify({ kind: "something-else", v: 1 })).toMatchObject({
      state: "invalid",
      reason: "kind",
    });
    expect(verify({ kind: "openbot-budget-receipt", v: 2 })).toMatchObject({
      state: "invalid",
      reason: "version",
    });
  });
});

describe("the credit admission behind the dial", () => {
  function wiring(options: { mode?: "ok" | "insufficient" | "throw" } = {}) {
    const mode = options.mode ?? "ok";
    const reservations: unknown[] = [];
    const marks: { reservationId: string; reason: string }[] = [];
    const logs: { level: string; context: Record<string, unknown> }[] = [];
    const gate = createRemoteRunBudgetGate({
      creditWriter: {
        async reserveCredits(input: {
          externalCustomerId: string;
          idempotencyKey: string;
          maximumCents: number;
          expiresAt: Date;
        }) {
          reservations.push(input);
          if (mode === "throw") throw new Error("ledger unavailable");
          if (mode === "insufficient") {
            return { reserved: false as const, availableCents: 40 };
          }
          return { reserved: true as const, reservationId: "hold-1" };
        },
        async markReservationUnknown(reservationId: string, reason: string) {
          marks.push({ reservationId, reason });
        },
      },
      resolvePayer: () => ({
        externalCustomerId: "customer-1",
        payer: { kind: "personal" as const },
      }),
      maximumCents: 6_200,
      reservationWindowMs: 15 * 60_000,
      idempotencyPrefix: "usage:",
      log: {
        error: (context) => logs.push({ level: "error", context }),
        warn: (context) => logs.push({ level: "warn", context }),
      },
      refusals: {
        gateFailure: () => new Error("credit_gate_unavailable"),
        insufficient: (input) =>
          new Error(
            `credits_exhausted: ${input.payerKind} has ${input.availableCents}`,
          ),
      },
    });
    return { gate, reservations, marks, logs };
  }

  const admission = () => ({
    eventId: "remote-run:risk:dial-run",
    occurredAt: new Date("2026-10-25T08:00:00.000Z"),
    botId: "risk",
    runId: "dial-run",
    threadId: "dial-thread",
    attribution: { userId: "person-1" },
  });

  test("an admitted run holds its worst case in the same ledger every paid path uses", async () => {
    const { gate, reservations, marks } = wiring();
    const hold = await gate(admission());
    expect(reservations).toEqual([
      {
        externalCustomerId: "customer-1",
        // The natural-key discipline the built-in path keeps: a replay of this run asks for
        // the SAME hold, not a second one.
        idempotencyKey: "usage:remote-run:risk:dial-run",
        maximumCents: 6_200,
        expiresAt: new Date("2026-10-25T08:15:00.000Z"),
      },
    ]);
    // Settling marks unknown with the observed outcome; a release is not offered anywhere.
    await hold.finish({ outcome: "succeeded" });
    expect(marks).toEqual([
      { reservationId: "hold-1", reason: "remote_usage_unreported:succeeded" },
    ]);
  });

  test("an empty balance, a short one, and a broken ledger each refuse by their own name", async () => {
    const short = wiring({ mode: "insufficient" });
    await expect(short.gate(admission())).rejects.toThrow(
      "credits_exhausted: personal has 40",
    );
    expect(short.logs.map((entry) => entry.context.type)).toEqual([
      "remote-run-credit-reservation-refused",
    ]);

    const broken = wiring({ mode: "throw" });
    await expect(broken.gate(admission())).rejects.toThrow(
      "credit_gate_unavailable",
    );
    expect(broken.logs.map((entry) => entry.context.type)).toEqual([
      "remote-run-credit-gate-failed",
    ]);
  });

  test("a settlement that cannot be written stays contained and never releases the hold", async () => {
    const { marks, logs } = wiring();
    const failing = createRemoteRunBudgetGate({
      creditWriter: {
        reserveCredits: async () => ({
          reserved: true,
          reservationId: "hold-1",
        }),
        markReservationUnknown: async () => {
          throw new Error("write failed");
        },
      },
      resolvePayer: () => ({
        externalCustomerId: "customer-1",
        payer: { kind: "personal" as const },
      }),
      maximumCents: 6_200,
      reservationWindowMs: 15 * 60_000,
      idempotencyPrefix: "usage:",
      log: {
        error: (context) => logs.push({ level: "error", context }),
        warn: (context) => logs.push({ level: "warn", context }),
      },
      refusals: {
        gateFailure: () => new Error("credit_gate_unavailable"),
        insufficient: () => new Error("credits_exhausted"),
      },
    });
    const held = await failing(admission());
    // The answer was already delivered; a ledger that cannot record the unknown cost is
    // logged, never the run's failure, and the hold is left to expire on its own clock.
    await held.finish({ outcome: "unknown" });
    // Nothing was written, so nothing released: the failed mark is the evidence, and the
    // hold it belongs to is left to its own expiry for reconciliation to find.
    expect(marks).toEqual([]);
    expect(logs.at(-1)?.context.type).toBe("remote-run-credit-settle-failed");
  });
});

describe("the config block: the boundary an operator has to spell out", () => {
  const baseEnvironment = {
    DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
    BETTER_AUTH_URL: "http://localhost:3001",
    GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
    INITIAL_ADMIN_EMAILS: "admin@openbot.test",
    INTELLIGENCE_API_URL: "http://localhost:7100",
    INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
    INTELLIGENCE_API_KEY: "tenant-api-key",
    COPILOTKIT_LICENSE_TOKEN: "license-token",
  };

  test("absent by default: no endpoint is declared contract-capable by inference", () => {
    expect(loadConfig(baseEnvironment).remoteBudgetContract).toBeUndefined();
  });

  test("a declared list is canonicalised, and the step limit defaults to the runtime's loop", () => {
    const config = loadConfig({
      ...baseEnvironment,
      REMOTE_BUDGET_CONTRACT_ENDPOINTS:
        " https://risk.test/ag-ui/ , http://127.0.0.1:4201/ag-ui",
    });
    expect(config.remoteBudgetContract?.endpoints).toEqual(
      new Set(["https://risk.test/ag-ui", "http://127.0.0.1:4201/ag-ui"]),
    );
    expect(config.remoteBudgetContract?.maxModelSteps).toBe(8);
    expect(
      loadConfig({
        ...baseEnvironment,
        REMOTE_BUDGET_CONTRACT_ENDPOINTS: "https://risk.test/ag-ui",
        REMOTE_BUDGET_CONTRACT_MAX_MODEL_STEPS: "25",
      }).remoteBudgetContract?.maxModelSteps,
    ).toBe(25);
  });

  test("a boundary that cannot be understood refuses to start", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        REMOTE_BUDGET_CONTRACT_ENDPOINTS: "https://risk.test/ag-ui,",
      }),
    ).toThrow(/comma-separated list of endpoint URLs/);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        REMOTE_BUDGET_CONTRACT_ENDPOINTS: "not a url",
      }),
    ).toThrow(/must be a valid URL/);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        REMOTE_BUDGET_CONTRACT_ENDPOINTS: "ftp://risk.test/ag-ui",
      }),
    ).toThrow(/must be an HTTP\(S\) URL/);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        REMOTE_BUDGET_CONTRACT_ENDPOINTS: "https://risk.test/ag-ui",
        REMOTE_BUDGET_CONTRACT_MAX_MODEL_STEPS: "zero-is-not-a-number-word",
      }),
    ).toThrow(/must be a whole number/);
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        REMOTE_BUDGET_CONTRACT_ENDPOINTS: "https://risk.test/ag-ui",
        REMOTE_BUDGET_CONTRACT_MAX_MODEL_STEPS: "0",
      }),
    ).toThrow(/between 1 and 1000/);
  });
});
