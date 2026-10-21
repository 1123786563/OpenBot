import { describe, expect, jest, test } from "../../tests/support/e2e-compat";
import {
  checkModelAvailability,
  officialModelMetadataLookup,
  STARTUP_CHECK_BUDGET_MS,
  type StartupCheckResult,
} from "../src/model-availability-check";

const SECRET_KEY = "sk-fixture-not-a-real-key";

type LogCall = { result: StartupCheckResult; json: string };

function recordingLog(): {
  calls: LogCall[];
  log: (result: StartupCheckResult) => void;
} {
  const calls: LogCall[] = [];
  return {
    calls,
    log: (result) => {
      calls.push({ result, json: JSON.stringify(result) });
    },
  };
}

/** A lookup whose promise settles only when the budget's abort arrives. */
function abortingLookup(onAbort?: (signal: AbortSignal) => void): {
  lookup: (signal: AbortSignal) => Promise<{ status: number }>;
  signals: AbortSignal[];
} {
  const signals: AbortSignal[] = [];
  return {
    signals,
    lookup: (signal) => {
      signals.push(signal);
      onAbort?.(signal);
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

/** A lookup that ignores the signal and never settles. */
function hangingLookup(): {
  lookup: (signal: AbortSignal) => Promise<{ status: number }>;
  signals: AbortSignal[];
} {
  const signals: AbortSignal[] = [];
  return {
    signals,
    lookup: (signal) => {
      signals.push(signal);
      return new Promise(() => {});
    },
  };
}

describe("checkModelAvailability", () => {
  test("a deployment with no model credential is skipped as unconfigured, without any probe", async () => {
    const { calls, log } = recordingLog();
    let asked = 0;
    const result = await checkModelAvailability({
      enabled: false,
      model: "gpt-5.6-terra",
      lookup: async () => {
        asked += 1;
        return { status: 200 };
      },
      log,
    });
    expect(result.kind).toBe("skipped");
    expect(result.code).toBe("unconfigured");
    expect(asked).toBe(0);
    expect(calls).toEqual([]);
  });

  test("a compatible endpoint with no lookup is skipped as unsupported", async () => {
    const { calls, log } = recordingLog();
    const result = await checkModelAvailability({
      enabled: true,
      model: "gpt-5.6-terra",
      log,
    });
    expect(result.kind).toBe("skipped");
    expect(result.code).toBe("unsupported");
    expect(calls).toEqual([]);
  });

  test.each([200, 204, 299])(
    "a %s answer from the lookup is available and is not logged",
    async (status) => {
      const { calls, log } = recordingLog();
      const result = await checkModelAvailability({
        enabled: true,
        model: "gpt-5.6-terra",
        lookup: async () => ({ status }),
        log,
      });
      expect(result).toEqual({ kind: "available" });
      expect(calls).toEqual([]);
    },
  );

  test.each([401, 403])(
    "a %s from the provider is a credential rejection, reported once",
    async (status) => {
      const { calls, log } = recordingLog();
      const result = await checkModelAvailability({
        enabled: true,
        model: "gpt-5.6-terra",
        lookup: async () => ({ status }),
        log,
      });
      expect(result.kind).toBe("warning");
      expect(result.code).toBe("credential-rejected");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.result).toBe(result);
    },
  );

  test("a 404 from the official model API is model-unavailable, reported once", async () => {
    const { calls, log } = recordingLog();
    const result = await checkModelAvailability({
      enabled: true,
      model: "gpt-5.6-terra",
      lookup: async () => ({ status: 404 }),
      log,
    });
    expect(result.kind).toBe("warning");
    expect(result.code).toBe("model-unavailable");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.result).toBe(result);
  });

  test.each([302, 500, 503])(
    "a %s answer that says nothing actionable is unreadable, reported once",
    async (status) => {
      const { calls, log } = recordingLog();
      const result = await checkModelAvailability({
        enabled: true,
        model: "gpt-5.6-terra",
        lookup: async () => ({ status }),
        log,
      });
      expect(result.kind).toBe("warning");
      expect(result.code).toBe("unreadable");
      expect(calls).toHaveLength(1);
    },
  );

  test("a lookup that rejects is unreadable, and the check still resolves", async () => {
    const { calls, log } = recordingLog();
    const result = await checkModelAvailability({
      enabled: true,
      model: "gpt-5.6-terra",
      lookup: async () => {
        throw new Error("network unreachable");
      },
      log,
    });
    expect(result.kind).toBe("warning");
    expect(result.code).toBe("unreadable");
    expect(calls).toHaveLength(1);
  });

  test("a lookup that throws synchronously is unreadable, and the check still resolves", async () => {
    const { calls, log } = recordingLog();
    const result = await checkModelAvailability({
      enabled: true,
      model: "gpt-5.6-terra",
      lookup: () => {
        throw new Error("sync");
      },
      log,
    });
    expect(result.kind).toBe("warning");
    expect(result.code).toBe("unreadable");
    expect(calls).toHaveLength(1);
  });

  test("a lookup still inside the budget is classified, not timed out", async () => {
    jest.useFakeTimers();
    try {
      const { calls, log } = recordingLog();
      let release: ((value: { status: number }) => void) | undefined;
      const pending = checkModelAvailability({
        enabled: true,
        model: "gpt-5.6-terra",
        lookup: () =>
          new Promise<{ status: number }>((resolve) => {
            release = resolve;
          }),
        log,
      });
      await Promise.resolve();
      jest.advanceTimersByTime(STARTUP_CHECK_BUDGET_MS - 1);
      release?.({ status: 404 });
      const result = await pending;
      expect(result.kind).toBe("warning");
      expect(result.code).toBe("model-unavailable");
      expect(calls).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the budget aborts a hanging request and answers timeout, reported once", async () => {
    jest.useFakeTimers();
    try {
      const { calls, log } = recordingLog();
      const { lookup, signals } = abortingLookup();
      const pending = checkModelAvailability({
        enabled: true,
        model: "gpt-5.6-terra",
        lookup,
        log,
      });
      await Promise.resolve();
      jest.advanceTimersByTime(STARTUP_CHECK_BUDGET_MS);
      const result = await pending;
      expect(result.kind).toBe("warning");
      expect(result.code).toBe("timeout");
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.result).toBe(result);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a lookup that ignores the abort still leaves the check answering timeout", async () => {
    jest.useFakeTimers();
    try {
      const { calls, log } = recordingLog();
      const { lookup } = hangingLookup();
      const pending = checkModelAvailability({
        enabled: true,
        model: "gpt-5.6-terra",
        lookup,
        log,
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

  test("no logged line carries the credential, an auth header name, or a URL", async () => {
    const { calls, log } = recordingLog();
    await checkModelAvailability({
      enabled: true,
      model: "gpt-5.6-terra",
      lookup: async () => ({ status: 401 }),
      log,
    });
    await checkModelAvailability({
      enabled: true,
      model: "gpt-5.6-terra",
      lookup: async () => {
        throw new Error(`fetch failed for ${SECRET_KEY}`);
      },
      log,
    });
    for (const call of calls) {
      expect(call.json.includes(SECRET_KEY)).toBe(false);
      expect(call.json.toLowerCase().includes("authorization")).toBe(false);
      expect(call.json.toLowerCase().includes("x-api-key")).toBe(false);
      expect(call.json.includes("https://")).toBe(false);
    }
  });
});

describe("officialModelMetadataLookup", () => {
  test("dials the provider's own model endpoint, with the key only in the auth header", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      seen.push({ url: String(url), init: init ?? {} });
      return { status: 200 };
    }) as unknown as typeof fetch;
    const lookup = officialModelMetadataLookup({
      provider: "openai",
      model: "gpt-5.6-terra",
      key: SECRET_KEY,
      fetch: fakeFetch,
    });
    const controller = new AbortController();
    const answer = await lookup(controller.signal);
    expect(answer).toEqual({ status: 200 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.openai.com/v1/models/gpt-5.6-terra");
    expect(seen[0]?.init.signal).toBe(controller.signal);
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SECRET_KEY}`);
  });

  test("the anthropic endpoint rides its own header and version", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      seen.push({ url: String(url), init: init ?? {} });
      return { status: 404 };
    }) as unknown as typeof fetch;
    const lookup = officialModelMetadataLookup({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      key: SECRET_KEY,
      fetch: fakeFetch,
    });
    const answer = await lookup(new AbortController().signal);
    expect(answer).toEqual({ status: 404 });
    expect(seen[0]?.url).toBe(
      "https://api.anthropic.com/v1/models/claude-sonnet-4-5",
    );
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(SECRET_KEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.authorization).toBeUndefined();
  });

  test("a model name with reserved characters is URL-encoded", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return { status: 200 };
    }) as unknown as typeof fetch;
    const lookup = officialModelMetadataLookup({
      provider: "openai",
      model: "org/model name",
      key: SECRET_KEY,
      fetch: fakeFetch,
    });
    await lookup(new AbortController().signal);
    expect(seen[0]).toBe(
      `https://api.openai.com/v1/models/${encodeURIComponent("org/model name")}`,
    );
  });

  test("the provider's response body is never read, so its bytes never reach the check", async () => {
    const fakeFetch = (async () => ({
      status: 403,
      json: () => {
        throw new Error("body must never be read");
      },
      text: () => {
        throw new Error("body must never be read");
      },
    })) as unknown as typeof fetch;
    const lookup = officialModelMetadataLookup({
      provider: "openai",
      model: "gpt-5.6-terra",
      key: SECRET_KEY,
      fetch: fakeFetch,
    });
    const answer = await lookup(new AbortController().signal);
    expect(answer).toEqual({ status: 403 });
  });
});
