import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CraftConfig } from "../src/craft/config";
import { loadCraftConfig } from "../src/craft/config";
import type { InterruptFence } from "../src/craft/interrupt";
import type { CraftSessionManager } from "../src/craft/manager";
import type {
  AgentSandboxFileApi,
  SandboxGateway,
} from "../src/craft/sandbox-gateway";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import pluginFactory from "../src/craft/templates/turn-budget.plugin";
import {
  clearTurnDeadline,
  stampTurnDeadline,
  turnBudgetPluginSource,
  turnBudgetStampJson,
} from "../src/craft/turn-budget";
import { SESSION_TURN_BUDGET_PLUGIN_SPEC } from "../src/craft/session-plugins";
import { createTurnExecutor } from "../src/craft/turn-executor";
import type { InteractiveTurn, TurnStateStore } from "../src/craft/turn-state";

/**
 * The turn-budget contract in three layers: the stamp derivation (pure, fake clock), the
 * best-effort workspace writes (memory file API), and the ported sandbox-side plugin
 * (driven directly against a real temp directory — notice texts byte-for-byte onyx's,
 * 60s throttle, inert on missing/garbage/stale stamps). The executor wiring (stamp at
 * start, "{}" in the ownership-guarded finally) is pinned at the end.
 */

const SESSION_ID = "cs-budget";
const DIRECTORY = `/workspace/sessions/${SESSION_ID}`;
const STAMP_PATH = `${DIRECTORY}/.onyx-turn-budget.json`;

const config = loadCraftConfig({});

/** A config whose derived family is NOT the default's — proves the stamp reads config, not literals. */
const otherConfig: CraftConfig = {
  ...config,
  interactiveTurnHardCapSeconds: 600,
  interactiveTurnSoftBudgetSeconds: 240,
  turnFinalNoticeMarginSeconds: 120,
};

// ── turnBudgetStampJson — the derivation (onyx base.py stamp_turn_deadline) ────

describe("turnBudgetStampJson", () => {
  test("default config: soft=now+720s, final=max(soft, 1800s−600s)=now+1200s, stale=now+1800s", () => {
    const now = 1_000_000;
    expect(turnBudgetStampJson(config, now)).toBe(
      JSON.stringify({
        soft_deadline_epoch_ms: now + 720_000,
        final_deadline_epoch_ms: now + 1_200_000,
        stale_after_epoch_ms: now + 1_800_000,
      }),
    );
  });

  test("every value derives from the config roots, not literals", () => {
    const now = 5_000_000;
    expect(turnBudgetStampJson(otherConfig, now)).toBe(
      JSON.stringify({
        // soft = 240s, hard = 600s, margin = 120s → final = max(240s, 600s−120s) = 480s
        soft_deadline_epoch_ms: now + 240_000,
        final_deadline_epoch_ms: now + 480_000,
        stale_after_epoch_ms: now + 600_000,
      }),
    );
  });

  test("final never precedes soft: a margin wider than the wrap-up window clamps to soft", () => {
    const wideMargin: CraftConfig = {
      ...otherConfig,
      turnFinalNoticeMarginSeconds: 600, // > the whole 600s cap
    };
    const now = 0;
    const stamp = JSON.parse(turnBudgetStampJson(wideMargin, now)) as Record<
      string,
      number
    >;
    expect(stamp.final_deadline_epoch_ms).toBe(stamp.soft_deadline_epoch_ms);
  });
});

// ── stamp / clear — the best-effort workspace writes ──────────────────────────

