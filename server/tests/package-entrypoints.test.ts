// server/tests/package-entrypoints.test.ts
// PKG09（Issue #468，Spec §9）：入口支持矩阵的 store/executor 侧证据面。
//
// 逐入口证据（#468 AC1、A02/A05/A07）：
//   (a) plugins/tools grantedTools/grantedSkills —— 携带服务端签发的 run
//       上下文时，pin 仍有效的包工具加入 offer 并经包分支执行；不带上下文
//       时一个都不提供（schedules/ingestion 等无上下文的入口因此拿不到包
//       工具），legacy offer 不变。
//   (b) plugins/routes.ts `/call` —— HTTP 调用者无法呈交服务端签发的 run
//       上下文：`pkg:` ref 在 store 的包分支被 PACKAGE_RUN_REQUIRED 拒绝
//       （403 + 固定句 + 审计行），seam 的 prepare/dispatch 均为 0 次。
//   (c) app.ts `/api/agent-tools/call` —— 同一条 store 分支；签名 run
//       assertion 证明的是「哪个黑盒 Bot 在调」，不是受管准入。入口表在
//       runtime.ts，拒绝行为由本套件与上一条同一代码路径覆盖。
//       （不接受 pkg: ref 的黑盒 Bot 在绑定/就绪面显示 unsupported。）
//   (d) 审批恢复的 legacy 臂 —— createApprovedActionExecutor：
//       run 上下文只来自 packageRunFor（持久 Run 行重建），提案里反序列化
//       的 runId/scope/target 字段一律不成为授权事实；无受管 Run → 固定
//       拒绝句；未接线部署拒绝而不是猜上下文；legacy ref 不咨询恢复面。
//   (e) memory ingestion —— 包来源在 authorize 被点名拒绝（PACKAGE_RUN_REQUIRED
//       语义），不伪造 Run；eligibleSources 把该来源记为失败而不是放行。
//   (f) dispatch 的「取消/重试不重置 operation identity」与审批期失效由
//       multitenancy/package-entrypoints.test.ts（真实受限角色）证明。
//
// 本文件在 driven（Bun）层执行：store 为真实实现 + 真实审计面 + 真实测试库；
// package seam / approved-action deps / memory store 为可控注入。

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import type { ApprovedActionDependencies } from "../src/approvals/execute";
import { createApprovedActionExecutor } from "../src/approvals/execute";
import { ApprovalRefusedError, approvalAction } from "../src/approvals/types";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { MemoryRefusedError } from "../src/memory/types";
import type {
  PackageToolDescriptor,
  PackageToolSeam,
  PackageToolTicket,
} from "../src/plugins/package-tools";
import type { BotAccessCheck } from "../src/plugins/routes";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  createPluginStore,
  type PluginStore,
  toolNameFor,
} from "../src/plugins/store";
import { grantedTools } from "../src/plugins/tools";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);

const INSTALL = `pkg09-install-${randomUUID().slice(0, 8)}`;
const REF = `pkg:${INSTALL}:notes/lookup`;

const runContext = {
  runId: randomUUID(),
  attemptGeneration: 3,
  scope: { tenantId: "tenant-a", workspaceId: "team-a1" },
};

const ticket: PackageToolTicket = {
  runId: runContext.runId,
  attemptGeneration: runContext.attemptGeneration,
  toolCallId: `call-${randomUUID()}`,
  ref: REF,
  installId: INSTALL,
  resourceId: "notes",
  toolName: "lookup",
  effect: "read",
  schemaDigest: "a".repeat(64),
  connectorInstallId: `conn-${INSTALL}`,
  connectionId: `cx-${INSTALL}`,
  connectionGeneration: 1,
  argsDigest: "b".repeat(64),
};

type SeamState = {
  listed: PackageToolDescriptor[];
  listCalls: number;
  prepared: number;
  dispatched: number;
  cancelled: number;
};

function makeSeam(state: SeamState): PackageToolSeam {
  return {
    async list() {
      state.listCalls += 1;
      return state.listed;
    },
    async prepare() {
      state.prepared += 1;
      return { outcome: "ticket", ticket };
    },
    async dispatch() {
      state.dispatched += 1;
      return { outcome: "ok", text: "two notes", isError: false };
    },
    async cancel() {
      state.cancelled += 1;
    },
  };
}

const allowAllPolicy = () => ({
  mode: "enforce" as const,
  deny: [],
  allow: ["true"],
});

