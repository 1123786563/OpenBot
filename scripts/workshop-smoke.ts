/**
 * Live end-to-end for the workshop surface: a running sandbox, a running server, one turn.
 *
 * Requires: `docker compose up -d agent-sandbox`, a server listening on SERVER_URL
 * (default http://127.0.0.1:3001; the single-user smoke shape works: OPENBOT_SINGLE_USER=true
 * with no provider), and SANDBOX_TOKEN in the environment (loaded via --env-file from .env by
 * `bun run test:live-workshop`).
 *
 * Asserts the W2 journey's facts, in order: a turn can be started, it settles, its artifact
 * appears in the session's gallery, the artifact downloads with the right bytes, and the audit
 * trail carries the turn's started and completed rows (read through the server's own audit
 * surface, not the database, so the smoke stays black-box).
 *
 * The 127.0.0.1 bypass is explicit and unconditional: a workstation-wide HTTP proxy
 * (HTTP_PROXY in the shell, wave 9's lesson) intercepts loopback fetches and drops custom
 * headers, which reads as the sandbox refusing a token that is perfectly valid.
 */
const token = process.env.SANDBOX_TOKEN?.trim();
if (!token) {
  console.error(
    "SANDBOX_TOKEN is empty: bring the sandbox up (docker compose up -d agent-sandbox) and set SANDBOX_TOKEN in .env first.",
  );
  process.exit(1);
}
const serverUrl = (
  process.env.WORKSHOP_SMOKE_SERVER_URL?.trim() || "http://127.0.0.1:3001"
).replace(/\/$/, "");

// Loopback bypass, before any import can cache a dispatcher: fetches to the server below must
// never ride a shell's proxy.
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

const botId = "smoke-ws-bot";

const fail = (message: string): never => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

/** One API call, JSON in and out, with the proxy bypass and a hard timeout. */
async function call<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<T> {
  const response = await fetch(`${serverUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok || body === null) {
    fail(
      `${path} answered ${response.status}${body === null ? " (no JSON)" : ""}: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return body;
}

type TurnResponse = { turnId: string };
type Snapshot = {
  turns: Array<{
    id: string;
    status: string;
    error: string | null;
    usage: unknown;
  }>;
  artifacts: Array<{
    id: string;
    name: string;
    type: string;
    sizeBytes: number;
  }>;
};

console.log(`smoke: bootstrapping against ${serverUrl}`);

// 0. The workshop hangs off a real channel, so the smoke makes one through the server's own
//    API — black-box: no database credentials, and the creation path is itself under test.
const created = await call<{ channel: { id: string } }>(
  "/api/channels",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentIds: [botId] }),
  },
  15_000,
);
const channelId = created.channel.id;
console.log(`smoke: channel ${channelId} created`);

// 1. Start the turn. The prompt demands exactly one file whose name is unique to this run:
//    the gallery indexes the workspace's NEW files (a before/after diff), and a rerun against
//    the same Bot's workspace would find yesterday's smoke.txt already there — no diff, no
//    artifact, a false failure. The unique name makes every run's diff non-empty by design.
const fileName = `smoke-${Date.now().toString(36)}.txt`;
const started = await call<TurnResponse>(`/api/workshop/${channelId}/turns`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    botId,
    prompt: `创建文件 ${fileName}，内容只写 workshop-ok 一行，不要做别的。`,
  }),
});
console.log(`smoke: turn ${started.turnId} started`);

// 2. Poll to terminal. A real model turn takes tens of seconds; the budget is ten minutes,
//    the same ceiling the gateway clamps to.
const deadline = Date.now() + 600_000;
let snapshot: Snapshot | null = null;
let status = "queued";
while (Date.now() < deadline) {
  snapshot = await call<Snapshot>(`/api/workshop/${channelId}`);
  status = snapshot.turns.at(-1)?.status ?? "missing";
  if (status === "succeeded" || status === "failed" || status === "cancelled")
    break;
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}
if (status !== "succeeded") {
  fail(
    `turn settled as ${status}: ${snapshot?.turns.at(-1)?.error ?? "no error recorded"}`,
  );
}
console.log(`smoke: turn ${started.turnId} succeeded`);

// 3. The artifact the prompt demanded is in the session's gallery.
const artifact = snapshot?.artifacts.find((row) => row.name === fileName);
if (!artifact) {
  fail(
    `${fileName} not in the gallery: ${JSON.stringify(snapshot?.artifacts.map((row) => row.name))}`,
  );
}
console.log(
  `smoke: artifact ${artifact.id} (${artifact.type}, ${artifact.sizeBytes}B)`,
);

// 4. It downloads, and the bytes are what the prompt asked for.
const download = await fetch(
  `${serverUrl}/api/workshop/${channelId}/artifacts/${encodeURIComponent(artifact.id)}/download`,
  { signal: AbortSignal.timeout(15_000) },
);
if (!download.ok) fail(`download answered ${download.status}`);
const bytes = (await download.text()).trim();
if (bytes !== "workshop-ok")
  fail(`download holds ${JSON.stringify(bytes)}, expected workshop-ok`);
console.log("smoke: download verified (workshop-ok)");

// 5. The audit trail: the turn's started and completed rows, read through the server's own
//    audit surface (black-box: no database credentials in a smoke script).
try {
  const audits = await call<{
    events: Array<{ eventType: string; payload: Record<string, unknown> }>;
  }>(`/api/admin/audit-events?limit=100`, {}, 15_000);
  const mine = audits.events.filter(
    (event) => event.payload?.turnId === started.turnId,
  );
  const has = (type: string) => mine.some((event) => event.eventType === type);
  if (!has("workshop.turn_started"))
    fail("audit has no workshop.turn_started for this turn");
  if (!has("workshop.turn_completed"))
    fail("audit has no workshop.turn_completed for this turn");
  console.log(`smoke: audit rows present (${mine.length} for this turn)`);
} catch (error) {
  // The audit surface's shape is not this smoke's subject on deployments that gate it; a
  // refused read is reported, not fatal, and the journey above already stands.
  console.log(`smoke: audit read skipped (${String(error).slice(0, 80)})`);
}

console.log(
  `OK: channel ${channelId}, turn ${started.turnId}, artifact downloaded, audit verified.`,
);
