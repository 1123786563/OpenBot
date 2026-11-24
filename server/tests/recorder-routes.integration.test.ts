import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  type ExchangeResponse,
  LEARNING_SPACE_STATES,
  RECORDER_ACTIVITY_STALE_MS,
  RECORDER_SIGNED_OUT,
  type RecorderConnectionsResponse,
  type RecordingsPage,
} from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { eq, inArray } from "drizzle-orm";
import { chromium } from "playwright-core";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import {
  recorderConnections,
  recorderRecordingEvents,
  recorderRecordings,
  recorderTrajectoryBindings,
} from "../src/db/schema/recorder";
import { createRecorderExtension } from "../src/recorder/wiring";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { SESSION_LIFETIME_MS, testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `recorder-routes-${randomUUID()}`;
const owner = `${prefix}-owner`;
const busy = `${prefix}-busy`;
const otherUser = `${prefix}-other`;
const ORIGIN = `chrome-extension://${RECORDER_EXTENSION_ID}`;
const INSTALL = "c".repeat(32);
const OTHER_EXTENSION = `chrome-extension://${"a".repeat(32)}`;

let transcribed = 0;
const transcriber = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => {
    transcribed += 1;
    return Response.json({ text: "hello from the fake" });
  },
});

type Harness = ReturnType<typeof build>;

function build(
  extra: Record<string, string | undefined> = {},
  options: {
    kickThrows?: boolean;
    /** The trail refuses every row written with a connection (connections.ts writes them in its transaction). */
    auditFails?: boolean;
    /** What Intelligence answers for trajectory summaries. */
    intelligenceFetch?: typeof fetch;
  } = {},
) {
  const config = loadConfig(
    testEnvironment({
      TRANSCRIPTION_PROVIDER: "openai-compatible",
      TRANSCRIPTION_BASE_URL: `http://127.0.0.1:${transcriber.port}`,
      TRANSCRIPTION_MODEL: "fake",
      ...extra,
    }),
  );
  const audits: AuditEventInput[] = [];
  const auditStore = {
    insert: async (event: AuditEventInput) => {
      audits.push(event);
    },
  };
  const roleRepository = { rolesForUser: async () => ["user" as const] };
  /** The person's own Learning space, faked: what the Recorder is told, and whose browsers connected. */
  const kicked: string[] = [];
  const recorder = createRecorderExtension({
    config,
    database,
    organizationAuth: undefined,
    roleRepository,
    peopleStore: { isRevoked: async () => false },
    personalSpaces: {
      containerFor: (userId) => `space-of-${userId}`,
      state: async (userId) => ({
        state: "assigned",
        containerId: `space-of-${userId}`,
      }),
      kick: (userId) => {
        kicked.push(userId);
        if (options.kickThrows) throw new Error("credential store down");
      },
    },
    sessionLifetimeMs: SESSION_LIFETIME_MS,
    auditStore,
    ...(options.intelligenceFetch
      ? { intelligenceFetch: options.intelligenceFetch }
      : {}),
    ...(options.auditFails
      ? {
          auditFor: () => ({
            insert: async () => {
              throw new Error("the audit trail is unavailable");
            },
          }),
        }
      : {}),
  });
  /*
   * createApp is positional. Placed by index rather than after a spread of `undefined`s, whose
   * length TypeScript cannot see, so each dependency is type-checked against the parameter it
   * lands on: the audit store the Recorder's routes write to is `auditStore`.
   */
  const args = new Array(createApp.length) as unknown as Parameters<
    typeof createApp
  >;
  args[0] = config;
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const cookie = headers.get("cookie") ?? "";
        const id = cookie.includes("test-session=owner")
          ? owner
          : cookie.includes("test-session=busy")
            ? busy
            : cookie.includes("test-session=other")
              ? otherUser
              : null;
        return id
          ? { user: { id, email: `${id}@example.test`, name: "The Owner" } }
          : null;
      },
    },
  } as never;
  args[2] = roleRepository;
  args[12] = auditStore;
  args[34] = { recorder };
  const app = createApp(...args);
  return { app, audits, config, kicked, recorder };
}

