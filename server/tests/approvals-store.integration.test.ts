import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalCandidate,
  ApprovalNotFoundError,
  approvalAction,
} from "../src/approvals/types";
import { createDatabase } from "../src/db/client";
import { approvalRequests } from "../src/db/schema/approvals";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `approval-${randomUUID()}`;
const owner = `${prefix}-owner`,
  stranger = `${prefix}-stranger`;
const store = createApprovalStore(database);
const keys: string[] = [];
beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: stranger, email: `${stranger}@example.test` },
  ]);
});
afterAll(async () => {
  if (keys.length)
    await database
      .delete(workItems)
      .where(
        and(
          eq(workItems.kind, "approval.resume"),
          inArray(workItems.key, keys),
        ),
      );
  await database.delete(users).where(inArray(users.id, [owner, stranger]));
  await database.$client.close();
});
function candidate(scope = "project"): ApprovalCandidate {
  const runId = randomUUID();
  return {
    actorId: owner,
    botId: `${prefix}-bot`,
    toolRef: "computer_write_file",
    effect: "write",
    scope,
    args: { path: "notes.txt", contents: "saved" },
    target: { filePath: `${scope}/notes.txt` },
    continuation: {
      runId,
      threadId: `${prefix}-thread`,
      toolCallId: randomUUID(),
      toolName: "computer_write_file",
      args: { path: "notes.txt", contents: "saved" },
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
  };
}
test("PostgreSQL stores one immutable owned request, one decision queue item and one atomic consumption", async () => {
  await store.setEnabled(owner, true);
  const action = approvalAction(candidate());
  const requests = await Promise.all([store.open(action), store.open(action)]);
  const request = requests[0];
  if (!request) throw new Error("missing request");
  keys.push(request.id);
  expect(requests[1]?.id).toBe(request.id);
  await expect(store.get(stranger, request.id)).rejects.toBeInstanceOf(
    ApprovalNotFoundError,
  );
  await expect(
    store.decide(stranger, request.id, "allow_once"),
  ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  const choices = await Promise.allSettled([
    store.decide(owner, request.id, "allow_once"),
    store.decide(owner, request.id, "allow_once"),
  ]);
  expect(
    choices.filter((choice) => choice.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    await database
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, "approval.resume"),
          eq(workItems.key, request.id),
        ),
      ),
  ).toHaveLength(1);
  const consumed = await Promise.all([
    store.consume(owner, request.id, action.actionDigest),
    store.consume(owner, request.id, action.actionDigest),
  ]);
  expect(consumed.filter(Boolean)).toHaveLength(1);
  await store.saveResult(owner, request.id, { content: '{"saved":true}' });
  await store.finish(owner, request.id);
  const restarted = createApprovalService(createApprovalStore(database));
  expect(await restarted.gate({ ...action })).toMatchObject({
    replay: { saved: true },
  });
  await expect(
    store.open(approvalAction({ ...action, args: { path: "different.txt" } })),
  ).rejects.toThrow("changed");
});
test("PostgreSQL persistent permissions are exact, revocable and denied choices stay durable", async () => {
  const first = await store.open(approvalAction(candidate("persistent")));
  keys.push(first.id);
  await store.decide(owner, first.id, "allow_always");
  const subsequent = await store.open(approvalAction(candidate("persistent")));
  keys.push(subsequent.id);
  expect(subsequent.status).toBe("approved");
  const elsewhere = await store.open(
    approvalAction(candidate("other-project")),
  );
  keys.push(elsewhere.id);
  expect(elsewhere.status).toBe("pending");
  const [rule] = await store.rules(owner);
  if (!rule) throw new Error("missing rule");
  await expect(store.revoke(stranger, rule.id)).rejects.toBeInstanceOf(
    ApprovalNotFoundError,
  );
  await store.revoke(owner, rule.id);
  expect(
    await store.consume(owner, subsequent.id, subsequent.action.actionDigest),
  ).toBe(false);
  const denied = await store.open(approvalAction(candidate("deny")));
  keys.push(denied.id);
  await store.decide(owner, denied.id, "deny");
  const restarted = createApprovalService(createApprovalStore(database));
  await expect(restarted.gate(denied.action)).rejects.toThrow("declined");
});

test("a Thread inbox sees older pending requests without exposing another person's requests", async () => {
  const action = approvalAction(candidate("thread-inbox"));
  const request = await store.open(action);
  const newer = approvalAction(candidate("other-thread"));
  await database.insert(approvalRequests).values(
    Array.from({ length: 100 }, () => ({
      id: randomUUID(),
      ownerUserId: owner,
      runId: randomUUID(),
      toolCallId: randomUUID(),
      actionDigest: newer.actionDigest,
      action: { ...newer, threadId: "other-thread" },
      status: "pending" as const,
      createdAt: new Date(request.createdAt.getTime() + 1000),
    })),
  );
  expect(
    (await store.list(owner)).some((entry) => entry.id === request.id),
  ).toBe(false);

  const inbox = async (actorId: string) => {
    const routes = createApprovalRoutes(
      createApprovalService(store),
      async (context, next) => {
        context.set("actor", {
          id: actorId,
          name: "Test person",
          email: "person@example.test",
          role: "user",
        });
        await next();
      },
    );
    return routes.request(
      `/?${new URLSearchParams({ threadId: action.threadId })}`,
    );
  };
  const own = await inbox(owner);
  expect(own.status).toBe(200);
  const ownBody = await own.json();
  expect(ownBody.requests).toContainEqual(
    expect.objectContaining({ id: request.id, status: "pending" }),
  );
  expect(ownBody.requests).not.toContainEqual(
    expect.objectContaining({
      action: expect.objectContaining({ threadId: "other-thread" }),
    }),
  );
  const other = await inbox(stranger);
  expect(other.status).toBe(200);
  expect(await other.json()).toEqual({ requests: [] });
});
