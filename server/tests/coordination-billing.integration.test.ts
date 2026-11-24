import { expect, test } from "bun:test";
import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import { SUBAGENT_TOOL } from "@openbot/shared/subagent";
import { createTurnRunner, type RunnerLike } from "@openbot/toolkit/run-turn";
import { and, eq, sql } from "drizzle-orm";
import { EMPTY, Observable } from "rxjs";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import type { RunAssertion } from "../src/agents/callback-token";
import { createHandoffDesk } from "../src/agents/handoff";
import { createHandoffDelivery } from "../src/agents/handoff-delivery";
import { createHandoffRunner } from "../src/agents/handoff-runner";
import { signHandoffDeliveryRun } from "../src/agents/handoff-signing";
import {
  authoriseCoordinationRun,
  createCoordinationTools,
  HANDOFF_TOOL,
  readCoordinationHandoffClaim,
} from "../src/agents/handoff-tool";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createSubagents } from "../src/agents/subagent";
import { createAuditStore, PERSON_INITIATOR } from "../src/audit";
import { createBackgroundModel } from "../src/billing/background-model";
import { budgetedTurn } from "../src/billing/background-model-turn";
import {
  createBifrostLogProxy,
  loadBifrostEvidenceReader,
  recoverBifrostEvidence,
} from "../src/billing/bifrost-evidence";
import { createTestCreditLedger } from "../src/billing/test-credit";
import {
  bifrostRouteProof,
  createBifrostCreditExecutor,
} from "../src/billing/test-credit-bifrost";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channels,
  enterpriseSettings,
  intelligenceChannelMappings,
  proactiveSettings,
  proactiveSuggestions,
  testCreditOperations,
  users,
  workItems,
} from "../src/db/schema";
import { createRoutineRunner } from "../src/routines/runner";
import { createRoutineStore } from "../src/routines/store";
import { createTaskRunner } from "../src/tasks/runner";
import { createTaskStore } from "../src/tasks/store";
import { createTaskTurn, type TaskTurn } from "../src/tasks/turn";
import { createWorkQueue } from "../src/work/queue";
import { fixtureTraceReport } from "./support/bifrost-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const call = (id: string, name: string, args: object) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const delegate = (id: string, bot: string, task: string) =>
  call(id, HANDOFF_TOOL, { bot, task });
const subagent = (id: string) =>
  call(id, SUBAGENT_TOOL, { task: "Compute one result", answer: "A sentence" });

