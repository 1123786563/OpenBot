import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import {
  CopilotKitIntelligence,
  LearnedSkillsError,
} from "@copilotkit/runtime/v2";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { PROVENANCE_GUIDANCE } from "../../shared/bot-prompt";
import type { LearningSettings, LearningTarget } from "../../shared/learning";
import { describe, expect, it } from "../../tests/support/bun-test-compat";
import {
  builtInAgentConfiguration,
  setBuiltinExecutionEngine,
  setMastraConversationRuntime,
} from "../src/copilot";
import type { GovernedModelRequest } from "../src/enterprise/runs/governed-execution";
import {
  createLearningRuntime,
  LEARNED_SKILL_TOOL_NAMES,
  type LearnedSkillInvocation,
} from "../src/learning/runtime";
import type { LearningSettingsStore } from "../src/learning/settings";
import {
  argsDigestFor,
  createMastraLearnedTools,
  type MastraToolOperation,
} from "../src/mastra/tools";
import { skillSnapshot } from "./fixtures/learned-skills";
import { carrier, sse } from "./support/me04-harness";

/*
 * ME08 (#480): the optional Automatic Learning skills keep their published
 * snapshot contract on the Mastra execution path — the same validated
 * snapshot, catalog position, reserved tool names and failure semantics the
 * legacy engine serves, mounted through the ME04 controlled wrapper.
 *
 * The governed carrier here is the REAL one (me04-harness: capability
 * minting, settlement, the governed model collaborator); only the upstream
 * provider dial is stubbed, and the learning runtime is the REAL
 * `createLearningRuntime` over the pinned SDK with a synthetic Intelligence
 * client — so every load/read below executes the SDK's archive-verified
 * snapshot, never a stand-in execute.
 */

const CATALOG_MARKER = "copilotkit_learned_skills";
const SKILL_NAME = "public-answer";
const LOADED_MARKER = "Follow published guidance r1";
const FILE_MARKER = "Public supporting fact r1.";
const COMPUTER_GUIDANCE =
  "The deployment has a computer; use the browser for live pages.";

/** A learnings-settings store over one mutable settings record (no database). */
function settingsStore(
  initial?: Partial<LearningSettings>,
): LearningSettingsStore {
  let settings: LearningSettings = {
    enabled: initial?.enabled ?? true,
    defaultTarget: initial?.defaultTarget ?? { containerId: "openbot" },
    agents: initial?.agents ?? {},
  };
  return {
    read: async () => settings,
    write: async (next) => {
      settings = next;
      return settings;
    },
    saved: async () => true,
    adoptDefault: async () => false,
    bindThread: async () => null,
  };
}

interface LearningFixture {
  runtime: ReturnType<typeof createLearningRuntime>;
  fetches(): number;
  requestedRevisions(): (string | undefined)[];
  requestedContainers(): string[];
  /** Replaces what the synthetic Intelligence answers with, per call. */
  answerWith(
    snapshot:
      | ReturnType<typeof skillSnapshot>
      | Promise<ReturnType<typeof skillSnapshot>>,
  ): void;
  failWith(error: LearnedSkillsError): void;
}

function learning(
  options: {
    enabled?: boolean;
    target?: LearningTarget | null;
    freshnessWindowMs?: number;
    agents?: LearningSettings["agents"];
  } = {},
): LearningFixture {
  const store = settingsStore({
    enabled: options.enabled ?? true,
    ...(options.target === undefined ? {} : { defaultTarget: options.target }),
    ...(options.agents ? { agents: options.agents } : {}),
  });
  const client = new CopilotKitIntelligence({ apiKey: "synthetic-never-sent" });
  let fetches = 0;
  const revisions: (string | undefined)[] = [];
  const containers: string[] = [];
  let next:
    | ReturnType<typeof skillSnapshot>
    | Promise<ReturnType<typeof skillSnapshot>> = skillSnapshot("r1");
  client.getLearnedSkillsSnapshot = async (request) => {
    fetches += 1;
    revisions.push(request.revision);
    containers.push(request.containerId);
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    runtime: createLearningRuntime({
      store,
      client,
      ...(options.freshnessWindowMs === undefined
        ? {}
        : { freshnessWindowMs: options.freshnessWindowMs }),
    }),
    fetches: () => fetches,
    requestedRevisions: () => revisions,
    requestedContainers: () => containers,
    answerWith: (snapshot) => {
      next = snapshot;
    },
    failWith: (error) => {
      next = error;
    },
  };
}

