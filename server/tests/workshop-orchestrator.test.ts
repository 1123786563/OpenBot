import { describe, expect, test } from "bun:test";
import { createTurnOrchestrator } from "../src/workshop/orchestrator";
import type { WorkshopStore, WorkshopTurnRow } from "../src/workshop/store";
import type { TurnLease, TurnLock } from "../src/workshop/locks";
import type {
  CodeRunGateway,
  StreamingRun,
  TranslatedEvent,
} from "../src/codesandbox/types";

/** An in-memory store honouring the guarded-transition semantics the orchestrator leans on. */
function fakeStore() {
  const turns = new Map<string, WorkshopTurnRow>();
  const events = new Map<
    string,
    Array<{ seq: number; type: string; payload: Record<string, unknown> }>
  >();
  let nextIndex = 0;
  const guard = (id: string, from: string[]) =>
    turns.get(id) !== undefined && from.includes(turns.get(id)!.status);
  const store = {
    turns,
    events,
    async getOrCreateSession(input: { channelId: string }) {
      return {
        id: `ws_${input.channelId}`,
        channelId: input.channelId,
        botId: "bot_1",
        ownerUserId: "user_1",
        status: "active",
        opencodeSessionId: null,
        webappPort: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        visibility: "private",
        shareTokenHash: null,
        shareScope: "preview",
        shareExpiresAt: null,
        shareRevokedAt: null,
        shareCreatedBy: null,
        shareCreatedAt: null,
      } as never as Awaited<ReturnType<WorkshopStore["getOrCreateSession"]>>;
    },
    async sessionById(id: string) {
      return id === "ws_ch"
        ? ({ id, botId: "bot_1", ownerUserId: "user_1" } as never)
        : undefined;
    },
    async touchSession() {},
    async insertArtifact() {
      throw new Error("not under test here");
    },
    async listArtifacts() {
      return [];
    },
    async enqueueTurn(input: { sessionId: string; prompt: string }) {
      const row = {
        id: `wt_${nextIndex}`,
        sessionId: input.sessionId,
        prompt: input.prompt,
        status: "queued",
        turnIndex: nextIndex,
        codeRunId: null,
        runnerHeartbeatAt: new Date(),
        error: null,
        usage: {},
        startedAt: new Date(),
        finishedAt: null,
        initiator: "person",
      } as never as WorkshopTurnRow;
      nextIndex += 1;
      turns.set(row.id, row);
      return row;
    },
    async markRunning(id: string) {
      if (!guard(id, ["queued"])) return false;
      turns.get(id)!.status = "running";
      return true;
    },
    async heartbeat(id: string) {
      if (guard(id, ["running"])) turns.get(id)!.runnerHeartbeatAt = new Date();
    },
    async markSucceeded(id: string) {
      if (!guard(id, ["running"])) return false;
      turns.get(id)!.status = "succeeded";
      turns.get(id)!.finishedAt = new Date();
      return true;
    },
    async markFailed(id: string, error: string) {
      if (!guard(id, ["queued", "running"])) return false;
      turns.get(id)!.status = "failed";
      turns.get(id)!.error = error;
      turns.get(id)!.finishedAt = new Date();
      return true;
    },
    async markCancelled(id: string) {
      if (!guard(id, ["queued", "running"])) return false;
      turns.get(id)!.status = "cancelled";
      turns.get(id)!.finishedAt = new Date();
      return true;
    },
    async getTurn(id: string) {
      return turns.get(id);
    },
    async listTurns(sessionId: string) {
      return [...turns.values()].filter((t) => t.sessionId === sessionId);
    },
    async recoverStale(_nowMs: number, staleAfterMs: number) {
      const settled: Array<{ turnId: string; error: string }> = [];
      const cutoff = Date.now() - staleAfterMs;
      for (const [id, turn] of turns) {
        if (
          turn.status === "running" &&
          turn.runnerHeartbeatAt.getTime() < cutoff
        ) {
          turn.status = "failed";
          turn.error = `runner heartbeat timed out after ${staleAfterMs}ms`;
          settled.push({ turnId: id, error: turn.error });
        }
      }
      return settled;
    },
    async appendEvent(input: {
      turnId: string;
      type: string;
      payload: Record<string, unknown>;
    }) {
      const list = events.get(input.turnId) ?? [];
      const row = {
        seq: list.length + 1,
        type: input.type,
        payload: input.payload,
      };
      list.push(row);
      events.set(input.turnId, list);
      return row as never;
    },
    async readEventsSince(turnId: string, seq: number) {
      return (events.get(turnId) ?? []).filter((row) => row.seq > seq) as never;
    },
  } as unknown as WorkshopStore & {
    turns: typeof turns;
    events: typeof events;
  };
  return store;
}

