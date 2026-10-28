// server/tests/package-dispatch-call.test.ts
// PKG05（Issue #464）：callTool 的包分支——上下文、策略/审批门与禁止回退。
//
// 证据面（Spec §9 + #464 AC4/AC5 + A07 的 store 侧臂）：
//   (1) `pkg:` 引用且无包上下文 → PACKAGE_RUN_REQUIRED 语义的拒绝 + 审计行
//       （不改 legacy 合同：legacy 引用在同一 store 上照旧）。
//   (2) 部署未接线 package seam → 同样拒绝，绝不以 legacy grant 放行。
//   (3) prepare 拒绝（如本人无连接）→ 固定拒绝句，无 cancel（无票面）。
//   (4) 策略拒绝 → 拒绝句 + cancel（prepared → cancelled）。
//   (5) 参数携带凭据形态 → 内容检查拒绝（A04）。
//   (6) 审批挂起（HeadlessToolSuspension）→ 原样上抛，行停留 prepared，
//       绝不 dispatch。
//   (7) 审批 replay → 返回既有结果，cancel，不 dispatch。
//   (8) 快乐路径：prepare → 审批通过 → dispatch → 结果与审计/回执完成。
//   (9) dispatch 拒绝（如并发重复）→ 拒绝句 + cancel。
//   (10) secret canary：审计 payload 与返回值不含 token/摘要。
//
// store 为真实实现（真实 DB + 真实审计面）；package seam 为可控注入——
// 授权判定面（beginDispatch 的线性化）由 multitenancy 套件证明。

import { randomUUID } from "node:crypto";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import type { ApprovalCandidate, ApprovalGate } from "../src/approvals/types";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import type {
  PackageToolDescriptor,
  PackageToolRunContext,
  PackageToolSeam,
  PackageToolTicket,
} from "../src/plugins/package-tools";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);

const INSTALL = `pkg05-install-${randomUUID().slice(0, 8)}`;
const REF = `pkg:${INSTALL}:notes/lookup`;

const context: PackageToolRunContext = {
  runId: randomUUID(),
  attemptGeneration: 1,
  scope: { tenantId: "tenant", workspaceId: "ws" },
};

const ticket: PackageToolTicket = {
  runId: context.runId,
  attemptGeneration: 1,
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
  prepared: number;
  dispatched: number;
  cancelled: number;
  dispatchBehaviour: "ok" | { code: string };
};

