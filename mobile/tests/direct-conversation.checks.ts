import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ConversationSnapshot,
  directConversation,
} from "../src/direct-conversation.ts";

const threadId = "thread";
const agentId = "bot";
const turn = { runId: "run", messageId: "message", text: "Hello" };

test("an ambiguous submit retries the same message and Run and discovers the canonical records", async () => {
  const bodies: unknown[] = [];
  const client = directConversation(
    async (path, request) => {
      if (path === "/api/copilotkit/agent/bot/run") {
        bodies.push(JSON.parse(String(request?.body)));
        if (bodies.length === 1) throw new Error("Connection lost");
        return new Response("", { headers: { "x-openbot-run-replay": "run" } });
      }
      assert.equal(path, "/api/copilotkit/threads/thread/messages?agentId=bot");
      return Response.json({
        messages: [{ id: "message", role: "user", content: "Hello" }],
        runs: [{ id: "run", userMessageId: "message", status: "running" }],
      });
    },
    { threadId, agentId },
  );
  await assert.rejects(client.submit(turn), /Connection lost/);
  await client.submit(turn);
  assert.deepEqual(
    bodies,
    Array(2).fill({
      threadId,
      runId: "run",
      messages: [{ id: "message", role: "user", content: "Hello" }],
    }),
  );
  assert.deepEqual(await client.history(), {
    messages: [{ id: "message", role: "user", content: "Hello" }],
    runs: [{ id: "run", userMessageId: "message", status: "running" }],
    approvals: [],
  });
});

test("replay resumes at the last delivered position and reads an expired-cursor snapshot with partial output", async () => {
  const positions: number[] = [];
  const snapshots: ConversationSnapshot[] = [];
  const client = directConversation(
    async (path, request) => {
      if (path.endsWith("/resume")) {
        const { cursor } = JSON.parse(String(request?.body));
        positions.push(cursor);
        const frame =
          positions.length === 1
            ? 'id: 7\ndata: {"type":"TEXT_MESSAGE_CONTENT"}\n\n'
            : 'data: {"type":"MESSAGES_SNAPSHOT"}\n\nid: 15\ndata: {"type":"CUSTOM","name":"openbot.run.snapshot"}\n\n';
        return new Response(frame, {
          headers: { "x-openbot-run-replay": "run" },
        });
      }
      return Response.json({
        messages: [
          {
            id: "answer",
            role: "assistant",
            content: positions.length === 1 ? "par" : "partial",
          },
        ],
        runs: [{ id: "run", userMessageId: "message", status: "running" }],
      });
    },
    { threadId, agentId },
  );
  const refresh = async () => {
    snapshots.push(await client.history());
  };
  const signal = new AbortController().signal;
  await client.follow("run", refresh, signal);
  await client.follow("run", refresh, signal);
  assert.deepEqual(positions, [0, 7]);
  assert.deepEqual(
    snapshots.map(({ messages }) => messages[0]?.content),
    ["par", "partial"],
  );
});

test("only the current Run's approvals appear and access loss rejects Run control", async () => {
  let authorized = true;
  const approval = {
    id: "approval",
    status: "pending",
    action: { threadId, toolRef: "tool", scope: "scope", args: {} },
  };
  const controls: string[] = [];
  const client = directConversation(
    async (path, request) => {
      if (!authorized)
        return Response.json(
          { error: "Conversation not found." },
          { status: 404 },
        );
      if (path.endsWith("/messages?agentId=bot")) {
        return Response.json({
          messages: [],
          runs: [
            {
              id: "run",
              userMessageId: "message",
              status: "running",
              pendingApprovals: [{ id: approval.id }],
            },
          ],
        });
      }
      if (path === "/api/approvals") {
        return Response.json({
          requests: [approval, { ...approval, id: "another-approval" }],
        });
      }
      assert.equal(request?.method, "POST");
      controls.push(path);
      if (path.endsWith("/decision"))
        assert.deepEqual(JSON.parse(String(request.body)), {
          decision: "allow_once",
        });
      return Response.json({});
    },
    { threadId, agentId },
  );
  assert.deepEqual((await client.history()).approvals, [approval]);
  await client.decide(approval.id, "allow_once");
  await client.stop(turn.runId);
  assert.deepEqual(controls, [
    "/api/approvals/approval/decision",
    "/api/copilotkit/threads/thread/runs/run/stop?agentId=bot",
  ]);
  authorized = false;
  await assert.rejects(client.history(), { status: 404, accessLost: true });
  await assert.rejects(client.stop(turn.runId), {
    status: 404,
    accessLost: true,
  });
  await assert.rejects(client.reconcile(turn.runId), {
    status: 404,
    accessLost: true,
  });
});

test("a context-revoked Run leaves the Conversation history readable", async () => {
  const revoked = {
    id: "older-run",
    userMessageId: "older-message",
    status: "failed",
    stopReason: "context_revoked",
  };
  const running = {
    id: turn.runId,
    userMessageId: turn.messageId,
    status: "running",
  };
  const client = directConversation(
    async () =>
      Response.json({
        messages: [
          { id: "older-message", role: "user", content: "Earlier request" },
        ],
        runs: [revoked, running],
      }),
    { threadId, agentId },
  );

  const snapshot = await client.history();
  assert.equal(snapshot.messages[0]?.content, "Earlier request");
  assert.deepEqual(snapshot.runs, [revoked, running]);
});

test("checking an unknown outcome refreshes the original Run without submitting again", async () => {
  const requests: string[] = [];
  let verified = false;
  const client = directConversation(
    async (path, request) => {
      requests.push(path);
      if (request?.method === "POST") {
        assert.equal(
          path,
          "/api/copilotkit/threads/thread/runs/run/reconcile?agentId=bot",
        );
        verified = true;
        return Response.json({ externalOutcome: "executed" });
      }
      return Response.json({
        messages: verified
          ? [{ id: "answer", role: "assistant", content: "Verified result" }]
          : [],
        runs: [
          {
            id: turn.runId,
            userMessageId: turn.messageId,
            status: "failed",
            externalOutcome: verified ? "executed" : "unknown",
          },
        ],
      });
    },
    { threadId, agentId },
  );
  assert.equal((await client.history()).runs[0]?.externalOutcome, "unknown");
  await client.reconcile(turn.runId);
  const snapshot = await client.history();
  assert.equal(snapshot.runs[0]?.id, turn.runId);
  assert.equal(snapshot.runs[0]?.externalOutcome, "executed");
  assert.equal(snapshot.messages[0]?.content, "Verified result");
  assert.equal(requests.length, 3);
});