function fakeLock(mode: "memory" | "redis" = "memory") {
  const held = new Set<string>();
  const lock: TurnLock = {
    mode,
    async acquire(turnId) {
      if (held.has(turnId)) return null;
      held.add(turnId);
      let lost = false;
      return {
        token: `lease-${turnId}`,
        get lost() {
          return lost;
        },
        async renew() {
          return !lost;
        },
        async release() {
          held.delete(turnId);
        },
      } satisfies TurnLease;
    },
  };
  return { lock, held };
}

/** A streaming gateway scripted per test: events, then an ending. */
function fakeGateway(script: {
  events: Array<{ family: string; payload?: Record<string, unknown> }>;
  ending: "complete" | "refused" | "throw" | "hold";
}) {
  const started: string[] = [];
  const cancels: string[] = [];
  const gateway: CodeRunGateway = {
    async run() {
      throw new Error("run() is not under test here");
    },
    async resetWorkspace() {
      return { ok: true as const };
    },
    async startStreaming(task: string): Promise<StreamingRun> {
      started.push(task);
      const runId = `cr_${started.length}`;
      if (script.ending === "throw") {
        throw new Error("the sandbox exploded");
      }
      const queue: Array<TranslatedEvent> = script.events.map((event) => ({
        family: event.family as never,
        eventId: `evt_${Math.random().toString(36).slice(2, 6)}`,
        payload: event.payload ?? {},
      }));
      if (script.ending === "refused") {
        queue.unshift({
          family: "unknown",
          eventId: "",
          payload: { refused: "not-configured" },
        });
      }
      let released = false;
      const events: AsyncIterable<TranslatedEvent> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              const next = queue.shift();
              if (next !== undefined) return { done: false, value: next };
              if (script.ending === "hold" && !released) {
                // An open stream: no more events, and no end — until cancel releases it.
                await new Promise<void>((resolve) => {
                  const probe = setInterval(() => {
                    if (released) {
                      clearInterval(probe);
                      resolve();
                    }
                  }, 5);
                });
              }
              return { done: true, value: undefined };
            },
          };
        },
      };
      return {
        runId,
        events,
        async cancel() {
          released = true;
          cancels.push(runId);
        },
      };
    },
  };
  return { gateway, started, cancels };
}

function fakeAudit() {
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> =
    [];
  return {
    events,
    store: {
      async insert(event: {
        eventType: string;
        payload: Record<string, unknown>;
      }) {
        events.push(event);
      },
    } as never,
  };
}

const baseInput = {
  sessionId: "ws_ch",
  prompt: "算一下 2+2",
  actorUserId: "user_1",
  botId: "bot_1",
  ownerUserId: "user_1",
};

