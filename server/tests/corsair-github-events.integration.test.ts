import { afterAll, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createApprovalStore } from "../src/approvals/store";
import { createAuditReader, createAuditStore } from "../src/audit";
import { encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  githubPilotConnections,
  githubPilotEventReceipts,
  githubPilotRepositories,
  responsibilities,
  responsibilityRuns,
  users,
  workItems,
} from "../src/db/schema";
import { createGithubEventDispatch } from "../src/plugins/corsair/event-dispatch";
import { createGithubEventIngress } from "../src/plugins/corsair/event-ingress";
import {
  createGithubEventTriggerRoutes,
  createGithubEventTriggers,
} from "../src/plugins/corsair/event-triggers";
import { createGithubPilotProvider } from "../src/plugins/corsair/github";
import { createGithubPilotRoutes } from "../src/plugins/corsair/routes";
import {
  createResponsibilityEngine,
  RESPONSIBILITY_RUN_KIND,
} from "../src/responsibilities/engine";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const secret = "fixture-webhook-secret";
const scope = { workspaceId: randomUUID(), registration: "9/fixture" };
afterAll(async () => {
  await database
    .delete(githubPilotEventReceipts)
    .where(eq(githubPilotEventReceipts.workspaceId, scope.workspaceId));
  await database.$client.close();
});

function request(delivery: string, body: string, signedWith = secret) {
  return new Request("https://openbot.test/webhook", {
    method: "POST",
    headers: {
      "x-github-delivery": delivery,
      "x-github-event": "issues",
      "x-hub-signature-256": `sha256=${createHmac("sha256", signedWith).update(body).digest("hex")}`,
    },
    body,
  });
}

function issue(
  occurredAt: Date,
  { installationId = 20, repositoryId = 30, issueId = 40 } = {},
) {
  return JSON.stringify({
    action: "opened",
    installation: { id: installationId },
    repository: { id: repositoryId, full_name: "octo/issues" },
    issue: {
      id: issueId,
      number: 4,
      title: "Fixture issue",
      created_at: occurredAt.toISOString(),
    },
  });
}

test("only signed deliveries receive a durable receipt, including retries through a new route instance", async () => {
  const route = () => createGithubEventIngress({ database, ...scope, secret });
  const body = issue(new Date());
  const delivery = randomUUID();
  expect((await route().fetch(request(delivery, body, "wrong"))).status).toBe(
    401,
  );
  const first = await route().fetch(request(delivery, body));
  expect(first.status).toBe(202);
  const receipt = await first.json();
  expect(receipt).toEqual({ receiptId: expect.any(String), duplicate: false });
  const duplicate = await route().fetch(request(delivery, body));
  expect(await duplicate.json()).toEqual({
    receiptId: receipt.receiptId,
    duplicate: true,
  });
  const relabeled = await route().fetch(request(randomUUID(), body));
  expect(await relabeled.json()).toEqual({
    receiptId: receipt.receiptId,
    duplicate: true,
  });
});

test("only the Goal owner can bind an enrolled repository, with an explicit readable Connection", async () => {
  const fixture = await eventFixture();
  try {
    const options = {
      method: "POST",
      body: JSON.stringify(fixture.input),
      headers: { "X-OpenBot-Pilot": "github" },
    };
    expect(
      (await fixture.routes(fixture.stranger).request("/triggers", options))
        .status,
    ).toBe(404);
    expect(
      (
        await fixture.routes(fixture.owner).request("/triggers", {
          ...options,
          body: JSON.stringify({ ...fixture.input, repositoryId: 31 }),
        })
      ).status,
    ).toBe(403);
    fixture.setAccess("denied");
    expect(
      (await fixture.routes(fixture.owner).request("/triggers", options))
        .status,
    ).toBe(403);
    fixture.setAccess("allowed");
    const response = await fixture
      .routes(fixture.owner)
      .request("/triggers", options);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      connectionId: fixture.input.connectionId,
      repositoryId: "30",
    });
  } finally {
    await fixture.cleanup();
  }
});

