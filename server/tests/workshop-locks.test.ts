import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  createInProcessTurnLock,
  createRedisTurnLock,
} from "../src/workshop/locks";
import { fakeRedisPort } from "./support/fake-redis";

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
  });

  test("mode reports memory", () => {
    expect(createInProcessTurnLock().mode).toBe("memory");
  });
});

describe("redis turn lock (fake port)", () => {
  test("SET NX: concurrent acquires, exactly one wins", async () => {
    const redis = fakeRedisPort();
    const lock = createRedisTurnLock(redis, { ttlMs: 30_000 });
    const winners = await Promise.all([
      lock.acquire("turn-1"),
      lock.acquire("turn-1"),
      lock.acquire("turn-1"),
    ]);
    expect(winners.filter((l) => l !== null)).toHaveLength(1);
    expect(winners.filter((l) => l === null)).toHaveLength(2);
    expect(lock.mode).toBe("redis");
  });

  test("release is compare-and-delete: a wrong token deletes nothing", async () => {
    const redis = fakeRedisPort();
    const lock = createRedisTurnLock(redis, { ttlMs: 30_000 });
    const lease = await lock.acquire("turn-1");
    expect(lease).not.toBeNull();

    // A forged release with a token that is not the owner's: the script must not delete.
    await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end
       return 0`,
      1,
      "ws:lock:turn:turn-1",
      `forged-${lease!.token}`,
    );
    expect(await lock.acquire("turn-1")).toBeNull();

    // The right token releases, and the next acquire succeeds.
    await lease!.release();
    const next = await lock.acquire("turn-1");
    expect(next).not.toBeNull();
  });

  test("renew extends for the owner; a failed renewal latches lost", async () => {
    const redis = fakeRedisPort();
    const lock = createRedisTurnLock(redis, { ttlMs: 30_000 });
    const lease = await lock.acquire("turn-1");
    expect(await lease!.renew()).toBe(true);
    expect(lease!.lost).toBe(false);

    // Expire the key out from under the holder (as TTL would), then renew: the token no longer
    // matches anything, renewal fails, and `lost` latches so the holder can settle itself.
    redis.keys.delete("ws:lock:turn:turn-1");
    expect(await lease!.renew()).toBe(false);
    expect(lease!.lost).toBe(true);
    expect(await lease!.renew()).toBe(false);
    expect(lease!.lost).toBe(true);
  });

  test("a Redis failure on acquire surfaces as an exception, not a silent lock", async () => {
    const redis = fakeRedisPort();
    const lock = createRedisTurnLock(redis, { ttlMs: 30_000 });
    redis.failNext();
    // The lock path lets the error propagate: the caller refuses the new turn (and audits
    // workshop.lock_unavailable) rather than running unguarded.
    await expect(lock.acquire("turn-1")).rejects.toThrow(/fake redis/);
  });
});
