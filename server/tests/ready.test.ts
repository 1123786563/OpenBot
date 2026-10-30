import { describe, expect, test } from "../../tests/support/e2e-compat";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/*
 * createApp takes its services positionally; the readiness probe is the sixteenth-from-last of
 * them (the OpenMuse template revision, personal-files, task, Google OAuth, Mail,
 * Reviewed-action, private-Goal, Calendar, private-Idea, private-Memory, documents,
 * notification, account-deletion, activity and ops-signals seams were appended after it), so it is set by offset the same way tests/self-host-banner.test.ts sets
 * the banner, for the same reason: the optional tail only ever gains parameters appended last,
 * so a new one moves this offset by exactly one and this comment by one line. Four parameters
 * have been appended since: identity, identityGithubCallback, botServices and workbenchPayer.
 */
function appWithProbe(probe: () => Promise<void>) {
  const args: unknown[] = new Array(createApp.length).fill(undefined);
  args[0] = loadConfig(testEnvironment());
  // The OpenMuse seam tail is ONE named object (openMuseSeams), and the four
  // parameters above were appended after it, so the probe reaches its object
  // five from the end — never by the last slot.
  args[createApp.length - 5] = { readinessProbe: probe };
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