/** Let the fire-and-forget run settle: the microtask queue drains the run's awaits. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("turn orchestrator", () => {
  test("① queued → running → succeeded through the full chain", async () => {
    const store = fakeStore();
    const { lock } = fakeLock();
    const audit = fakeAudit();
    const { gateway } = fakeGateway({
      events: [
        { family: "progress" },
        { family: "message_chunk", payload: { text: "4" } },
        { family: "prompt_response" },
      ],
      ending: "complete",
    });
    const orchestrator = createTurnOrchestrator({
      store,
      lock,
      gatewayFor: () => gateway,
      auditStore: audit.store,
    });

    const { turnId } = await orchestrator.enqueue(baseInput);
    await settle();

    expect(store.turns.get(turnId)?.status).toBe("succeeded");
    const types = store.events.get(turnId)?.map((event) => event.type);
    expect(types).toEqual(["progress", "message_chunk", "prompt_response"]);
    const auditTypes = audit.events.map((event) => event.eventType);
    expect(auditTypes).toEqual([
      "workshop.turn_started",
      "workshop.turn_completed",
    ]);
  });

  test("② cancel settles cancelled, audits, and cancels the in-flight stream", async () => {
    const store = fakeStore();
    const { lock } = fakeLock();
    const audit = fakeAudit();
    // A stream that never ends on its own: only cancel can finish it.
    const { gateway, cancels } = fakeGateway({
      events: [{ family: "progress" }],
      ending: "hold",
    });
    const orchestrator = createTurnOrchestrator({
      store,
      lock,
      gatewayFor: () => gateway,
      auditStore: audit.store,
    });
    const { turnId } = await orchestrator.enqueue(baseInput);
    await settle();
    expect(store.turns.get(turnId)?.status).toBe("running");

    const cancelled = await orchestrator.cancel(turnId);
    await settle();
    expect(cancelled).toBe(true);
    expect(store.turns.get(turnId)?.status).toBe("cancelled");
    expect(audit.events.map((e) => e.eventType)).toContain(
      "workshop.turn_cancelled",
    );
    expect(cancels).toHaveLength(1); // the in-flight stream was told to stop
  });

  test("③ recoverStale settles a quiet running turn and audits stale_recovered", async () => {
    const store = fakeStore();
    const { lock } = fakeLock();
    const audit = fakeAudit();
    const { gateway } = fakeGateway({ events: [], ending: "hold" });
    const orchestrator = createTurnOrchestrator({
      store,
      lock,
      gatewayFor: () => gateway,
      auditStore: audit.store,
    });
    const { turnId } = await orchestrator.enqueue(baseInput);
    await settle();
    expect(store.turns.get(turnId)?.status).toBe("running");

    // Age the heartbeat past the stale window.
    store.turns.get(turnId)!.runnerHeartbeatAt = new Date(
      Date.now() - 10 * 60 * 1000,
    );
    const recovered = await orchestrator.recoverStale(
      Date.now(),
      5 * 60 * 1000,
    );
    expect(recovered).toEqual([turnId]);
    expect(store.turns.get(turnId)?.status).toBe("failed");
    expect(audit.events.map((e) => e.eventType)).toContain(
      "workshop.turn_stale_recovered",
    );
    // Exactly once: a second sweep finds nothing.
    expect(await orchestrator.recoverStale(Date.now(), 5 * 60 * 1000)).toEqual(
      [],
    );
  });

  test("④ a held lock blocks the second runner: the turn runs once", async () => {
    const store = fakeStore();
    const { lock, held } = fakeLock();
    const { gateway, started } = fakeGateway({
      events: [{ family: "prompt_response" }],
      ending: "complete",
    });
    const orchestrator = createTurnOrchestrator({ store, lock, gateway });
    // Hold the turn's lock externally, as another replica would.
    held.add("wt_0");
    await orchestrator.enqueue(baseInput);
    await settle();
    expect(started).toHaveLength(0); // never reached the gateway
    expect(store.turns.get("wt_0")?.status).toBe("queued"); // and stays queued
  });

  test("⑤ a refused stream settles the turn failed (the gateway kept its run row)", async () => {
    const store = fakeStore();
    const { lock } = fakeLock();
    const audit = fakeAudit();
    const { gateway, started } = fakeGateway({ events: [], ending: "refused" });
    const orchestrator = createTurnOrchestrator({
      store,
      lock,
      gatewayFor: () => gateway,
      auditStore: audit.store,
    });
    const { turnId } = await orchestrator.enqueue(baseInput);
    await settle();
    expect(started).toHaveLength(1); // the gateway WAS called: its code_runs row exists
    expect(store.turns.get(turnId)?.status).toBe("failed");
    expect(audit.events.map((e) => e.eventType)).toContain(
      "workshop.turn_failed",
    );
  });

  test("⑥ a broken lock refuses the turn: fail closed, lock_unavailable audited", async () => {
    const store = fakeStore();
    const audit = fakeAudit();
    const broken: TurnLock = {
      mode: "redis",
      async acquire() {
        throw new Error("redis is down");
      },
    };
    const { gateway, started } = fakeGateway({
      events: [],
      ending: "complete",
    });
    const orchestrator = createTurnOrchestrator({
      store,
      lock: broken,
      gatewayFor: () => gateway,
      auditStore: audit.store,
    });
    const { turnId } = await orchestrator.enqueue(baseInput);
    await settle();
    expect(started).toHaveLength(0);
    expect(store.turns.get(turnId)?.status).toBe("failed");
    expect(store.turns.get(turnId)?.error).toContain("lock");
    expect(audit.events.map((e) => e.eventType)).toContain(
      "workshop.lock_unavailable",
    );
  });

  test("⑦ a gateway explosion on startStreaming settles failed, not stuck", async () => {
    const store = fakeStore();
    const { lock } = fakeLock();
    const audit = fakeAudit();
    const { gateway } = fakeGateway({ events: [], ending: "throw" });
    const orchestrator = createTurnOrchestrator({
      store,
      lock,
      gatewayFor: () => gateway,
      auditStore: audit.store,
    });
    const { turnId } = await orchestrator.enqueue(baseInput);
    await settle();
    expect(store.turns.get(turnId)?.status).toBe("failed");
    expect(audit.events.map((e) => e.eventType)).toContain(
      "workshop.turn_failed",
    );
  });
});