const call = (
  { app }: Harness,
  path: string,
  init: RequestInit & { json?: unknown } = {},
) => {
  const { json, headers, ...rest } = init;
  return app.request(`http://openbot.test${path}`, {
    ...rest,
    headers: {
      ...(json === undefined ? {} : { "content-type": "application/json" }),
      ...(headers as Record<string, string>),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
};
const COOKIE = { cookie: "test-session=owner" };

async function connect(
  harness: Harness,
  installId = INSTALL,
  cookie = COOKIE,
): Promise<ExchangeResponse> {
  const minted = await call(harness, "/api/recorder/connect-codes", {
    method: "POST",
    headers: cookie,
    json: { via: "web" },
  });
  expect(minted.status).toBe(201);
  const { code } = (await minted.json()) as { code: string };
  const exchanged = await call(harness, "/api/recorder/connections", {
    method: "POST",
    headers: { origin: ORIGIN },
    json: { code, label: "Chrome on macOS", installId },
  });
  expect(exchanged.status).toBe(201);
  return exchanged.json();
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test`, name: "The Owner" },
    { id: busy, email: `${busy}@example.test`, name: "The Owner" },
    {
      id: otherUser,
      email: `${otherUser}@example.test`,
      name: "The Other User",
    },
  ]);
});
afterAll(async () => {
  await database
    .delete(users)
    .where(inArray(users.id, [owner, busy, otherUser]));
  await database.$client.close();
  await transcriber.stop(true);
});

describe("connecting", () => {
  test("a connect code needs JSON and a signed-in person", async () => {
    const h = build();
    const form = await call(h, "/api/recorder/connect-codes", {
      method: "POST",
      headers: { ...COOKIE, "content-type": "text/plain" },
      body: '{"via":"web"}',
    });
    expect(form.status).toBe(415);
    const anonymous = await call(h, "/api/recorder/connect-codes", {
      method: "POST",
      json: { via: "web" },
    });
    expect(anonymous.status).toBe(401);
    const minted = await call(h, "/api/recorder/connect-codes", {
      method: "POST",
      headers: COOKIE,
      json: { via: "web" },
    });
    expect(minted.status).toBe(201);
    expect(((await minted.json()) as { code: string }).code).toMatch(/^obc_/);
  });

  test("a person who already holds ten unused codes is told to wait", async () => {
    const h = build();
    const mint = () =>
      call(h, "/api/recorder/connect-codes", {
        method: "POST",
        headers: { cookie: "test-session=busy" },
        json: { via: "web" },
      });
    for (let index = 0; index < 10; index += 1) {
      expect((await mint()).status).toBe(201);
    }
    const refused = await mint();
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error:
        "Too many connection codes were asked for at once. Wait a few minutes and try again.",
    });
    // A refusal like any other of the Recorder's: on the trail, as the person's.
    expect(
      h.audits.filter((a) => a.eventType === "recorder.connect_refused"),
    ).toEqual([
      {
        eventType: "recorder.connect_refused",
        targetType: "recorder_connection",
        actorUserId: busy,
        payload: { reason: "too_many_codes", via: "web" },
      },
    ]);
  });

  test("a code that is unknown, expired or already used is refused on the trail", async () => {
    const h = build();
    const unknown = await call(h, "/api/recorder/connections", {
      method: "POST",
      headers: { origin: ORIGIN },
      json: { code: `obc_${"A".repeat(43)}`, label: "x", installId: INSTALL },
    });
    expect(unknown.status).toBe(400);
    const refusals = h.audits.filter(
      (a) => a.eventType === "recorder.connect_refused",
    );
    expect(refusals).toEqual([
      {
        eventType: "recorder.connect_refused",
        targetType: "recorder_connection",
        initiator: { kind: "deployment" },
        payload: {
          reason: "code",
          extensionId: RECORDER_EXTENSION_ID,
          installId: INSTALL,
        },
      },
    ]);
    // Never the code itself.
    expect(JSON.stringify(refusals)).not.toContain("AAAA");
  });

  test("a connection whose row cannot be written is not made, and the person is told to try again", async () => {
    const h = build({}, { auditFails: true });
    const minted = await call(h, "/api/recorder/connect-codes", {
      method: "POST",
      headers: COOKIE,
      json: { via: "web" },
    });
    const { code } = (await minted.json()) as { code: string };
    const failed = await call(h, "/api/recorder/connections", {
      method: "POST",
      headers: { origin: ORIGIN },
      json: { code, label: "Chrome on macOS", installId: "9".repeat(32) },
    });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: "This browser could not be connected. Try again.",
    });
    const listed = (await (
      await call(h, "/api/recorder/connections", { headers: COOKIE })
    ).json()) as { connections: { installId: string }[] };
    expect(listed.connections.map((c) => c.installId)).not.toContain(
      "9".repeat(32),
    );
    // The code was not spent: with the trail back, the same code connects.
    const done = await call(build(), "/api/recorder/connections", {
      method: "POST",
      headers: { origin: ORIGIN },
      json: { code, label: "Chrome on macOS", installId: "9".repeat(32) },
    });
    expect(done.status).toBe(201);
  });

  test("a body over 2 KiB is refused", async () => {
    const h = build();
    const big = await call(h, "/api/recorder/connect-codes", {
      method: "POST",
      headers: COOKIE,
      json: { via: "web", padding: "x".repeat(3000) },
    });
    expect(big.status).toBe(413);
  });

  test("only the Recorder's own origin may finish connecting", async () => {
    const h = build();
    const minted = await call(h, "/api/recorder/connect-codes", {
      method: "POST",
      headers: COOKIE,
      json: { via: "web" },
    });
    const { code } = (await minted.json()) as { code: string };
    const body = { code, label: "x", installId: INSTALL };
    for (const origin of ["https://evil.example.test", OTHER_EXTENSION]) {
      const refused = await call(h, "/api/recorder/connections", {
        method: "POST",
        headers: { origin },
        json: body,
      });
      expect(refused.status).toBe(403);
    }
    expect(
      h.audits.filter((a) => a.eventType === "recorder.connect_refused"),
    ).toHaveLength(2);
    const missing = await call(h, "/api/recorder/connections", {
      method: "POST",
      headers: { origin: ORIGIN },
      json: { code, label: "x" },
    });
    expect(missing.status).toBe(400);
    const done = await call(h, "/api/recorder/connections", {
      method: "POST",
      headers: { origin: ORIGIN },
      json: body,
    });
    expect(done.status).toBe(201);
    const made = (await done.json()) as ExchangeResponse;
    expect(made.connection.installId).toBe(INSTALL);
    expect(made.user.id).toBe(owner);
    expect(
      h.audits.filter((a) => a.eventType === "recorder.connected"),
    ).toHaveLength(1);
    const again = await call(h, "/api/recorder/connections", {
      method: "POST",
      headers: { origin: ORIGIN },
      json: body,
    });
    expect(again.status).toBe(400);
  });

  test("connecting still succeeds when starting the person's Learning space fails", async () => {
    const h = build({}, { kickThrows: true });
    const made = await connect(h, "7".repeat(32));
    expect(made.token).toMatch(/^obr_/);
    expect(h.kicked).toEqual([owner]);
  });

  test("the same copy connecting again replaces its older connection", async () => {
    const h = build();
    const first = await connect(h, "d".repeat(32));
    const second = await connect(h, "d".repeat(32));
    const replaced = h.audits.filter((a) => a.eventType === "recorder.revoked");
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.payload).toEqual({
      connectionId: first.connection.id,
      via: "web",
      reason: "replaced",
    });
    expect(
      (await call(h, "/api/recorder/me", { headers: bearer(first.token) }))
        .status,
    ).toBe(401);
    expect(
      (await call(h, "/api/recorder/me", { headers: bearer(second.token) }))
        .status,
    ).toBe(200);
  });

  test("extra extension ids are listed after the fixed one and accepted", async () => {
    const extra = "b".repeat(32);
    const plain = build();
    const refused = await call(plain, "/api/recorder/connections", {
      method: "POST",
      headers: { origin: `chrome-extension://${extra}` },
      json: { code: "obc_x", label: "x", installId: INSTALL },
    });
    expect(refused.status).toBe(403);
    const h = build({ OPENBOT_RECORDER_EXTRA_EXTENSION_IDS: extra });
    const listed = await call(h, "/api/recorder/connections", {
      headers: COOKIE,
    });
    expect(
      ((await listed.json()) as { extensionIds: string[] }).extensionIds,
    ).toEqual([RECORDER_EXTENSION_ID, extra]);
    const minted = await call(h, "/api/recorder/connect-codes", {
      method: "POST",
      headers: COOKIE,
      json: { via: "desktop" },
    });
    const { code } = (await minted.json()) as { code: string };
    const accepted = await call(h, "/api/recorder/connections", {
      method: "POST",
      headers: { origin: `chrome-extension://${extra}/` },
      json: { code, label: "Fork", installId: "f".repeat(32) },
    });
    expect(accepted.status).toBe(201);
  });
});