async function eventFixture() {
  const owner = randomUUID();
  const stranger = randomUUID();
  const botId = randomUUID();
  const scope = { workspaceId: randomUUID(), registration: "9/fixture" };
  const key = Buffer.alloc(32, 7).toString("base64");
  const connectionId = randomUUID();
  await database
    .insert(users)
    .values(
      [owner, stranger].map((id) => ({ id, email: `${id}@example.test` })),
    );
  await database.insert(agents).values({
    id: botId,
    name: "Fixture Bot",
    type: "built_in",
    configuration: {},
  });
  await database.insert(githubPilotConnections).values({
    ...scope,
    id: connectionId,
    personId: owner,
    githubUserId: "12",
    login: "octo",
    credential: await encryptSecret(key, "ghu_bound"),
    expiresAt: new Date(Date.now() + 60_000),
  });
  await database.insert(githubPilotRepositories).values({
    ...scope,
    installationId: "20",
    repositoryId: "30",
    nodeId: "repo-node",
    name: "octo/issues",
  });
  const goals = createResponsibilityStore(database, {
    resolveTarget: async () => ({ threadId: "fixture-thread" }),
  });
  const goal = await goals.create(owner, {
    agentId: botId,
    channelId: "channel",
    title: "Triage GitHub Issues",
    instruction: "Triage the issue.",
    successCriteria: "Report triage result.",
  });
  type Access = "allowed" | "denied" | "retry";
  let access: Access | (() => Access) = "allowed";
  const triggers = createGithubEventTriggers({
    database,
    ...scope,
    encryptionKey: key,
    checkRepository: async ({ token, userId, repositoryId }) => {
      expect([token, userId, repositoryId]).toEqual(["ghu_bound", "12", "30"]);
      return typeof access === "function" ? access() : access;
    },
  });
  return {
    database,
    scope,
    goals,
    goal,
    botId,
    owner,
    stranger,
    triggers,
    input: {
      goalId: goal.id,
      connectionId,
      installationId: 20,
      repositoryId: 30,
      eventTypes: ["issues.opened"],
    },
    async switchDefault() {
      const id = randomUUID();
      await database.insert(githubPilotConnections).values({
        ...scope,
        id,
        personId: owner,
        githubUserId: "13",
        login: "other",
        credential: await encryptSecret(key, "ghu_other"),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const routes = createGithubPilotRoutes({
        ...scope,
        database,
        encryptionKey: key,
        audit: createAuditStore(database),
        approvals: createApprovalStore(database),
        provider: createGithubPilotProvider(
          {
            appId: "9",
            clientId: "fixture",
            clientSecret: "fixture",
            redirectUri: "https://openbot.test",
          },
          Object.assign(
            async () => {
              throw new Error("No real provider requests expected");
            },
            { preconnect: fetch.preconnect },
          ),
        ),
        canUseBot: async () => true,
        requireUser: async (c, next) => {
          c.set("actor", {
            id: owner,
            email: "person@example.test",
            role: "user",
          });
          await next();
        },
      });
      const response = await routes.request("/connections/default", {
        method: "PUT",
        headers: { "X-OpenBot-Pilot": "github" },
        body: JSON.stringify({ connectionId: id }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ defaultConnectionId: id });
    },
    setAccess(next: Access | (() => Access)) {
      access = next;
    },
    routes(person: string) {
      return createGithubEventTriggerRoutes({
        triggers,
        requireUser: async (c, next) => {
          c.set("actor", {
            id: person,
            email: "person@example.test",
            role: "user",
          });
          await next();
        },
      });
    },
    async cleanup() {
      const ownRuns = database
        .select({ id: responsibilityRuns.id })
        .from(responsibilityRuns)
        .innerJoin(
          responsibilities,
          eq(responsibilityRuns.responsibilityId, responsibilities.id),
        )
        .where(eq(responsibilities.ownerUserId, owner));
      await database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, RESPONSIBILITY_RUN_KIND),
            inArray(workItems.key, ownRuns),
          ),
        );
      await database
        .delete(githubPilotEventReceipts)
        .where(eq(githubPilotEventReceipts.workspaceId, scope.workspaceId));
      await database
        .delete(githubPilotRepositories)
        .where(eq(githubPilotRepositories.workspaceId, scope.workspaceId));
      await database.delete(users).where(inArray(users.id, [owner, stranger]));
      await database.delete(agents).where(eq(agents.id, botId));
    },
  };
}

