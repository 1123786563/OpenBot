import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

async function call(path, status, body) {
  const response = await fetch(`http://127.0.0.1:3001${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${path}: ${text}`);
  return text;
}

const { agent } = JSON.parse(await call("/api/agents", 201, {
  name: "Offline pilot Bot",
  title: "Pilot acceptance",
  roleDescription: "Respond to offline pilot requests.",
  visibility: "private",
}));
assert.ok(agent?.id, "created a Bot through the public API");
const { channel } = JSON.parse(await call("/api/channels", 201, { agentIds: [agent.id] }));
assert.ok(channel?.id && channel.threadId, "created a conversation through the public API");
const runId = randomUUID();
const accepted = JSON.parse(await call(`/api/copilotkit/agent/${encodeURIComponent(agent.id)}/run`, 200, {
  threadId: channel.threadId,
  runId,
  state: {},
  messages: [{ id: randomUUID(), role: "user", content: "Reply for the isolated pilot smoke test." }],
  tools: [],
  context: [],
  forwardedProps: {},
}));
assert.equal(accepted.runId, runId);
const deadline = Date.now() + 20_000;
let events;
do {
  const response = await fetch(`http://fixture:4200/events/${encodeURIComponent(accepted.threadId)}`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  events = await response.json();
  if (events.some((event) => event.type === "RUN_FINISHED" && event.runId === runId)) break;
  await Bun.sleep(250);
} while (Date.now() < deadline);
assert.ok(events.some((event) => event.type === "RUN_FINISHED" && event.runId === runId), JSON.stringify(events));
const reply = events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => event.delta).join("");
assert.equal(reply, "Offline pilot Bot reply.");
console.log(JSON.stringify({ type: "bot-request", agentId: agent.id, channelId: channel.id, runId, reply }));

// Allow at least 15 seconds to create the hourly Routine before its first UTC slot.
const minute = new Date(Date.now() + 75_000).getUTCMinutes();
const { routine } = JSON.parse(await call("/api/routines", 201, {
  agentId: agent.id,
  channelId: channel.id,
  title: "Pilot worker schedule",
  instruction: "Reply for the scheduled pilot smoke test.",
  cron: `${minute} * * * *`,
  timezone: "UTC",
}));
assert.ok(routine?.id);
const due = Date.parse(routine.nextRunAt);
assert.ok(due > Date.now() && due - Date.now() <= 120_000, `Unexpected next run ${routine.nextRunAt}`);
console.log(JSON.stringify({ type: "routine-created", routineId: routine.id, dueAt: routine.nextRunAt }));
let runs;
while (Date.now() < due + 100_000) {
  ({ runs } = JSON.parse(await call(`/api/routines/${routine.id}/runs`, 200)));
  const scheduled = runs.find((run) => run.source === "schedule" && run.finishedAt);
  if (scheduled) {
    assert.equal(scheduled.status, "succeeded", JSON.stringify(scheduled));
    console.log(JSON.stringify({ type: "worker-task", routineId: routine.id, ...scheduled }));
    process.exit(0);
  }
  await Bun.sleep(2_000);
}
assert.fail(`Worker did not complete the scheduled Routine: ${JSON.stringify(runs)}`);
