import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { ApprovalRecord, ApprovalStore } from "../src/approvals/types";
import {
  ApprovalNotFoundError,
  ApprovalRefusedError,
} from "../src/approvals/types";
import type { AppVariables } from "../src/auth/guards";
import {
  createCraftApprovalRoutes,
  listLiveApprovals,
  openCraftApproval,
} from "../src/craft/approvals";
import { loadCraftConfig } from "../src/craft/config";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";

const config = loadCraftConfig({});

function fakeRequireUser(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id: "u1", email: "u1@example.com", role: "user" });
    await next();
  };
}

const fakeStore = (overrides: Partial<CraftStore> = {}): CraftStore =>
  overrides as unknown as CraftStore;

function sessionRow(): CraftSessionRow {
  return {
    id: "cs-sess",
    userId: "u1",
    name: null,
    status: "active",
    lastActivityAt: new Date(),
    createdAt: new Date(),
    nextjsPort: null,
    sharingScope: "private",
    origin: "INTERACTIVE",
    opencodeSessionId: null,
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
  };
}

function approvalRecord(
  overrides: Partial<ApprovalRecord> = {},
): ApprovalRecord {
  return {
    id: "appr-1",
    ownerUserId: "u1",
    action: {
      actorId: "u1",
      botId: "craft",
      toolRef: "bash",
      effect: "execute",
      scope: "workspace",
      args: { command: "npm install" },
      runId: "cs-sess",
      threadId: "cs-sess",
      toolCallId: "appr-1",
      actionDigest: "digest",
    },
    status: "pending",
    decision: null,
    result: null,
    createdAt: new Date(),
    decidedAt: null,
    consumedAt: null,
    completedAt: null,
    ...overrides,
  };
}

/**
 * In-memory mirror of the store methods craft's approval surface touches. Decision writes are
 * recorded (`decisions`) so tests can assert WHICH path the endpoint took — the generic
 * `decide` (whose real implementation inserts the `approval.resume` work item and, for
 * allow_always, an approvalRules row) must never run for craft rows.
 */
function fakeApprovals(initial: ApprovalRecord[] = []): ApprovalStore & {
  records: ApprovalRecord[];
  decisions: string[];
} {
  const records = [...initial];
  const decisions: string[] = [];
  const settle = (
    owner: string,
    id: string,
    decision: "allow_once" | "allow_always" | "deny" | "handled",
    via: string,
  ) => {
    const found = records.find(
      (record) => record.ownerUserId === owner && record.id === id,
    );
    if (!found) throw new ApprovalNotFoundError();
    if (found.status !== "pending")
      throw new ApprovalRefusedError("This request was already decided.");
    decisions.push(`${via}:${decision}`);
    found.decision = decision;
    found.status = decision === "deny" ? "denied" : "approved";
    found.decidedAt = new Date();
    return found;
  };
  return {
    records,
    decisions,
    async enabled() {
      return true;
    },
    async setEnabled() {},
    async open(action) {
      const record: ApprovalRecord = {
        id: crypto.randomUUID(),
        ownerUserId: action.actorId,
        action,
        status: "pending",
        decision: null,
        result: null,
        createdAt: new Date(),
        decidedAt: null,
        consumedAt: null,
        completedAt: null,
      };
      records.push(record);
      return record;
    },
    async get(owner, id) {
      const found = records.find(
        (record) => record.ownerUserId === owner && record.id === id,
      );
      if (!found) throw new ApprovalNotFoundError();
      return found;
    },
    async list(owner) {
      return records.filter((record) => record.ownerUserId === owner);
    },
    async decide(owner, id, decision) {
      return settle(owner, id, decision, "decide");
    },
    async decideQuiet(owner, id, decision) {
      return settle(owner, id, decision, "decideQuiet");
    },
    async consume() {
      return false;
    },
    async saveResult() {
      return false;
    },
    async finish() {},
    async rules() {
      return [];
    },
    async revoke() {},
  };
}

const candidate = () => ({
  sessionId: "cs-sess",
  userId: "u1",
  botId: "craft",
  approvalId: "appr-1",
  toolRef: "bash",
  effect: "execute",
  scope: "workspace",
  args: { command: "npm install" },
});