function storeOf(input: {
  seam?: PackageToolSeam;
  approvalGate?: Parameters<typeof createPluginStore>[0]["approvalGate"];
}) {
  return createPluginStore({
    database,
    auditStore,
    credentials: { readSecret: async () => null },
    encryptionKey: "x".repeat(44),
    policy: allowAllPolicy,
    ...(input.seam ? { packageTool: input.seam } : {}),
    ...(input.approvalGate ? { approvalGate: input.approvalGate } : {}),
  });
}

// ---------------------------------------------------------------------------
// (d) 审批恢复 —— legacy 执行器臂
// ---------------------------------------------------------------------------

function continuation(toolName: string, args: Record<string, unknown>) {
  return {
    runId: "run-from-proposal",
    threadId: "thread",
    toolCallId: "call-1",
    toolName,
    args,
    messages: [],
    state: {},
    context: [],
    forwardedProps: {},
  };
}

const PERSON = { kind: "person" as const, id: "" };

function executorHarness(overrides: Partial<ApprovedActionDependencies> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const credentials: string[] = [];
  let restorationCalls = 0;
  const deps = {
    sourceFor: async () => ({ channelId: "channel" }),
    gate: async () => undefined,
    computerTools: async () => [],
    hostTools: () => [],
    callTool: async (input: Record<string, unknown>) => {
      calls.push(input);
      return { text: "found 2 notes", isError: false };
    },
    answer: (result: { text: string }) => result.text,
    privateShareToolRef: "openbot/private_share",
    refusalMarker: "REFUSED:",
    personInitiator: PERSON,
    coordinationCall: async () => null,
    readRun: () => null,
    credentialActorFor: async (actorId: string) => {
      credentials.push(actorId);
      return "owner-of-team-bot";
    },
    packageRunFor: async () => {
      restorationCalls += 1;
      return {
        outcome: "context" as const,
        runId: "run-from-row",
        attemptGeneration: 3,
        scope: Object.freeze({ tenantId: "tenant-from-row" }),
      };
    },
    ...overrides,
  } as ApprovedActionDependencies;
  return {
    execute: createApprovedActionExecutor(deps),
    calls,
    credentials,
    restorationCalls: () => restorationCalls,
  };
}

function packageAction(args: Record<string, unknown> = { query: "notes" }) {
  return approvalAction({
    actorId: "person",
    botId: "notes-bot",
    toolRef: REF,
    effect: "read",
    scope: `pkg:${INSTALL}`,
    args,
    // A proposal's `target` and continuation are DESERIALIZED CLIENT STATE.
    // They identify the action; they must never become the restored scope.
    target: {
      installId: INSTALL,
      scope: { tenantId: "forged-by-client", workspaceId: "forged-team" },
    },
    continuation: continuation("lookup", args),
  });
}