test("dispatch recovers incomplete fan-out, and retries cannot queue a second Run for the same Trigger", async () => {
  const f = await eventFixture();
  try {
    const second = await f.goals.create(f.owner, {
      agentId: f.botId,
      channelId: "channel",
      title: "Second Goal",
      instruction: "Review GitHub issues",
      successCriteria: "Record review",
    });
    expect(
      (
        await f.triggers.create(f.owner, {
          ...f.input,
          eventTypes: ["issues.opened"],
        })
      ).kind,
    ).toBe("created");
    expect(
      (
        await f.triggers.create(f.owner, {
          ...f.input,
          goalId: second.id,
          eventTypes: ["issues.opened"],
        })
      ).kind,
    ).toBe("created");
    const ingress = createGithubEventIngress({
      database,
      ...f.scope,
      secret,
      isolatedSources: new Set(["20/30"]),
    });
    const delivery = request(randomUUID(), issue(new Date()));
    expect((await ingress.fetch(delivery.clone())).status).toBe(202);
    let checks = 0;
    f.setAccess(() => (++checks === 1 ? "retry" : "allowed"));
    const dispatcher = () =>
      createGithubEventDispatch({
        database,
        ...f.scope,
        triggers: f.triggers,
        isolatedSources: new Set(["20/30"]),
        retryMs: 0,
      });
    await dispatcher().sweep();
    const count = async () =>
      (await f.goals.listRuns(f.owner, f.goal.id)).length +
      (await f.goals.listRuns(f.owner, second.id)).length;
    expect(await count()).toBe(1);
    f.setAccess("allowed");
    expect((await ingress.fetch(delivery.clone())).status).toBe(202);
    await Promise.all([dispatcher().sweep(), dispatcher().sweep()]);
    expect(await count()).toBe(2);
    await dispatcher().sweep();
    expect(await count()).toBe(2);
  } finally {
    await f.cleanup();
  }
});

