import type { MiddlewareHandler } from "hono";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { AppVariables } from "../src/auth/guards";
import { loadCraftConfig } from "../src/craft/config";
import { SandboxExecutionScopeUnavailableError } from "../src/craft/errors";
import { CraftSessionManager } from "../src/craft/manager";
import type { CraftLLMProviderConfig } from "../src/craft/opencode-config";
import { createSandboxGateway } from "../src/craft/sandbox-gateway";
import { createSessionRoutes } from "../src/craft/session-routes";
import type {
  CraftSessionRow,
  CraftSnapshotRow,
  CraftStore,
} from "../src/craft/store";

/**
 * #618 (FR-F1): the session-lifecycle entrances — create, snapshot, restore — meet the
 * scope refusal through the same gateway chokepoint the file face does (the first
 * provisioning write for create, the archive/restore dial for the snapshot pair), and T2's
 * real stack showed all three swallowing it into their generic 500/502/200 masks. These
 * route tests pin the contract AC3 asks for: the fixed, admin-fixable sentence as the
 * answer (503), no ownership value echoed, and zero outbound calls — the refusal happens
 * before fetch, exactly like the file face's R1-F2/r3 fixes.
 *
 * The gateway is REAL (half-scoped config: a half scope is no scope), so the error's
 * provenance is the production scopeHeaders throw, not a hand-thrown stub; the manager is
 * real too, so create exercises the genuine provisioning chain up to its first write.
 */

const SESSION_ID = "cs-sess";

const halfScopedConfig = loadCraftConfig({
  OPENBOT_CRAFT_SANDBOX_EXECUTION_TENANT_ID: "acme-co",
});

const llm: CraftLLMProviderConfig = {
  provider: "openbot",
  modelName: "glm-test",
  apiKey: null,
  apiBase: null,
  displayName: null,
  models: null,
};

function fakeRequireUser(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id: "u1", email: "u1@example.com", role: "user" });
    await next();
  };
}

function sessionRow(overrides: Partial<CraftSessionRow> = {}): CraftSessionRow {
  return {
    id: SESSION_ID,
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
    ...overrides,
  };
}

const snapshotRow = (): CraftSnapshotRow => ({
  id: "csn-1",
  sessionId: SESSION_ID,
  storagePath: `sandbox-snapshots/craft/csn-1.tar.gz`,
  sizeBytes: 4,
  createdAt: new Date(),
});

/**
 * A REAL gateway on the half-scoped deployment plus a recording fetchImpl — the
 * fail-closed contract says the recorder must stay empty (the refusal precedes fetch).
 */