describe("approved package action executor (PKG09)", () => {
  test("the resume carries the run context rebuilt from the run row, not the proposal", async () => {
    const harness = executorHarness();
    await expect(harness.execute(packageAction())).resolves.toBe(
      "found 2 notes",
    );
    expect(harness.restorationCalls()).toBe(1);
    expect(harness.calls).toHaveLength(1);
    const call = harness.calls[0] as {
      packageRun?: Record<string, unknown>;
      credentialActorId?: string;
    };
    // Everything authority-bearing comes from the restoration: run id, attempt
    // and scope. The proposal's own runId ("run-from-proposal") and its forged
    // target scope never appear.
    expect(call.packageRun).toEqual({
      runId: "run-from-row",
      attemptGeneration: 3,
      scope: { tenantId: "tenant-from-row" },
      // The tool call keeps the PROPOSAL's identity: the dispatch row it must
      // linearize is the one prepared under that id (operation identity is
      // never reset by the resume).
      toolCallId: "call-1",
    });
    // A package call resolves its own connection in the dispatch chain; the
    // legacy credential-actor rule is not consulted (nothing is spent twice).
    expect(harness.credentials).toEqual([]);
    expect(call.credentialActorId).toBeUndefined();
  });

  test("an unreachable managed run refuses before any call", async () => {
    const harness = executorHarness({
      packageRunFor: async () => ({
        outcome: "refused" as const,
        code: "PACKAGE_RUN_REQUIRED",
      }),
    });
    await expect(harness.execute(packageAction())).rejects.toBeInstanceOf(
      ApprovalRefusedError,
    );
    await expect(harness.execute(packageAction())).rejects.toThrow(
      "This package tool runs only inside a managed run, and none is reachable for this approval.",
    );
    expect(harness.calls).toEqual([]);
  });

  test("a proposal naming another Bot or a lost scope answers its own sentence", async () => {
    for (const [code, sentence] of [
      [
        "PACKAGE_RUN_BOT_MISMATCH",
        "This approval names a Bot the run was not admitted for, so it cannot run.",
      ],
      [
        "PACKAGE_RUN_SCOPE_LOST",
        "The team or membership this run belongs to changed while it waited, so the approval no longer applies.",
      ],
    ] as const) {
      const harness = executorHarness({
        packageRunFor: async () => ({ outcome: "refused" as const, code }),
      });
      await expect(harness.execute(packageAction())).rejects.toThrow(sentence);
      expect(harness.calls).toEqual([]);
    }
  });

  test("an unwired deployment refuses rather than guessing a context", async () => {
    // No `packageRunFor` at all — a deployment that never wired the enterprise
    // entrypoints service. The package ref must be refused, never run on a
    // guessed or optional context.
    const calls: unknown[] = [];
    const unwired = createApprovedActionExecutor({
      sourceFor: async () => ({ channelId: "channel" }),
      gate: async () => undefined,
      computerTools: async () => [],
      hostTools: () => [],
      callTool: async (input: unknown) => {
        calls.push(input);
        return { text: "should not run", isError: false };
      },
      answer: (result: { text: string }) => result.text,
      privateShareToolRef: "openbot/private_share",
      refusalMarker: "REFUSED:",
      personInitiator: PERSON,
      coordinationCall: async () => null,
      credentialActorFor: async () => "owner-of-team-bot",
    } as ApprovedActionDependencies);
    await expect(unwired(packageAction())).rejects.toThrow(
      /runs only inside a managed run/,
    );
    expect(calls).toEqual([]);
  });

  test("a legacy ref never consults the package restoration", async () => {
    const harness = executorHarness();
    const action = approvalAction({
      actorId: "person",
      botId: "notes-bot",
      toolRef: "notes/lookup",
      effect: "read",
      scope: "notes",
      args: { query: "notes" },
      continuation: continuation("lookup", { query: "notes" }),
    });
    await expect(harness.execute(action)).resolves.toBe("found 2 notes");
    expect(harness.restorationCalls()).toBe(0);
    const call = harness.calls[0] as {
      packageRun?: unknown;
      credentialActorId?: string;
    };
    expect(call.packageRun).toBeUndefined();
    // The legacy contract is untouched: the credential-actor rule still runs.
    expect(harness.credentials).toEqual(["person"]);
    expect(call.credentialActorId).toBe("owner-of-team-bot");
  });
});

// ---------------------------------------------------------------------------
// (b) plugins/routes.ts `/call`
// ---------------------------------------------------------------------------

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "user-1",
    email: "user@openbot.test",
    role: "admin",
  });
  await next();
};
const canUseBot: BotAccessCheck = async () => true;

