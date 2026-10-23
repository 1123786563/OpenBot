import type { AbstractAgent } from "@ag-ui/client";
import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { createTurnRunner } from "@openbot/toolkit/run-turn";
import type { LearningSettings } from "../../shared/learning";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { loadConfig } from "../src/config";
import {
  agentRuntimeConfigRefusal,
  IntelligenceUnconfiguredError,
  lazyIntelligenceClient,
} from "../src/intelligence-optional";
import { createLearningRuntime } from "../src/learning/runtime";
import type { LearningSettingsStore } from "../src/learning/settings";

/*
 * ME15 (#487): a deployment that has not configured Intelligence must boot,
 * and it must not construct a single Intelligence client at import, boot or
 * run. These cases pin the LAZY seams that make that true:
 *
 *   - `lazyIntelligenceClient` constructs on first use and refuses BY NAME
 *     when the settings are absent — never a silent no-permission fallback.
 *   - the learning runtime takes the client as a thunk, so a disabled
 *     learning setting never touches it;
 *   - the legacy headless turn takes its client and runner as thunks, so an
 *     assembly that never runs a turn never constructs them;
 *   - `loadConfig` boots with the whole Intelligence block absent (mode
 *     "none"), while a PARTIAL block is still a refusal (typo protection);
 *   - the boot gate refuses, by name, a deployment with neither engine.
 */

const SETTINGS = {
  apiUrl: "http://intelligence.example",
  gatewayWsUrl: "ws://intelligence.example/gateway",
  apiKey: "key",
};

function countingBuild() {
  const state = { constructions: 0 };
  const build = (settings: IntelligenceSettingsParameters) => {
    state.constructions++;
    return { settings } as unknown as CopilotKitIntelligence;
  };
  return { state, build };
}
type IntelligenceSettingsParameters = typeof SETTINGS;

describe("lazyIntelligenceClient", () => {
  test("constructs nothing until first use, then exactly once", () => {
    const { state, build } = countingBuild();
    const client = lazyIntelligenceClient({
      settings: SETTINGS,
      feature: "unit-test client",
      build: build as (settings: never) => CopilotKitIntelligence,
    });
    expect(state.constructions).toBe(0);
    void client();
    void client();
    void client();
    expect(state.constructions).toBe(1);
  });

  test("refuses by name when Intelligence is not configured, and keeps refusing", () => {
    const { state, build } = countingBuild();
    const client = lazyIntelligenceClient({
      settings: undefined,
      feature: "the legacy headless turn",
      build: build as (settings: never) => CopilotKitIntelligence,
    });
    expect(state.constructions).toBe(0);
    let message = "";
    try {
      client();
    } catch (error) {
      message = error instanceof Error ? error.message : "";
      expect(error).toBeInstanceOf(IntelligenceUnconfiguredError);
      expect((error as { name?: string }).name).toBe(
        "IntelligenceUnconfiguredError",
      );
    }
    expect(message).toContain("INTELLIGENCE_UNCONFIGURED");
    expect(message).toContain("the legacy headless turn");
    expect(message).toContain("INTELLIGENCE_API_URL");
    expect(message).toContain("no in-memory fallback");
    expect(state.constructions).toBe(0);
    expect(() => client()).toThrow(IntelligenceUnconfiguredError);
    expect(state.constructions).toBe(0);
  });
});

describe("createLearningRuntime with a client thunk", () => {
  function fixtureStore(initial: LearningSettings): {
    store: LearningSettingsStore;
    set: (next: LearningSettings) => void;
  } {
    let settings = initial;
    return {
      store: {
        read: async () => settings,
        write: async (next) => {
          settings = next;
          return settings;
        },
        saved: async () => true,
        adoptDefault: async () => false,
        bindThread: async () => null,
      },
      set: (next) => {
        settings = next;
      },
    };
  }

  test("a disabled learning setting never resolves the client thunk", async () => {
    const { store } = fixtureStore({
      enabled: false,
      defaultTarget: { containerId: "openbot" },
      agents: {},
    });
    let resolutions = 0;
    const learning = createLearningRuntime({
      store,
      client: () => {
        resolutions++;
        throw new Error("the client must not be constructed while disabled");
      },
    });
    expect(await learning.acquire("bot")).toBeUndefined();
    expect(
      await learning.containerForThread({
        threadId: "t",
        agentId: "bot",
        userId: "u",
      }),
    ).toBeUndefined();
    expect(await learning.status("bot")).toEqual({
      configured: false,
      initialized: false,
      stale: false,
    });
    expect(resolutions).toBe(0);
  });

  test("an enabled target resolves the thunk when the snapshot is acquired", async () => {
    const { store } = fixtureStore({
      enabled: true,
      defaultTarget: { containerId: "openbot" },
      agents: {},
    });
    let resolutions = 0;
    const learning = createLearningRuntime({
      store,
      client: () => {
        resolutions++;
        throw new Error("NO_REAL_INTELLIGENCE_IN_THIS_TEST");
      },
    });
    await expect(learning.acquire("bot")).rejects.toThrow(
      "NO_REAL_INTELLIGENCE_IN_THIS_TEST",
    );
    expect(resolutions).toBe(1);
  });
});