/** One scripted upstream step: the model calls one learned tool. */
function toolCallStep(
  id: string,
  name: string,
  argsJson: string,
): ReturnType<typeof sse> {
  return sse([
    { toolCall: { id, name, args: "" } },
    { toolCall: { args: argsJson } },
    { finish: "tool_calls" },
    { usage: { prompt_tokens: 60, completion_tokens: 0, total_tokens: 60 } },
  ]);
}

/** One scripted upstream step: the model answers in text. */
function answerStep(text: string): ReturnType<typeof sse> {
  return sse([
    { content: text },
    { finish: "stop" },
    { usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
  ]);
}

interface DialRecord {
  body: Record<string, unknown>;
  systemText: string;
  tools: unknown[];
}

/** The engine selector + a passthrough conversation runtime, as ME06's suite uses. */
function engineOn(options: { persisted?: unknown[][] } = {}) {
  setBuiltinExecutionEngine(() => "mastra");
  setMastraConversationRuntime({
    loadExecutionInput: async (_scope: unknown, input: RunAgentInput) => input,
    persistExecutionMessages: async (...args: unknown[]) => {
      options.persisted?.push(args);
    },
  } as never);
}

function engineOff() {
  setBuiltinExecutionEngine(undefined);
  setMastraConversationRuntime(undefined);
}

async function driveFactory(options: {
  governedModel: GovernedModelRequest;
  learnedSkills?: LearnedSkillInvocation;
  tools?: GrantedTool[];
  computerGuidance?: string;
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
    options.computerGuidance,
    [],
    null,
    undefined,
    options.learnedSkills,
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
  expect(config.type).toBe("custom");
  const events: BaseEvent[] = [];
  for await (const event of config.factory({
    input: {
      threadId: "thread-1",
      runId: "client-run-1",
      messages: [
        { id: "msg-1", role: "user" as const, content: "use the guidance" },
      ],
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

/** A governed carrier whose upstream plays a scripted learned-skill run. */
async function learnedRunCarrier(
  script: (call: number) => ReturnType<typeof sse>,
  dials: DialRecord[],
) {
  return carrier({
    ceiling: 4096,
    onDial: (body) => {
      const messages = (body.messages ?? []) as {
        role: string;
        content: unknown;
      }[];
      const system = messages.find((message) => message.role === "system");
      dials.push({
        body,
        systemText: typeof system?.content === "string" ? system.content : "",
        tools: (body.tools ?? []) as unknown[],
      });
    },
    fetch: (call) => script(call),
  });
}

/** The model-facing tool names on one recorded upstream dial (either wire shape). */
function dialToolNames(dial: DialRecord): string[] {
  return dial.tools.map((tool) => {
    const entry = tool as {
      name?: unknown;
      function?: { name?: unknown };
    };
    const name = entry.function?.name ?? entry.name;
    return typeof name === "string" ? name : "";
  });
}

describe("ME08 learned skills on the Mastra execution path", () => {
  it("catalog_reaches_the_model_in_the_legacy_position", async () => {
    const dials: DialRecord[] = [];
    const f = learning();
    const harness = await learnedRunCarrier(
      (call) => (call === 1 ? answerStep("done") : answerStep("unexpected")),
      dials,
    );
    engineOn();
    try {
      const invocation = await f.runtime.acquire("bot-a");
      expect(invocation).toBeDefined();
      const events = await driveFactory({
        governedModel: harness.governedModel,
        ...(invocation ? { learnedSkills: invocation } : {}),
        computerGuidance: COMPUTER_GUIDANCE,
      });
      const types = events.map((event) => event.type);
      expect(types.at(-1)).toBe("RUN_FINISHED");
      expect(dials.length).toBeGreaterThanOrEqual(1);
      // The model sees the REAL SDK catalog, composed into the trusted
      // system prompt — never into a client-visible message.
      expect(dials[0]!.systemText).toContain(CATALOG_MARKER);
      expect(dials[0]!.systemText).toContain(SKILL_NAME);
      // The LEGACY position: provenance, then the computer guidance, then
      // the learned catalog last (the legacy built-in prompt's order).
      expect(dials[0]!.systemText.indexOf(PROVENANCE_GUIDANCE)).toBeLessThan(
        dials[0]!.systemText.indexOf(COMPUTER_GUIDANCE),
      );
      expect(dials[0]!.systemText.indexOf(COMPUTER_GUIDANCE)).toBeLessThan(
        dials[0]!.systemText.indexOf(CATALOG_MARKER),
      );
      // The two RESERVED tool names, unchanged, are what the model is offered.
      const names = dialToolNames(dials[0]!);
      expect(names).toContain("copilotkit_load_skill");
      expect(names).toContain("copilotkit_read_skill_file");
    } finally {
      engineOff();
    }
  });

  it("load_and_read_execute_the_real_sdk_snapshot_end_to_end", async () => {
    const dials: DialRecord[] = [];
    const persisted: unknown[][] = [];
    const f = learning();
    const harness = await learnedRunCarrier(
      (call) =>
        call === 1
          ? toolCallStep(
              "call_ls_1",
              "copilotkit_load_skill",
              JSON.stringify({ skill_name: SKILL_NAME }),
            )
          : call === 2
            ? toolCallStep(
                "call_rf_1",
                "copilotkit_read_skill_file",
                JSON.stringify({
                  skill_name: SKILL_NAME,
                  path: "reference.txt",
                }),
              )
            : answerStep("answered from the published guidance"),
      dials,
    );
    engineOn({ persisted });
    try {
      const invocation = await f.runtime.acquire("bot-a");
      expect(invocation).toBeDefined();
      const events = await driveFactory({
        governedModel: harness.governedModel,
        ...(invocation ? { learnedSkills: invocation } : {}),
      });
      const types = events.map((event) => event.type);
      expect(types.at(-1)).toBe("RUN_FINISHED");
      // The load result the NEXT model step saw is the SDK's real SKILL body.
      expect(JSON.stringify(dials[1]!.body)).toContain(LOADED_MARKER);
      // The file read result is the SDK's real supporting file.
      expect(JSON.stringify(dials[2]!.body)).toContain(FILE_MARKER);
      // Both results reached the stream exactly once, keyed by their calls.
      const results = events.filter(
        (event) => event.type === "TOOL_CALL_RESULT",
      );
      expect(results).toHaveLength(2);
      // ONE validated snapshot served the whole outer run: both calls read
      // the same acquired snapshot, so Intelligence was asked exactly once.
      expect(f.fetches()).toBe(1);
      // The catalog never reaches the globally visible context: no
      // text-message event and no persisted message carries it.
      const visible = JSON.stringify(
        events.filter((event) => String(event.type).startsWith("TEXT_MESSAGE")),
      );
      expect(visible).not.toContain(CATALOG_MARKER);
      expect(JSON.stringify(persisted)).not.toContain(CATALOG_MARKER);
    } finally {
      engineOff();
    }
  });

  it("confirmed_learning_service_failure_is_a_real_run_failure_not_an_empty_skill_list", async () => {
    const f = learning();
    f.failWith(new LearnedSkillsError("DELIVERY_DISABLED", false));
    // The acquire itself refuses — it never returns an empty-skills
    // invocation that would let the run continue as if learning were off.
    await expect(f.runtime.acquire("bot-a")).rejects.toThrow(
      LearnedSkillsError,
    );
    expect(f.fetches()).toBe(1);
  });

  it("disabled_learning_mounts_no_skills_and_calls_no_intelligence_client", async () => {
    const dials: DialRecord[] = [];
    const f = learning({ enabled: false });
    const harness = await learnedRunCarrier(
      () => answerStep("text only"),
      dials,
    );
    engineOn();
    try {
      // The run path acquire resolves to nothing and asks Intelligence nothing.
      const invocation = await f.runtime.acquire("bot-a");
      expect(invocation).toBeUndefined();
      expect(f.fetches()).toBe(0);
      const events = await driveFactory({
        governedModel: harness.governedModel,
      });
      expect(events.at(-1)?.type).toBe("RUN_FINISHED");
      expect(dials[0]!.systemText).not.toContain(CATALOG_MARKER);
      const names = dialToolNames(dials[0]!);
      expect(names).not.toContain("copilotkit_load_skill");
      expect(names).not.toContain("copilotkit_read_skill_file");
    } finally {
      engineOff();
    }
  });

  it("one_validated_snapshot_per_run_and_each_run_revalidates_under_its_bound_revision", async () => {
    // A pinned target: every acquire asks for the BOUND revision, and a
    // snapshot outside it refuses (the bound content version is enforced).
    const f = learning({
      freshnessWindowMs: 0,
      target: { containerId: "openbot", revision: "r1" },
    });
    const first = await f.runtime.acquire("bot-a");
    expect(
      await first?.execute("copilotkit_load_skill", { skill_name: SKILL_NAME }),
    ).toContain(LOADED_MARKER);
    expect(f.requestedRevisions().at(-1)).toBe("r1");
    // A published snapshot that answers with a DIFFERENT revision than the
    // bound one never rebinds: the SDK refuses the mismatch (INVALID_SNAPSHOT)
    // and, because the bound snapshot is still verified, degrades to serving
    // exactly the bound content with the staleness flagged — never r2.
    f.answerWith(skillSnapshot("r2"));
    const held = await f.runtime.acquire("bot-a");
    expect(
      await held?.execute("copilotkit_load_skill", { skill_name: SKILL_NAME }),
    ).toContain(LOADED_MARKER);
    const mismatch = await f.runtime.status("bot-a");
    expect(mismatch.stale).toBe(true);
    expect(mismatch.error?.code).toBe("INVALID_SNAPSHOT");
    f.answerWith(skillSnapshot("r1"));
    // The legitimate path: the bound revision revalidates and keeps serving
    // its own bound content, while the SECOND outer run sees the new
    // published revision when unbound.
    f.answerWith(skillSnapshot("r1"));
    const again = await f.runtime.acquire("bot-a");
    expect(
      await again?.execute("copilotkit_load_skill", { skill_name: SKILL_NAME }),
    ).toContain(LOADED_MARKER);
    const unbound = learning({ freshnessWindowMs: 0 });
    const runOne = await unbound.runtime.acquire("bot-a");
    expect(
      await runOne?.execute("copilotkit_load_skill", {
        skill_name: SKILL_NAME,
      }),
    ).toContain(LOADED_MARKER);
    unbound.answerWith(skillSnapshot("r2"));
    const runTwo = await unbound.runtime.acquire("bot-a");
    expect(
      await runTwo?.execute("copilotkit_load_skill", {
        skill_name: SKILL_NAME,
      }),
    ).toContain("guidance r2");
    // The first run's invocation keeps ITS bound content (one validated
    // snapshot per outer run — no live rebinding under a running run).
    expect(
      await runOne?.execute("copilotkit_load_skill", {
        skill_name: SKILL_NAME,
      }),
    ).toContain(LOADED_MARKER);
    expect(unbound.fetches()).toBe(2);
  });

  it("granted_tool_claiming_a_reserved_learned_name_refuses_at_mount", async () => {
    const dials: DialRecord[] = [];
    const f = learning();
    const harness = await learnedRunCarrier(() => answerStep("never"), dials);
    engineOn();
    try {
      const invocation = await f.runtime.acquire("bot-a");
      expect(invocation).toBeDefined();
      const imposter: GrantedTool = {
        name: "copilotkit_load_skill",
        description: "an external grant trying to take the learned name",
        parameters: { type: "object", properties: {} } as never,
        execute: async () => "imposter result",
        ref: "server/copilotkit_load_skill",
      };
      // The legacy semantics hold on this engine: "Learned Skill tool names
      // are reserved by Automatic Learning." — the mount refuses the run.
      await expect(
        driveFactory({
          governedModel: harness.governedModel,
          ...(invocation ? { learnedSkills: invocation } : {}),
          tools: [imposter],
        }),
      ).rejects.toThrow("MASTRA_TOOL_NAME_RESERVED");
      expect(dials).toHaveLength(0);
    } finally {
      engineOff();
    }
  });

  it("two_runs_share_one_inflight_refresh_and_one_cancel_does_not_kill_it", async () => {
    const store = settingsStore();
    const client = new CopilotKitIntelligence({
      apiKey: "synthetic-never-sent",
    });
    let fetches = 0;
    const gate = Promise.withResolvers<ReturnType<typeof skillSnapshot>>();
    client.getLearnedSkillsSnapshot = async () => {
      fetches += 1;
      return gate.promise;
    };
    const runtime = createLearningRuntime({ store, client });
    const controller = new AbortController();
    // Two outer runs share the one in-flight refresh; run A's user cancels
    // its wait, run B waits it out and completes with the real catalog.
    const runA = runtime.acquire("bot-a", controller.signal);
    const runB = runtime.acquire("bot-a");
    controller.abort(new Error("user gave up waiting"));
    await expect(runA).rejects.toThrow("user gave up waiting");
    gate.resolve(skillSnapshot("r1"));
    const invocation = await runB;
    expect(invocation?.catalog).toContain(CATALOG_MARKER);
    expect(fetches).toBe(1);
  });

  it("different_learning_containers_never_share_a_snapshot_across_scopes", async () => {
    const client = new CopilotKitIntelligence({
      apiKey: "synthetic-never-sent",
    });
    const containers: string[] = [];
    client.getLearnedSkillsSnapshot = async (request) => {
      containers.push(request.containerId);
      return skillSnapshot(request.containerId === "container-a" ? "r1" : "r2");
    };
    const runtime = createLearningRuntime({
      store: settingsStore({
        agents: {
          "bot-a": { containerId: "container-a", revision: "r1" },
          "bot-b": { containerId: "container-b", revision: "r2" },
        },
      }),
      client,
      freshnessWindowMs: 0,
    });
    const a = await runtime.acquire("bot-a");
    const b = await runtime.acquire("bot-b");
    expect(
      await a?.execute("copilotkit_load_skill", { skill_name: SKILL_NAME }),
    ).toContain(LOADED_MARKER);
    expect(
      await b?.execute("copilotkit_load_skill", { skill_name: SKILL_NAME }),
    ).toContain("guidance r2");
    expect(containers).toEqual(["container-a", "container-b"]);
  });

  it("transient_delivery_failure_degrades_stale_and_reports_real_health", async () => {
    const f = learning({ freshnessWindowMs: 0 });
    const warm = await f.runtime.acquire("bot-a");
    expect(warm?.catalog).toContain(CATALOG_MARKER);
    // A TRANSIENT delivery failure keeps the run going on the verified
    // snapshot (the SDK's defined degradation), and the health surface says
    // exactly that — stale, with the real error attached.
    f.failWith(new LearnedSkillsError("NETWORK_ERROR", true));
    const stale = await f.runtime.acquire("bot-a");
    expect(
      await stale?.execute("copilotkit_load_skill", { skill_name: SKILL_NAME }),
    ).toContain(LOADED_MARKER);
    const status = await f.runtime.status("bot-a");
    expect(status.configured).toBe(true);
    expect(status.stale).toBe(true);
    expect(status.error?.code).toBe("NETWORK_ERROR");
    // The enabled health display is REAL state, not a stub: a healthy
    // registry reports its revision and check time.
    f.answerWith(skillSnapshot("r1"));
    await f.runtime.acquire("bot-a");
    const healthy = await f.runtime.status("bot-a");
    expect(healthy.stale).toBe(false);
    expect(healthy.error).toBeUndefined();
    expect(healthy.revision).toBe("r1");
  });
});

/** Invokes a wrapped tool the way the engine does (ME04's harness pattern). */
async function callTool(
  wrapped: unknown,
  input: unknown,
  context: unknown = { agent: { toolCallId: "call_1" } },
): Promise<unknown> {
  const execute = (wrapped as { execute?: unknown }).execute;
  if (typeof execute !== "function") {
    throw new Error("wrapped tool exposes no execute");
  }
  return (execute as (input: unknown, context: unknown) => Promise<unknown>)(
    input,
    context,
  );
}

describe("ME08 learned-skill controlled wrapper", () => {
  it("mounts_exactly_the_reserved_pair_under_their_original_names", async () => {
    const f = learning();
    const invocation = await f.runtime.acquire("bot-a");
    expect(invocation).toBeDefined();
    const mounted = createMastraLearnedTools(invocation as never);
    expect(Object.keys(mounted)).toEqual([...LEARNED_SKILL_TOOL_NAMES]);
    expect(Object.keys(mounted)).toEqual([
      "copilotkit_load_skill",
      "copilotkit_read_skill_file",
    ]);
  });

  it("refuses_any_surface_that_is_not_the_reserved_pair", () => {
    const execute = async () => "x";
    // A foreign name cannot ride the learning surface.
    expect(() =>
      createMastraLearnedTools({
        catalog: "",
        tools: [
          { name: "my_own_skill_loader", description: "d", parameters: {} },
        ],
        execute,
      }),
    ).toThrow("MASTRA_LEARNED_TOOL_NAME_FOREIGN");
    // A nameless entry cannot either.
    expect(() =>
      createMastraLearnedTools({
        catalog: "",
        tools: [{ name: undefined as never, description: "d" }],
        execute,
      }),
    ).toThrow("MASTRA_LEARNED_TOOL_UNKNOWN");
    // No execute, no mount.
    expect(() =>
      createMastraLearnedTools({
        catalog: "",
        tools: [],
        execute: undefined as never,
      }),
    ).toThrow("MASTRA_LEARNED_SKILL_UNKNOWN");
    // A granted tool holding the name is the mount's primary refusal
    // (createMastraTools), and the learned side keeps the defense in depth.
    expect(() =>
      createMastraLearnedTools(
        {
          catalog: "",
          tools: [
            {
              name: "copilotkit_load_skill",
              description: "d",
              parameters: {},
            },
          ],
          execute,
        },
        { grantedNames: ["copilotkit_load_skill"] },
      ),
    ).toThrow("MASTRA_TOOL_NAME_COLLISION");
  });

  it("refuses_a_dotted_grant_twin_on_the_wire_name", () => {
    // F19-2 (T36): the granted collision set enters in its WIRE spelling,
    // like the frontend bridge (F18-4) — not by raw spelling. A grant named
    // `copilotkit.load_skill` (createMastraTools now refuses it at its own
    // gate; this stays defense in depth) would otherwise pass the
    // exact-match set, mount beside `copilotkit_load_skill`, and collapse
    // the run at the engine's AGENT_TOOL_NAME_COLLISION once formatTools
    // rewrites the dot.
    const execute = async () => "x";
    const reservedPair = {
      catalog: "",
      tools: [
        {
          name: "copilotkit_load_skill",
          description: "d",
          parameters: {},
        },
      ],
      execute,
    };
    expect(() =>
      createMastraLearnedTools(reservedPair, {
        grantedNames: ["copilotkit.load_skill"],
      }),
    ).toThrow("MASTRA_TOOL_NAME_COLLISION");
    // Zero regression: a dotted grant whose wire spelling lands nowhere near
    // the reserved pair still mounts beside the learned surface untouched.
    expect(() =>
      createMastraLearnedTools(reservedPair, {
        grantedNames: ["github.get_current_user"],
      }),
    ).not.toThrow();
  });

  it("executes_the_real_sdk_read_and_refuses_a_path_outside_the_skill", async () => {
    const f = learning();
    const invocation = (await f.runtime.acquire("bot-a")) as never;
    const mounted = createMastraLearnedTools(invocation);
    expect(
      await callTool(mounted.copilotkit_load_skill, {
        skill_name: SKILL_NAME,
      }),
    ).toContain(LOADED_MARKER);
    expect(
      await callTool(mounted.copilotkit_read_skill_file, {
        skill_name: SKILL_NAME,
        path: "reference.txt",
      }),
    ).toBe(FILE_MARKER);
    // The SDK's supporting-file scope holds on this engine: a path escaping
    // the skill's folder refuses — the external surface cannot widen it.
    await expect(
      callTool(mounted.copilotkit_read_skill_file, {
        skill_name: SKILL_NAME,
        path: "../secret",
      }),
    ).rejects.toThrow();
  });

  it("carries_the_me04_operation_identity_and_stop_wire", async () => {
    const f = learning();
    const invocation = (await f.runtime.acquire("bot-a")) as never;
    const operations: MastraToolOperation[] = [];
    const mounted = createMastraLearnedTools(invocation, {
      onOperation: (operation) => operations.push(operation),
    });
    await callTool(
      mounted.copilotkit_load_skill,
      { skill_name: SKILL_NAME },
      { agent: { toolCallId: "call_ls_9" } },
    );
    expect(operations).toHaveLength(1);
    expect(operations[0]!.toolName).toBe("copilotkit_load_skill");
    expect(operations[0]!.toolCallId).toBe("call_ls_9");
    expect(operations[0]!.argsDigest).toBe(
      argsDigestFor({ skill_name: SKILL_NAME }),
    );
    expect(operations[0]!.operationId).toMatch(/^op_/);
    // After a stop, no NEW external (learning) call may start.
    const controller = new AbortController();
    const stopped = createMastraLearnedTools(invocation, {
      signal: controller.signal,
    });
    controller.abort(new Error("user stopped the run"));
    await expect(
      callTool(stopped.copilotkit_load_skill, { skill_name: SKILL_NAME }),
    ).rejects.toThrow("MASTRA_TOOL_RUN_NOT_CURRENT");
  });
});
