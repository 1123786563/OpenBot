import { afterAll, expect, test } from "bun:test";

const fixture = Bun.spawn(
  ["bun", "--no-env-file", "scripts/browser-acceptance/api.mjs"],
  {
    env: { ...process.env, FIXTURE_API_PORT: "0" },
    stdout: "pipe",
    stderr: "inherit",
  },
);
afterAll(() => fixture.kill());

const origin = (async () => {
  const reader = fixture.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const address = new TextDecoder()
    .decode(value)
    .match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (!address) throw new Error("Fixture API did not announce its port");
  await fetch(`${address}/__fixture/session?signedIn=true`, {
    redirect: "manual",
  });
  return address;
})();

async function request(path, options) {
  return fetch((await origin) + path, options);
}

test("the shell can load an empty Bot attention feed", async () => {
  const response = await request("/api/bots/attention");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ bots: [], lastPingId: null });
});

test("a fresh direct thread can connect and read empty history", async () => {
  const mint = await request("/api/threads/mint", { method: "POST" });
  expect(mint.status).toBe(200);
  const { threadId } = await mint.json();
  expect(threadId).toMatch(/^[\da-f-]{36}$/i);
  const connect = await request("/api/copilotkit/agent/whatif-sales/connect", {
    method: "POST",
    body: JSON.stringify({
      threadId,
      runId: crypto.randomUUID(),
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
    }),
  });
  expect(connect.status).toBe(200);
  expect(connect.headers.get("content-type")).toBe("text/event-stream");
  expect(await connect.text()).toBe("");
  const history = await request(`/api/copilotkit/threads/${threadId}/messages`);
  expect(history.status).toBe(200);
  expect(await history.json()).toEqual({ messages: [] });
  const unknown = await request("/api/copilotkit", {
    method: "POST",
    body: JSON.stringify({ method: "unknown" }),
  });
  expect(unknown.status).toBe(501);
});

test("opening a seeded conversation exposes its transcript and records a read", async () => {
  const detail = await request("/api/channels/acceptance-plan");
  expect(detail.status).toBe(200);
  expect((await detail.json()).channel.threadId).toBe("acceptance-plan");
  const group = await request("/api/groups/acceptance-plan");
  expect(group.status).toBe(200);
  expect(await group.json()).toMatchObject({
    bots: [{ id: "general", name: "General Assistant" }],
    messages: [],
  });
  const read = await request("/api/channels/acceptance-plan/read", {
    method: "PUT",
  });
  expect(read.status).toBe(204);
  const roster = await request("/api/channels");
  expect((await roster.json()).channels).toContainEqual(
    expect.objectContaining({
      id: "acceptance-plan",
      lastReadAt: expect.any(String),
    }),
  );
  expect((await request("/api/channels/acceptance-plan/read")).status).toBe(
    501,
  );
});

test("the onboarding page can save progress without gating other fixture pages", async () => {
  const save = await request("/api/me/onboarding", {
    method: "POST",
    body: JSON.stringify({ step: 1 }),
  });
  expect(save.status).toBe(200);
  const expected = { step: 1, completedAt: null };
  expect(await save.json()).toEqual({ onboarding: expected });
  const currentUser = await request("/api/me");
  expect((await currentUser.json()).user.onboarding).toBeNull();
});

test("a seeded chat can load its saved voice sessions and Learning status", async () => {
  const voice = await request("/api/voice/sessions?channelId=acceptance-plan");
  expect(voice.status).toBe(200);
  expect(await voice.json()).toEqual({ sessions: [], nextCursor: null });
  const learning = await request(
    "/api/copilotkit/threads/acceptance-plan/learn?agentId=general",
  );
  expect(learning.status).toBe(200);
  expect(await learning.json()).toMatchObject({
    enabled: false,
    proposals: [],
    scope: {
      personId: "browser-acceptance",
      threadId: "acceptance-plan",
      botId: "general",
    },
  });
});
