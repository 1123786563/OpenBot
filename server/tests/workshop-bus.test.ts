import { describe, expect, test } from "../../tests/support/e2e-compat";
import { createTurnEventBus } from "../src/workshop/bus";
import { fakeRedisPort } from "./support/fake-redis";

/**
 * A controllable reader: the tests place rows and move the clock of `readEventsSince` by hand,
 * because the bus's only database surface is "everything after seq N".
 */
function fakeReader(rowsByTurn: Map<string, Array<{ seq: number }>>) {
  return {
    async readEventsSince(turnId: string, seq: number) {
      return (rowsByTurn.get(turnId) ?? []).filter((row) => row.seq > seq);
    },
  };
}

/** A scheduler that never fires on its own: tests tick the captured callbacks manually. */
function manualScheduler() {
  const callbacks: Array<() => void> = [];
  return {
    callbacks,
    schedule: (callback: () => void) => {
      callbacks.push(callback);
      return () => {
        const index = callbacks.indexOf(callback);
        if (index >= 0) callbacks.splice(index, 1);
      };
    },
    tick: () => {
      for (const callback of [...callbacks]) callback();
    },
  };
}

/** One turn's stored rows, in the shape the fake reader serves. */
function rows(turnId: string, seqs: number[]) {
  return new Map([[turnId, seqs.map((seq) => ({ seq }))]]);
}