function memoryFileApi() {
  const files = new Map<string, string>();
  const api: AgentSandboxFileApi = {
    async listFiles() {
      return [...files.keys()];
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async writeFileBytes(path, bytes) {
      files.set(path, new TextDecoder().decode(bytes));
    },
    async deletePath(path) {
      return files.delete(path);
    },
    async readFile(path) {
      return files.get(path) ?? null;
    },
    async readFileBytes(path) {
      return files.get(path)
        ? new TextEncoder().encode(files.get(path)!)
        : null;
    },
  };
  return { api, files };
}

function gatewayWith(api: AgentSandboxFileApi): SandboxGateway {
  return { fileApiFor: () => api } as unknown as SandboxGateway;
}

describe("stampTurnDeadline / clearTurnDeadline", () => {
  test("stamp writes the derived deadline to the session's contract path", async () => {
    const { api, files } = memoryFileApi();
    await stampTurnDeadline({
      gateway: gatewayWith(api),
      botId: "craft",
      sessionId: SESSION_ID,
      config,
      nowMs: 1_000_000,
    });
    expect(files.get(STAMP_PATH)).toBe(turnBudgetStampJson(config, 1_000_000));
  });

  test("clear overwrites the stamp with the inert {}", async () => {
    const { api, files } = memoryFileApi();
    await stampTurnDeadline({
      gateway: gatewayWith(api),
      botId: "craft",
      sessionId: SESSION_ID,
      config,
    });
    await clearTurnDeadline({
      gateway: gatewayWith(api),
      botId: "craft",
      sessionId: SESSION_ID,
      config,
    });
    expect(files.get(STAMP_PATH)).toBe("{}");
  });

  test("bot-relative sessions stamp inside the bot workspace path", async () => {
    const { api, files } = memoryFileApi();
    const botRelative = loadCraftConfig({
      OPENBOT_CRAFT_SESSION_DIRECTORY_MODE: "bot-relative",
    });
    await stampTurnDeadline({
      gateway: gatewayWith(api),
      botId: "craft",
      sessionId: SESSION_ID,
      config: botRelative,
      nowMs: 0,
    });
    expect(files.get(`${SESSION_ID}/.onyx-turn-budget.json`)).toBe(
      turnBudgetStampJson(botRelative, 0),
    );
  });

  test("both writes are best-effort: a failing file API never rejects", async () => {
    const throwing: AgentSandboxFileApi = {
      ...memoryFileApi().api,
      async writeFile() {
        throw new Error("sandbox down");
      },
    };
    await expect(
      stampTurnDeadline({
        gateway: gatewayWith(throwing),
        botId: "craft",
        sessionId: SESSION_ID,
        config,
      }),
    ).resolves.toBeUndefined();
    await expect(
      clearTurnDeadline({
        gateway: gatewayWith(throwing),
        botId: "craft",
        sessionId: SESSION_ID,
        config,
      }),
    ).resolves.toBeUndefined();
  });
});

// ── the ported plugin — notice texts verbatim, throttle, inertness ────────────

const CONVERGE_TEXT =
  "[Onyx turn budget] About 5 minute(s) of turn budget left. " +
  "Stop opening new research or subagent work; converge on the final " +
  "deliverable with what you already have.";

const FINISH_NOW_TEXT =
  "[Onyx turn budget] Finish now: write any pending outputs to disk and " +
  "reply immediately with what was delivered and what remains. Do not report " +
  "work as complete if it is not — separate what is done from what remains. " +
  "If you are a subagent, return your findings immediately.";

/** A stamp placing `now` in the requested phase of the budget window. */
function stampFile(
  phase: "pre-soft" | "converge" | "finish-now" | "stale",
): string {
  const now = Date.now();
  const windows: Record<
    "pre-soft" | "converge" | "finish-now" | "stale",
    Record<string, number>
  > = {
    "pre-soft": {
      soft_deadline_epoch_ms: now + 60_000,
      final_deadline_epoch_ms: now + 120_000,
      stale_after_epoch_ms: now + 300_000,
    },
    // 5 whole minutes to the cap → "About 5 minute(s)".
    converge: {
      soft_deadline_epoch_ms: now - 60_000,
      final_deadline_epoch_ms: now + 60_000,
      stale_after_epoch_ms: now + 300_000,
    },
    "finish-now": {
      soft_deadline_epoch_ms: now - 120_000,
      final_deadline_epoch_ms: now - 60_000,
      stale_after_epoch_ms: now + 300_000,
    },
    stale: {
      soft_deadline_epoch_ms: now - 300_000,
      final_deadline_epoch_ms: now - 240_000,
      stale_after_epoch_ms: now - 1_000,
    },
  };
  return JSON.stringify(windows[phase]);
}

describe("turn-budget plugin (ported from onyx opencode-plugins/turn-budget.ts)", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "turn-budget-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const loadHooks = async (stamp: string | null) => {
    await writeFile(
      join(directory, ".onyx-turn-budget.json"),
      stamp ?? "",
      "utf8",
    );
    return pluginFactory({ directory });
  };

  test("past soft, before final: appends the converge notice verbatim", async () => {
    const hooks = await loadHooks(stampFile("converge"));
    const output = { output: "tool result text" };
    await hooks["tool.execute.after"]({}, output);
    expect(output.output).toBe(`tool result text\n\n${CONVERGE_TEXT}`);
  });

  test("an undefined output field still becomes the notice cleanly", async () => {
    const hooks = await loadHooks(stampFile("converge"));
    const output: { output?: string } = {};
    await hooks["tool.execute.after"]({}, output);
    expect(output.output).toBe(`\n\n${CONVERGE_TEXT}`);
  });

  test("throttles: at most one notice per 60s", async () => {
    const hooks = await loadHooks(stampFile("converge"));
    const first = { output: "r1" };
    const second = { output: "r2" };
    await hooks["tool.execute.after"]({}, first);
    await hooks["tool.execute.after"]({}, second); // < 60s later
    expect(first.output).toBe(`r1\n\n${CONVERGE_TEXT}`);
    expect(second.output).toBe("r2"); // suppressed
  });

  test("past final: escalates to the finish-now notice verbatim (em-dash included)", async () => {
    const hooks = await loadHooks(stampFile("finish-now"));
    const output = { output: "" };
    await hooks["tool.execute.after"]({}, output);
    expect(output.output).toBe(`\n\n${FINISH_NOW_TEXT}`);
  });

  test("MCP results get a content entry pushed alongside .output", async () => {
    const hooks = await loadHooks(stampFile("converge"));
    const content: Array<{ type: string; text: string }> = [
      { type: "text", text: "mcp result" },
    ];
    const output = { output: "mcp result", content };
    await hooks["tool.execute.after"]({}, output);
    expect(content).toEqual([
      { type: "text", text: "mcp result" },
      { type: "text", text: CONVERGE_TEXT },
    ]);
  });

  test("inert on every degenerate stamp: absent, cleared ({}), malformed, non-numeric, pre-soft, stale", async () => {
    await writeFile(join(directory, ".onyx-turn-budget.json"), "", "utf8");
    // absent file
    let hooks = await pluginFactory({ directory: join(directory, "nowhere") });
    let output = { output: "untouched" };
    await hooks["tool.execute.after"]({}, output);
    expect(output.output).toBe("untouched");

    for (const stamp of [
      "{}", // the cleared stamp
      "not json",
      JSON.stringify({ soft_deadline_epoch_ms: "soon" }), // non-numeric
      stampFile("pre-soft"),
      stampFile("stale"),
    ]) {
      hooks = await loadHooks(stamp);
      output = { output: "untouched" };
      await hooks["tool.execute.after"]({}, output);
      expect(output.output).toBe("untouched");
    }
  });

  test("a null output (failed subtask) is a no-op, not a throw", async () => {
    const hooks = await loadHooks(stampFile("converge"));
    await expect(
      hooks["tool.execute.after"]({}, undefined),
    ).resolves.toBeUndefined();
  });
});