describe("craft approvals", () => {
  test("open → live 1 → decision → live 0 → re-decision idempotent, conflict 409", async () => {
    const approvals = fakeApprovals();
    const store = fakeStore({ getSession: async () => sessionRow() });
    const app = createCraftApprovalRoutes(fakeRequireUser(), {
      config,
      store,
      approvals,
    });

    const record = await openCraftApproval(approvals, candidate());

    const live = await app.request("/sessions/cs-sess/approvals/live");
    expect(live.status).toBe(200);
    const liveBody = (await live.json()) as {
      approvals: Array<{ id: string }>;
    };
    expect(liveBody.approvals).toHaveLength(1);
    expect(liveBody.approvals[0].id).toBe(record.id);

    const decision = await app.request(`/approvals/${record.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow_once" }),
    });
    expect(decision.status).toBe(200);
    expect(await decision.json()).toEqual({ ok: true });
    expect(approvals.decisions).toEqual(["decideQuiet:allow_once"]);

    const liveAfter = await app.request("/sessions/cs-sess/approvals/live");
    const liveAfterBody = (await liveAfter.json()) as {
      approvals: unknown[];
    };
    expect(liveAfterBody.approvals).toHaveLength(0);

    const duplicate = await app.request(`/approvals/${record.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow_once" }),
    });
    expect(duplicate.status).toBe(200); // same decision replays idempotently (onyx)

    const conflicting = await app.request(`/approvals/${record.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    });
    expect(conflicting.status).toBe(409); // a different decision conflicts (onyx)
  });

  test("listLiveApprovals drops expired and other-session rows", async () => {
    const approvals = fakeApprovals([
      approvalRecord({
        id: "a",
        createdAt: new Date(Date.now() - 10_000),
      }),
      approvalRecord({
        id: "b",
        action: { ...approvalRecord().action, runId: "cs-other" },
      }),
      approvalRecord({ id: "c" }),
    ]);

    const live = await listLiveApprovals({
      approvals,
      sessionId: "cs-sess",
      userId: "u1",
      maxAgeSeconds: 1,
    });

    expect(live.map((record) => record.id)).toEqual(["c"]);
  });

  test("decide writes only the quiet path — no work item, no rule row; allow_always lands as-is", async () => {
    const approvals = fakeApprovals();
    const store = fakeStore({ getSession: async () => sessionRow() });
    const app = createCraftApprovalRoutes(fakeRequireUser(), {
      config,
      store,
      approvals,
    });

    const record = await openCraftApproval(approvals, candidate());

    // allow_always ≡ allow_once on the craft side: the decision lands verbatim (so its
    // replay stays idempotent), but no persistent grant is ever written.
    const decision = await app.request(`/approvals/${record.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow_always" }),
    });
    expect(decision.status).toBe(200);
    expect(await decision.json()).toEqual({ ok: true });

    const after = await approvals.get("u1", record.id);
    expect(after.status).toBe("approved");
    expect(after.decision).toBe("allow_always");

    // The regression this guards: the generic `decide` never ran — in the real store that
    // path inserts an `approval.resume` work item (worker bounded-retry noise for a craft
    // row with no continuation) and an approvalRules row (a grant craft never reads).
    expect(approvals.decisions).toEqual(["decideQuiet:allow_always"]);

    // Idempotent replay writes nothing again; a different decision still conflicts.
    const replay = await app.request(`/approvals/${record.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow_always" }),
    });
    expect(replay.status).toBe(200);
    const conflict = await app.request(`/approvals/${record.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    });
    expect(conflict.status).toBe(409);
    expect(approvals.decisions).toEqual(["decideQuiet:allow_always"]);

    // And a first-time deny rides the quiet path too.
    const record2 = await openCraftApproval(approvals, {
      ...candidate(),
      approvalId: "appr-2",
    });
    const deny = await app.request(`/approvals/${record2.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    });
    expect(deny.status).toBe(200);
    expect(approvals.decisions).toEqual([
      "decideQuiet:allow_always",
      "decideQuiet:deny",
    ]);
    expect((await approvals.get("u1", record2.id)).status).toBe("denied");
  });
});
