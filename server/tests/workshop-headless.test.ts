import { describe, expect, test } from "../../tests/support/e2e-compat";
import { createHeadlessWorkshopTools } from "../src/workshop/headless";
import type { TurnOrchestrator } from "../src/workshop/orchestrator";
import type { WorkshopStore, WorkshopTurnRow } from "../src/workshop/store";
import { createTurnEventBus } from "../src/workshop/bus";

/**
 * The headless path is the machine shape: enqueue, poll, answer — no stream, no subscriber.
 * The store and the orchestrator are fakes driven by hand; the bus is real (in its degraded
 * poll mode) precisely so the no-subscriber assertion is meaningful.
 */
function fakeStore() {
  const turns = new Map<string, WorkshopTurnRow>();
  const sessions = new Map<string, { id: string; channelId: string; botId: string; ownerUserId: string }>();
  const artifactsBySession = new Map<string, Array<{ id: string; name: string; type: string }>>();
  return {
    turns,
    async getOrCreateSession(input: { channelId: string; botId: string; ownerUserId: string }) {
      const existing = [...sessions.values()].find(
        (session) => session.channelId === input.channelId,
      );
      if (existing) return existing;
      const session = {
        id: `ws_${input.channelId}`,
        channelId: input.channelId,
        botId: input.botId,
        ownerUserId: input.ownerUserId,
      };
      sessions.set(session.id, session);
      return session;
    },
    async sessionById(id: string) {
      return sessions.get(id);
    },
    async sessionByChannel(channelId: string) {
      return [...sessions.values()].find((s) => s.channelId === channelId);
    },
    async touchSession() {},
    async insertArtifact(input: { sessionId: string; id?: string; type: string; name: string }) {
      const list = artifactsBySession.get(input.sessionId) ?? [];
      list.push({ id: input.id ?? `wa_${list.length}`, name: input.name, type: input.type });
      artifactsBySession.set(input.sessionId, list);
    },
    async listArtifacts(sessionId: string) {
      return artifactsBySession.get(sessionId) ?? [];
    },
    async enqueueTurn(input: { sessionId: string; prompt: string; initiator?: string }) {
      const row = {
        id: `wt_${turns.size}`,
        sessionId: input.sessionId,
        prompt: input.prompt,
        status: "queued",
        turnIndex: turns.size,
        codeRunId: null,
        runnerHeartbeatAt: new Date(),
        error: null,
        usage: {},
        startedAt: new Date(),
        finishedAt: null,
        initiator: (input.initiator ?? "person") as WorkshopTurnRow["initiator"],
      };
      turns.set(row.id, row as never as WorkshopTurnRow);
      return row as never as WorkshopTurnRow;
    },
    async markRunning(id: string) {
      if (turns.get(id)?.status === "queued") {
        turns.get(id)!.status = "running";
        return true;
      }
      return false;
    },
    async heartbeat() {},
    async markSucceeded(id: string) {
      if (turns.get(id)?.status === "running") {
        turns.get(id)!.status = "succeeded";
        return true;
      }
      return false;
    },
    async markFailed(id: string, error: string) {
      const turn = turns.get(id);
      if (turn && ["queued", "running"].includes(turn.status)) {
        turn.status = "failed";
        turn.error = error;
        return true;
      }
      return false;
    },
    async markCancelled(id: string) {
      const turn = turns.get(id);
      if (turn && ["queued", "running"].includes(turn.status)) {
        turn.status = "cancelled";
        return true;
      }
      return false;
    },
    async getTurn(id: string) {
      return turns.get(id);
    },
    async listTurns(sessionId: string) {
      return [...turns.values()].filter((turn) => turn.sessionId === sessionId);
    },
    async recoverStale() {
      return [];
    },
    async appendEvent() {
      throw new Error("no events on the headless path");
    },
    async readEventsSince() {
      return [];
    },
  } as unknown as WorkshopStore;
}

/** An orchestrator that settles turns on a script the test controls. */
function scriptedOrchestrator(store: ReturnType<typeof fakeStore>) {
  const enqueued: Array<{ sessionId: string; prompt: string; initiator?: unknown }> = [];
  let settleAs: (turnId: string) => Promise<void> = async () => undefined;
  const orchestrator: TurnOrchestrator = {
    async enqueue(input) {
      enqueued.push({
        sessionId: input.sessionId,
        prompt: input.prompt,
        initiator: input.initiator,
      });
      const row = await store.enqueueTurn({
        sessionId: input.sessionId,
        prompt: input.prompt,
        initiator: "headless",
      });
      void store.markRunning(row.id).then(() => settleAs(row.id));
      return { turnId: row.id };
    },
    async cancel(turnId) {
      return store.markCancelled(turnId);
    },
    async recoverStale() {
      return [];
    },
    async heartbeat() {},
  };
  return { orchestrator, enqueued, onSettle: (fn: (turnId: string) => Promise<void>) => {
    settleAs = fn;
  } };
}