/** Let a fire-and-forget deliver() finish its reads before asserting on callbacks. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("turn event bus", () => {
  test("redis mode: publish rings the subscriber, which reads the rows back", async () => {
    const redis = fakeRedisPort();
    const stored = rows("t1", [1, 2, 3]);
    const bus = createTurnEventBus(redis, { reader: fakeReader(stored) });
    expect(bus.mode).toBe("redis");

    const received: Array<Array<{ seq: number }>> = [];
    await bus.subscribe("t1", (events) => received.push(events));
    await bus.publish("t1", 3);

    expect(received).toHaveLength(1);
    expect(received[0].map((e) => e.seq)).toEqual([1, 2, 3]);
    await bus.close();
  });

  test("duplicate deliveries at or below lastSeq are dropped", async () => {
    const redis = fakeRedisPort();
    const stored = rows("t1", [1, 2, 3]);
    const bus = createTurnEventBus(redis, { reader: fakeReader(stored) });

    const received: Array<Array<{ seq: number }>> = [];
    await bus.subscribe("t1", (events) => received.push(events));

    await bus.publish("t1", 3);
    await bus.publish("t1", 2); // late duplicate
    await bus.publish("t1", 3); // exact duplicate

    expect(received).toHaveLength(1);
    await bus.close();
  });

  test("null redis: poll mode from the start, timer-driven, reads new rows", async () => {
    const stored = new Map<string, Array<{ seq: number }>>([["t1", []]]);
    const scheduler = manualScheduler();
    const bus = createTurnEventBus(null, {
      reader: fakeReader(stored),
      schedule: scheduler.schedule,
    });
    expect(bus.mode).toBe("poll");

    const received: Array<Array<{ seq: number }>> = [];
    await bus.subscribe("t1", (events) => received.push(events));

    scheduler.tick(); // nothing new yet
    expect(received).toHaveLength(0);

    stored.set("t1", [{ seq: 1 }, { seq: 2 }]);
    await scheduler.tick();
    await Promise.resolve(); // let the async poll body run
    expect(received).toHaveLength(1);
    expect(received[0].map((e) => e.seq)).toEqual([1, 2]);

    stored.set("t1", [{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    await scheduler.tick();
    await Promise.resolve();
    // The third event only: polling resumes from lastSeq rather than replaying.
    expect(received[1].map((e) => e.seq)).toEqual([3]);
    await bus.close();
  });

  test("redis dying mid-flight degrades live turns to polling (asymmetric fallback)", async () => {
    const redis = fakeRedisPort();
    const stored = new Map<string, Array<{ seq: number }>>([["t1", []]]);
    const scheduler = manualScheduler();
    const bus = createTurnEventBus(redis, {
      reader: fakeReader(stored),
      schedule: scheduler.schedule,
    });
    expect(bus.mode).toBe("redis");

    const received: Array<Array<{ seq: number }>> = [];
    await bus.subscribe("t1", (events) => received.push(events));

    redis.failNext();
    await bus.publish("t1", 1); // the publish throws inside the bus and degrades it
    expect(bus.mode).toBe("poll");

    stored.set("t1", [{ seq: 1 }]);
    await scheduler.tick();
    await Promise.resolve();
    expect(received).toHaveLength(1);
    expect(received[0].map((e) => e.seq)).toEqual([1]);
    await bus.close();
  });

  test("a turn longer than one page delivers every event, not just the first page", async () => {
    const redis = fakeRedisPort();
    const seqs = Array.from({ length: 600 }, (_, index) => index + 1);
    const stored = rows("t1", seqs);
    // A reader that honours the requested LIMIT, like the production one.
    const paged = {
      async readEventsSince(turnId: string, seq: number, limit = 500) {
        return (stored.get(turnId) ?? [])
          .filter((row) => row.seq > seq)
          .slice(0, limit);
      },
    };
    const bus = createTurnEventBus(redis, { reader: paged });

    const received: number[][] = [];
    await bus.subscribe("t1", (events) =>
      received.push(events.map((e) => e.seq)),
    );
    await bus.publish("t1", 600);
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(seqs);
    await bus.close();
  });

  test("a failed read leaves the watermark alone: the same ring re-reads, nothing is skipped", async () => {
    const redis = fakeRedisPort();
    const stored = rows("t1", [1, 2, 3]);
    let fail = true;
    const flaky = {
      async readEventsSince(turnId: string, seq: number) {
        if (fail) {
          fail = false;
          throw new Error("read failed");
        }
        return (stored.get(turnId) ?? []).filter((row) => row.seq > seq);
      },
    };
    const bus = createTurnEventBus(redis, { reader: flaky });

    const received: number[][] = [];
    await bus.subscribe("t1", (events) =>
      received.push(events.map((e) => e.seq)),
    );
    await bus.publish("t1", 3); // the read fails: nothing delivered, watermark still 0
    await flush();
    expect(received).toHaveLength(0);

    await bus.publish("t1", 3); // the same ring re-reads the same rows
    await flush();
    expect(received).toEqual([[1, 2, 3]]);
    await bus.close();
  });

  test("reference counting: the channel outlives one of two subscribers", async () => {
    const redis = fakeRedisPort();
    const stored = rows("t1", [1]);
    const bus = createTurnEventBus(redis, { reader: fakeReader(stored) });

    const receivedA: number[][] = [];
    const receivedB: number[][] = [];
    const stopA = await bus.subscribe("t1", (events) =>
      receivedA.push(events.map((e) => e.seq)),
    );
    const stopB = await bus.subscribe("t1", (events) =>
      receivedB.push(events.map((e) => e.seq)),
    );

    stopA(); // B still listening: the subscription must survive
    await bus.publish("t1", 1);
    expect(receivedA).toHaveLength(0);
    expect(receivedB).toHaveLength(1);

    stopB(); // last one out: the channel unsubscribes
    expect(redis.listeners.has("ws:turn:t1")).toBe(false);
    await bus.close();
  });

  test("close stops everything and further subscribes are inert", async () => {
    const stored = rows("t1", [1]);
    const scheduler = manualScheduler();
    const bus = createTurnEventBus(null, {
      reader: fakeReader(stored),
      schedule: scheduler.schedule,
    });
    const stop = await bus.subscribe("t1", () => undefined);
    stop();
    await bus.close();
    expect(scheduler.callbacks).toHaveLength(0);
  });
});