function unscopedScopeRoutes(input?: {
  session?: CraftSessionRow;
  withSnapshot?: boolean;
}) {
  const calls: { method: string; url: string }[] = [];
  const fetchImpl = (async (input_: unknown, init?: RequestInit) => {
    const url = new URL(String(input_));
    calls.push({ method: init?.method ?? "GET", url: url.pathname });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const gateway = createSandboxGateway({
    config: halfScopedConfig,
    connectionFor: () => ({
      botId: "craft",
      baseUrl: "http://gw.test",
      token: "sandbox-secret",
    }),
    fetchImpl,
  });

  const rows = new Map<string, CraftSessionRow>();
  if (input?.session) rows.set(input.session.id, { ...input.session });
  let created = 0;
  const store = {
    async createSession(creation: { userId: string; name?: string | null }) {
      const row = sessionRow({
        id: `cs-new-${created++}`,
        userId: creation.userId,
        name: creation.name ?? null,
        status: "initializing",
      });
      rows.set(row.id, row);
      return { ...row };
    },
    async reserveNextjsPort(reservation: {
      userId: string;
      sessionId: string;
      portStart: number;
      portEnd: number;
    }) {
      const row = rows.get(reservation.sessionId);
      if (!row) throw new Error("no row");
      row.nextjsPort = reservation.portStart;
      return reservation.portStart;
    },
    async getSession(sessionId: string, userId: string) {
      const row = rows.get(sessionId);
      return row && row.userId === userId ? { ...row } : undefined;
    },
    async getEmptySessionForUser() {
      return undefined; // every POST /sessions takes the genuine create path
    },
    async updateSession(sessionId: string, patch: Partial<CraftSessionRow>) {
      const row = rows.get(sessionId);
      if (!row) return undefined;
      Object.assign(row, patch);
      return { ...row };
    },
    async finalizeSessionInitialization() {
      return true;
    },
    async resetFailedSessionForRepair() {
      return true;
    },
    async getLatestSnapshot(sessionId: string) {
      return input?.withSnapshot && sessionId === SESSION_ID
        ? snapshotRow()
        : undefined;
    },
  } as unknown as CraftStore;

  const blobs = new Map<string, Uint8Array>([
    [snapshotRow().storagePath, new Uint8Array([1, 2, 3, 4])],
  ]);
  const objectStore = {
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
    async put(key: string, bytes: Uint8Array) {
      blobs.set(key, bytes);
    },
  };

  const manager = new CraftSessionManager({
    config: halfScopedConfig,
    store,
    gateway,
    llmConfigFor: async () => llm,
    botIdFor: async () => "craft",
  });

  const app = createSessionRoutes(fakeRequireUser(), {
    db: {} as never,
    config: halfScopedConfig,
    store,
    manager,
    // The lock only serializes creators; the route's answer under test is the
    // refusal inside the body, so a passthrough lock keeps the test on that path.
    locks: {
      withSessionCreationLock: <T>(_userId: string, body: () => Promise<T>) =>
        body(),
    } as never,
    gateway,
    objectStore: objectStore as never,
    botIdFor: async () => "craft",
    userNameFor: async () => null,
  } as never);
  return { app, calls };
}

describe("#618 FR-F1: the scope refusal answers at the session-lifecycle entrances", () => {
  const REFUSAL = new SandboxExecutionScopeUnavailableError().message;

  test("create answers 503 with the fixed sentence, zero outbound calls", async () => {
    const { app, calls } = unscopedScopeRoutes();
    const response = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(REFUSAL);
    // The configured half must never echo back into an answer people read.
    expect(body.error).not.toContain("acme-co");
    expect(calls).toEqual([]); // fail-closed: no request ever left the process
  });

  test("snapshot answers 503 with the fixed sentence, zero outbound calls", async () => {
    const { app, calls } = unscopedScopeRoutes({
      session: sessionRow({ status: "active" }),
    });
    const response = await app.request(`/sessions/${SESSION_ID}/snapshot`, {
      method: "POST",
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(REFUSAL);
    expect(body.error).not.toContain("acme-co");
    expect(calls).toEqual([]);
  });

  test("restore of an idle session answers 503 with the fixed sentence, zero outbound calls", async () => {
    // The wake replays the newest snapshot, so the refusal is met at the restore
    // dial — it must not degrade into "no snapshot" (the false that silently
    // skips the wake) nor surface as a bare 200 with an unwoken session.
    const { app, calls } = unscopedScopeRoutes({
      session: sessionRow({ status: "idle" }),
      withSnapshot: true,
    });
    const response = await app.request(`/sessions/${SESSION_ID}/restore`, {
      method: "POST",
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(REFUSAL);
    expect(body.error).not.toContain("acme-co");
    expect(calls).toEqual([]);
  });

  test("the read face stays available: GET detail degrades the wake, not the answer", async () => {
    // The detail read is not a lifecycle entrance — a scopeless deployment must
    // still open the sidebar's session (the turn face carries the refusal when
    // the person actually acts). The wake fails, the row still answers 200.
    const { app, calls } = unscopedScopeRoutes({
      session: sessionRow({ status: "idle" }),
      withSnapshot: true,
    });
    const response = await app.request(`/sessions/${SESSION_ID}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; status: string };
    expect(body.id).toBe(SESSION_ID);
    expect(body.status).toBe("active"); // the CAS half of the wake still ran
    expect(calls).toEqual([]);
  });

  test("restore of an active session is the warm fast path — no gateway touch", async () => {
    const { app, calls } = unscopedScopeRoutes({
      session: sessionRow({ status: "active" }),
    });
    const response = await app.request(`/sessions/${SESSION_ID}/restore`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([]);
  });
});
