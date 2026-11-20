import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApprovalQuestions } from "../src/approvals/questions";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { approvalAction } from "../src/approvals/types";
import { createDatabase } from "../src/db/client";
import {
  personalSaasAccounts,
  personalWorkspaces,
  users,
} from "../src/db/schema";
import { createAccountAccess } from "../src/personal-saas/account-access";
import { suspensionRoutes } from "../src/personal-saas/workspace-suspension";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
afterAll(() => database.$client.end({ timeout: 5 }));

test.each(["pause", "disablement", "expired status"] as const)(
  "%s invalidates pending approvals and decisions queued before recovery",
  async (cutoff) => {
    const owner = randomUUID();
    let now = Date.now();
    const clock = () => now;
    const active = {
      source: "active" as const,
      observedAt: now,
      confirmedAt: now,
      epoch: 0,
      disablements: [],
    };
    await database
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test` });
    await database.insert(personalSaasAccounts).values({
      id: owner,
      issuer: "test",
      subject: owner,
      email: `${owner}@example.test`,
      status: active,
    });
    const store = createApprovalStore(database, clock);
    const questions = createApprovalQuestions(database, async () => {}, clock);
    const approvals = createApprovalService(store, questions);
    const ask = () =>
      approvalAction({
        actorId: owner,
        botId: "assistant",
        toolRef: "computer_write_file",
        effect: "write",
        scope: "notes",
        args: { path: "notes.txt" },
        target: { filePath: "notes.txt" },
        continuation: {
          runId: randomUUID(),
          threadId: randomUUID(),
          toolCallId: randomUUID(),
          toolName: "computer_write_file",
          args: { path: "notes.txt" },
          messages: [],
          state: {},
          context: [],
          forwardedProps: {},
        },
      });
    const old = await store.open(ask());
    const answered = await store.open(ask());
    const inFlight = await store.open(ask());
    await approvals.decide(owner, inFlight.id, "allow_once");
    const validating = Promise.withResolvers<void>();
    const validated = Promise.withResolvers<void>();
    let dispatched = 0;
    const resume = approvals.resume(owner, inFlight.id, {
      validate: async (action) => {
        validating.resolve();
        await validated.promise;
        return action;
      },
      execute: async () => {
        dispatched++;
      },
      continue: async () => {
        dispatched++;
      },
    });
    await validating.promise;
    await approvals.decide(owner, answered.id, "allow_once");
    const question = {
      actorId: owner,
      botId: "assistant",
      runId: randomUUID(),
      threadId: randomUUID(),
      question: "Continue?",
      mode: "completed_question",
    };
    const queue = createWorkQueue(database, clock);
    const questionKey = randomUUID();
    await queue.offer({
      kind: "person.question",
      key: questionKey,
      accountId: owner,
      payload: question,
    });
    const answeredQuestion = randomUUID();
    await queue.offer({
      kind: "person.question",
      key: answeredQuestion,
      accountId: owner,
      payload: question,
    });
    expect(
      await approvals.answerQuestion(owner, answeredQuestion, "Go ahead", {
        inConversation: true,
      }),
    ).toEqual({ id: answeredQuestion, queued: true });

    let activeAtProvider = true;
    const disablements: { id: string; effectiveAt: number }[] = [];
    const access = createAccountAccess(
      database,
      async () => ({
        issuer: "test",
        subject: owner,
        active: activeAtProvider,
        observedAt: now,
        disablements,
      }),
      clock,
    );

    if (cutoff === "pause") {
      const [workspace] = await database
        .insert(personalWorkspaces)
        .values({
          ownerId: owner,
        })
        .returning();
      if (!workspace) throw new Error("Workspace setup failed");
      const operator = { id: randomUUID(), token: "test-token" };
      const routes = suspensionRoutes(database, operator, clock);
      const change = (action: "pause" | "resume") =>
        routes.request(`/api/operator/workspaces/${workspace.id}/suspension`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${operator.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action, reason: "test" }),
        });
      now += 1;
      const [paused, reply] = await Promise.allSettled([
        change("pause"),
        approvals.decide(owner, old.id, "allow_once"),
      ]);
      expect(paused.status === "fulfilled" && paused.value.ok).toBe(true);
      // An answer that obtained the account lock first may queue, but cannot survive the pause.
      expect(
        reply.status === "rejected" || reply.value.status === "approved",
      ).toBe(true);
      expect((await change("resume")).ok).toBe(true);
    } else if (cutoff === "disablement") {
      now += 1;
      activeAtProvider = false;
      disablements.push({ id: "provider-disabled", effectiveAt: now });
      expect(await access.check({ issuer: "test", subject: owner })).toBe(
        false,
      );
      activeAtProvider = true;
    } else {
      now += 60_000;
      expect((await access.decision(owner)).kind).toBe("denied");
    }
    now += 1;
    expect(await access.check({ issuer: "test", subject: owner })).toBe(true);
    await expect(approvals.decide(owner, old.id, "allow_once")).rejects.toThrow(
      /invalidated/,
    );
    expect((await approvals.inbox(owner)).requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: old.id,
          status: "completed",
          invalidated: true,
          result: { error: expect.stringMatching(/invalidated/) },
        }),
      ]),
    );
    validated.resolve();
    await resume;
    await approvals.resume(owner, answered.id, {
      validate: async (action) => {
        dispatched++;
        return action;
      },
      execute: async () => {
        dispatched++;
      },
      continue: async () => {
        dispatched++;
      },
    });
    expect(dispatched).toBe(0);
    await expect(
      approvals.answerQuestion(owner, questionKey, "Yes"),
    ).rejects.toThrow(/invalidated/);
    expect(
      await queue.personalStatus("person.response", owner, answeredQuestion),
    ).toMatchObject({
      finishedAt: expect.any(Date),
    });
    const fresh = await store.open(ask());
    expect(fresh.status).toBe("pending");
    expect((await approvals.decide(owner, fresh.id, "allow_once")).status).toBe(
      "approved",
    );
  },
);
