import { describe, expect, jest, test } from "../../tests/support/e2e-compat";
import {
  reportIntelligenceEntitlement,
  type StartupCheckResult,
  scheduleStartupDiagnostics,
} from "../src/intelligence-entitlement-check";
import { STARTUP_CHECK_BUDGET_MS } from "../src/model-availability-check";

const SECRET_TOKEN = "fixture-not-a-real-service-token";

type LogCall = {
  source: "model" | "entitlement";
  result: StartupCheckResult;
  json: string;
};

function recordingLog(): {
  calls: LogCall[];
  log: (source: "model" | "entitlement", result: StartupCheckResult) => void;
} {
  const calls: LogCall[] = [];
  return {
    calls,
    log: (source, result) => {
      calls.push({ source, result, json: JSON.stringify(result) });
    },
  };
}

/** A read whose promise settles only when the budget's abort arrives. */
function abortingRead(): {
  read: (signal: AbortSignal) => Promise<{ active: boolean }>;
  signals: AbortSignal[];
} {
  const signals: AbortSignal[] = [];
  return {
    signals,
    read: (signal) => {
      signals.push(signal);
      return new Promise((_, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    },
  };
}

describe("reportIntelligenceEntitlement", () => {
  test("a deployment without the optional learning dependency is skipped unconfigured, and is never probed", async () => {
    let asked = 0;
    const calls: StartupCheckResult[] = [];
    const result = await reportIntelligenceEntitlement({
      enabled: false,
      read: async () => {
        asked += 1;
        return { active: true };
      },
      log: (result) => calls.push(result),
    });
    expect(result.kind).toBe("skipped");
    expect(result.code).toBe("unconfigured");
    expect(asked).toBe(0);
    expect(calls).toEqual([]);
  });

  test("no read channel is skipped as unsupported", async () => {
    const calls: StartupCheckResult[] = [];
    const result = await reportIntelligenceEntitlement({
      enabled: true,
      log: (result) => calls.push(result),
    });
    expect(result.kind).toBe("skipped");
    expect(result.code).toBe("unsupported");
    expect(calls).toEqual([]);
  });

  test("an active entitlement is available and is not logged", async () => {
    const calls: StartupCheckResult[] = [];
    const result = await reportIntelligenceEntitlement({
      enabled: true,
      read: async () => ({ active: true }),
      log: (result) => calls.push(result),
    });
    expect(result).toEqual({ kind: "available" });
    expect(calls).toEqual([]);
  });

  test("an inactive entitlement is a warning, reported once", async () => {
    const calls: StartupCheckResult[] = [];
    const result = await reportIntelligenceEntitlement({
      enabled: true,
      read: async () => ({ active: false }),
      log: (result) => calls.push(result),
    });
    expect(result.kind).toBe("warning");
    expect(result.code).toBe("entitlement-unavailable");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(result);
  });

  test("a read that rejects is entitlement-unavailable, and the check still resolves", async () => {
    const calls: StartupCheckResult[] = [];
    const result = await reportIntelligenceEntitlement({
      enabled: true,
      read: async () => {
        throw new Error("connection refused");
      },
      log: (result) => calls.push(result),
    });
    expect(result.kind).toBe("warning");
    expect(result.code).toBe("entitlement-unavailable");
    expect(calls).toHaveLength(1);
  });

  test("an answer without a boolean is unreadable, reported once", async () => {
    const calls: StartupCheckResult[] = [];
    const result = await reportIntelligenceEntitlement({
      enabled: true,
      read: async () => ({ active: "yes" as unknown as boolean }),
      log: (result) => calls.push(result),
    });
    expect(result.kind).toBe("warning");
    expect(result.code).toBe("unreadable");
    expect(calls).toHaveLength(1);
  });

  test("the budget aborts a hanging read and answers timeout, reported once", async () => {
    jest.useFakeTimers();
    try {
      const calls: StartupCheckResult[] = [];
      const { read, signals } = abortingRead();
      const pending = reportIntelligenceEntitlement({
        enabled: true,
        read,
        log: (result) => calls.push(result),
      });
      await Promise.resolve();
      jest.advanceTimersByTime(STARTUP_CHECK_BUDGET_MS);
      const result = await pending;
      expect(result.kind).toBe("warning");
      expect(result.code).toBe("timeout");
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toBe(result);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a read that ignores the abort still leaves the check answering timeout", async () => {
    jest.useFakeTimers();
    try {
      const calls: StartupCheckResult[] = [];
      const pending = reportIntelligenceEntitlement({
        enabled: true,
        read: () => new Promise<{ active: boolean }>(() => {}),
        log: (result) => calls.push(result),
      });
      await Promise.resolve();
      jest.advanceTimersByTime(STARTUP_CHECK_BUDGET_MS);
      const result = await pending;
      expect(result.kind).toBe("warning");
      expect(result.code).toBe("timeout");
      expect(calls).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("no logged line carries a credential, an auth header name, or a URL", async () => {
    const calls: string[] = [];
    const log = (result: StartupCheckResult) =>
      calls.push(JSON.stringify(result));
    await reportIntelligenceEntitlement({
      enabled: true,
      read: async () => ({ active: false }),
      log,
    });
    await reportIntelligenceEntitlement({
      enabled: true,
      read: async () => {
        throw new Error(`401 at ${SECRET_TOKEN}`);
      },
      log,
    });
    for (const json of calls) {
      expect(json.includes(SECRET_TOKEN)).toBe(false);
      expect(json.toLowerCase().includes("authorization")).toBe(false);
      expect(json.toLowerCase().includes("api-key")).toBe(false);
      expect(json.includes("https://")).toBe(false);
    }
  });
});

describe("scheduleStartupDiagnostics", () => {
  test("returns before either check finishes, and the checks still land their classification", async () => {
    const { calls, log } = recordingLog();
    let releaseModel: ((value: { status: number }) => void) | undefined;
    let releaseRead: ((value: { active: boolean }) => void) | undefined;
    const returned = scheduleStartupDiagnostics({
      model: () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                enabled: true,
                name: "gpt-5.6-terra",
                lookup: () =>
                  new Promise<{ status: number }>((resolve) => {
                    releaseModel = resolve;
                  }),
              }),
            0,
          );
        }),
      entitlement: {
        enabled: true,
        read: () =>
          new Promise((resolve) => {
            releaseRead = resolve;
          }),
      },
      log,
    });
    // The scheduler gave the caller its answer before either diagnostic finished:
    // the statements after it ran while both probes were still unresolved.
    expect(returned).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(releaseModel).toBeDefined();
    expect(releaseRead).toBeDefined();
    expect(calls).toEqual([]);
    releaseModel?.({ status: 404 });
    releaseRead?.({ active: false });
    await new Promise((resolve) => setTimeout(resolve, 1));
    await Promise.resolve();
    const model = calls.filter((call) => call.source === "model");
    const entitlement = calls.filter((call) => call.source === "entitlement");
    expect(model).toHaveLength(1);
    expect(model[0]?.result.code).toBe("model-unavailable");
    expect(entitlement).toHaveLength(1);
    expect(entitlement[0]?.result.code).toBe("entitlement-unavailable");
  });

  test("a failing model factory does not stop the entitlement check, and each side reports once", async () => {
    const { calls, log } = recordingLog();
    let asked = 0;
    scheduleStartupDiagnostics({
      model: async () => {
        throw new Error("credential store unavailable");
      },
      entitlement: {
        enabled: true,
        read: async () => {
          asked += 1;
          return { active: false };
        },
      },
      log,
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    await Promise.resolve();
    const model = calls.filter((call) => call.source === "model");
    const entitlement = calls.filter((call) => call.source === "entitlement");
    expect(model).toHaveLength(1);
    expect(model[0]?.result.kind).toBe("warning");
    expect(entitlement).toHaveLength(1);
    expect(entitlement[0]?.result.code).toBe("entitlement-unavailable");
    expect(asked).toBe(1);
  });

  test("each check probes at most once per startup", async () => {
    const { calls, log } = recordingLog();
    let lookups = 0;
    let reads = 0;
    scheduleStartupDiagnostics({
      model: async () => ({
        enabled: true,
        name: "gpt-5.6-terra",
        lookup: async () => {
          lookups += 1;
          return { status: 200 };
        },
      }),
      entitlement: {
        enabled: true,
        read: async () => {
          reads += 1;
          return { active: true };
        },
      },
      log,
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    await Promise.resolve();
    expect(lookups).toBe(1);
    expect(reads).toBe(1);
    expect(calls).toEqual([]);
  });

  test("a model factory that throws synchronously does not throw out of the scheduler", async () => {
    const { calls, log } = recordingLog();
    let reads = 0;
    expect(() =>
      scheduleStartupDiagnostics({
        model: () => {
          throw new Error("credential store exploded synchronously");
        },
        entitlement: {
          enabled: true,
          read: async () => {
            reads += 1;
            return { active: true };
          },
        },
        log,
      }),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 1));
    await Promise.resolve();
    const model = calls.filter((call) => call.source === "model");
    expect(model).toHaveLength(1);
    expect(model[0]?.result.kind).toBe("warning");
    expect(reads).toBe(1);
    expect(calls.filter((call) => call.source === "entitlement")).toEqual([]);
  });

  test("a throwing log sink never escapes the scheduler", async () => {
    let lookups = 0;
    scheduleStartupDiagnostics({
      model: async () => ({
        enabled: true,
        name: "gpt-5.6-terra",
        lookup: async () => {
          lookups += 1;
          return { status: 404 };
        },
      }),
      entitlement: { enabled: false },
      log: () => {
        throw new Error("log sink is broken");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    await Promise.resolve();
    expect(lookups).toBe(1);
  });
});