describe("createTurnRunner with lazy intelligence and runner", () => {
  const buildAgentFor = async (): Promise<AbstractAgent> => {
    throw new Error("BUILD_AGENT_SENTINEL");
  };

  test("assembling the runner constructs neither client nor runner", async () => {
    let intelligenceBuilt = 0;
    let runnerBuilt = 0;
    const turn = createTurnRunner({
      intelligence: () => {
        intelligenceBuilt++;
        throw new IntelligenceUnconfiguredError("unit-test turn");
      },
      runner: () => {
        runnerBuilt++;
        throw new Error("runner must not be constructed at assembly");
      },
      admission: async () => ({ ok: true as const }),
      buildAgentFor,
    });
    expect(intelligenceBuilt).toBe(0);
    expect(runnerBuilt).toBe(0);
    // A turn that fails on its first client call names the refusal — never a
    // silent in-memory stand-in.
    await expect(
      turn({
        ownerUserId: "u1",
        routineId: "r1",
        agentId: "b1",
        threadId: "t1",
        instruction: "hi",
      }),
    ).rejects.toThrow(IntelligenceUnconfiguredError);
    expect(intelligenceBuilt).toBe(1);
    expect(runnerBuilt).toBe(0);
  });

  test("plain values keep working beside the thunk form", async () => {
    const turn = createTurnRunner({
      intelligence: {
        getOrCreateThread: async () => {
          throw new Error("GET_OR_CREATE_THREAD_SENTINEL");
        },
        getThreadMessages: async () => ({ messages: [] }),
        ɵacquireThreadLock: async () => ({}),
        ɵrenewThreadLock: async () => ({}),
        ɵcleanupThreadLock: async () => undefined,
      },
      runner: { run: async () => ({}), stop: async () => undefined },
      admission: async () => ({ ok: true as const }),
      buildAgentFor,
    });
    await expect(
      turn({
        ownerUserId: "u1",
        routineId: "r1",
        agentId: "b1",
        threadId: "t1",
        instruction: "hi",
      }),
    ).rejects.toThrow("GET_OR_CREATE_THREAD_SENTINEL");
  });
});

describe("loadConfig without Intelligence", () => {
  const base: Record<string, string | undefined> = {
    DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    // The minimal boot needs an identity story; single-user is the smallest.
    OPENBOT_SINGLE_USER: "true",
  };

  test("boots with the whole Intelligence block absent (mode none)", () => {
    const config = loadConfig({ ...base });
    expect(config.runtime.mode).toBe("none");
    expect(config.runtime.intelligence).toBeUndefined();
    expect(config.runtime.durableHistory).toBe(false);
  });

  test.each([
    "INTELLIGENCE_API_URL",
    "INTELLIGENCE_GATEWAY_WS_URL",
    "INTELLIGENCE_API_KEY",
  ])("still refuses a partial Intelligence block (%s absent)", (name) => {
    const environment = {
      ...base,
      INTELLIGENCE_API_URL: "http://localhost:7100",
      INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
      INTELLIGENCE_API_KEY: "tenant-api-key",
    };
    delete environment[name];
    expect(() => loadConfig(environment)).toThrow(
      `CopilotKit Intelligence is required and is not configured. Missing: ${name}`,
    );
  });

  test("the boot gate refuses a deployment with neither engine, by name", () => {
    const refusal = agentRuntimeConfigRefusal({
      intelligenceConfigured: false,
      enterpriseDirectoryUrl: undefined,
      enterpriseDataUrl: undefined,
      tenantStorageRuntimeUrl: undefined,
    });
    expect(refusal).toContain("AGENT_RUNTIME_UNCONFIGURED");
    expect(refusal).toContain("INTELLIGENCE_API_URL");
    expect(refusal).toContain("ENTERPRISE_DIRECTORY_DATABASE_URL");
    expect(refusal).toContain("ENTERPRISE_DATA_DATABASE_URL");
    expect(refusal).toContain("OPENBOT_TENANT_STORAGE_RUNTIME_DATABASE_URL");
    expect(refusal).toContain("in-memory runner");
  });

  test("the boot gate passes when either engine's configuration exists", () => {
    expect(
      agentRuntimeConfigRefusal({
        intelligenceConfigured: true,
      }),
    ).toBeUndefined();
    expect(
      agentRuntimeConfigRefusal({
        intelligenceConfigured: false,
        enterpriseDirectoryUrl: "postgres://d",
        enterpriseDataUrl: "postgres://d",
        tenantStorageRuntimeUrl: "postgres://d",
      }),
    ).toBeUndefined();
    // A partial enterprise wiring is still a refusal: one verified directory
    // without its data database is not a path that can serve a turn.
    expect(
      agentRuntimeConfigRefusal({
        intelligenceConfigured: false,
        enterpriseDirectoryUrl: "postgres://d",
      }),
    ).toContain("AGENT_RUNTIME_UNCONFIGURED");
  });
});
