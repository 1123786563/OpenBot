import { describe, expect, test } from "bun:test";
import { createRedisPort } from "../src/redis";
import type { RedisPort } from "../src/redis";

/**
 * The factory's three branches only — no sockets. The real client's behaviour (locking, pub/sub)
 * is exercised by the lock and bus tests against a fake port; here what matters is that the
 * factory refuses, declines or builds exactly when the two env variables say so.
 */
describe("createRedisPort", () => {
  test("returns null when OPENBOT_REDIS_URL is not set", () => {
    expect(createRedisPort({})).toBeNull();
    expect(createRedisPort({ OPENBOT_REDIS_URL: "  " })).toBeNull();
    expect(
      createRedisPort({ OPENBOT_REDIS_URL: "", WORKSHOP_REQUIRE_REDIS: "0" }),
    ).toBeNull();
  });

  test("throws when WORKSHOP_REQUIRE_REDIS=1 and the URL is not set", () => {
    expect(() => createRedisPort({ WORKSHOP_REQUIRE_REDIS: "1" })).toThrow(
      /OPENBOT_REDIS_URL/,
    );
    expect(() => createRedisPort({ WORKSHOP_REQUIRE_REDIS: "1" })).toThrow(
      /WORKSHOP_REQUIRE_REDIS/,
    );
  });

  test("builds a port with all seven methods when the URL is set", () => {
    const port = createRedisPort({
      OPENBOT_REDIS_URL: "redis://127.0.0.1:6379",
    });
    expect(port).not.toBeNull();
    for (const method of [
      "get",
      "set",
      "eval",
      "publish",
      "subscribe",
      "duplicate",
      "quit",
    ] as const) {
      expect(typeof port![method]).toBe("function");
    }
    // lazyConnect means building the port opened no socket, so closing it needs no server.
    expect(port!.quit()).resolves.toBeUndefined();
  });
});

/** Compile-time shape check: the port stays seven methods wide. */
const typeProbe: RedisPort = null as unknown as RedisPort;
void typeProbe;
