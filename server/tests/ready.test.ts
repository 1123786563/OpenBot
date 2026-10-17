import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/*
 * createApp takes its services positionally; the OpenMuse seam tail is ONE named object
 * (openMuseSeams) that carries the readiness probe, so the probe is set by offset the same way
 * tests/self-host-banner.test.ts sets the banner, for the same reason: the optional tail only
 * ever gains parameters appended last, so a new one moves this offset by exactly one and this
 * comment by one line. Since the seams object landed, aa0f90a5 (#763) appended identity and
 * identityGithubCallback and 65e8d57c (bifrost-5) appended botServices after it, so it now sits
 * fourth from the end.
 */
function appWithProbe(probe: () => Promise<void>) {
  const args: unknown[] = new Array(createApp.length).fill(undefined);
  args[0] = loadConfig(testEnvironment());
  // The OpenMuse seam tail is ONE named object (openMuseSeams), fourth-from-last since the
  // identity and botServices positionals were appended behind it, so the probe reaches it by
  // name through that slot — never by its own offset.
  args[createApp.length - 4] = { readinessProbe: probe };
  return (createApp as (...input: unknown[]) => ReturnType<typeof createApp>)(
    ...args,
  );
}

describe("/ready", () => {
  test("answers 200 with database up when the ping resolves", async () => {
    const app = appWithProbe(async () => {});
    const ready = await app.request("/ready");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ok", database: "up" });
  });

  test("answers 503 with database down when the ping rejects", async () => {
    const app = appWithProbe(async () => {
      throw new Error("connection refused");
    });
    const ready = await app.request("/ready");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({
      status: "unavailable",
      database: "down",
    });
  });

  test("/health stays 200 ok whatever the database does", async () => {
    for (const probe of [
      async () => {},
      async () => {
        throw new Error("connection refused");
      },
    ]) {
      const app = appWithProbe(probe);
      const health = await app.request("/health");
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });
    }
  });
});
