import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { AppVariables } from "../src/auth/guards";
import { loadCraftConfig } from "../src/craft/config";
import { WorkspaceListingError } from "../src/craft/directory-archive";
import { SandboxExecutionScopeUnavailableError } from "../src/craft/errors";
import { CraftSessionManager } from "../src/craft/manager";
import type { CraftLLMProviderConfig } from "../src/craft/opencode-config";
import {
  createSandboxGateway,
  type SandboxGateway,
} from "../src/craft/sandbox-gateway";
import {
  assertNotScopeRefusal,
  sandboxScopeRefusalOf,
} from "../src/craft/scope-refusal";
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

/** The OCR r3 #4 counterpart: the pair fully present — the assert passes, the wake proceeds. */
const fullyScopedConfig = loadCraftConfig({
  OPENBOT_CRAFT_SANDBOX_EXECUTION_TENANT_ID: "acme-co",
  OPENBOT_CRAFT_SANDBOX_EXECUTION_WORKSPACE_ID: "acme-ws",
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
function scopeRoutes(input?: {
  session?: CraftSessionRow;
  withSnapshot?: boolean;
  /** "half" (default): a half scope is no scope, the refusal fires. "full": the pair resolves. */
  scope?: "half" | "full";
  /** Override the gateway outright (stubbed probes); default is the REAL gateway on the chosen scope. */
  gateway?: SandboxGateway;
  /** Live managed-content fingerprints — make a runtime stale so reload reaches its first write. */
  managedContentHashesFor?: (
    session: CraftSessionRow,
  ) => Promise<{ skillsHash: string | null; mcpConfigHash: string | null }>;
}) {
  const config = input?.scope === "full" ? fullyScopedConfig : halfScopedConfig;
  const calls: { method: string; url: string }[] = [];
  const fetchImpl = (async (input_: unknown, init?: RequestInit) => {
    const url = new URL(String(input_));
    calls.push({ method: init?.method ?? "GET", url: url.pathname });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const gateway =
    input?.gateway ??
    createSandboxGateway({
      config,
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
    async findSession(sessionId: string, userId: string) {
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
    config,
    store,
    gateway,
    llmConfigFor: async () => llm,
    botIdFor: async () => "craft",
    managedContentHashesFor: input?.managedContentHashesFor,
  });

  const app = createSessionRoutes(fakeRequireUser(), {
    db: {} as never,
    config,
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
    turnState: {
      async getActiveTurn() {
        return null; // no live turn: the reload reaches its gateway write
      },
    } as never,
    managedContentHashesFor: input?.managedContentHashesFor,
  } as never);
  return { app, calls, rows };
}

describe("#618 FR-F1: the scope refusal answers at the session-lifecycle entrances", () => {
  const REFUSAL = new SandboxExecutionScopeUnavailableError().message;

  test("create answers 503 with the fixed sentence, zero outbound calls", async () => {
    const { app, calls } = scopeRoutes();
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
    const { app, calls } = scopeRoutes({
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
    const { app, calls } = scopeRoutes({
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

  test("the read face stays available: GET detail leaves the row honestly idle", async () => {
    // The detail read is not a lifecycle entrance — a scopeless deployment must
    // still open the sidebar's session (the turn face carries the refusal when
    // the person actually acts). The wake is refused, and the row must NOT be
    // CASed active behind a wake that never ran — that mask (200 + "active" +
    // nothing restored) is exactly what stranded the restore entrance's 503
    // behind a warm path. The honest answer is 200 + still sleeping (OCR#11).
    const { app, calls } = scopeRoutes({
      session: sessionRow({ status: "idle" }),
      withSnapshot: true,
    });
    const response = await app.request(`/sessions/${SESSION_ID}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      status: string;
      session_loaded_in_sandbox: boolean;
    };
    expect(body.id).toBe(SESSION_ID);
    expect(body.status).toBe("idle"); // not woken: the refusal keeps the row honest
    // OCR r3 #1: a refused wake loaded nothing into any sandbox — the flag must
    // not still hardcode true against the row's own "sleeping" (idle) status.
    expect(body.session_loaded_in_sandbox).toBe(false);
    expect(calls).toEqual([]);
  });

  test("after a refused detail read, POST restore still answers 503 — the wake entrance is not preempted", async () => {
    // The detail-first flow (open the session, then hit restore): only the
    // refusal-not-CAS discipline above keeps THIS entrance reachable — a row
    // already flipped active would take the warm fast path and answer 200
    // forever, leaving the person to discover the refusal on their first turn.
    const { app, calls } = scopeRoutes({
      session: sessionRow({ status: "idle" }),
      withSnapshot: true,
    });
    const detail = await app.request(`/sessions/${SESSION_ID}`);
    expect(detail.status).toBe(200);
    const response = await app.request(`/sessions/${SESSION_ID}/restore`, {
      method: "POST",
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(REFUSAL);
    expect(calls).toEqual([]);
  });

  test("skills reload answers 503 with the fixed sentence, zero outbound calls", async () => {
    // OCR#1: reload is a person's explicit action and routes through the
    // gateway's file verbs (the opencode.json rewrite) — a scopeless deployment
    // answers the fixed sentence here too, not the misleading "Failed to reload
    // session." 502 its catch used to wear.
    const { app, calls } = scopeRoutes({
      session: sessionRow({
        status: "active",
        opencodeSessionId: "ses_scope",
        skillsHash: "old",
      }),
      managedContentHashesFor: async () => ({
        skillsHash: "live",
        mcpConfigHash: null,
      }),
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/skills/reload`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(REFUSAL);
    expect(body.error).not.toContain("acme-co");
    expect(calls).toEqual([]);
  });

  test("sandbox-status answers failed, not an eternal provisioning", async () => {
    // OCR#12: a missing scope is an admin-level permanent failure — the chip
    // must wear the settled red "failed", never a "provisioning" that can
    // never clear (the cold-start mask the null probe used to fold into).
    const { app, calls } = scopeRoutes({
      session: sessionRow({ status: "active" }),
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/sandbox-status`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("failed");
    expect(calls).toEqual([]);
  });

  test("restore of an active session is the warm fast path — no gateway touch", async () => {
    const { app, calls } = scopeRoutes({
      session: sessionRow({ status: "active" }),
    });
    const response = await app.request(`/sessions/${SESSION_ID}/restore`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([]);
  });
  test("a successful wake still answers session_loaded_in_sandbox: true (OCR r3 #1, the derivation's true side)", async () => {
    // Scoped pair, idle row, newest snapshot present: the wake really dials the
    // restore, the row CASes active, and the DERIVED flag (woken.status !==
    // "idle") still answers true — the derivation narrows only the refused
    // case, never the honest warm wake.
    const { app, calls } = scopeRoutes({
      scope: "full",
      session: sessionRow({ status: "idle" }),
      withSnapshot: true,
    });
    const response = await app.request(`/sessions/${SESSION_ID}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      session_loaded_in_sandbox: boolean;
    };
    expect(body.status).toBe("active");
    expect(body.session_loaded_in_sandbox).toBe(true);
    // exactly the one restore dial — the wake itself, nothing else
    expect(calls).toEqual([{ method: "POST", url: "/workspace/restore" }]);
  });

  test("sandbox-status recognizes a WRAPPED refusal by its cause — the chip answers failed, not an eternal provisioning (OCR r3 #2)", async () => {
    // A future wrap between gateway.healthCheck and this catch (bot context, an
    // error enhancer) must not silently turn the settled "failed" back into the
    // "provisioning" cold-start mask OCR#12 closed: the recognizer rides the
    // structural cause chain, exactly like every entrance's catch. The wrap's
    // TEXT deliberately lost the fixed sentence — only the cause carries it.
    const wrapped = new WorkspaceListingError(
      "/doc",
      new SandboxExecutionScopeUnavailableError(),
    );
    wrapped.message = "rewritten by a future healthCheck wrap layer";
    const { app } = scopeRoutes({
      session: sessionRow({ status: "active" }),
      gateway: {
        healthCheck: async () => {
          throw wrapped;
        },
      } as unknown as SandboxGateway,
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/sandbox-status`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("failed");
  });

  test("restore without a snapshot row, scopeless deployment: 503, and the row is NOT CASed active (OCR r3 #4)", async () => {
    // No snapshot row (or an evicted blob) means restoreLatestSnapshot never
    // dials — the refusal had no chance to throw, and the entrance used to CAS
    // active behind a wake that ran nothing: FR-F1's "wake quietly degraded to
    // a rebuild" with the 503 unreachable until the next turn. The pre-CAS
    // scope assert closes it — the 503 no longer depends on a snapshot
    // existing — and the assert itself resolves without any dial.
    const { app, calls, rows } = scopeRoutes({
      session: sessionRow({ status: "idle" }),
      // no withSnapshot: nothing to restore, so the gateway is never dialed
    });
    const response = await app.request(`/sessions/${SESSION_ID}/restore`, {
      method: "POST",
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(REFUSAL);
    expect(rows.get(SESSION_ID)?.status).toBe("idle"); // never CASed behind a wake that ran nothing
    expect(calls).toEqual([]); // the scope assert resolves, it does not dial
  });

  test("restore without a snapshot row, scoped deployment: 200 — the rebuild semantics unchanged (OCR r3 #4)", async () => {
    // The assert must not narrow the honest degrade-to-rebuild: scope present +
    // nothing to restore still wakes — CAS active, 200, zero dials — and the
    // next turn's reconcile rebuilds the workspace, as ever.
    const { app, calls, rows } = scopeRoutes({
      scope: "full",
      session: sessionRow({ status: "idle" }),
    });
    const response = await app.request(`/sessions/${SESSION_ID}/restore`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      session_loaded_in_sandbox: boolean;
    };
    expect(body.status).toBe("active");
    expect(body.session_loaded_in_sandbox).toBe(true);
    expect(rows.get(SESSION_ID)?.status).toBe("active");
    expect(calls).toEqual([]);
  });
});

describe("#618 OCR r4: the recognizer hands back the ORIGINAL refused instance", () => {
  test("the structural cause arm returns error.cause — the first-throw stack survives the wrap", () => {
    // The refusal design keeps no log line, so the first throw's stack — minted
    // inside scopeHeaders(), before the archive walk folds it — is the only
    // trace an operator ever sees. The wrap's cause IS that instance; a rebuild
    // (what this arm used to answer) discards its stack. The direct arm already
    // returned the original; the two paths now agree.
    const refusal = new SandboxExecutionScopeUnavailableError();
    const wrap = new WorkspaceListingError("dir", refusal);
    expect(sandboxScopeRefusalOf(wrap)).toBe(refusal);
    expect(sandboxScopeRefusalOf(refusal)).toBe(refusal);
  });
});

describe("#656 D2: the one guard shape answers the refusal's own 503", () => {
  const REFUSAL = new SandboxExecutionScopeUnavailableError().message;

  test("the guard throws the 503 itself — status and body verbatim", async () => {
    // The seven call sites no longer build the response themselves: the guard's
    // throw IS the answer (an HTTPException hono's error chain hands straight
    // to the wire), which is what makes "the refusal precedes the masking
    // branch" a property of the guard rather than of each catch's ordering.
    let caught: unknown = null;
    try {
      assertNotScopeRefusal(new SandboxExecutionScopeUnavailableError());
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof HTTPException).toBe(true);
    const refusal = caught as HTTPException;
    expect(refusal.status).toBe(503);
    const response = refusal.getResponse();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: REFUSAL });
  });

  test("a non-refusal passes the guard untouched — nothing throws, nothing masks", () => {
    // The guard must be a no-op for every other error the catches see: their
    // own masking branches (the 413 needle, the 502/404 faces) stay reachable.
    let threw = false;
    try {
      assertNotScopeRefusal(new Error("Sandbox /file answered 413."));
      assertNotScopeRefusal(
        new WorkspaceListingError("dir", new Error("boom")),
      );
      assertNotScopeRefusal("not even an error");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

describe("#656 D3: the recognizer walks any wrap's cause chain", () => {
  test("a plain Error wrapping a refusal is recognized — the healthCheck chain shape", () => {
    // #618 OCR r3 #2 pinned this for the WorkspaceListingError wrap; the
    // contract is the STRUCTURE (a refusal riding as cause), not that one
    // class — a future wrap layer between healthCheck and its catch (bot
    // context, an error enhancer) must not re-open the mask. The original
    // instance comes back, exactly like the direct arm (#618 OCR r4).
    const refusal = new SandboxExecutionScopeUnavailableError();
    const wrap = new Error("probe context layer: upstream unreachable", {
      cause: refusal,
    });
    expect(sandboxScopeRefusalOf(wrap)).toBe(refusal);
  });

  test("the walk answers at four hops and stops at five — the bound", () => {
    // Bounded, not exhaustive: a refusal deeper than any real fold (the
    // archive walk is one hop, a probe wrap two) is not ours to claim, and an
    // unbounded walk would follow a crafted chain as far as it was given.
    const deep = (hops: number): Error => {
      let current = new SandboxExecutionScopeUnavailableError();
      for (let i = 0; i < hops; i += 1) {
        current = new Error(`layer ${i}`, { cause: current });
      }
      return current;
    };
    expect(sandboxScopeRefusalOf(deep(4))).toBeInstanceOf(
      SandboxExecutionScopeUnavailableError,
    );
    expect(sandboxScopeRefusalOf(deep(5))).toBe(null);
  });

  test("a cyclic cause chain terminates at the bound — no infinite walk", () => {
    // cause chains can loop (a wraps b wraps a); the depth bound is the
    // cycle-proofing, so recognizing a cyclic non-refusal chain answers null
    // instead of hanging the recognizer (and the route's catch with it).
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(sandboxScopeRefusalOf(a)).toBe(null);
  });

  test("sandbox-status recognizes a PLAIN wrap's refusal — the chip answers failed, not an eternal provisioning", async () => {
    // The route face of the plain-wrap case above: a wrap the recognizer never
    // saw coming (not a WorkspaceListingError) still must not turn the settled
    // "failed" back into OCR#12's "provisioning" cold-start mask.
    const refusal = new SandboxExecutionScopeUnavailableError();
    const wrapped = new Error("bot context: probe layer failed", {
      cause: refusal,
    });
    const { app } = scopeRoutes({
      session: sessionRow({ status: "active" }),
      gateway: {
        healthCheck: async () => {
          throw wrapped;
        },
      } as unknown as SandboxGateway,
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/sandbox-status`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("failed");
  });
});