describe("using the bearer", () => {
  test("a disconnect whose row cannot be written does not happen, and the person is told to try again", async () => {
    const made = await connect(build(), "6".repeat(32));
    const broken = build({}, { auditFails: true });
    const fromSettings = await call(
      broken,
      `/api/recorder/connections/${made.connection.id}`,
      { method: "DELETE", headers: COOKIE },
    );
    expect(fromSettings.status).toBe(500);
    expect(await fromSettings.json()).toEqual({
      error: "That browser could not be disconnected. Try again.",
    });
    const fromTheRecorder = await call(
      broken,
      "/api/recorder/connections/current",
      { method: "DELETE", headers: bearer(made.token) },
    );
    expect(fromTheRecorder.status).toBe(500);
    expect(await fromTheRecorder.json()).toEqual({
      error: "This browser could not be disconnected. Try again.",
    });
    // Still connected: neither disconnect happened without its row.
    expect(
      (await call(build(), "/api/recorder/me", { headers: bearer(made.token) }))
        .status,
    ).toBe(200);
  });

  test("a connection unused for as long as a session lasts is signed out, and one used within it stands", async () => {
    const h = build();
    const made = await connect(h, "5".repeat(32));
    const me = () =>
      call(h, "/api/recorder/me", { headers: bearer(made.token) });
    const lastUsedAgo = async (ms: number) => {
      const at = new Date(Date.now() - ms);
      await database
        .update(recorderConnections)
        .set({ createdAt: at, lastUsedAt: at })
        .where(eq(recorderConnections.id, made.connection.id));
    };
    await lastUsedAgo(SESSION_LIFETIME_MS - 60_000);
    expect((await me()).status).toBe(200);
    await lastUsedAgo(SESSION_LIFETIME_MS + 60_000);
    const expired = await me();
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({
      code: RECORDER_SIGNED_OUT,
      reason: "revoked",
    });
    const listed = (await (
      await call(h, "/api/recorder/connections", { headers: COOKIE })
    ).json()) as { connections: { id: string }[] };
    expect(listed.connections.map((c) => c.id)).not.toContain(
      made.connection.id,
    );
  });

  test("me, the person's own Learning space and the connections list", async () => {
    const h = build();
    const made = await connect(h, "1".repeat(32));
    // Connecting the browser starts making the person's space, so it is there before the first recording.
    expect(h.kicked).toEqual([owner]);
    const me = await call(h, "/api/recorder/me", {
      headers: bearer(made.token),
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      user: { id: owner, email: `${owner}@example.test`, name: "The Owner" },
      connectionId: made.connection.id,
    });

    const learning = await call(h, "/api/recorder/learning", {
      headers: bearer(made.token),
    });
    expect(learning.status).toBe(200);
    const answer = (await learning.json()) as {
      learning: { state: string; containerId: string | null };
    };
    expect(LEARNING_SPACE_STATES as readonly string[]).toContain(
      answer.learning.state,
    );
    expect(answer.learning).toEqual({
      state: "assigned",
      containerId: `space-of-${owner}`,
    });
    // There is no Bot list any more: a recording is the person's, not a Bot's.
    expect(
      (await call(h, "/api/recorder/bots", { headers: bearer(made.token) }))
        .status,
    ).toBe(404);

    const listed = (await (
      await call(h, "/api/recorder/connections", { headers: COOKIE })
    ).json()) as {
      connections: { id: string }[];
      extensionIds: string[];
    };
    expect(listed.connections.map((c) => c.id)).toContain(made.connection.id);
    expect(listed.extensionIds).toEqual([RECORDER_EXTENSION_ID]);
  });

  test("the connections list says which browser is recording now, from its Recorder's own recent report", async () => {
    // End-to-end run: a browser recording right now read "last used 49 seconds ago", since a recording streams to the
    // gateway and reaches OpenBot only with its activity reports.
    const h = build();
    const made = await connect(h, "5".repeat(32));
    const recordingNow = async () => {
      const listed = (await (
        await call(h, "/api/recorder/connections", { headers: COOKIE })
      ).json()) as RecorderConnectionsResponse;
      return listed.connections.find(
        (connection) => connection.id === made.connection.id,
      )?.recording;
    };
    const report = async (phase: "recording" | "idle") =>
      expect(
        (
          await call(h, "/api/recorder/activity", {
            method: "POST",
            headers: bearer(made.token),
            json: { phase, recordingId: "rec-1", actions: 3 },
          })
        ).status,
      ).toBe(204);
    expect(await recordingNow()).toBe(false);
    await report("recording");
    expect(await recordingNow()).toBe(true);
    // A report from a browser that went quiet mid-recording stops standing after its window.
    await database
      .update(recorderConnections)
      .set({
        activityAt: new Date(Date.now() - RECORDER_ACTIVITY_STALE_MS - 1_000),
      })
      .where(eq(recorderConnections.id, made.connection.id));
    expect(await recordingNow()).toBe(false);
    await report("recording");
    expect(await recordingNow()).toBe(true);
    await report("idle");
    expect(await recordingNow()).toBe(false);
  });

  test("disconnecting signs the browser out", async () => {
    const h = build();
    const made = await connect(h, "3".repeat(32));
    const gone = await call(h, "/api/recorder/connections/current", {
      method: "DELETE",
      headers: bearer(made.token),
    });
    expect(gone.status).toBe(204);
    expect(
      h.audits.find((a) => a.eventType === "recorder.revoked")?.payload,
    ).toMatchObject({ connectionId: made.connection.id });
    const after = await call(h, "/api/recorder/me", {
      headers: bearer(made.token),
    });
    expect(after.status).toBe(401);
    expect(((await after.json()) as { code: string }).code).toBe(
      RECORDER_SIGNED_OUT,
    );
    expect(
      h.audits.filter((a) => a.eventType === "recorder.bearer_refused"),
    ).toHaveLength(1);
  });

  test("a person removes one of their connections from the list", async () => {
    const h = build();
    const made = await connect(h, "4".repeat(32));
    const removed = await call(
      h,
      `/api/recorder/connections/${made.connection.id}`,
      { method: "DELETE", headers: COOKIE },
    );
    expect(removed.status).toBe(204);
    const missing = await call(h, "/api/recorder/connections/nope", {
      method: "DELETE",
      headers: COOKIE,
    });
    expect(missing.status).toBe(404);
    expect(
      (await call(h, "/api/recorder/me", { headers: bearer(made.token) }))
        .status,
    ).toBe(401);
  });

  test("the bearer cannot transcribe speech, even with the dictation header", async () => {
    const h = build();
    const made = await connect(h, "5".repeat(32));
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(8)], "recording.webm", { type: "audio/webm" }),
    );
    const answer = await h.app.request(
      "http://openbot.test/api/audio/transcriptions",
      {
        method: "POST",
        headers: { ...bearer(made.token), "x-openbot-dictation": "1" },
        body: form,
      },
    );
    expect(answer.status).toBe(401);
    expect(await answer.json()).toEqual({ error: "Authentication required." });
    expect(transcribed).toBe(0);
  });

  test("OpenBot takes no recording from the Recorder, not even with its bearer", async () => {
    const h = build();
    const made = await connect(h, "6".repeat(32));
    for (const [method, path] of [
      ["POST", "/api/recorder/demonstrations"],
      ["GET", "/api/recorder/demonstrations/open?botId=mine"],
      ["POST", "/api/recorder/demonstrations/x/actions"],
      ["POST", "/api/recorder/demonstrations/x/media"],
      ["PUT", "/api/recorder/demonstrations/x/media/m/chunks/0"],
    ]) {
      const answer = await call(h, path, {
        method,
        headers: bearer(made.token),
        ...(method === "GET" ? {} : { json: {} }),
      });
      expect([method, path, answer.status]).toEqual([method, path, 404]);
    }
  });
});