function realBus() {
  // The real bus in poll mode: subscribers would be tracked through its schedule; the
  // headless path must leave it with none.
  return createTurnEventBus(null, {
    reader: { readEventsSince: async () => [] },
    schedule: () => () => undefined,
  });
}

describe("run_workshop_turn (the headless tool)", () => {
  test("awaits the turn and answers with artifacts; the row is marked headless", async () => {
    const store = fakeStore();
    const { orchestrator, enqueued, onSettle } = scriptedOrchestrator(store);
    const tools = createHeadlessWorkshopTools({
      store,
      orchestrator,
      actorUserId: "user_1",
      sleep: async () => undefined,
    });
    onSettle(async (turnId) => {
      await store.markSucceeded(turnId);
      await store.insertArtifact({
        sessionId: "ws_ch1",
        type: "csv",
        name: "out.csv",
      });
    });

    const result = await tools.runWorkshopTurn({
      botId: "bot_1",
      channelId: "ch1",
      prompt: "汇总数据",
    });
    if (typeof result === "string") throw new Error(result);
    expect(result.status).toBe("succeeded");
    expect(result.artifacts).toEqual([{ id: "wa_0", name: "out.csv", type: "csv" }]);
    // The enqueue carried the headless initiator, and the row says headless.
    expect((enqueued[0]?.initiator as { kind: string } | undefined)?.kind).toBe("handoff");
    expect(store.turns.get(result.turnId)?.initiator).toBe("headless");
  });

  test("a missing field is a sentence, not a throw", async () => {
    const store = fakeStore();
    const { orchestrator } = scriptedOrchestrator(store);
    const tools = createHeadlessWorkshopTools({
      store,
      orchestrator,
      actorUserId: "user_1",
    });
    const answer = await tools.runWorkshopTurn({
      botId: "",
      channelId: "ch1",
      prompt: "x",
    });
    expect(typeof answer === "string" && answer.includes("botId")).toBe(true);
  });

  test("a failed turn answers failed with its error", async () => {
    const store = fakeStore();
    const { orchestrator, onSettle } = scriptedOrchestrator(store);
    const tools = createHeadlessWorkshopTools({
      store,
      orchestrator,
      actorUserId: "user_1",
      sleep: async () => undefined,
    });
    onSettle(async (turnId) => {
      await store.markFailed(turnId, "sandbox refused");
    });
    const result = await tools.runWorkshopTurn({
      botId: "bot_1",
      channelId: "ch1",
      prompt: "跑一下",
    });
    if (typeof result === "string") throw new Error(result);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("sandbox refused");
  });

  test("the wait budget cancels the turn and throws the timeout", async () => {
    const store = fakeStore();
    const { orchestrator } = scriptedOrchestrator(store);
    let ticks = 0;
    const tools = createHeadlessWorkshopTools({
      store,
      orchestrator,
      actorUserId: "user_1",
      timeoutMs: undefined as never,
      sleep: async () => {
        ticks += 1;
      },
      nowMs: (() => {
        let now = 1_000;
        return () => {
          // Every poll advances the clock past the budget quickly.
          now += 600;
          return now;
        };
      })(),
    });
    await expect(
      tools.runWorkshopTurn({
        botId: "bot_1",
        channelId: "ch1",
        prompt: "慢任务",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/did not settle/);
    expect(ticks).toBeGreaterThan(0);
  });

  test("no SSE subscription is opened anywhere on the path", async () => {
    const store = fakeStore();
    const { orchestrator, onSettle } = scriptedOrchestrator(store);
    const bus = realBus();
    let subscribers = 0;
    const subscribe = bus.subscribe.bind(bus);
    bus.subscribe = async (...args: Parameters<typeof subscribe>) => {
      subscribers += 1;
      return subscribe(...args);
    };
    const tools = createHeadlessWorkshopTools({
      store,
      orchestrator,
      actorUserId: "user_1",
      sleep: async () => undefined,
    });
    onSettle(async (turnId) => {
      await store.markSucceeded(turnId);
    });
    await tools.runWorkshopTurn({
      botId: "bot_1",
      channelId: "ch1",
      prompt: "静默跑完",
    });
    // The headless shape: not one subscriber, not even briefly.
    expect(subscribers).toBe(0);
  });
});