// ── the executor wiring: stamp at start, clear in the guarded finally ─────────

function budgetSessionRow(): CraftSessionRow {
  return {
    id: SESSION_ID,
    userId: "u1",
    name: null,
    status: "active",
    lastActivityAt: new Date(),
    createdAt: new Date(),
    nextjsPort: null,
    sharingScope: "private",
    origin: "INTERACTIVE",
    opencodeSessionId: "ses_1",
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
  };
}

function executorHarness(input: { failOwnership?: boolean }) {
  const { api, files } = memoryFileApi();
  const finishes: Array<{ status: string }> = [];
  const turn: InteractiveTurn = {
    turnId: "turn-1",
    sessionId: SESSION_ID,
    userId: "u1",
    prompt: "build it",
    status: "RUNNING",
    turnIndex: 0,
    attachments: [],
    lastHeartbeatAt: new Date().toISOString(),
    errorDetail: null,
    runnerId: "runner-1",
    reclaimed: false,
  };
  const store = {
    async getSession(id: string, userId: string) {
      return id === SESSION_ID && userId === "u1"
        ? budgetSessionRow()
        : undefined;
    },
  } as unknown as CraftStore;
  const turnState = {
    mode: "memory",
    async claimTurnForRunner() {
      return turn;
    },
    async touchTurn() {
      return true;
    },
    async getActiveTurn() {
      return input.failOwnership
        ? { ...turn, turnId: "turn-2", runnerId: "runner-2" }
        : turn;
    },
    async finishTurn(finish: { status: string }) {
      finishes.push({ status: finish.status });
      return turn;
    },
  } as unknown as TurnStateStore;
  const fence = {
    async isInterruptRequested() {
      return false;
    },
    async clearInterrupt() {},
  } as unknown as InterruptFence;
  /** One runner built over a manager whose event stream is `events`. */
  const withEvents = (events: () => AsyncGenerator<unknown>) => {
    const manager = {
      yieldSandboxEvents: events,
      async persistSandboxEvent() {},
      async finalizePersist() {},
      async persistTurnError() {},
    } as unknown as CraftSessionManager;
    return createTurnExecutor({
      db: {} as never,
      config,
      store,
      manager,
      turnState,
      fence,
      botIdFor: async () => "craft",
      gateway: gatewayWith(api),
    });
  };
  return { withEvents, files, finishes };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("turn executor stamp/clear wiring", () => {
  test("stamps at turn start and clears to {} on success", async () => {
    const harness = executorHarness({});
    let stampedBeforeFirstEvent = false;
    harness
      .withEvents(async function* () {
        // The stamp must precede the first prompt's first event.
        stampedBeforeFirstEvent =
          harness.files.get(STAMP_PATH)?.includes("soft_deadline_epoch_ms") ??
          false;
        yield { stopReason: "end_turn" };
      })
      .startInteractiveTurnRunner("turn-1");
    await settle();
    expect(stampedBeforeFirstEvent).toBe(true);
    expect(harness.finishes).toEqual([{ status: "SUCCEEDED" }]);
    // Stamped, then cleared — the final on-disk state is the inert stamp.
    expect(harness.files.get(STAMP_PATH)).toBe("{}");
  });

  test("clears to {} on the failure path too (the finally, not the happy tail)", async () => {
    const harness = executorHarness({});
    harness
      .withEvents(async function* () {
        yield { stopReason: "end_turn" };
        throw new Error("stream exploded mid-turn");
      })
      .startInteractiveTurnRunner("turn-1");
    await settle();
    expect(harness.finishes).toEqual([{ status: "FAILED" }]);
    expect(harness.files.get(STAMP_PATH)).toBe("{}");
  });

  test("a runner that lost ownership does NOT clear — a successor's stamp survives", async () => {
    const harness = executorHarness({ failOwnership: true });
    harness
      .withEvents(async function* () {
        yield { stopReason: "end_turn" };
      })
      .startInteractiveTurnRunner("turn-1");
    await settle();
    expect(harness.finishes).toEqual([{ status: "SUCCEEDED" }]);
    // The stamp this runner wrote survives unclobbered: not the inert "{}" the
    // clear would leave, and still a deadline payload (self-invalidating past
    // stale_after, so it can never nag the successor's fresh turn anyway).
    const final = harness.files.get(STAMP_PATH) ?? "";
    expect(final).not.toBe("{}");
    expect(final).toContain("stale_after_epoch_ms");
  });
});

// ── the workspace shipping: the plugin source is the ported file ──────────────

describe("turnBudgetPluginSource", () => {
  test("serves the ported plugin (notice texts byte-for-byte) for workspace writes", async () => {
    const source = await turnBudgetPluginSource();
    const placeholder = "$" + "{minutesLeft}"; // keep biome off the template curl
    expect(source).toContain(
      `[Onyx turn budget] About ${placeholder} minute(s) of turn budget left. `,
    );
    expect(source).toContain(
      "work as complete if it is not — separate what is done from what remains.",
    );
    expect(source).toContain("NOTICE_INTERVAL_MS = 60_000");
    expect(source).toContain(".onyx-turn-budget.json");
  });

  test("the opencode.json spec names the file the workspace writes", () => {
    expect(SESSION_TURN_BUDGET_PLUGIN_SPEC).toBe(
      "./.opencode/plugin/turn-budget.ts",
    );
  });
});