describe("recordings", () => {
  test("a person sees only their own recordings, newest first, 50 at a time", async () => {
    const mine = Array.from({ length: 51 }, () => randomUUID());
    const theirs = randomUUID();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    await database.insert(recorderTrajectoryBindings).values([
      ...mine.map((trajectoryId, index) => ({
        trajectoryId,
        userId: owner,
        createdAt: new Date(base + index * 1_000),
      })),
      { trajectoryId: theirs, userId: busy, createdAt: new Date(base) },
    ]);
    const asked: string[] = [];
    const intelligenceFetch = (async (input: Request | string | URL) => {
      const url = String(input);
      asked.push(url);
      const ids = (new URL(url).searchParams.get("ids") ?? "")
        .split(",")
        .filter(Boolean);
      return Response.json({
        items: ids.map((trajectoryId) => ({
          trajectoryId,
          createdAt: new Date(base).toISOString(),
          firstEventAt: new Date(base).toISOString(),
          lastEventAt: new Date(base).toISOString(),
          eventCount: 3,
          workflow: "Send the report",
          outcome: { phase: "succeeded", reason: null },
        })),
      });
    }) as unknown as typeof fetch;
    const h = build({}, { intelligenceFetch });

    const anonymous = await call(h, "/api/recorder/recordings");
    expect(anonymous.status).toBe(401);

    const first = await call(h, "/api/recorder/recordings", {
      headers: COOKIE,
    });
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as RecordingsPage;
    expect(page1.recordings).toHaveLength(50);
    expect(page1.recordings.map((row) => row.id)).toEqual(
      [...mine].reverse().slice(0, 50),
    );
    expect(page1.nextCursor).not.toBeNull();

    const second = await call(
      h,
      `/api/recorder/recordings?cursor=${encodeURIComponent(page1.nextCursor ?? "")}`,
      { headers: COOKIE },
    );
    const page2 = (await second.json()) as RecordingsPage;
    expect(page2.recordings.map((row) => row.id)).toEqual([mine[0]]);
    expect(page2.nextCursor).toBeNull();

    expect(asked.join(" ")).not.toContain(theirs);
    expect(JSON.stringify([page1, page2])).not.toContain(theirs);

    const bad = await call(h, "/api/recorder/recordings?cursor=nonsense", {
      headers: COOKIE,
    });
    expect(bad.status).toBe(400);

    const farYear = Buffer.from(
      `+010000-01-01T00:00:00.000Z|${randomUUID()}`,
    ).toString("base64url");
    const far = await call(h, `/api/recorder/recordings?cursor=${farYear}`, {
      headers: COOKIE,
    });
    expect(far.status).toBe(400);
  });
});