test("a recorded Task and Run dispatch parallel coordination through durable ancestor budgets", async () => {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  let ledgerTime = Date.now();
  const ledger = createTestCreditLedger(database, () => new Date(ledgerTime));
  const actorId = crypto.randomUUID();
  const identity = {
    issuer: "https://coordination-issue95.example.test",
    subject: actorId,
  };
  const accountBatch = crypto.randomUUID();
  const taskBudget = crypto.randomUUID();
  const runBudget = crypto.randomUUID();
  const subagentBudget = crypto.randomUUID();
  const taskChildBudget = crypto.randomUUID();
  const delegationBudget = crypto.randomUUID();
  const descendantBudget = crypto.randomUUID();
  const parentBot = `parent-${actorId}`;
  const firstBot = `first-${actorId}`;
  const secondBot = `second-${actorId}`;
  const channelIds: string[] = [];
  const authority = async () => {};
  const portAgent = new (class extends AbstractAgent {
    run() {
      return EMPTY;
    }
  })();
  const runner: RunnerLike = {
    run: ({ agent, input }) =>
      new Observable((subscriber) => {
        agent
          .runAgent(input, { onEvent: ({ event }) => subscriber.next(event) })
          .then(
            () => subscriber.complete(),
            (error) => subscriber.error(error),
          );
      }),
    stop: async () => true,
  };
  const turnOptions = {
    admission: async ({ signal }: { signal?: AbortSignal }) =>
      signal ?? new AbortController().signal,
    intelligence: {
      getOrCreateThread: async () => {},
      getThreadMessages: async () => ({ messages: [] }),
      ɵacquireThreadLock: async () => {},
      ɵrenewThreadLock: async () => {},
      ɵcleanupThreadLock: async () => {},
    },
    runner,
    buildAgentFor: async () => {
      throw new Error("Unexpected unmetered turn");
    },
  };
  const releaseSubagent = Promise.withResolvers<void>();
  const subagentReached = Promise.withResolvers<void>();
  const sent: { operationId: string | null; purpose: string }[] = [];
  const logs = new Map<string, object>();
  const gateway = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.method === "GET") {
        const id = new URL(request.url).pathname.split("/").at(-1);
        const entry = id && logs.get(id);
        return entry
          ? Response.json(entry)
          : new Response(null, { status: 404 });
      }
      const body = await request.json();
      const text = body.messages.at(-1)?.content.trim() ?? "";
      const operationId = request.headers.get("x-openbot-operation-id");
      const complete = (content: string) =>
        Response.json({
          choices: [{ finish_reason: "stop", message: { content } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      const choose = (
        purpose: string,
        toolCalls: ReturnType<typeof call>[],
      ) => {
        sent.push({ operationId, purpose });
        const offered = body.tools.map(
          (tool: { function: { name: string } }) => tool.function.name,
        );
        expect(
          toolCalls.every(({ function: spec }) => offered.includes(spec.name)),
        ).toBe(true);
        return Response.json({
          choices: [
            { finish_reason: "tool_calls", message: { tool_calls: toolCalls } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      };
      if (text === "Task plan")
        return choose("task", [
          subagent("one"),
          delegate("three", "First", "Task delegation"),
          delegate("four", "Second", "Task strict delegation"),
        ]);
      if (text === "Run plan")
        return choose("run", [delegate("one", "First", "Redelegate once")]);
      if (
        text.includes("Task: Redelegate once") ||
        text.includes("Task: Nested answer")
      ) {
        const redelegate = text.includes("Task: Redelegate once");
        const requestId = request.headers.get("x-request-id");
        if (!requestId) throw new Error("Missing request ID");
        sent.push({
          operationId,
          purpose: redelegate ? "redelegate" : "nested",
        });
        logs.set(requestId, {
          id: requestId,
          object: "chat_completion",
          status: "success",
          stop_reason: redelegate ? "tool_calls" : "stop",
          stream: false,
          provider: "fixture",
          model: "model",
          parent_request_id: null,
          number_of_retries: 0,
          fallback_index: 0,
          metadata: {
            "openbot-operation-id": operationId,
            "openbot-request-sha256": request.headers.get(
              "x-bf-lh-openbot-request-sha256",
            ),
            "openbot-route-proof": request.headers.get(
              "x-bf-lh-openbot-route-proof",
            ),
          },
          token_usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
          output_message: redelegate
            ? {
                role: "assistant",
                tool_calls: [delegate("one", "Second", "Nested answer")],
              }
            : { role: "assistant", content: "Recovered nested answer" },
        });
        return new Response(null, { status: 502 });
      }
      if (text.includes("Compute one result")) {
        sent.push({ operationId, purpose: "subagent" });
        subagentReached.resolve();
        await releaseSubagent.promise;
        return complete("Subagent fixture answer");
      }
      throw new Error(`Unexpected provider dispatch: ${text}`);
    },
  });

  const proxy = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: createBifrostLogProxy({
      BIFROST_LOG_PROXY_UPSTREAM_ORIGIN: gateway.url.href,
      TEST_CREDIT_BIFROST_LOG_TOKEN: "fixture-token",
    }),
  });
  const readEvidence = loadBifrostEvidenceReader({
    TEST_CREDIT_BIFROST_LOG_ORIGIN: proxy.url.href,
    TEST_CREDIT_BIFROST_LOG_TOKEN: "fixture-token",
    TEST_CREDIT_GATEWAY_REVISION: "fixture",
    TEST_CREDIT_METERING_REVISION: "fixture",
    TEST_CREDIT_GATEWAY_IMAGE_DIGEST: `sha256:${"d".repeat(64)}`,
  });
  if (!readEvidence) throw new Error("Missing evidence reader");
  const execute = createBifrostCreditExecutor({
    endpoint: gateway.url,
    gatewayRevision: "fixture",
    meteringRevision: "fixture",
    countInputTokens: async () => 1,
  });
  const model = createBackgroundModel({
    ledger,
    identityOf: async (person) => (person === actorId ? identity : undefined),
    execute: (input) =>
      execute({ ...input, routeProof: bifrostRouteProof(input.route) }),
  });
  const close = new AbortController();
  const profiles = createAgentProfileStore(
    database,
    new URL("https://fixture.example.test/ag-ui"),
  );
  const auditStore = createAuditStore(database);
  const queue = createWorkQueue(database);
  const caps = { maxDepth: 2, maxPerRun: 4 };
  const actorFor = async (id: string) => ({ id, role: "user" as const });
  const actor = await actorFor(actorId);
  const channelStore = createChannelStore(
    database,
    profiles,
    createThreadIdentity("issue95"),
  );
  const taskStore = createTaskStore(database);
  const routineStore = createRoutineStore(database);
  const desk = createHandoffDesk({
    queue,
    profiles,
    actorFor,
    auditStore,
    caps,
    mayAddress: async () => true,
  });
  const book = createCoordinationTools({
    desk,
    caps,
    auditStore,
    botsReachableFrom: async () => [firstBot, secondBot],
    route: async () => {
      throw new Error("Unexpected ask-person tool");
    },
    authoriseRun: (assertion) =>
      authoriseCoordinationRun(assertion, {
        canUseBot: async (run) => run.actorId === actorId,
        sourceThread: async (run) => {
          if (!run.threadId) return null;
          const [source] = await database
            .select({ botId: channelAgents.agentId })
            .from(intelligenceChannelMappings)
            .innerJoin(
              channelAgents,
              eq(
                channelAgents.channelId,
                intelligenceChannelMappings.channelId,
              ),
            )
            .where(
              and(
                eq(intelligenceChannelMappings.userId, run.actorId),
                eq(intelligenceChannelMappings.threadId, run.threadId),
              ),
            );
          return source ?? null;
        },
        delegationFor: (claim) => readCoordinationHandoffClaim(database, claim),
      }),
  });
  const delegationTools = async (run: RunAssertion) =>
    (await book.toolsForRun(run)).filter(({ name }) => name === HANDOFF_TOOL);
  const subagents = createSubagents({
    turn: turnOptions,
    buildAgentFor: turnOptions.buildAgentFor,
    withdrawApprovals: async () => {},
    backgroundModel: model,
    authorizeBudgetedTurn: authority,
    asksEveryStep: async () => true,
  });
  const metered = (kind: "task" | "routine") =>
    budgetedTurn(
      model,
      kind,
      (agent) =>
        createTurnRunner({ ...turnOptions, buildAgentFor: async () => agent }),
      authority,
      turnOptions.buildAgentFor,
      async (turn, run) => {
        const parent = {
          ...run,
          actorId,
          botId: parentBot,
          initiator: PERSON_INITIATOR,
          coordinationOperationId: run.operationId,
          billingTaskId:
            kind === "task"
              ? turn.budget?.stepId?.slice("task-".length)
              : undefined,
        };
        return [
          ...(await delegationTools(parent)),
          subagents.toolForRun(parent),
        ];
      },
    );
  const delivery = createHandoffDelivery({
    backgroundModel: model,
    authorizeBudgetedWork: async (work) => {
      if (!work.billingTaskId) return;
      const task = await taskStore.locate(work.actorId, work.billingTaskId);
      if (!task || task.resolvedAt)
        throw new Error("This task is no longer open.");
    },
    admission: turnOptions.admission,
    coordination: (work, claim, run) =>
      delegationTools({
        ...run,
        actorId,
        botId: work.toBotId,
        threadId: work.threadId,
        depth: work.depth,
        initiator: work.initiator,
        handoff: claim,
        coordinationOperationId: run.operationId,
      }),
    agentFor: async () => portAgent,
    history: async () => [],
    lock: {
      acquire: async ({ runId }) => ({ runId }),
      renew: async () => {},
      release: async () => {},
    },
    mintThreadId: () => crypto.randomUUID(),
    newRunId: () => crypto.randomUUID(),
    runner: {
      run: ({ agent, input, threadId }) =>
        runner.run({
          agent,
          threadId,
          input: input as RunAgentInput,
        }) as Observable<import("@ag-ui/client").BaseEvent>,
    },
  });
  const worker = createHandoffRunner({
    queue,
    auditStore,
    owner: "billing-fixture",
    delivery,
    sign: (work, claim) =>
      signHandoffDeliveryRun(work, "1".repeat(64), crypto.randomUUID(), claim),
  });
  const task = createTaskTurn({
    channels: channelStore,
    actorFor,
    runTurn: metered("task"),
  });
  const taskExecution = Promise.withResolvers<Parameters<TaskTurn>>();
  const taskWorker = createTaskRunner({
    database,
    store: taskStore,
    channels: channelStore,
    actorFor,
    queue,
    owner: "issue95-task",
    canStartBudget: model.canStart,
    scopeFor: async (ownerUserId, channelId, agentId) => {
      const channel = await channelStore.get(actor, channelId);
      return (
        channel && {
          ownerUserId,
          channelId,
          agentId,
          threadId: channel.threadId,
        }
      );
    },
    runTask: (...input) => {
      taskExecution.resolve(input);
      return task(...input);
    },
  });
  const routineWorker = createRoutineRunner({
    routineStore,
    channelStore,
    runTurn: metered("routine"),
  });
  const [original] = await database
    .select()
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, pilotCatalogKey));

  const forActor = sql`${workItems.payload}->>'actorId' = ${actorId}`;
  const finish = async (nonempty: () => Promise<boolean>) => {
    const deadline = Date.now() + 12000;
    while (!(await nonempty())) {
      if (Date.now() > deadline)
        throw new Error("Coordination did not reach the work queue");
      await Bun.sleep(10);
    }
  };
  try {
    await database.insert(users).values({
      id: actorId,
      email: `${actorId}@example.test`,
      name: "Coordination fixture",
    });
    for (const [id, name] of [
      [parentBot, "Parent"],
      [firstBot, "First"],
      [secondBot, "Second"],
    ]) {
      await database
        .insert(agents)
        .values({ id, name, type: "built_in", configuration: {} });
      await database.insert(agentProfiles).values({
        agentId: id,
        title: "",
        roleDescription: "",
        avatarSeed: id,
        visibility: "public",
      });
    }
    const harnessImage = `agent-langgraph-agui@sha256:${"b".repeat(64)}`;
    const catalog = configure(emptyCatalog, {
      harnessImage,
      routes: {
        pilot: {
          provider: "fixture",
          model: "model",
          gatewayRevision: "fixture",
          meteringRevision: "fixture",
          maxInputTokens: 32,
          maxOutputTokens: 32,
          tools: true,
          price: { inputPerMillion: 1_000_000, outputPerMillion: 1_000_000 },
        },
      },
    });
    const route = catalog.routes.pilot;
    if (!route) throw new Error("Missing route fixture");
    const { catalog: published } = publish(
      verify(catalog, "pilot", fixtureTraceReport(harnessImage, route), "test"),
      ["pilot"],
      "pilot",
      "test",
    );
    await database
      .insert(enterpriseSettings)
      .values({ key: pilotCatalogKey, value: published })
      .onConflictDoUpdate({
        target: enterpriseSettings.key,
        set: { value: published },
      });
    const quote = await ledger.quote();
    if (!quote) throw new Error("Missing quote");
    const bound = BigInt(quote.maxChargeMicrocredits);
    await ledger.enroll({
      identity,
      batchId: accountBatch,
      amount: bound * 20n,
    });
    await ledger.claim(identity, accountBatch);
    const create = (
      budgetId: string,
      limitMicrocredits: bigint,
      childOf?: {
        budgetId: string;
        kind: "subagent" | "delegation";
        botId: string;
      },
    ) =>
      ledger.createBudget(identity, {
        budgetId,
        creditType: "test",
        limitMicrocredits,
        childOf,
        modelQuote: childOf ? undefined : quote,
      });
    await create(taskBudget, bound + 2n);
    await create(subagentBudget, bound, {
      budgetId: taskBudget,
      kind: "subagent",
      botId: parentBot,
    });
    await create(taskChildBudget, bound - 1n, {
      budgetId: taskBudget,
      kind: "delegation",
      botId: secondBot,
    });
    await create(runBudget, bound + 4n);
    await create(delegationBudget, bound + 2n, {
      budgetId: runBudget,
      kind: "delegation",
      botId: firstBot,
    });
    await create(descendantBudget, bound, {
      budgetId: delegationBudget,
      kind: "delegation",
      botId: secondBot,
    });
    const used = async (id: string) =>
      (await ledger.budget(identity, id))?.usedMicrocredits;
    const channel = await channelStore.create(actor, [parentBot]);
    channelIds.push(channel.id);
    const settingId = crypto.randomUUID();
    const item = {
      id: crypto.randomUUID(),
      agentId: parentBot,
      title: "Task plan",
      detail: "",
      sourceApp: "Fixture",
      sourceLink: null,
    };
    await database.insert(proactiveSettings).values({
      id: settingId,
      ownerUserId: actorId,
      agentId: parentBot,
      channelId: channel.id,
      threadId: channel.threadId,
    });
    await database.insert(proactiveSuggestions).values({
      ...item,
      ownerUserId: actorId,
      settingId,
      runId: "issue95-checkin",
      sourceRef: "fixture/search",
    });
    const opened = await taskWorker.startFromItem({
      ownerUserId: actorId,
      item,
      budgetId: taskBudget,
    });
    channelIds.push(opened.channelId);
    const [taskScope, taskInput] = await taskExecution.promise;
    await Promise.race([
      subagentReached.promise,
      Bun.sleep(12000).then(() => {
        throw new Error("Subagent did not dispatch");
      }),
    ]);
    await finish(
      async () =>
        (await database.select().from(workItems).where(forActor)).length === 2,
    );
    const refused = await worker.sweep();
    expect(refused.skipped).toHaveLength(2);
    expect(sent.map(({ purpose }) => purpose)).toEqual(["task", "subagent"]);
    expect(
      await Promise.all([
        used(taskBudget),
        used(subagentBudget),
        used(taskChildBudget),
      ]),
    ).toEqual([(bound + 2n).toString(), bound.toString(), "0"]);
    const point = (await ledger.resumePoints(identity))?.find(
      (item) => item.requiredBudgetId === taskChildBudget,
    );
    if (!point) throw new Error("Missing pinned resume point");
    expect(
      await ledger.confirmResumePoint(identity, point.operationId, runBudget),
    ).toEqual({ state: "denied" });
    releaseSubagent.resolve();
    await taskWorker.idle();
    expect(await taskStore.get(actorId, opened.id)).toMatchObject({
      status: "ready_for_review",
    });
    await task(taskScope, {
      ...taskInput,
      runId: crypto.randomUUID(),
      signal: close.signal,
    });
    expect(sent.map(({ purpose }) => purpose)).toEqual(["task", "subagent"]);
    expect(await Promise.all([used(taskBudget), used(subagentBudget)])).toEqual(
      ["4", "2"],
    );
    const sub = sent.find(
      (request) => request.purpose === "subagent",
    )?.operationId;
    if (!sub) throw new Error("Missing Subagent receipt");
    expect(await ledger.reconcile(identity, sub)).toMatchObject({
      budgetId: subagentBudget,
      parentRunId: taskInput.runId,
      chargedMicrocredits: "2",
      releasedMicrocredits: (bound - 2n).toString(),
    });

    await ledger.confirmBudget(identity, taskBudget, bound * 2n);
    await taskStore.resolve(actorId, opened.id);
    await database.update(workItems).set({ runAt: sql`now()` }).where(forActor);
    const cancelled = await worker.sweep();
    expect(cancelled.skipped.map(({ reason }) => reason)).toEqual([
      "This step cannot run under its current billing authorization or confirmed price.",
      "This step cannot run under its current billing authorization or confirmed price.",
    ]);
    expect(sent.map(({ purpose }) => purpose)).toEqual(["task", "subagent"]);

    const routine = await routineStore.create({
      ownerUserId: actorId,
      agentId: parentBot,
      channelId: channel.id,
      cron: "0 9 * * *",
      instruction: "Run plan",
      budgetId: runBudget,
    });
    const { runId } = await routineStore.insertRun(
      routine.id,
      "issue95-firing",
    );
    await routineWorker.run(runId);
    expect(await routineStore.listRuns(actorId, routine.id)).toMatchObject([
      { id: runId, status: "succeeded" },
    ]);
    const makeRetryable = async (
      report: Awaited<ReturnType<typeof worker.sweep>>,
    ) => {
      const pending = report.skipped.find(({ reason }) =>
        reason.includes("reconciliation"),
      );
      if (!pending)
        throw new Error(
          "Expected the interrupted Delegation to wait for reconciliation",
        );
      ledgerTime += 90_001;
      await recoverBifrostEvidence(ledger, readEvidence);
      await database
        .update(workItems)
        .set({ runAt: sql`now()` })
        .where(eq(workItems.key, pending.key));
    };
    await makeRetryable(await worker.sweep());
    expect((await worker.sweep()).delivered).toContain(firstBot);
    const pending = await worker.sweep();
    expect(pending.skipped.map(({ reason }) => reason)).toContain(
      "This step is waiting for billing reconciliation.",
    );
    const nested = sent.find(
      (request) => request.purpose === "nested",
    )?.operationId;
    if (!nested) throw new Error("Missing nested operation");
    const [held] = await database
      .select()
      .from(testCreditOperations)
      .where(eq(testCreditOperations.id, nested));
    if (!held) throw new Error("Missing nested reservation");
    expect(held.budgetId).toBe(descendantBudget);
    expect(
      await Promise.all([
        used(runBudget),
        used(delegationBudget),
        used(descendantBudget),
      ]),
    ).toEqual([
      (bound + 4n).toString(),
      (bound + 2n).toString(),
      bound.toString(),
    ]);
    await makeRetryable(pending);
    expect((await worker.sweep()).delivered).toContain(secondBot);
    expect(sent.map(({ purpose }) => purpose)).toEqual([
      "task",
      "subagent",
      "run",
      "redelegate",
      "nested",
    ]);
    expect(
      await Promise.all([
        used(runBudget),
        used(delegationBudget),
        used(descendantBudget),
      ]),
    ).toEqual(["6", "4", "2"]);
    expect(await ledger.reconcile(identity, nested)).toMatchObject({
      state: "settled",
      budgetId: descendantBudget,
      parentRunId: held.parentRunId,
      chargedMicrocredits: "2",
      releasedMicrocredits: (bound - 2n).toString(),
    });
  } finally {
    close.abort();
    releaseSubagent.resolve();
    await taskWorker.idle().catch(() => {});
    await proxy.stop(true);
    await gateway.stop(true);
    await database.delete(workItems).where(forActor);
    await database
      .delete(workItems)
      .where(sql`${workItems.payload}->>'ownerUserId' = ${actorId}`);
    await database.delete(users).where(eq(users.id, actorId));
    for (const id of channelIds)
      await database.delete(channels).where(eq(channels.id, id));
    for (const id of [parentBot, firstBot, secondBot]) {
      await database.delete(agentProfiles).where(eq(agentProfiles.agentId, id));
      await database.delete(agents).where(eq(agents.id, id));
    }
    if (original)
      await database
        .update(enterpriseSettings)
        .set({ value: original.value })
        .where(eq(enterpriseSettings.key, pilotCatalogKey));
    else
      await database
        .delete(enterpriseSettings)
        .where(eq(enterpriseSettings.key, pilotCatalogKey));
    await database.$client.close();
  }
}, 60_000);