function makeSeam(state: SeamState): PackageToolSeam {
  return {
    async list() {
      return state.listed;
    },
    async prepare() {
      state.prepared += 1;
      return { outcome: "ticket", ticket };
    },
    async dispatch() {
      state.dispatched += 1;
      if (state.dispatchBehaviour !== "ok") {
        return { outcome: "refused", code: state.dispatchBehaviour.code };
      }
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
const denyAllPolicy = () => ({
  mode: "enforce" as const,
  deny: ["true"],
  allow: [],
});

function storeOf(input: {
  seam?: PackageToolSeam;
  policy?: () => ReturnType<typeof allowAllPolicy>;
  approvalGate?: ApprovalGate;
}) {
  return createPluginStore({
    database,
    auditStore,
    credentials: { readSecret: async () => null },
    encryptionKey: "x".repeat(44),
    policy: input.policy ?? allowAllPolicy,
    ...(input.seam ? { packageTool: input.seam } : {}),
    ...(input.approvalGate ? { approvalGate: input.approvalGate } : {}),
  });
}

async function auditOf(ref: string) {
  return database
    .select({
      eventType: auditEvents.eventType,
      payload: auditEvents.payload,
    })
    .from(auditEvents)
    .where(eq(auditEvents.targetId, ref));
}

function payloadOf(row: { payload: unknown }): Record<string, unknown> {
  return (row.payload ?? {}) as Record<string, unknown>;
}

describe("callTool package branch (PKG05)", () => {
  test("a package tool ref without a run context answers PACKAGE_RUN_REQUIRED", async () => {
    const state = {
      listed: [],
      prepared: 0,
      dispatched: 0,
      cancelled: 0,
      dispatchBehaviour: "ok" as const,
    };
    const store = storeOf({ seam: makeSeam(state) });
    await expect(
      store.callTool({
        ref: REF,
        args: {},
        botId: "bot",
        actorId: "actor",
      }),
    ).rejects.toThrow(
      "Package tools run only inside a managed run, and this call has no run context.",
    );
    // The refusal is in the trail, and nothing reached the dispatch chain.
    const rows = await auditOf(REF);
    const refusalRow = rows.find(
      (row) => payloadOf(row).refusal === "package_run_required",
    );
    expect(refusalRow?.eventType).toBe("mcp.call_rejected");
    expect(state.prepared).toBe(0);
    expect(state.dispatched).toBe(0);
  });

  test("an unwired deployment refuses the same way — never a legacy fallback", async () => {
    const store = storeOf({});
    await expect(
      store.callTool({
        ref: REF,
        args: {},
        botId: "bot",
        actorId: "actor",
        packageRun: context,
      }),
    ).rejects.toThrow(/no run context|managed run/);
  });

  test("a prepare refusal answers its own sentence and never cancels", async () => {
    const state = {
      listed: [],
      prepared: 0,
      dispatched: 0,
      cancelled: 0,
      dispatchBehaviour: "ok" as const,
    };
    const seam = makeSeam(state);
    seam.prepare = async () => ({
      outcome: "refused" as const,
      code: "CONNECTION_UNAVAILABLE",
    });
    const store = storeOf({ seam });
    await expect(
      store.callTool({
        ref: REF,
        args: {},
        botId: "bot",
        actorId: "actor",
        packageRun: context,
      }),
    ).rejects.toThrow(
      "This package tool runs in your own connected account for this team. Connect your account and try again.",
    );
    expect(state.cancelled).toBe(0);
    expect(state.dispatched).toBe(0);
  });

  test("a policy refusal cancels the prepared row and never dispatches", async () => {
    const state = {
      listed: [],
      prepared: 0,
      dispatched: 0,
      cancelled: 0,
      dispatchBehaviour: "ok" as const,
    };
    const store = storeOf({
      seam: makeSeam(state),
      policy: denyAllPolicy,
    });
    await expect(
      store.callTool({
        ref: REF,
        args: {},
        botId: "bot",
        actorId: "actor",
        packageRun: context,
      }),
    ).rejects.toThrow();
    expect(state.prepared).toBe(1);
    expect(state.cancelled).toBe(1);
    expect(state.dispatched).toBe(0);
    const rows = await auditOf(REF);
    expect(rows.some((row) => payloadOf(row).refusal === "policy")).toBe(true);
  });

  test("credential-shaped arguments are refused before dispatch (A04)", async () => {
    const state = {
      listed: [],
      prepared: 0,
      dispatched: 0,
      cancelled: 0,
      dispatchBehaviour: "ok" as const,
    };
    const store = storeOf({ seam: makeSeam(state) });
    await expect(
      store.callTool({
        ref: REF,
        args: { api_key: "sk-ant-api03-abcdefghij0123456789ABCDEFGHIJ" },
        botId: "bot",
        actorId: "actor",
        packageRun: context,
      }),
    ).rejects.toThrow("credential material");
    expect(state.cancelled).toBe(1);
    expect(state.dispatched).toBe(0);
  });

  test("a pending approval suspends and leaves the prepared row waiting", async () => {
    const state = {
      listed: [],
      prepared: 0,
      dispatched: 0,
      cancelled: 0,
      dispatchBehaviour: "ok" as const,
    };
    const store = storeOf({
      seam: makeSeam(state),
      approvalGate: async () => {
        throw new HeadlessToolSuspension(
          "This action is waiting for your approval.",
        );
      },
    });
    await expect(
      store.callTool({
        ref: REF,
        args: {},
        botId: "bot",
        actorId: "actor",
        packageRun: context,
      }),
    ).rejects.toBeInstanceOf(HeadlessToolSuspension);
    expect(state.prepared).toBe(1);
    expect(state.cancelled).toBe(0);
    expect(state.dispatched).toBe(0);
  });

  test("an approval replay answers the stored result and cancels", async () => {
    const state = {
      listed: [],
      prepared: 0,
      dispatched: 0,
      cancelled: 0,
      dispatchBehaviour: "ok" as const,
    };
    const store = storeOf({
      seam: makeSeam(state),
      approvalGate: async () => ({
        replay: { text: "already done", isError: false },
        complete: async () => undefined,
      }),
    });
    const result = await store.callTool({
      ref: REF,
      args: {},
      botId: "bot",
      actorId: "actor",
      packageRun: context,
    });
    expect(result).toEqual({ text: "already done", isError: false });
    expect(state.cancelled).toBe(1);
    expect(state.dispatched).toBe(0);
  });

  test("the happy path prepares, dispatches and completes the approval", async () => {
    const state = {
      listed: [],
      prepared: 0,
      dispatched: 0,
      cancelled: 0,
      dispatchBehaviour: "ok" as const,
    };
    let completed = false;
    let approvedCandidate: ApprovalCandidate | undefined;
    const store = storeOf({
      seam: makeSeam(state),
      approvalGate: async (candidate) => {
        approvedCandidate = candidate;
        return {
          complete: async () => {
            completed = true;
          },
        };
      },
    });
    const result = await store.callTool({
      ref: REF,
      args: { query: "hi" },
      botId: "bot",
      actorId: "actor",
      packageRun: context,
    });
    expect(result).toEqual({ text: "two notes", isError: false });
    expect(state.dispatched).toBe(1);
    expect(completed).toBe(true);
    // The approval was bound to the dispatch facts (A07's digest surface).
    expect(approvedCandidate?.toolRef).toBe(REF);
    expect(approvedCandidate?.effect).toBe("read");
    expect(approvedCandidate?.target).toMatchObject({
      installId: INSTALL,
      connectionGeneration: 1,
      argsDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // The trail records the package outcome — never the arguments.
    const rows = await auditOf(REF);
    const successRow = rows.find((row) => payloadOf(row).source === "package");
    expect(successRow?.eventType).toBe("mcp.call_succeeded");
    expect(JSON.stringify(successRow?.payload)).not.toContain("hi");
  });

  test("a dispatch refusal answers its sentence and cancels", async () => {
    const state = {
      listed: [],
      prepared: 0,
      dispatched: 0,
      cancelled: 0,
      dispatchBehaviour: { code: "DUPLICATE_DISPATCH" },
    };
    const store = storeOf({ seam: makeSeam(state) });
    await expect(
      store.callTool({
        ref: REF,
        args: {},
        botId: "bot",
        actorId: "actor",
        packageRun: context,
      }),
    ).rejects.toThrow("This tool call was already dispatched in this run.");
    expect(state.cancelled).toBe(1);
  });

  test("a legacy ref with a package run keeps the legacy contract untouched", async () => {
    const state = {
      listed: [],
      prepared: 0,
      dispatched: 0,
      cancelled: 0,
      dispatchBehaviour: "ok" as const,
    };
    const store = storeOf({ seam: makeSeam(state) });
    // An unknown legacy server fails the legacy way; the package seam is never
    // consulted for it.
    await expect(
      store.callTool({
        ref: `pkg05_unknown_${randomUUID().slice(0, 6)}/tool`,
        args: {},
        botId: "bot",
        actorId: "actor",
        packageRun: context,
      }),
    ).rejects.toThrow();
    expect(state.prepared).toBe(0);
  });
});