const noIntelligence = {
  INTELLIGENCE_API_URL: undefined,
  INTELLIGENCE_GATEWAY_WS_URL: undefined,
  INTELLIGENCE_API_KEY: undefined,
  COPILOTKIT_LICENSE_TOKEN: undefined,
};

test("a connected Recorder submits an OpenBot recording once without Intelligence", async () => {
  const h = build(noIntelligence);
  const { token } = await connect(h);
  expect(h.kicked).toEqual([]);
  const learning = await call(h, "/api/recorder/learning", {
    headers: bearer(token),
  });
  expect(learning.status).toBe(200);
  expect(await learning.json()).toEqual({
    learning: { state: "openbot", containerId: null },
  });
  const recordingId = randomUUID();
  const trajectoryId = randomUUID();
  const path = `/api/recorder/capture/${trajectoryId}`;
  const headers = { ...bearer(token), origin: ORIGIN };
  const grant = await call(h, `${path}/grant`, {
    method: "POST",
    headers,
    json: { recordingId },
  });
  expect(grant.status).toBe(200);
  const { token: captureToken } = await grant.json();
  const submit = () =>
    call(h, `${path}/events`, {
      method: "POST",
      headers,
      json: {
        captureToken,
        dropped: 0,
        events: [
          {
            type: "CUSTOM",
            name: "outcome",
            timestamp: Date.now(),
            value: { seq: 1, workflow: "Build a report", phase: "succeeded" },
          },
        ],
      },
    });
  const submissions = await Promise.all([submit(), submit()]);
  expect(submissions.map((response) => response.status)).toEqual([200, 200]);
  const list = await call(h, "/api/recorder/recordings", { headers: COOKIE });
  const { recordings }: RecordingsPage = await list.json();
  expect(recordings.filter((row) => row.id === recordingId)).toEqual([
    expect.objectContaining({ title: "Build a report", ended: "succeeded" }),
  ]);
});