test("a queued Run waits through lookup failure and is skipped if its bound authorization disappears", async () => {
  const f = await eventFixture();
  try {
    const goals = createResponsibilityStore(database, {
      resolveTarget: async () => ({ threadId: "fixture-thread" }),
      githubEventAccess: f.triggers,
    });
    expect(
      (
        await f.triggers.create(f.owner, {
          ...f.input,
          eventTypes: ["issues.opened"],
        })
      ).kind,
    ).toBe("created");
    await f.switchDefault();
    const route = createGithubEventIngress({
      database,
      ...f.scope,
      secret,
      isolatedSources: new Set(["20/30"]),
    });
    expect(
      (await route.fetch(request(randomUUID(), issue(new Date())))).status,
    ).toBe(202);
    await createGithubEventDispatch({
      database,
      ...f.scope,
      triggers: f.triggers,
      isolatedSources: new Set(["20/30"]),
    }).sweep();
    const [run] = await goals.listRuns(f.owner, f.goal.id);
    if (!run) throw new Error("Missing queued Run");
    let executions = 0;
    const engine = createResponsibilityEngine({
      store: goals,
      queue: createWorkQueue(database),
      runTurn: async () => {
        executions++;
        return { replyText: "Unexpected" };
      },
    });
    f.setAccess("retry");
    expect((await engine.dispatch({ owner: "fixture-worker" })).busy).toEqual([
      run.id,
    ]);
    expect((await goals.listRuns(f.owner, f.goal.id))[0]?.status).toBe(
      "queued",
    );
    f.setAccess("allowed");
    await database
      .delete(githubPilotConnections)
      .where(eq(githubPilotConnections.id, f.input.connectionId));
    await database
      .update(workItems)
      .set({ runAt: sql`now()` })
      .where(
        and(
          eq(workItems.kind, RESPONSIBILITY_RUN_KIND),
          eq(workItems.key, run.id),
        ),
      );
    expect(
      (await engine.dispatch({ owner: "fixture-worker" })).skipped,
    ).toEqual([run.id]);
    expect(executions).toBe(0);
    expect((await goals.listRuns(f.owner, f.goal.id))[0]).toMatchObject({
      status: "skipped",
      error: "GitHub event read authorization ended.",
    });
    expect(
      (
        await route.fetch(
          request(randomUUID(), issue(new Date(), { issueId: 43 })),
        )
      ).status,
    ).toBe(202);
    await createGithubEventDispatch({
      database,
      ...f.scope,
      triggers: f.triggers,
      isolatedSources: new Set(["20/30"]),
    }).sweep();
    expect(await goals.listRuns(f.owner, f.goal.id)).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("GitHub can recover a failed receipt write, and the audit links the redelivery to its Trigger and Run", async () => {
  const f = await eventFixture();
  const failedDatabase = createDatabase(testDatabaseUrl(), TEST_POOL);
  await failedDatabase.$client.close();
  try {
    const binding = await f.triggers.create(f.owner, {
      ...f.input,
      eventTypes: ["issues.opened"],
    });
    if (binding.kind !== "created") throw new Error("Expected a Trigger");
    const githubDelivery = randomUUID();
    const delivery = request(githubDelivery, issue(new Date()));
    const fail = createGithubEventIngress({
      database: failedDatabase,
      ...f.scope,
      secret,
    });
    expect((await fail.fetch(delivery.clone())).status).toBe(503);
    const restored = createGithubEventIngress({
      database,
      ...f.scope,
      secret,
      isolatedSources: new Set(["20/30"]),
    });
    const accepted = await restored.fetch(delivery.clone());
    expect(accepted.status).toBe(202);
    const { receiptId, duplicate } = await accepted.json();
    expect(duplicate).toBe(false);
    await createGithubEventDispatch({
      database,
      ...f.scope,
      triggers: f.triggers,
      isolatedSources: new Set(["20/30"]),
    }).sweep();
    const runs = await f.goals.listRuns(f.owner, f.goal.id);
    expect(runs).toHaveLength(1);
    const { events } = await createAuditReader(database).list({
      targetId: receiptId,
      limit: 20,
    });
    expect(events.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({
        deliveryId: githubDelivery,
        triggerId: binding.trigger.id,
        runId: runs[0]?.id,
        outcome: "queued",
      }),
    );
  } finally {
    await f.cleanup();
  }
});

test("observation and historical/ineligible events produce no Runs", async () => {
  const f = await eventFixture();
  try {
    const binding = await f.triggers.create(f.owner, {
      ...f.input,
      eventTypes: ["issues.opened"],
    });
    expect(binding.kind).toBe("created");
    const route = createGithubEventIngress({
      database,
      ...f.scope,
      secret,
      isolatedSources: new Set(["20/30"]),
    });
    async function receive(body: string) {
      const response = await route.fetch(request(randomUUID(), body));
      expect(response.status).toBe(202);
      return (await response.json()).receiptId;
    }
    const observationRoute = createGithubEventIngress({
      database,
      ...f.scope,
      secret,
    });
    const observation = await observationRoute.fetch(
      request(randomUUID(), issue(new Date())),
    );
    expect(observation.status).toBe(202);
    const observed = (await observation.json()).receiptId;
    const dispatch = (isolatedSources: ReadonlySet<string>) =>
      createGithubEventDispatch({
        database,
        ...f.scope,
        triggers: f.triggers,
        isolatedSources,
      });
    const older = await receive(issue(new Date(0), { issueId: 41 }));
    const wrongRepository = await receive(
      issue(new Date(), { repositoryId: 31 }),
    );
    const wrongInstallation = await receive(
      issue(new Date(), { installationId: 21 }),
    );
    f.setAccess("denied");
    const denied = await receive(issue(new Date(), { issueId: 42 }));
    await dispatch(new Set(["20/30", "20/31", "21/30"])).sweep();
    expect(await f.goals.listRuns(f.owner, f.goal.id)).toHaveLength(0);
    for (const [targetId, outcome] of [
      [observed, "observed"],
      [older, "ineligible"],
      [wrongRepository, "unenrolled"],
      [wrongInstallation, "unenrolled"],
      [denied, "denied"],
    ]) {
      const { events } = await createAuditReader(database).list({
        targetId,
        limit: 20,
      });
      expect(events.map((event) => event.payload.outcome)).toContain(outcome);
    }
  } finally {
    await f.cleanup();
  }
});
