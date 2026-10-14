import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Hono } from "hono";
import { createLogger } from "../../shared/logger";
import {
  createRequestTracking,
  currentRequestId,
} from "../src/telemetry/request-tracking";
import { testEnvironment } from "./support/environment";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function miniApp(logger = createLogger("test", capture().stream)) {
  const tracking = createRequestTracking({ logger });
  const app = new Hono<{ Variables: { requestId?: string } }>();
  app.use("/api/*", tracking.requestId);
  app.use("/api/*", tracking.accessLog);
  app.get("/api/ping", (c) => c.json({ requestId: currentRequestId() }));
  app.get("/health", (c) => c.json({ status: "ok" }));
  return app;
}

describe("request tracking", () => {
  test("mints a request id, echoes it back, and the handler sees the same one", async () => {
    const response = await miniApp().request("/api/ping");
    const requestId = response.headers.get("x-request-id");
    expect(requestId ?? "").toMatch(UUID);
    expect((await response.json()).requestId).toBe(requestId);
  });

  test("reuses a well-formed inbound x-request-id", async () => {
    const response = await miniApp().request("/api/ping", {
      headers: { "x-request-id": "client-trace-42" },
    });
    expect(response.headers.get("x-request-id")).toBe("client-trace-42");
  });

  test("replaces a malformed inbound id with a minted one", async () => {
    const response = await miniApp().request("/api/ping", {
      headers: { "x-request-id": "bad id with spaces" },
    });
    expect(response.headers.get("x-request-id") ?? "").toMatch(UUID);
  });

  test("the access log line carries method, path, status, duration and request id", async () => {
    const { stream, lines } = capture();
    await miniApp(createLogger("test", stream)).request("/api/ping");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.msg).toBe("request");
    expect(record.method).toBe("GET");
    expect(record.path).toBe("/api/ping");
    expect(record.status).toBe(200);
    expect(record.duration_ms).toBeTypeOf("number");
    expect(record.request_id ?? "").toMatch(UUID);
  });

  test("a throwing handler still leaves its access log line, as Hono's 500", async () => {
    const { stream, lines } = capture();
    const logger = createLogger("test", stream);
    const tracking = createRequestTracking({ logger });
    const app = new Hono<{ Variables: { requestId?: string } }>();
    app.use("/api/*", tracking.requestId);
    app.use("/api/*", tracking.accessLog);
    app.get("/api/boom", () => {
      throw new Error("boom");
    });
    const response = await app.request("/api/boom");
    expect(response.status).toBe(500);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.status).toBe(500);
    expect(record.path).toBe("/api/boom");
  });

  test("probes outside /api are not access-logged", async () => {
    const { stream, lines } = capture();
    await miniApp(createLogger("test", stream)).request("/health");
    expect(lines).toHaveLength(0);
  });

  test("outside a request there is no ambient request id", () => {
    expect(currentRequestId()).toBeUndefined();
  });
});

describe("the main deployment app", () => {
  test("carries x-request-id on a plain route", async () => {
    const { createApp } = await import("../src/app");
    const { loadConfig } = await import("../src/config");
    const app = createApp(loadConfig(testEnvironment()));
    const response = await app.request("/health");
    expect(response.headers.get("x-request-id") ?? "").toMatch(UUID);
  });
});

describe("the OpenMuse seam tail mounts by name (ocr-ob-certify findings 14/15/20)", () => {
  test("deletionAdmin mounts /api/admin/openmuse-deletion and the delete route runs the wired seams", async () => {
    const ran: string[] = [];
    const { createApp } = await import("../src/app");
    const { loadConfig } = await import("../src/config");
    const app = createApp(
      loadConfig(
        testEnvironment({
          OPENBOT_SINGLE_USER: "true",
          // Single-user is refused while any provider is configured — drop
          // the Google pair so the no-sign-in mode this test needs applies.
          GOOGLE_OAUTH_CLIENT_ID: undefined,
          GOOGLE_OAUTH_CLIENT_SECRET: undefined,
          BETTER_AUTH_SECRET: undefined,
          BETTER_AUTH_URL: undefined,
        }),
      ),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        accountDeletion: {
          delete: async (userId: string) => ({
            userId,
            disabledAt: new Date("2026-10-13T00:00:00Z"),
            phase: "fenced" as const,
            restoreUntil: null,
            resources: [],
          }),
          get: async () => null,
          list: async () => [],
          isDisabled: async () => false,
          restore: async () => null,
          complete: async () => null,
          enumerateOwner: async () => [],
        },
        deletionShutdown: async () => {
          ran.push("shutdown");
        },
        deletionRevoke: async () => {
          ran.push("revoke");
        },
        deletionManifest: async () => {
          ran.push("manifest");
          return {
            userId: "user-1",
            disabledAt: null,
            restoreUntil: null,
            phase: "fenced",
            resources: [],
          };
        },
        deletionRevokeSessions: async () => {
          ran.push("sessions");
        },
        deletionAdmin: {
          restore: async () => ({
            status: 410 as const,
            restoreUntil: "2026-11-12T00:00:00.000Z",
          }),
        },
      },
    );
    // The admin surface is mounted (finding 20): its gate answers, not 404.
    const restore = await app.request(
      "/api/admin/openmuse-deletion/nobody/restore",
      { method: "POST" },
    );
    expect(restore.status).not.toBe(404);
    // The delete route runs the wired seams in §9 order (finding 15/16):
    // sessions first, then shutdown, revoke, manifest.
    const deleted = await app.request("/api/mobile/openmuse-account/delete", {
      method: "POST",
    });
    expect(deleted.status).toBe(200);
    expect(ran).toEqual(["sessions", "shutdown", "revoke", "manifest"]);
  });
});
