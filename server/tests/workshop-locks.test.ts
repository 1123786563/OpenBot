import { describe, expect, test } from "bun:test";
import { createInProcessTurnLock } from "../src/workshop/locks";

describe("in-process turn lock", () => {
  test("concurrent acquire of one turn: exactly one wins", async () => {
    const lock = createInProcessTurnLock();
    const winners = await Promise.all([
      lock.acquire("turn-1"),
      lock.acquire("turn-1"),
      lock.acquire("turn-1"),
    ]);
    expect(winners.filter((lease) => lease !== null)).toHaveLength(1);
    expect(winners.filter((lease) => lease === null)).toHaveLength(2);
  });

  test("different turns do not contend", async () => {
    const lock = createInProcessTurnLock();
    const a = await lock.acquire("turn-a");
    const b = await lock.acquire("turn-b");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  test("release frees the turn for the next holder", async () => {
    const lock = createInProcessTurnLock();
    const lease = await lock.acquire("turn-1");
    expect(lease).not.toBeNull();

    // Still held: a second acquire loses.
    expect(await lock.acquire("turn-1")).toBeNull();

    await lease!.release();
    const next = await lock.acquire("turn-1");
    expect(next).not.toBeNull();
    expect(next!.token).not.toBe(lease!.token);
  });

  test("renew holds true while owned, false after release; lost latches", async () => {
    const lock = createInProcessTurnLock();
    const lease = await lock.acquire("turn-1");
    expect(await lease!.renew()).toBe(true);
    expect(lease!.lost).toBe(false);

    await lease!.release();
    expect(await lease!.renew()).toBe(false);
    expect(lease!.lost).toBe(true);
    // Lost is a one-way latch: the holder reads it to settle itself, never to unlose.
    expect(await lease!.renew()).toBe(false);
    expect(lease!.lost).toBe(true);
  });

  test("mode reports memory", () => {
    expect(createInProcessTurnLock().mode).toBe("memory");
  });
});