test("only the recording owner can read it, and deleting it revokes evidence and replay", async () => {
  const h = build(noIntelligence);
  const otherCookie = { cookie: "test-session=other" };
  const { token } = await connect(h, randomUUID().replaceAll("-", ""));
  const other = await connect(h, "d".repeat(32), otherCookie);
  const recordingId = randomUUID();
  const trajectoryId = randomUUID();
  const path = `/api/recorder/capture/${trajectoryId}`;
  const detailPath = `/api/recorder/recordings/${recordingId}`;
  const ownerHeaders = { ...bearer(token), origin: ORIGIN };
  const otherHeaders = { ...bearer(other.token), origin: ORIGIN };
  const grant = (headers: Record<string, string>, id = recordingId) =>
    call(h, `${path}/grant`, {
      method: "POST",
      headers,
      json: { recordingId: id },
    });
  const { token: captureToken } = await (await grant(ownerHeaders)).json();
  const batch = {
    captureToken,
    dropped: 0,
    events: [
      {
        type: "CUSTOM",
        name: "outcome",
        timestamp: Date.now(),
        value: {
          seq: 1,
          phase: "succeeded",
          workflow: "Visible only to the owner",
        },
      },
    ],
  };
  const upload = (
    headers: Record<string, string>,
    capability = captureToken,
    trajectoryPath = path,
  ) =>
    call(h, `${trajectoryPath}/events`, {
      method: "POST",
      headers,
      json: { ...batch, captureToken: capability },
    });
  expect((await upload(ownerHeaders, "")).status).toBe(403);
  expect((await upload(otherHeaders)).status).toBe(403);
  expect(
    (
      await upload(
        ownerHeaders,
        captureToken,
        `/api/recorder/capture/${randomUUID()}`,
      )
    ).status,
  ).toBe(403);
  expect((await grant(otherHeaders)).status).toBe(404);
  expect((await grant(otherHeaders, randomUUID())).status).toBe(404);
  expect((await upload(ownerHeaders)).status).toBe(200);
  expect((await upload(ownerHeaders)).status).toBe(200);
  const detail = await call(h, detailPath, { headers: COOKIE });
  expect(detail.status).toBe(200);
  expect((await detail.json()).events).toEqual(batch.events);
  expect((await call(h, detailPath, { headers: otherCookie })).status).toBe(
    404,
  );
  expect((await call(h, detailPath, { headers: otherHeaders })).status).toBe(
    401,
  );
  expect(
    (await call(h, detailPath, { method: "DELETE", headers: otherCookie }))
      .status,
  ).toBe(404);
  expect(
    (await h.recorder.recordingTitles(owner, [recordingId])).get(recordingId),
  ).toBe("Visible only to the owner");
  expect(
    (await call(h, detailPath, { method: "DELETE", headers: COOKIE })).status,
  ).toBe(204);
  expect((await call(h, detailPath, { headers: COOKIE })).status).toBe(404);
  expect(
    (await h.recorder.recordingTitles(owner, [recordingId])).has(recordingId),
  ).toBe(false);
  expect((await upload(ownerHeaders)).status).toBe(404);
  expect((await grant(ownerHeaders)).status).toBe(404);
  const [marker] = await database
    .select()
    .from(recorderRecordings)
    .where(eq(recorderRecordings.id, recordingId));
  expect(marker).toMatchObject({
    deletedAt: expect.any(Date),
    cleanupCompletedAt: expect.any(Date),
    title: null,
    reason: null,
  });
  expect(
    await database
      .select()
      .from(recorderRecordingEvents)
      .where(eq(recorderRecordingEvents.recordingId, recordingId)),
  ).toEqual([]);
}, 30_000);