describe("plugins/routes /call (PKG09)", () => {
  test("a package ref over HTTP answers PACKAGE_RUN_REQUIRED and never reaches the package chain", async () => {
    const state: SeamState = {
      listed: [],
      listCalls: 0,
      prepared: 0,
      dispatched: 0,
      cancelled: 0,
    };
    const store = storeOf({ seam: makeSeam(state) });
    const app = new Hono<{ Variables: AppVariables }>();
    app.use(requireUser);
    app.route("/", createPluginRoutes(store, requireUser, canUseBot));

    const response = await app.request("http://openbot.test/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: REF, agentId: "notes-bot", args: {} }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe(
      "Package tools run only inside a managed run, and this call has no run context.",
    );
    // No package authorization step ran: not even a prepare ticket exists.
    expect(state.prepared).toBe(0);
    expect(state.dispatched).toBe(0);
    // The refusal is in the trail with the package refusal vocabulary.
    const rows = await database
      .select({
        eventType: auditEvents.eventType,
        payload: auditEvents.payload,
      })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, REF));
    expect(
      rows.some(
        (row) =>
          (row.payload as Record<string, unknown> | null)?.refusal ===
          "package_run_required",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (e) memory ingestion
// ---------------------------------------------------------------------------

function memoryHarness(sources: unknown[] = []) {
  const calls = { authorizePluginReads: 0, failSync: [] as string[] };
  const plugins = {
    agentOwner: async () => "person",
    // `listForAgent` is also read by `formedFor` (the shape of a Bot's grants,
    // which is not an authorization read): only the catalogue read below is
    // the counter that proves `authorize` never got that far.
    listForAgent: async () => ({ tools: [], skills: [] }),
    listServers: async () => {
      calls.authorizePluginReads += 1;
      return [];
    },
    connectionsFor: async () => [],
    brokeredConnectionsFor: async () => [],
    deploymentConnectionFor: async () => null,
    callTool: async () => {
      throw new Error("memory ingestion must not call a package tool");
    },
  } as unknown as PluginStore;
  const store = {
    sources: async () => sources,
    failSync: async (_owner: string, id: string) => {
      calls.failSync.push(id);
    },
    getSource: async () => {
      throw new Error("not used");
    },
    claimSync: async () => null,
    createSource: async () => {
      throw new Error("a refused source is never created");
    },
    completeSync: async () => undefined,
    dueSources: async () => [],
    retrieve: async () => [],
  };
  const ingestion = createMemoryIngestion({
    store: store as never,
    plugins,
  });
  return { ingestion, calls };
}

describe("memory ingestion (PKG09)", () => {
  test("a package ref is refused by name before any grant read", async () => {
    const harness = memoryHarness();
    await expect(
      harness.ingestion.createSource("person", {
        agentId: "notes-bot",
        toolRef: REF,
        title: "Package notes",
        args: {},
      }),
    ).rejects.toBeInstanceOf(MemoryRefusedError);
    await expect(
      harness.ingestion.createSource("person", {
        agentId: "notes-bot",
        toolRef: REF,
        title: "Package notes",
        args: {},
      }),
    ).rejects.toThrow(
      "Package tools run only inside a managed run, so they cannot be memory sources.",
    );
    // The refusal is not the accidental "lost access" sentence, and no plugin
    // read happened at all.
    expect(harness.calls.authorizePluginReads).toBe(0);
  });

  test("an already-configured package source is excluded and marked failed, never synced", async () => {
    const harness = memoryHarness([
      {
        id: "source-1",
        ownerUserId: "person",
        agentId: "notes-bot",
        toolRef: REF,
        title: "Package notes",
        args: {},
        enabled: true,
        syncStatus: "succeeded",
        lastSyncAt: new Date(),
        syncError: null,
      },
    ]);
    // Recall is the read that goes through eligibleSources: the package source
    // must not be eligible, must be recorded as failed, and no plugin read may
    // happen for it.
    await expect(
      harness.ingestion.recall("person", "notes-bot", "notes"),
    ).resolves.toEqual([]);
    expect(harness.calls.failSync).toEqual(["source-1"]);
    expect(harness.calls.authorizePluginReads).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (a) grantedTools —— the offer
// ---------------------------------------------------------------------------

describe("grantedTools package offer (PKG09)", () => {
  const descriptor: PackageToolDescriptor = {
    ref: REF,
    installId: INSTALL,
    resourceId: "notes",
    toolName: "lookup",
    effect: "read",
  };

  test("the run's pinned tools join the offer only with a run context", async () => {
    const state: SeamState = {
      listed: [descriptor],
      listCalls: 0,
      prepared: 0,
      dispatched: 0,
      cancelled: 0,
    };
    const store = storeOf({ seam: makeSeam(state) });

    const withoutContext = await grantedTools({
      store,
      botId: "notes-bot",
      actorId: "person",
    });
    expect(withoutContext.map((tool) => tool.name)).not.toContain(
      toolNameFor(REF),
    );
    expect(state.listCalls).toBe(0);

    const withContext = await grantedTools({
      store,
      botId: "notes-bot",
      actorId: "person",
      packageRun: runContext,
    });
    const offered = withContext.find((tool) => tool.name === toolNameFor(REF));
    expect(offered?.ref).toBe(REF);
    expect(state.listCalls).toBe(1);

    // The offered tool executes through the package branch with the SAME
    // server-issued context.
    const answer = await offered?.execute({ query: "notes" });
    // The store's own untrusted-data wrapper is applied on the way out — the
    // vendor text is carried, never presented as instructions.
    expect(String(answer)).toContain("two notes");
    expect(state.prepared).toBe(1);
    expect(state.dispatched).toBe(1);
  });

  test("grantedSkills serves legacy skills only — pinned skills arrive via the runner", async () => {
    const store = storeOf({});
    const skills = await (await import("../src/plugins/tools")).grantedSkills({
      store,
      botId: "notes-bot",
    });
    expect(skills).toEqual([]);
  });
});