test("a signed capture grant expires at its deadline and a new grant can submit", async () => {
  const h = build(noIntelligence);
  const { token } = await connect(h, randomUUID().replaceAll("-", ""));
  const headers = { ...bearer(token), origin: ORIGIN };
  const recordingId = randomUUID();
  const path = `/api/recorder/capture/${randomUUID()}`;
  const grant = () =>
    call(h, `${path}/grant`, {
      method: "POST",
      headers,
      json: { recordingId },
    });
  const now = Date.now;
  let time = now();
  Date.now = () => time;
  try {
    const { token: captureToken } = await (await grant()).json();
    const submit = (capability: string) =>
      call(h, `${path}/events`, {
        method: "POST",
        headers,
        json: {
          captureToken: capability,
          dropped: 0,
          events: [
            {
              type: "CUSTOM",
              name: "outcome",
              timestamp: now(),
              value: { seq: 1, phase: "succeeded", workflow: "Renewed grant" },
            },
          ],
        },
      });
    time += 5 * 60_000;
    const expired = await submit(captureToken);
    expect(expired.status).toBe(403);
    expect(await expired.json()).toEqual({ reason: "capture_grant_expired" });
    expect(
      (
        await call(h, `/api/recorder/recordings/${recordingId}`, {
          headers: COOKIE,
        })
      ).status,
    ).toBe(404);
    const renewed = await (await grant()).json();
    expect((await submit(renewed.token)).status).toBe(200);
  } finally {
    Date.now = now;
  }
}, 30_000);

async function waitForRecorder(
  description: string,
  condition: () => Promise<boolean>,
) {
  const deadline = performance.now() + 10_000;
  do {
    if (await condition()) return;
    await Bun.sleep(100);
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

// Playwright evaluates this browser-provided API inside the Chromium page.
declare const chrome: {
  runtime: {
    sendMessage(
      extensionId: string,
      message: Record<string, unknown>,
    ): Promise<unknown>;
  };
};

const recorderDist = process.env.OPENBOT_TEST_RECORDER_DIST;
test.skipIf(!recorderDist)(
  "Chromium Recorder masks a password, submits without Intelligence, and cannot replay after deletion",
  async () => {
    if (!recorderDist)
      throw new Error("Set OPENBOT_TEST_RECORDER_DIST to the built extension");
    const dist = resolve(recorderDist);
    const profile = await mkdtemp(
      resolve(tmpdir(), "openbot-recorder-chromium-"),
    );
    const h = build(noIntelligence);
    const submissions: Request[] = [];
    const responses: string[] = [];
    const site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname.startsWith("/api/")) {
          if (pathname.endsWith("/events") && request.method === "POST")
            submissions.push(request.clone());
          const response = await h.app.fetch(request);
          responses.push(`${request.method} ${pathname} ${response.status}`);
          return response;
        }
        return new Response(
          `<title>Recorder test</title><form onsubmit="event.preventDefault()">
      <label>Password <input type="password" name="password" autocomplete="current-password"></label>
      <label>Note <input name="note"></label><button>Save task</button>
    </form>`,
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    const origin = site.url.origin;
    try {
      const browser = await chromium.launchPersistentContext(profile, {
        channel: "chromium",
        executablePath: process.env.OPENBOT_TEST_CHROMIUM,
        args: [
          `--disable-extensions-except=${dist}`,
          `--load-extension=${dist}`,
        ],
      });
      try {
        const page = await browser.newPage();
        await page.goto(origin);
        const minted = await call(h, "/api/recorder/connect-codes", {
          method: "POST",
          headers: COOKIE,
          json: { via: "web" },
        });
        expect(minted.status).toBe(201);
        const { code } = await minted.json();
        const message = (payload: Record<string, unknown>) =>
          page.evaluate(
            ({ id, payload }) => chrome.runtime.sendMessage(id, payload),
            { id: RECORDER_EXTENSION_ID, payload },
          );
        const connectPage = browser.waitForEvent("page", {
          timeout: 10_000,
          predicate: async (tab) => {
            if (tab.url().includes("setup.html")) return false;
            await tab
              .waitForURL("**/connect.html*", { timeout: 5_000 })
              .catch(() => undefined);
            return tab.url().includes("connect.html");
          },
        });
        expect(await message({ type: "openbot.connect", code })).toMatchObject({
          ok: true,
        });
        const approval = await connectPage;
        await approval
          .getByRole("button", { name: "Connect", exact: true })
          .click();
        await approval.getByText(/^Connected as /).waitFor({ timeout: 10_000 });
        expect(await message({ type: "openbot.state" })).toMatchObject({
          connected: true,
        });

        await page.bringToFront();
        const title = "Save the fixture task";
        expect(
          await message({ type: "openbot.record", title, narrate: false }),
        ).toEqual(expect.objectContaining({ ok: true }));
        const password = "FixtureOnly-Recorder-72398!";
        await page.getByLabel("Password").pressSequentially(password);
        await page.getByLabel("Note").fill("ordinary fixture note");
        await page.getByRole("button", { name: "Save task" }).click();
        await waitForRecorder("captured actions", async () => {
          const state = await message({ type: "openbot.state" });
          return (
            typeof state === "object" &&
            state !== null &&
            "actions" in state &&
            typeof state.actions === "number" &&
            state.actions > 0
          );
        });
        expect(await message({ type: "openbot.stop" })).toMatchObject({
          ok: true,
        });

        const list = async () =>
          (
            await call(h, "/api/recorder/recordings", { headers: COOKIE })
          ).json() as Promise<RecordingsPage>;
        await browser.addCookies([
          { name: "test-session", value: "owner", url: origin },
        ]);
        await waitForRecorder("the uploaded recording to finish", () =>
          page.evaluate(async (name) => {
            const data: RecordingsPage = await (
              await fetch("/api/recorder/recordings")
            ).json();
            return data.recordings.some(
              (row) => row.title === name && row.ended === "succeeded",
            );
          }, title),
        );
        const row = (await list()).recordings.find(
          (item) => item.title === title,
        );
        if (!row) throw new Error("Recorder did not publish a recording");
        const path = `/api/recorder/recordings/${row.id}`;
        const detail = await (await call(h, path, { headers: COOKIE })).text();
        expect(detail).toContain("ordinary fixture note");
        expect(detail).toContain("[redacted]");
        expect(detail).not.toContain(password);
        const submitted = await Promise.all(
          submissions.map((request) => request.clone().text()),
        );
        expect(submitted.join("\n")).not.toContain(password);
        const replay = submissions.find((_, i) =>
          submitted[i]?.includes(title),
        );
        if (!replay) throw new Error("Recorder submitted no outcome");
        expect((await h.app.fetch(replay.clone())).status).toBe(200);
        expect(
          (await list()).recordings.filter(({ id }) => id === row.id),
        ).toHaveLength(1);
        expect(await (await call(h, path, { headers: COOKIE })).text()).toBe(
          detail,
        );
        expect(
          (await call(h, path, { headers: COOKIE, method: "DELETE" })).status,
        ).toBe(204);
        expect((await call(h, path, { headers: COOKIE })).status).toBe(404);
        expect((await h.app.fetch(replay.clone())).status).toBe(404);
      } catch (error) {
        throw new Error(`Chromium Recorder requests: ${responses.join(", ")}`, {
          cause: error,
        });
      } finally {
        await browser.close();
      }
    } finally {
      await site.stop(true);
      await rm(profile, { recursive: true, force: true });
    }
  },
  60_000,
);
