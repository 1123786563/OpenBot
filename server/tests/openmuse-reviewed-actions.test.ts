import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { Hono, MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import type { CalendarWireDial } from "../src/openmuse-calendar/client";
import { buildOpenMuseCalendarClient } from "../src/openmuse-calendar/client";
import { OpenMuseConnectionRefusedError } from "../src/openmuse-connectors/google-oauth";
import type { StoredOpenMuseGoogleConnection } from "../src/openmuse-connectors/store";
import type { MailWireDial } from "../src/openmuse-mail/client";
import { createCalendarCreateExecutor } from "../src/openmuse-reviewed-actions/calendar-create-executor";
import { createCalendarDeleteExecutor } from "../src/openmuse-reviewed-actions/calendar-delete-executor";
import { createCalendarUpdateExecutor } from "../src/openmuse-reviewed-actions/calendar-update-executor";
import { createKindDispatchingExecutor } from "../src/openmuse-reviewed-actions/dispatch-executor";
import type { ReviewedActionExecutor } from "../src/openmuse-reviewed-actions/executor";
import { createGmailSendExecutor } from "../src/openmuse-reviewed-actions/gmail-send-executor";
import type { ReviewedActionProposal } from "../src/openmuse-reviewed-actions/proposal";
import {
  payloadHashOf,
  REVIEWED_ACTION_TTL_MS,
} from "../src/openmuse-reviewed-actions/proposal";
import { createOpenMuseReviewedActionsRoutes } from "../src/openmuse-reviewed-actions/routes";
import { createOpenMuseReviewedActionService } from "../src/openmuse-reviewed-actions/service";
import {
  OpenMuseOwnerDisabledError,
  type ReviewedActionRows,
  type StoredReviewedAction,
  type StoredReviewedAttempt,
} from "../src/openmuse-reviewed-actions/store";

const actorOne: AuthenticatedActor = {
  id: "user-1",
  email: "one@openbot.test",
  role: "user",
};

const actorTwo: AuthenticatedActor = {
  id: "user-2",
  email: "two@openbot.test",
  role: "user",
};

/** R04: reconciliation is an operator surface — the admin actor. */
const actorAdmin: AuthenticatedActor = {
  id: "admin-1",
  email: "admin@openbot.test",
  role: "admin",
};

let currentActor: AuthenticatedActor = actorOne;
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", currentActor);
  await next();
};

/**
 * In-memory row seam: the same contract the drizzle rows implement. The CAS
 * primitive mutates synchronously, exactly what one real
 * `UPDATE ... WHERE status = $from` proves in a database.
 */
function fakeRows(): ReviewedActionRows & {
  actions: StoredReviewedAction[];
  attempts: StoredReviewedAttempt[];
} {
  const actions: StoredReviewedAction[] = [];
  const attempts: StoredReviewedAttempt[] = [];
  const disabled = new Set<string>();
  return {
    actions,
    attempts,
    insertAction: async (action) => {
      actions.push({
        ...action,
        attachmentVersionIds: [...action.attachmentVersionIds],
      });
    },
    getAction: async (id) => actions.find((row) => row.id === id) ?? null,
    listByOwner: async (ownerUserId, { limit, before }) =>
      actions
        .filter((row) => row.ownerUserId === ownerUserId)
        .filter((row) =>
          before
            ? row.createdAt < before.createdAt ||
              (row.createdAt.getTime() === before.createdAt.getTime() &&
                row.id < before.id)
            : true,
        )
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id > b.id ? -1 : 1),
        )
        .slice(0, limit),
    findSettledSameSend: async (ownerUserId, kind, payloadHash, targetId) =>
      actions
        .filter(
          (row) =>
            row.ownerUserId === ownerUserId &&
            row.kind === kind &&
            row.payloadHash === payloadHash &&
            (row.targetId ?? null) === targetId &&
            (row.status === "executing" ||
              row.status === "outcome_unknown" ||
              row.status === "succeeded"),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ??
      null,
    // M37's twin query, mirrored from the drizzle rows.
    findAwaitingSameSend: async (ownerUserId, kind, payloadHash, targetId) =>
      actions.find(
        (row) =>
          row.ownerUserId === ownerUserId &&
          row.kind === kind &&
          row.payloadHash === payloadHash &&
          (row.targetId ?? null) === targetId &&
          row.status === "awaiting_review",
      ) ?? null,
    resetStaleExecuting: async (cutoff) => {
      const recovered: string[] = [];
      for (const row of actions) {
        if (
          row.status !== "executing" ||
          row.decidedAt === null ||
          row.decidedAt >= cutoff
        )
          continue;
        row.status = "outcome_unknown";
        row.error =
          "The executing attempt was abandoned by a restart; whether it was applied is unknown.";
        recovered.push(row.id);
      }
      return recovered;
    },
    claimTransition: async (id, from, to, patch) => {
      const row = actions.find((candidate) => candidate.id === id);
      if (!row || row.status !== from) return null;
      row.status = to;
      if (patch?.decidedAt !== undefined) row.decidedAt = patch.decidedAt;
      if (patch?.completedAt !== undefined) row.completedAt = patch.completedAt;
      if (patch?.providerRef !== undefined) row.providerRef = patch.providerRef;
      if (patch?.error !== undefined) row.error = patch.error;
      return { ...row };
    },
    insertAttempt: async (attempt) => {
      attempts.push({ ...attempt });
    },
    latestAttempt: async (actionId) =>
      attempts.find((attempt) => attempt.actionId === actionId) ?? null,
    updateAttempt: async (attemptId, patch) => {
      const attempt = attempts.find((row) => row.attemptId === attemptId);
      if (!attempt) return null;
      if (patch.fingerprint !== undefined)
        attempt.fingerprint = patch.fingerprint;
      if (patch.outcome !== undefined) attempt.outcome = patch.outcome;
      if (patch.providerRef !== undefined)
        attempt.providerRef = patch.providerRef;
      if (patch.completedAt !== undefined)
        attempt.completedAt = patch.completedAt;
      if (patch.reconciliation !== undefined)
        attempt.reconciliation = patch.reconciliation;
      return { ...attempt };
    },
    ownerDisabled: async (ownerUserId) => disabled.has(ownerUserId),
    disableOwner: async (ownerUserId) => {
      disabled.add(ownerUserId);
    },
    restoreOwner: async (ownerUserId) => {
      disabled.delete(ownerUserId);
    },
    listIdsByOwner: async (ownerUserId) =>
      actions
        .filter((row) => row.ownerUserId === ownerUserId)
        .map((row) => row.id),
    /** D02: the §9 bulk awaiting → cancelled, awaiting_review only. */
    cancelAwaiting: async (ownerUserId) => {
      const cancelled: string[] = [];
      for (const row of actions) {
        if (row.ownerUserId !== ownerUserId || row.status !== "awaiting_review")
          continue;
        row.status = "cancelled";
        row.decidedAt = new Date();
        cancelled.push(row.id);
      }
      return cancelled;
    },
  };
}

/** The fake's fixed fingerprint: 64 hex chars, as every sha256 fingerprint is. */
const FIXED_FINGERPRINT = "ab".repeat(32);

/** The counting fake: outcomes are planned ahead, unplanned calls succeed. */
function fakeExecutor() {
  const calls: ReviewedActionProposal[] = [];
  let planned: Array<"succeeded" | "failed" | "outcome_unknown"> = [];
  const executor: ReviewedActionExecutor = {
    execute: async (proposal) => {
      calls.push(proposal);
      const outcome = planned.shift() ?? "succeeded";
      return {
        outcome,
        ...(outcome === "succeeded"
          ? { providerRef: `fake-ref-${calls.length}` }
          : {}),
        ...(outcome === "failed" ? { error: "the fake executor refused" } : {}),
        fingerprint: FIXED_FINGERPRINT,
      };
    },
  };
  return {
    executor,
    calls,
    plan: (...outcomes: Array<"succeeded" | "failed" | "outcome_unknown">) => {
      planned = [...outcomes];
    },
  };
}

/** The §6 fixed mail fixture; its hash is asserted literally below. */
const mailPayload = {
  body: "See you at ten.",
  subject: "Lunch",
  to: ["ava@example.com"],
};
/** sha256 of the canonical serialization of `mailPayload`. */
const MAIL_PAYLOAD_HASH =
  "65882bf5777548fd883ca4dbabb0423b182a789525199628095a1b15bee1207e";

type Fixture = {
  service: ReturnType<typeof createOpenMuseReviewedActionService>;
  rows: ReturnType<typeof fakeRows>;
  executor: ReturnType<typeof fakeExecutor>;
  app: Hono<{ Variables: AppVariables }>;
};

let nowMs = Date.parse("2026-10-13T10:00:00.000Z");

function fixtureFor(): Fixture {
  const rows = fakeRows();
  const executor = fakeExecutor();
  const service = createOpenMuseReviewedActionService({
    rows,
    executor: executor.executor,
    now: () => new Date(nowMs),
  });
  const app = createOpenMuseReviewedActionsRoutes({ service, requireUser });
  return { service, rows, executor, app };
}

function proposeBody(overrides: Record<string, unknown> = {}) {
  return {
    // An EXECUTABLE kind: the propose route refuses the legacy `mail`/
    // `calendar` kinds with 400 (no executor is registered for them), so the
    // route-level fixtures propose gmail.send — same payload shape.
    kind: "gmail.send",
    payload: mailPayload,
    accountEmail: "owner@example.com",
    connectionGeneration: 2,
    ...overrides,
  };
}

async function propose(
  app: Hono<{ Variables: AppVariables }>,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; payloadHash: string } & Record<string, unknown>> {
  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(proposeBody(overrides)),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as never;
}

function decide(
  app: Hono<{ Variables: AppVariables }>,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/${id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** R04's operator surface: the reconciliation POST, in the admin seat. */
function reconcile(
  app: Hono<{ Variables: AppVariables }>,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/${id}/reconcile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("§6 state table", () => {
  describe("1. propose", () => {
    test("creates awaiting_review with +30min expiry and the literal canonical sha256", async () => {
      const fixture = fixtureFor();
      const created = await propose(fixture.app);
      expect(created.status).toBe("awaiting_review");
      expect(created.payloadHash).toBe(MAIL_PAYLOAD_HASH);
      expect(created.ownerUserId).toBe("user-1");
      expect(created.kind).toBe("gmail.send");
      // The boundary is exact: thirty minutes, to the millisecond.
      expect(
        Date.parse(created.expiresAt as string) -
          Date.parse(created.createdAt as string),
      ).toBe(REVIEWED_ACTION_TTL_MS);
      expect(fixture.executor.calls).toHaveLength(0);
    });

    test("persists targetId, targetVersion and attachmentVersionIds when present", async () => {
      const fixture = fixtureFor();
      const created = await propose(fixture.app, {
        targetId: "msg-7",
        targetVersion: "v3",
        attachmentVersionIds: ["fv-9", "fv-10"],
      });
      const stored = fixture.rows.actions.find((row) => row.id === created.id);
      expect(stored).toMatchObject({
        targetId: "msg-7",
        targetVersion: "v3",
        attachmentVersionIds: ["fv-9", "fv-10"],
        accountEmail: "owner@example.com",
        connectionGeneration: 2,
      });
    });

    test("an unknown kind or a malformed payload is 400 and stores nothing", async () => {
      const fixture = fixtureFor();
      const badKind = await fixture.app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proposeBody({ kind: "smoke-signal" })),
      });
      expect(badKind.status).toBe(400);
      const noSubject = await fixture.app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          proposeBody({ payload: { to: ["a@b.c"], body: "x" } }),
        ),
      });
      expect(noSubject.status).toBe(400);
      expect(fixture.rows.actions).toHaveLength(0);
    });
  });

  describe("2. deny", () => {
    test("settles denied with zero executor calls", async () => {
      const fixture = fixtureFor();
      const created = await propose(fixture.app);
      const denied = await decide(fixture.app, created.id, {
        decision: "deny",
      });
      expect(denied.status).toBe(200);
      const body = (await denied.json()) as { status: string };
      expect(body.status).toBe("denied");
      expect(fixture.executor.calls).toHaveLength(0);
      expect(
        fixture.rows.actions.find((row) => row.id === created.id)?.status,
      ).toBe("denied");
    });
  });

  describe("3. approve happy path", () => {
    test("one executor call, attempt row, succeeded plus receipt", async () => {
      const fixture = fixtureFor();
      const created = await propose(fixture.app);
      const approved = await decide(fixture.app, created.id, {
        decision: "approve",
      });
      expect(approved.status).toBe(200);
      const body = (await approved.json()) as {
        status: string;
        providerRef: string | null;
        receipt: {
          attemptId: string;
          fingerprint: string;
          providerRef: string;
          decidedAt: string;
          attemptedAt: string;
          completedAt: string;
        };
      };
      expect(body.status).toBe("succeeded");
      expect(fixture.executor.calls).toHaveLength(1);
      // The proposal the executor saw is the stored one, owner and all.
      expect(fixture.executor.calls[0]).toMatchObject({
        id: created.id,
        accountEmail: "owner@example.com",
        kind: "gmail.send",
      });
      expect(body.receipt.attemptId).toBe(fixture.rows.attempts[0]?.attemptId);
      expect(body.receipt.fingerprint).toBe(FIXED_FINGERPRINT);
      expect(body.receipt.providerRef).toBe("fake-ref-1");
      expect(body.receipt.decidedAt).toBeTruthy();
      expect(body.receipt.attemptedAt).toBeTruthy();
      expect(body.receipt.completedAt).toBeTruthy();
      expect(fixture.rows.attempts[0]).toMatchObject({
        actionId: created.id,
        outcome: "succeeded",
        providerRef: "fake-ref-1",
      });
    });
  });

  describe("4. executor outcomes", () => {
    test("a definite failure settles failed with the error detail", async () => {
      const fixture = fixtureFor();
      fixture.executor.plan("failed");
      const created = await propose(fixture.app);
      const failed = await decide(fixture.app, created.id, {
        decision: "approve",
      });
      expect(failed.status).toBe(200);
      const body = (await failed.json()) as { status: string; error: string };
      expect(body.status).toBe("failed");
      expect(body.error).toBe("the fake executor refused");
      expect(fixture.executor.calls).toHaveLength(1);
    });

    test("outcome_unknown stays settled and is never auto-retried", async () => {
      const fixture = fixtureFor();
      fixture.executor.plan("outcome_unknown");
      const created = await propose(fixture.app);
      const first = await decide(fixture.app, created.id, {
        decision: "approve",
      });
      expect(((await first.json()) as { status: string }).status).toBe(
        "outcome_unknown",
      );
      const again = await decide(fixture.app, created.id, {
        decision: "approve",
      });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { status: string }).status).toBe(
        "outcome_unknown",
      );
      expect(fixture.executor.calls).toHaveLength(1);
    });
  });

  describe("5. two simultaneous approvals", () => {
    test("exactly one executor call; both callers get the same settled record", async () => {
      const fixture = fixtureFor();
      const created = await propose(fixture.app);
      const [one, two] = await Promise.all([
        decide(fixture.app, created.id, { decision: "approve" }),
        decide(fixture.app, created.id, { decision: "approve" }),
      ]);
      expect(one.status).toBe(200);
      expect(two.status).toBe(200);
      expect(await one.json()).toEqual(await two.json());
      expect(fixture.executor.calls).toHaveLength(1);
      expect(fixture.rows.attempts).toHaveLength(1);
    });
  });

  describe("6. repeated decision after settle", () => {
    test("approve-then-deny returns the first settled record without another call", async () => {
      const fixture = fixtureFor();
      const created = await propose(fixture.app);
      const first = await decide(fixture.app, created.id, {
        decision: "approve",
      });
      const firstBody = (await first.json()) as Record<string, unknown>;
      const second = await decide(fixture.app, created.id, {
        decision: "deny",
      });
      expect(await second.json()).toEqual(firstBody);
      expect(fixture.executor.calls).toHaveLength(1);
    });

    test("deny-then-approve stays denied with zero calls", async () => {
      const fixture = fixtureFor();
      const created = await propose(fixture.app);
      await decide(fixture.app, created.id, { decision: "deny" });
      const approve = await decide(fixture.app, created.id, {
        decision: "approve",
      });
      expect(((await approve.json()) as { status: string }).status).toBe(
        "denied",
      );
      expect(fixture.executor.calls).toHaveLength(0);
    });
  });

  describe("7. expiry", () => {
    test("a decision after expiresAt is 409/expired, the row flips, zero calls", async () => {
      const fixture = fixtureFor();
      const created = await propose(fixture.app);
      nowMs = Date.parse(created.expiresAt as string) + 1; // one millisecond past
      const late = await decide(fixture.app, created.id, {
        decision: "approve",
      });
      expect(late.status).toBe(409);
      const body = (await late.json()) as { code: string; status: string };
      expect(body.code).toBe("expired");
      expect(body.status).toBe("expired");
      expect(
        fixture.rows.actions.find((row) => row.id === created.id)?.status,
      ).toBe("expired");
      expect(fixture.executor.calls).toHaveLength(0);
    });
  });

  describe("8. staleness", () => {
    test("a decision carrying another proposal's hash is 409/stale, zero calls", async () => {
      const fixture = fixtureFor();
      const first = await propose(fixture.app, { targetId: "msg-7" });
      const second = await propose(fixture.app, {
        targetId: "msg-7",
        payload: { ...mailPayload, body: "Moved to eleven." },
      });
      expect(second.payloadHash).not.toBe(first.payloadHash);
      const stale = await decide(fixture.app, first.id, {
        decision: "approve",
        payloadHash: second.payloadHash,
      });
      expect(stale.status).toBe(409);
      expect(((await stale.json()) as { code: string }).code).toBe("stale");
      expect(fixture.executor.calls).toHaveLength(0);
      expect(
        fixture.rows.actions.find((row) => row.id === first.id)?.status,
      ).toBe("awaiting_review");
    });

    test("a decision carrying a stale generation is 409/stale, zero calls", async () => {
      const fixture = fixtureFor();
      const created = await propose(fixture.app);
      const stale = await decide(fixture.app, created.id, {
        decision: "approve",
        connectionGeneration: 1,
      });
      expect(stale.status).toBe(409);
      expect(((await stale.json()) as { code: string }).code).toBe("stale");
      expect(fixture.executor.calls).toHaveLength(0);
    });

    test("a decision matching every guard still executes", async () => {
      const fixture = fixtureFor();
      const created = await propose(fixture.app, { targetVersion: "v3" });
      const fine = await decide(fixture.app, created.id, {
        decision: "approve",
        payloadHash: created.payloadHash,
        connectionGeneration: 2,
        targetVersion: "v3",
      });
      expect(((await fine.json()) as { status: string }).status).toBe(
        "succeeded",
      );
      expect(fixture.executor.calls).toHaveLength(1);
    });
  });

  describe("9. cancel", () => {
    test("cancels from awaiting_review only", async () => {
      const fixture = fixtureFor();
      const created = await propose(fixture.app);
      const cancelled = await fixture.app.request(`/${created.id}/cancel`, {
        method: "POST",
      });
      expect(cancelled.status).toBe(200);
      expect(((await cancelled.json()) as { status: string }).status).toBe(
        "cancelled",
      );
      expect(fixture.executor.calls).toHaveLength(0);

      // A settled row is never cancelled by a later cancel.
      const settled = await propose(fixture.app);
      await decide(fixture.app, settled.id, { decision: "deny" });
      const late = await fixture.app.request(`/${settled.id}/cancel`, {
        method: "POST",
      });
      expect(((await late.json()) as { status: string }).status).toBe("denied");
    });
  });

  describe("10. foreign user", () => {
    test("list, get and decision for another owner answer 404", async () => {
      const fixture = fixtureFor();
      const created = await propose(fixture.app);
      currentActor = actorTwo;
      try {
        const list = await fixture.app.request("/");
        expect(
          ((await list.json()) as { actions: unknown[] }).actions,
        ).toHaveLength(0);
        const detail = await fixture.app.request(`/${created.id}`);
        expect(detail.status).toBe(404);
        const decision = await decide(fixture.app, created.id, {
          decision: "approve",
        });
        expect(decision.status).toBe(404);
      } finally {
        currentActor = actorOne;
      }
      expect(fixture.executor.calls).toHaveLength(0);
    });
  });

  describe("11. §9 lifecycle hook", () => {
    test("disableOwner blocks propose and decide; enumerateOwner returns refs", async () => {
      const fixture = fixtureFor();
      const created = await propose(fixture.app);
      await fixture.service.disableOwner("user-1");
      // The disabled check is the store's typed refusal, not a route invention.
      await expect(
        fixture.service.propose("user-1", proposeBody()),
      ).rejects.toBeInstanceOf(OpenMuseOwnerDisabledError);
      const proposeRefused = await fixture.app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proposeBody()),
      });
      expect(proposeRefused.status).toBe(403);
      const decideRefused = await decide(fixture.app, created.id, {
        decision: "approve",
      });
      expect(decideRefused.status).toBe(403);
      expect(fixture.executor.calls).toHaveLength(0);

      await fixture.service.restoreOwner("user-1");
      expect(await fixture.service.enumerateOwner("user-1")).toEqual([
        { kind: "openmuse-reviewed-action", id: created.id },
      ]);
      expect(await fixture.service.enumerateOwner("user-2")).toEqual([]);
    });
  });

  describe("list", () => {
    test("returns the owner's actions newest first", async () => {
      const fixture = fixtureFor();
      const first = await propose(fixture.app);
      nowMs += 5_000;
      const second = await propose(fixture.app);
      const list = await fixture.app.request("/");
      const body = (await list.json()) as { actions: Array<{ id: string }> };
      expect(body.actions.map((action) => action.id)).toEqual([
        second.id,
        first.id,
      ]);
      const detail = await fixture.app.request(`/${first.id}`);
      expect(detail.status).toBe(200);
    });
  });
});

// ── R02: the Gmail send executor ────────────────────────────────────────────

/** The plain-send fixture: exactly recipients/subject/body. */
const gmailSendPayload = {
  to: ["ava@example.com"],
  subject: "Dinner",
  body: "Eight works for me.",
};

/** The connected gmail seat a proposal is bound to (email + generation). */
function gmailConnection(
  overrides: Partial<StoredOpenMuseGoogleConnection> = {},
): StoredOpenMuseGoogleConnection {
  return {
    id: "openmuse-google-1",
    userId: "user-1",
    provider: "gmail",
    accountEmail: "owner@example.com",
    status: "connected",
    grantedScopes: [],
    generation: 2,
    alias: "openmuse-alias-1",
    connectedAt: new Date(nowMs),
    ...overrides,
  };
}

type PlannedDial =
  | { ok: true; body: unknown }
  | { ok: false; status: number; body: unknown }
  | { throws: true }
  | { hangs: true };

/** The wire-dial fake: every call recorded, the answer planned ahead. */
function fakeMailDial() {
  const calls: Array<{
    path: string;
    init: { method: string; headers: Record<string, string>; body?: unknown };
  }> = [];
  let planned: PlannedDial = {
    ok: true,
    body: { data: { id: "provider-message-9" } },
  };
  const dial: MailWireDial = async (path, init) => {
    calls.push({ path, init });
    if (planned.throws) {
      throw new Error("the network went silent mid-request");
    }
    if (planned.hangs) {
      // The R04 fault injection: the request left, no answer ever comes.
      return new Promise(() => {});
    }
    const answer = planned as { ok: boolean; status?: number; body: unknown };
    return {
      ok: answer.ok,
      status: answer.status ?? 200,
      json: async () => answer.body,
    };
  };
  return {
    dial,
    calls,
    plan: (next: PlannedDial) => {
      planned = next;
    },
  };
}

type GmailSendFixture = {
  rows: ReturnType<typeof fakeRows>;
  dial: ReturnType<typeof fakeMailDial>;
  app: Hono<{ Variables: AppVariables }>;
  setConnection: (connection: StoredOpenMuseGoogleConnection | null) => void;
};

/** The R02 fixture: R01's rows and routes with the REAL Gmail executor wired. */
function gmailSendFixtureFor(
  options: { dialAbsent?: boolean; timeoutMs?: number } = {},
): GmailSendFixture {
  const rows = fakeRows();
  const dial = fakeMailDial();
  let connection: StoredOpenMuseGoogleConnection | null = gmailConnection();
  const executor = createGmailSendExecutor({
    ...(options.dialAbsent ? {} : { dial: dial.dial }),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    requireConnection: async (_userId, provider) => {
      if (connection === null) {
        throw new OpenMuseConnectionRefusedError(provider);
      }
      return connection;
    },
  });
  const service = createOpenMuseReviewedActionService({
    rows,
    executor,
    now: () => new Date(nowMs),
  });
  const app = createOpenMuseReviewedActionsRoutes({ service, requireUser });
  return {
    rows,
    dial,
    app,
    setConnection: (next) => {
      connection = next;
    },
  };
}

async function proposeGmailSend(
  app: Hono<{ Variables: AppVariables }>,
  overrides: Record<string, unknown> = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "gmail.send",
      payload: gmailSendPayload,
      accountEmail: "owner@example.com",
      connectionGeneration: 2,
      ...overrides,
    }),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

describe("R02 gmail.send execution", () => {
  describe("1. propose kind gmail.send", () => {
    test("validates the exact fields; identical submissions hash identically", async () => {
      const fixture = gmailSendFixtureFor();
      const first = await proposeGmailSend(fixture.app);
      const second = await proposeGmailSend(fixture.app);
      expect(first.response.status).toBe(201);
      expect(first.body).toMatchObject({
        kind: "gmail.send",
        status: "awaiting_review",
        payload: gmailSendPayload,
        accountEmail: "owner@example.com",
        connectionGeneration: 2,
      });
      expect(first.body.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect(first.body.payloadHash).toBe(second.body.payloadHash);
      // The kind carries to/subject/body plus, since R03, the optional reply
      // binding: a missing subject or an empty recipient list is still a 400.
      for (const payload of [
        { to: ["ava@example.com"], body: "Eight works for me." },
        { to: [], subject: "Dinner", body: "Eight works for me." },
      ]) {
        const refused = await proposeGmailSend(fixture.app, { payload });
        expect(refused.response.status).toBe(400);
      }
      expect(fixture.rows.actions).toHaveLength(2);
      expect(fixture.dial.calls).toHaveLength(0);
    });

    test("a reply-bound payload is accepted and hashes apart from the plain send", async () => {
      const fixture = gmailSendFixtureFor();
      const plain = await proposeGmailSend(fixture.app);
      const reply = await proposeGmailSend(fixture.app, {
        payload: { ...gmailSendPayload, threadId: "thread-A" },
      });
      expect(reply.response.status).toBe(201);
      expect(reply.body.payloadHash).not.toBe(plain.body.payloadHash);
      expect(fixture.dial.calls).toHaveLength(0);
    });

    test("a changed body hashes differently", async () => {
      const fixture = gmailSendFixtureFor();
      const first = await proposeGmailSend(fixture.app);
      const second = await proposeGmailSend(fixture.app, {
        payload: { ...gmailSendPayload, body: "Nine, actually." },
      });
      expect(first.body.payloadHash).not.toBe(second.body.payloadHash);
    });
  });

  describe("2. approve happy path", () => {
    test("one dial with the alias header and exact input; the receipt carries the provider message id", async () => {
      const fixture = gmailSendFixtureFor();
      const created = await proposeGmailSend(fixture.app);
      const approved = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(approved.status).toBe(200);
      const body = (await approved.json()) as {
        status: string;
        providerRef: string | null;
        receipt: {
          attemptId: string;
          fingerprint: string;
          providerRef: string;
        };
      };
      expect(body.status).toBe("succeeded");
      expect(body.providerRef).toBe("provider-message-9");
      expect(body.receipt.providerRef).toBe("provider-message-9");
      expect(body.receipt.attemptId).toBe(fixture.rows.attempts[0]?.attemptId);
      expect(body.receipt.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(fixture.rows.attempts[0]).toMatchObject({
        actionId: created.body.id,
        outcome: "succeeded",
        providerRef: "provider-message-9",
      });
      // The dial: once, the placeholder action id, the alias header, the input.
      expect(fixture.dial.calls).toHaveLength(1);
      expect(fixture.dial.calls[0]).toEqual({
        path: "/v1/actions/gmail.send",
        init: {
          method: "POST",
          headers: { "x-oo-connector-alias": "openmuse-alias-1" },
          body: { input: gmailSendPayload },
        },
      });
    });
  });

  describe("3. deny and expiry with the real executor wired", () => {
    test("deny settles denied with zero dials and zero attempts", async () => {
      const fixture = gmailSendFixtureFor();
      const created = await proposeGmailSend(fixture.app);
      const denied = await decide(fixture.app, created.body.id as string, {
        decision: "deny",
      });
      expect(denied.status).toBe(200);
      expect(((await denied.json()) as { status: string }).status).toBe(
        "denied",
      );
      expect(fixture.dial.calls).toHaveLength(0);
      expect(fixture.rows.attempts).toHaveLength(0);
    });

    test("a decision past expiresAt is 409/expired with zero dials", async () => {
      const fixture = gmailSendFixtureFor();
      const created = await proposeGmailSend(fixture.app);
      nowMs = Date.parse(created.body.expiresAt as string) + 1;
      const late = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(late.status).toBe(409);
      expect(((await late.json()) as { code: string }).code).toBe("expired");
      expect(fixture.dial.calls).toHaveLength(0);
    });
  });

  describe("4. provider answers", () => {
    test("a definite rejection settles failed with the vendor detail", async () => {
      const fixture = gmailSendFixtureFor();
      fixture.dial.plan({
        ok: false,
        status: 422,
        body: { message: "Recipient domain refused the message." },
      });
      const created = await proposeGmailSend(fixture.app);
      const failed = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      const body = (await failed.json()) as { status: string; error: string };
      expect(body.status).toBe("failed");
      expect(body.error).toBe("Recipient domain refused the message.");
      expect(fixture.dial.calls).toHaveLength(1);
    });

    test("a provider timeout settles outcome_unknown and is never retried", async () => {
      const fixture = gmailSendFixtureFor();
      fixture.dial.plan({ throws: true });
      const created = await proposeGmailSend(fixture.app);
      const first = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(((await first.json()) as { status: string }).status).toBe(
        "outcome_unknown",
      );
      const again = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(((await again.json()) as { status: string }).status).toBe(
        "outcome_unknown",
      );
      expect(fixture.dial.calls).toHaveLength(1);
    });

    test("a server-side failure after submission settles outcome_unknown, not failed", async () => {
      const fixture = gmailSendFixtureFor();
      fixture.dial.plan({ ok: false, status: 503, body: {} });
      const created = await proposeGmailSend(fixture.app);
      const unknown = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(((await unknown.json()) as { status: string }).status).toBe(
        "outcome_unknown",
      );
      expect(fixture.dial.calls).toHaveLength(1);
    });
  });

  describe("5. disconnected account", () => {
    test("approve answers 409/connection_required at decision time, zero dials, the row still awaiting_review", async () => {
      const fixture = gmailSendFixtureFor();
      fixture.setConnection(null);
      const created = await proposeGmailSend(fixture.app);
      const refused = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { code: string }).code).toBe(
        "connection_required",
      );
      expect(fixture.dial.calls).toHaveLength(0);
      expect(fixture.rows.attempts).toHaveLength(0);
      expect(
        fixture.rows.actions.find((row) => row.id === created.body.id)?.status,
      ).toBe("awaiting_review");
    });
  });

  describe("6. account mismatch", () => {
    test("a re-bound account email or bumped generation answers 409/stale, zero dials", async () => {
      // R03: the 409 names which binding drifted.
      for (const overrides of [
        {
          connection: { accountEmail: "newowner@example.com" },
          staleReason: "account",
        },
        { connection: { generation: 3 }, staleReason: "generation" },
      ]) {
        const fixture = gmailSendFixtureFor();
        const created = await proposeGmailSend(fixture.app);
        fixture.setConnection(gmailConnection(overrides.connection));
        const stale = await decide(fixture.app, created.body.id as string, {
          decision: "approve",
        });
        expect(stale.status).toBe(409);
        const body = (await stale.json()) as {
          code: string;
          staleReason: string;
        };
        expect(body.code).toBe("stale");
        expect(body.staleReason).toBe(overrides.staleReason);
        expect(fixture.dial.calls).toHaveLength(0);
        expect(
          fixture.rows.actions.find((row) => row.id === created.body.id)
            ?.status,
        ).toBe("awaiting_review");
      }
    });
  });

  describe("7. deployment and kind limits", () => {
    test("a deployment with no vendor dial answers 503 at decision time, the row still awaiting_review", async () => {
      const fixture = gmailSendFixtureFor({ dialAbsent: true });
      const created = await proposeGmailSend(fixture.app);
      const refused = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(refused.status).toBe(503);
      expect(fixture.dial.calls).toHaveLength(0);
      expect(
        fixture.rows.actions.find((row) => row.id === created.body.id)?.status,
      ).toBe("awaiting_review");
    });

    test("the fingerprint is path-stable: the dial path and the early-exit path fingerprint the same proposal identically", async () => {
      const proposal: ReviewedActionProposal = {
        id: "ra-fingerprint-stability",
        ownerUserId: "user-1",
        kind: "gmail.send",
        payload: gmailSendPayload,
        accountEmail: "owner@example.com",
        connectionGeneration: 2,
        targetId: null,
        targetVersion: null,
        attachmentVersionIds: [],
      };
      const requireConnection = async () => gmailConnection();
      // Dial path: the send goes out, the success answer carries the
      // fingerprint computed past the guard.
      const delivered = createGmailSendExecutor({
        dial: fakeMailDial().dial,
        requireConnection,
      });
      const sent = await delivered.execute(proposal);
      expect(sent.outcome).toBe("succeeded");
      // Early-exit path: the SAME proposal against a deployment whose dial
      // is absent fails before dialing — the fingerprint must not move, or
      // audit comparisons keyed on it would mis-match across paths.
      const absent = createGmailSendExecutor({ requireConnection });
      const refused = await absent.execute(proposal);
      expect(refused.outcome).toBe("failed");
      expect(refused.fingerprint).toBe(sent.fingerprint);
    });

    test("round 6 M39: an error raised BEFORE the dial exists is a definite failure, never outcome_unknown", async () => {
      const proposal: ReviewedActionProposal = {
        id: "openmuse-reviewed-action-m39",
        kind: "gmail.send",
        ownerUserId: actorOne.id,
        payload: { to: ["dest@example.test"], subject: "s", body: "b" },
        accountEmail: "one@openbot.test",
        connectionGeneration: 1,
        attachmentVersionIds: [],
      };
      // A transient DB failure inside requireConnection: the request was
      // never built, so the row must record a definite failure — the old
      // catch tail settled this outcome_unknown, blocking the logical
      // send's re-proposal behind an operator for a send that never left.
      const executor = createGmailSendExecutor({
        dial: fakeMailDial().dial,
        requireConnection: async () => {
          throw new Error("connection rows unreachable (transient)");
        },
      });
      const settled = await executor.execute(proposal);
      expect(settled.outcome).toBe("failed");
      expect(settled.error).toContain("never left");
    });

    test("a kind this executor does not send settles failed without a dial", async () => {
      const fixture = gmailSendFixtureFor();
      const created = await proposeGmailSend(fixture.app, {
        kind: "gcalendar.create",
        payload: {
          title: "Board review",
          start: "2026-10-20T09:00:00-07:00",
          end: "2026-10-20T10:00:00-07:00",
          timeZone: "America/Los_Angeles",
          calendarId: "calendar-1",
          attendees: [],
        },
      });
      expect(created.response.status).toBe(201);
      const failed = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      const body = (await failed.json()) as { status: string; error: string };
      expect(body.status).toBe("failed");
      expect(body.error).toContain("gmail.send");
      expect(fixture.dial.calls).toHaveLength(0);
    });
  });
});

// ── R03: the §6 staleness matrix for Gmail sends ────────────────────────────

/** A 64-hex hash that is not any fixture payload's: a decision's stale echo. */
const OTHER_HASH = "ff".repeat(32);

/** The reply-bound gmail.send fixture: the proposal answers in thread A. */
const replyBoundPayload = {
  ...gmailSendPayload,
  threadId: "thread-A",
  replyToMessageId: "msg-A",
};

describe("R03 staleness matrix", () => {
  test("1. a changed payloadHash answers 409/stale payload, zero dials", async () => {
    const fixture = gmailSendFixtureFor();
    const created = await proposeGmailSend(fixture.app);
    const stale = await decide(fixture.app, created.body.id as string, {
      decision: "approve",
      payloadHash: OTHER_HASH,
    });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      code: string;
      staleReason: string;
    };
    expect(body.code).toBe("stale");
    expect(body.staleReason).toBe("payload");
    expect(fixture.dial.calls).toHaveLength(0);
    expect(fixture.rows.attempts).toHaveLength(0);
    expect(
      fixture.rows.actions.find((row) => row.id === created.body.id)?.status,
    ).toBe("awaiting_review");
  });

  test("2. a changed accountEmail answers 409/stale account, zero dials", async () => {
    const fixture = gmailSendFixtureFor();
    const created = await proposeGmailSend(fixture.app);
    const stale = await decide(fixture.app, created.body.id as string, {
      decision: "approve",
      accountEmail: "newowner@example.com",
    });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      code: string;
      staleReason: string;
    };
    expect(body.code).toBe("stale");
    expect(body.staleReason).toBe("account");
    expect(fixture.dial.calls).toHaveLength(0);
    expect(fixture.rows.attempts).toHaveLength(0);
    expect(
      fixture.rows.actions.find((row) => row.id === created.body.id)?.status,
    ).toBe("awaiting_review");
  });

  test("3. a changed connection generation answers 409/stale generation, zero dials", async () => {
    const fixture = gmailSendFixtureFor();
    const created = await proposeGmailSend(fixture.app);
    const stale = await decide(fixture.app, created.body.id as string, {
      decision: "approve",
      connectionGeneration: 3,
    });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      code: string;
      staleReason: string;
    };
    expect(body.code).toBe("stale");
    expect(body.staleReason).toBe("generation");
    expect(fixture.dial.calls).toHaveLength(0);
    expect(fixture.rows.attempts).toHaveLength(0);
    expect(
      fixture.rows.actions.find((row) => row.id === created.body.id)?.status,
    ).toBe("awaiting_review");
  });

  test("4. a changed reply target answers 409/stale target, zero dials", async () => {
    for (const staleGuard of [
      { threadId: "thread-B" },
      { replyToMessageId: "msg-B" },
    ]) {
      const fixture = gmailSendFixtureFor();
      const created = await proposeGmailSend(fixture.app, {
        payload: replyBoundPayload,
      });
      expect(created.response.status).toBe(201);
      const stale = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
        ...staleGuard,
      });
      expect(stale.status).toBe(409);
      const body = (await stale.json()) as {
        code: string;
        staleReason: string;
      };
      expect(body.code).toBe("stale");
      expect(body.staleReason).toBe("target");
      expect(fixture.dial.calls).toHaveLength(0);
      expect(fixture.rows.attempts).toHaveLength(0);
      expect(
        fixture.rows.actions.find((row) => row.id === created.body.id)?.status,
      ).toBe("awaiting_review");
    }
  });

  test("5. staleReason is absent on the expired 409; expired keeps its own reason", async () => {
    const fixture = gmailSendFixtureFor();
    const created = await proposeGmailSend(fixture.app);
    nowMs = Date.parse(created.body.expiresAt as string) + 1;
    const late = await decide(fixture.app, created.body.id as string, {
      decision: "approve",
    });
    expect(late.status).toBe(409);
    const body = (await late.json()) as {
      code: string;
      status: string;
      staleReason?: string;
    };
    expect(body.code).toBe("expired");
    expect(body.status).toBe("expired");
    expect(body.staleReason).toBeUndefined();
    expect(fixture.dial.calls).toHaveLength(0);
  });

  test("6. after each stale refusal, a fresh proposal with current values approves and sends exactly once", async () => {
    const matrix = [
      {
        reason: "payload",
        propose: {},
        refuse: { payloadHash: OTHER_HASH },
        repropose: {
          payload: { ...gmailSendPayload, body: "Nine, actually." },
        },
        decide: (fresh: Record<string, unknown>) => ({
          payloadHash: fresh.payloadHash,
        }),
        connection: null as StoredOpenMuseGoogleConnection | null,
      },
      {
        reason: "account",
        propose: {},
        refuse: { accountEmail: "newowner@example.com" },
        repropose: { accountEmail: "newowner@example.com" },
        decide: () => ({ accountEmail: "newowner@example.com" }),
        connection: gmailConnection({ accountEmail: "newowner@example.com" }),
      },
      {
        reason: "generation",
        propose: {},
        refuse: { connectionGeneration: 3 },
        repropose: { connectionGeneration: 3 },
        decide: () => ({ connectionGeneration: 3 }),
        connection: gmailConnection({ generation: 3 }),
      },
      {
        reason: "target",
        propose: { payload: replyBoundPayload },
        refuse: { threadId: "thread-B" },
        repropose: {
          payload: { ...gmailSendPayload, threadId: "thread-B" },
        },
        decide: () => ({ threadId: "thread-B" }),
        connection: null,
      },
    ];
    for (const row of matrix) {
      const fixture = gmailSendFixtureFor();
      const staleRow = await proposeGmailSend(fixture.app, row.propose);
      const refused = await decide(fixture.app, staleRow.body.id as string, {
        decision: "approve",
        ...row.refuse,
      });
      expect(refused.status).toBe(409);

      // The seat moves when the account or generation actually changed.
      if (row.connection !== null) fixture.setConnection(row.connection);
      const fresh = await proposeGmailSend(fixture.app, row.repropose);
      expect(fresh.response.status).toBe(201);
      const approved = await decide(fixture.app, fresh.body.id as string, {
        decision: "approve",
        ...row.decide(fresh.body),
      });
      expect(approved.status).toBe(200);
      const body = (await approved.json()) as {
        status: string;
        providerRef: string | null;
      };
      expect(body.status).toBe("succeeded");
      expect(body.providerRef).toBe("provider-message-9");
      expect(fixture.dial.calls).toHaveLength(1);
      expect(fixture.rows.attempts).toHaveLength(1);
    }
  });

  test("7. §9 disabled owner still answers 403 with zero dials", async () => {
    const fixture = gmailSendFixtureFor();
    const created = await proposeGmailSend(fixture.app);
    await fixture.rows.disableOwner("user-1");
    const refused = await decide(fixture.app, created.body.id as string, {
      decision: "approve",
    });
    expect(refused.status).toBe(403);
    expect(fixture.dial.calls).toHaveLength(0);
  });
});

// ── R04: reconciling an uncertain Gmail send ────────────────────────────────

/*
 * Task 0 audit (cited): R02's executor already keeps the ambiguous case
 * distinct from definite refusals — OpenMuseConnectionRefusedError (the
 * request never left) and HTTP 4xx (the provider refused the send) settle
 * `failed`; 5xx, an answer without a readable message id, and every error
 * thrown after the request left settle `outcome_unknown`
 * (gmail-send-executor.ts). What R02 did not have is a deadline of its own:
 * a dial that neither answers nor throws would hang the decision forever.
 * R04 adds the executor's send deadline — the timeout AFTER the request was
 * sent — so the hanging case also settles outcome_unknown.
 */

/** The R04 fixture: a hanging dial (request left, no answer) + a 10ms deadline. */
function uncertainSendFixture() {
  const fixture = gmailSendFixtureFor({ timeoutMs: 10 });
  fixture.dial.plan({ hangs: true });
  return fixture;
}

/** Propose + approve into the uncertain state, in the admin seat for reconcile. */
async function approveUncertain(
  fixture: ReturnType<typeof uncertainSendFixture>,
): Promise<{ id: string; attemptId: string }> {
  const created = await proposeGmailSend(fixture.app);
  const approved = await decide(fixture.app, created.body.id as string, {
    decision: "approve",
  });
  expect(((await approved.json()) as { status: string }).status).toBe(
    "outcome_unknown",
  );
  const attempt = fixture.rows.attempts[0];
  expect(attempt).toBeDefined();
  return { id: created.body.id as string, attemptId: attempt!.attemptId };
}

describe("R04 uncertain send reconciliation", () => {
  test("1. a timeout after the request left settles outcome_unknown with fingerprint and timestamps, zero re-offers", async () => {
    const fixture = uncertainSendFixture();
    const created = await proposeGmailSend(fixture.app);
    const first = await decide(fixture.app, created.body.id as string, {
      decision: "approve",
    });
    expect(((await first.json()) as { status: string }).status).toBe(
      "outcome_unknown",
    );
    // The durable attempt reconciliation works from: fingerprint + both stamps.
    const attempt = fixture.rows.attempts[0];
    expect(attempt).toMatchObject({
      actionId: created.body.id,
      outcome: "outcome_unknown",
    });
    expect(attempt?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(attempt?.startedAt).toBeInstanceOf(Date);
    expect(attempt?.completedAt).toBeInstanceOf(Date);
    // §6 zero automatic retry: this module owns no replay queue by design, so
    // the observable is the re-offer count — a second decision re-dials
    // nothing and re-attempts nothing, and re-answers the settled record.
    const again = await decide(fixture.app, created.body.id as string, {
      decision: "approve",
    });
    expect(((await again.json()) as { status: string }).status).toBe(
      "outcome_unknown",
    );
    expect(fixture.dial.calls).toHaveLength(1);
    expect(fixture.rows.attempts).toHaveLength(1);
  });

  test("2. confirmed_succeeded settles succeeded with the reconciliation on the receipt", async () => {
    const fixture = uncertainSendFixture();
    const uncertain = await approveUncertain(fixture);
    currentActor = actorAdmin;
    let reconciled: Response;
    try {
      reconciled = await reconcile(fixture.app, uncertain.id, {
        outcome: "confirmed_succeeded",
        evidence: "provider console shows message id provider-message-9",
      });
    } finally {
      currentActor = actorOne;
    }
    expect(reconciled.status).toBe(200);
    const body = (await reconciled.json()) as {
      status: string;
      receipt: { reconciliation: Record<string, unknown> };
    };
    expect(body.status).toBe("succeeded");
    expect(body.receipt.reconciliation).toEqual({
      outcome: "confirmed_succeeded",
      evidence: "provider console shows message id provider-message-9",
      reviewer: "admin-1",
    });
    expect(
      fixture.rows.actions.find((row) => row.id === uncertain.id)?.status,
    ).toBe("succeeded");
    expect(fixture.rows.attempts[0]?.reconciliation).toEqual({
      outcome: "confirmed_succeeded",
      evidence: "provider console shows message id provider-message-9",
      reviewer: "admin-1",
    });
    // Reconcile closed the action: a later reconcile is the 409 below.
  });

  test("3. confirmed_not_sent settles failed; the same send re-proposes fresh and executes once on a new attempt", async () => {
    const fixture = uncertainSendFixture();
    const uncertain = await approveUncertain(fixture);
    const priorAttemptId = uncertain.attemptId;
    currentActor = actorAdmin;
    let reconciled: Response;
    try {
      reconciled = await reconcile(fixture.app, uncertain.id, {
        outcome: "confirmed_not_sent",
        evidence: "provider sent queue shows no such request",
      });
    } finally {
      currentActor = actorOne;
    }
    expect(reconciled.status).toBe(200);
    expect(((await reconciled.json()) as { status: string }).status).toBe(
      "failed",
    );
    expect(fixture.rows.attempts[0]?.reconciliation).toMatchObject({
      outcome: "confirmed_not_sent",
      reviewer: "admin-1",
    });

    // The ONLY door to a fresh proposal of the same logical send.
    fixture.dial.plan({
      ok: true,
      body: { data: { id: "provider-message-10" } },
    });
    const fresh = await proposeGmailSend(fixture.app);
    expect(fresh.response.status).toBe(201);
    const approved = await decide(fixture.app, fresh.body.id as string, {
      decision: "approve",
    });
    const body = (await approved.json()) as {
      status: string;
      providerRef: string | null;
      receipt: { attemptId: string };
    };
    expect(body.status).toBe("succeeded");
    expect(body.providerRef).toBe("provider-message-10");
    // A fresh attempt — the claimed one is never reused.
    expect(fixture.rows.attempts).toHaveLength(2);
    expect(body.receipt.attemptId).not.toBe(priorAttemptId);
    expect(fixture.rows.attempts[1]?.attemptId).not.toBe(priorAttemptId);
    expect(fixture.dial.calls).toHaveLength(2);
  });

  test("4. unresolved keeps outcome_unknown and its warning, appending evidence", async () => {
    const fixture = uncertainSendFixture();
    const uncertain = await approveUncertain(fixture);
    const warning = fixture.rows.actions.find(
      (row) => row.id === uncertain.id,
    )?.error;
    expect(warning).toContain("unknown");
    currentActor = actorAdmin;
    try {
      const first = await reconcile(fixture.app, uncertain.id, {
        outcome: "unresolved",
        evidence: "provider console unreachable",
      });
      expect(first.status).toBe(200);
      expect(((await first.json()) as { status: string }).status).toBe(
        "outcome_unknown",
      );
      // Still uncertain, so reconcile stays open and evidence appends.
      const second = await reconcile(fixture.app, uncertain.id, {
        outcome: "unresolved",
        evidence: "support ticket 4431 opened",
      });
      expect(second.status).toBe(200);
      expect(((await second.json()) as { status: string }).status).toBe(
        "outcome_unknown",
      );
    } finally {
      currentActor = actorOne;
    }
    const action = fixture.rows.actions.find((row) => row.id === uncertain.id);
    expect(action?.status).toBe("outcome_unknown");
    expect(action?.error).toBe(warning); // the warning is never cleared
    const evidence = fixture.rows.attempts[0]?.reconciliation?.evidence ?? "";
    expect(evidence).toContain("provider console unreachable");
    expect(evidence).toContain("support ticket 4431 opened");
    // Newest first: the operator's latest evidence leads the record, so a
    // saturated prior head can never slice it away.
    expect(evidence.startsWith("support ticket 4431 opened")).toBe(true);
    expect(fixture.rows.attempts[0]?.reconciliation?.outcome).toBe(
      "unresolved",
    );
  });

  test("5. a non-admin reconcile is 403 and records nothing; a non-uncertain action is 409", async () => {
    const fixture = uncertainSendFixture();
    const uncertain = await approveUncertain(fixture);
    // The owner's own seat is a user role: reconciliation is operator-only.
    const refused = await reconcile(fixture.app, uncertain.id, {
      outcome: "confirmed_succeeded",
      evidence: "owner insists it sent",
    });
    expect(refused.status).toBe(403);
    expect(fixture.rows.attempts[0]?.reconciliation).toBeNull();

    // A second user is still not the operator.
    currentActor = actorTwo;
    try {
      const alsoRefused = await reconcile(fixture.app, uncertain.id, {
        outcome: "unresolved",
        evidence: "x",
      });
      expect(alsoRefused.status).toBe(403);
    } finally {
      currentActor = actorOne;
    }
    expect(fixture.rows.attempts[0]?.reconciliation).toBeNull();

    // Reconciliation is for outcome_unknown only: a denied action is 409.
    // (A different body, so the re-proposal gate below does not answer first.)
    const deniedAction = await proposeGmailSend(fixture.app, {
      payload: { ...gmailSendPayload, body: "A different message." },
    });
    await decide(fixture.app, deniedAction.body.id as string, {
      decision: "deny",
    });
    currentActor = actorAdmin;
    let notUncertain: Response;
    try {
      notUncertain = await reconcile(
        fixture.app,
        deniedAction.body.id as string,
        {
          outcome: "confirmed_not_sent",
          evidence: "it was denied",
        },
      );
    } finally {
      currentActor = actorOne;
    }
    expect(notUncertain.status).toBe(409);
    // And an unknown id answers 404, not 403/409.
    currentActor = actorAdmin;
    let missing: Response;
    try {
      missing = await reconcile(fixture.app, "openmuse-reviewed-action-none", {
        outcome: "unresolved",
        evidence: "x",
      });
    } finally {
      currentActor = actorOne;
    }
    expect(missing.status).toBe(404);
  });

  test("6. the re-proposal gate: blocked while uncertain, unresolved or already sent; only confirmed_not_sent passes", async () => {
    const fixture = uncertainSendFixture();
    const uncertain = await approveUncertain(fixture);

    // While the send is merely uncertain, the same logical send cannot be
    // re-proposed — that would be the automatic retry §6 forbids.
    const blocked = await proposeGmailSend(fixture.app);
    expect(blocked.response.status).toBe(409);
    expect(blocked.body).toMatchObject({
      code: "reproposal_blocked",
      reason: "uncertain",
    });

    // An unresolved reconciliation keeps the warning, so still blocked.
    currentActor = actorAdmin;
    try {
      const unresolved = await reconcile(fixture.app, uncertain.id, {
        outcome: "unresolved",
        evidence: "still checking",
      });
      expect(unresolved.status).toBe(200);
    } finally {
      currentActor = actorOne;
    }
    const stillBlocked = await proposeGmailSend(fixture.app);
    expect(stillBlocked.response.status).toBe(409);

    // A DIFFERENT logical send is never blocked — the gate is per send.
    const other = await proposeGmailSend(fixture.app, {
      payload: { ...gmailSendPayload, body: "Nine, actually." },
    });
    expect(other.response.status).toBe(201);

    // An already-sent message is blocked as a duplicate, with its own reason.
    const sent = gmailSendFixtureFor();
    const created = await proposeGmailSend(sent.app);
    await decide(sent.app, created.body.id as string, { decision: "approve" });
    const duplicate = await proposeGmailSend(sent.app);
    expect(duplicate.response.status).toBe(409);
    expect(duplicate.body).toMatchObject({
      code: "reproposal_blocked",
      reason: "already_sent",
    });

    // Only confirmed_not_sent re-opens the same logical send.
    currentActor = actorAdmin;
    try {
      const closed = await reconcile(fixture.app, uncertain.id, {
        outcome: "confirmed_not_sent",
        evidence: "provider confirms no message",
      });
      expect(closed.status).toBe(200);
    } finally {
      currentActor = actorOne;
    }
    const fresh = await proposeGmailSend(fixture.app);
    expect(fresh.response.status).toBe(201);
  });

  test("7. token-shaped evidence is stripped before it is recorded (G06's pattern)", async () => {
    const fixture = uncertainSendFixture();
    const uncertain = await approveUncertain(fixture);
    const poisoned =
      "Checked ya29.a0ARrdaM-9x8LongTokenValue1234567890 in the audit log; " +
      'the refresh grant 1//0abcdefghijklmno was also visible, plus "Bearer ' +
      'AbCdEf012345678901234567890123456789012345678901234567890123" in a header; ' +
      "message id provider-message-9 confirmed.";
    currentActor = actorAdmin;
    let reconciled: Response;
    try {
      reconciled = await reconcile(fixture.app, uncertain.id, {
        outcome: "confirmed_succeeded",
        evidence: poisoned,
      });
    } finally {
      currentActor = actorOne;
    }
    expect(reconciled.status).toBe(200);
    const recorded =
      fixture.rows.attempts[0]?.reconciliation?.evidence ?? "<missing>";
    expect(recorded).not.toContain("ya29.a0ARrdaM");
    expect(recorded).not.toContain("1//0abcdefghijklmno");
    expect(recorded).not.toContain("Bearer AbCdEf");
    expect(recorded).not.toContain("0123456789012345678901234567890123456789");
    expect(recorded).toContain("[REDACTED]");
    // The human-readable finding survives the strip.
    expect(recorded).toContain("in the audit log");
    expect(recorded).toContain("message id provider-message-9 confirmed");
  });
});

// ── R04 gate and crash-recovery hardening ────────────────────────────────────

/** One stored row for direct seeding: every field explicit, like the rows are. */
function seededAction(overrides: Partial<StoredReviewedAction> = {}) {
  return {
    id: `openmuse-reviewed-action-seeded-${crypto.randomUUID()}`,
    ownerUserId: "user-1",
    kind: "gmail.send" as const,
    canonicalPayload: mailPayload,
    payloadHash: MAIL_PAYLOAD_HASH,
    accountEmail: "owner@example.com",
    connectionGeneration: 2,
    targetId: null,
    targetVersion: null,
    attachmentVersionIds: [],
    status: "awaiting_review" as const,
    expiresAt: new Date(nowMs + REVIEWED_ACTION_TTL_MS),
    createdAt: new Date(nowMs),
    decidedAt: null,
    completedAt: null,
    providerRef: null,
    error: null,
    ...overrides,
  };
}

describe("R04 re-proposal gate hardening", () => {
  test("the gate is directed: a hundred newer proposals cannot push the uncertain prior out", async () => {
    const fixture = fixtureFor();
    // The first send goes out and settles outcome_unknown.
    fixture.executor.plan("outcome_unknown");
    const uncertain = await propose(fixture.app);
    const decided = await decide(fixture.app, uncertain.id as string, {
      decision: "approve",
    });
    expect(decided.status).toBe(200);

    // The owner keeps proposing other sends — more than the newest-100 the
    // gate once scanned. Each lands a second later so the order is total.
    for (let index = 0; index < 101; index += 1) {
      nowMs += 1000;
      const noise = await propose(fixture.app, {
        payload: { ...mailPayload, body: `noise ${index}` },
      });
      expect(noise.id).toBeTruthy();
    }

    // The same logical send is STILL blocked: §6's "never automatically
    // retried" cannot depend on the owner's history staying short.
    const again = await fixture.app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposeBody()),
    });
    expect(again.status).toBe(409);
    const body = (await again.json()) as { code: string; reason: string };
    expect(body.code).toBe("reproposal_blocked");
    expect(body.reason).toBe("uncertain");
  });

  test("the gate keys on the target: a second delete of a DIFFERENT event on the same calendar is not already_sent", async () => {
    const fixture = fixtureFor();
    // A first delete of event-1 on calendar-1 succeeded — its payload is
    // only { calendarId }, so every delete on that calendar hashes alike.
    fixture.rows.actions.push(
      seededAction({
        kind: "gcalendar.delete",
        canonicalPayload: { calendarId: "calendar-1" },
        payloadHash: payloadHashOf({ calendarId: "calendar-1" }),
        targetId: "event-1",
        targetVersion: "etag-1",
        status: "succeeded",
      }),
    );

    // The same payload against a DIFFERENT target is a different logical
    // send: it must propose, not 409 as "already sent" forever.
    const second = await propose(fixture.app, {
      kind: "gcalendar.delete",
      payload: { calendarId: "calendar-1" },
      targetId: "event-2",
      targetVersion: "etag-2",
    });
    expect(second.status).toBe("awaiting_review");

    // The SAME target stays blocked: that exact delete did go out.
    const replay = await fixture.app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        proposeBody({
          kind: "gcalendar.delete",
          payload: { calendarId: "calendar-1" },
          targetId: "event-1",
          targetVersion: "etag-1",
        }),
      ),
    });
    expect(replay.status).toBe(409);
    const body = (await replay.json()) as { code: string; reason: string };
    expect(body.code).toBe("reproposal_blocked");
    expect(body.reason).toBe("already_sent");
  });

  test("a propose that loses the row-level unique index answers 409, not a 500", async () => {
    const fixture = fixtureFor();
    /*
     * The gate is a read, the insert is the write, and no lock spans both: a
     * racing propose with the SAME (owner, kind, hash, target) key passes the
     * read before the winner's insert lands, so the loser's only protection
     * is the partial unique index — whose rejection must surface as the gate's
     * own 409 rather than an unhandled database error.
     */
    const uniqueLoss = () => {
      const cause = new Error(
        'duplicate key value violates unique constraint "openmuse_reviewed_actions_active_send_uq"',
      );
      Object.assign(cause, {
        code: "23505",
        constraint: "openmuse_reviewed_actions_active_send_uq",
      });
      const wrapped = new Error(
        "Failed query: insert into openmuse_reviewed_actions",
      );
      wrapped.cause = cause;
      return wrapped;
    };
    fixture.rows.insertAction = async () => {
      // The racing twin this fake stands in for already wrote the winner's
      // row, so every insert on the contended key reads as the index's refusal.
      throw uniqueLoss();
    };
    const response = await fixture.app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposeBody()),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; reason: string };
    expect(body.code).toBe("reproposal_blocked");
    expect(body.reason).toBe("uncertain");

    // Not the index's refusal → the error stays the caller's to see, unhidden.
    fixture.rows.insertAction = async () => {
      const foreign = new Error("another constraint entirely");
      Object.assign(foreign, { code: "23503" });
      throw foreign;
    };
    const unrelated = await fixture.app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposeBody()),
    });
    expect(unrelated.status).toBe(503);
  });

  test("round 6 M37: losing the index to an awaiting twin answers already_proposed, not uncertain-and-operator", async () => {
    const fixture = fixtureFor();
    // The twin this propose loses to is still AWAITING review: nothing was
    // ever attempted, no operator exists to reconcile it — the honest 409
    // says decide the pending proposal, not call an operator.
    fixture.rows.actions.push(seededAction({ status: "awaiting_review" }));
    const uniqueLoss = () => {
      const cause = new Error(
        'duplicate key value violates unique constraint "openmuse_reviewed_actions_active_send_uq"',
      );
      Object.assign(cause, {
        code: "23505",
        constraint: "openmuse_reviewed_actions_active_send_uq",
      });
      const wrapped = new Error(
        "Failed query: insert into openmuse_reviewed_actions",
      );
      wrapped.cause = cause;
      return wrapped;
    };
    const realInsert = fixture.rows.insertAction;
    fixture.rows.insertAction = async (action) => {
      // The gate read passed (the twin is awaiting, invisible to it); the
      // index is what refuses.
      try {
        await realInsert(action);
      } catch {
        throw uniqueLoss();
      }
      throw uniqueLoss();
    };
    const response = await fixture.app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposeBody()),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; reason: string };
    expect(body.code).toBe("reproposal_blocked");
    expect(body.reason).toBe("already_proposed");
    expect(body.error).toContain("awaiting review");
  });

  test("an executing prior blocks the same send as uncertain — a stuck row is not a fresh start", async () => {
    const fixture = fixtureFor();
    fixture.rows.actions.push(
      seededAction({ status: "executing", decidedAt: new Date(nowMs - 1000) }),
    );

    const again = await fixture.app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposeBody()),
    });
    expect(again.status).toBe(409);
    const body = (await again.json()) as { code: string; reason: string };
    expect(body.reason).toBe("uncertain");
  });
});

describe("crash recovery (abandoned executing rows)", () => {
  test("recoverAbandonedExecutions flips stale executing to outcome_unknown — reconcile closes it; a fresh execution is untouched", async () => {
    const fixture = fixtureFor();
    const stale = seededAction({
      status: "executing",
      decidedAt: new Date(nowMs - 10 * 60 * 1000),
    });
    const fresh = seededAction({
      status: "executing",
      decidedAt: new Date(nowMs - 30 * 1000),
    });
    fixture.rows.actions.push(stale, fresh);
    fixture.rows.attempts.push({
      attemptId: "attempt-stale",
      actionId: stale.id,
      fingerprint: null,
      outcome: null,
      providerRef: null,
      startedAt: new Date(nowMs - 10 * 60 * 1000),
      completedAt: null,
      reconciliation: null,
    });

    const recovered = await fixture.service.recoverAbandonedExecutions();

    expect(recovered).toEqual([stale.id]);
    expect(
      fixture.rows.actions.find((row) => row.id === stale.id)?.status,
    ).toBe("outcome_unknown");
    expect(
      fixture.rows.actions.find((row) => row.id === fresh.id)?.status,
    ).toBe("executing");

    // The recovered row is reconcile's to close (the operator's verdict).
    currentActor = actorAdmin;
    const reconciled = await reconcile(fixture.app, stale.id, {
      outcome: "confirmed_not_sent",
      evidence: "the operator read the vendor log",
    });
    currentActor = actorOne;
    expect(reconciled.status).toBe(200);
    const body = (await reconciled.json()) as { status: string };
    expect(body.status).toBe("failed");
  });

  test("round 6 H8: an outcome_unknown row with NO attempt (crash between claim and insert) reconciles via a backfilled tombstone", async () => {
    const fixture = fixtureFor();
    // The crash window's aftermath, hand-seeded: recovery flipped the row
    // but no attempt exists. The old ConflictError wedged this row forever.
    fixture.rows.actions.push(
      seededAction({
        status: "outcome_unknown",
        decidedAt: new Date(nowMs - 60_000),
      }),
    );
    const wedged = fixture.rows.actions[0]!;
    currentActor = actorAdmin;
    const answer = await reconcile(fixture.app, wedged.id, {
      outcome: "confirmed_not_sent",
      evidence: "the operator read the vendor log",
    });
    currentActor = actorOne;
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { status: string };
    expect(body.status).toBe("failed");
    // The tombstone attempt exists and carries the reconciliation.
    const attempt = fixture.rows.attempts.find(
      (row) => row.actionId === wedged.id,
    );
    expect(attempt?.reconciliation?.outcome).toBe("confirmed_not_sent");
  });

  test("round 6 M36: reconcile's settle writes completedAt and the confirmed providerRef on the action row", async () => {
    const fixture = fixtureFor();
    fixture.rows.actions.push(
      seededAction({
        status: "outcome_unknown",
        decidedAt: new Date(nowMs - 60_000),
      }),
    );
    const action = fixture.rows.actions[0]!;
    fixture.rows.attempts.push({
      attemptId: "attempt-1",
      actionId: action.id,
      fingerprint: FIXED_FINGERPRINT,
      outcome: "outcome_unknown",
      providerRef: null,
      startedAt: new Date(nowMs - 50_000),
      completedAt: null,
      reconciliation: null,
    });
    currentActor = actorAdmin;
    const answer = await reconcile(fixture.app, action.id, {
      outcome: "confirmed_succeeded",
      evidence: "the operator read the vendor log",
      providerEventId: "provider-event-9",
    });
    currentActor = actorOne;
    expect(answer.status).toBe(200);
    const row = fixture.rows.actions.find(
      (candidate) => candidate.id === action.id,
    );
    expect(row?.providerRef).toBe("provider-event-9");
    expect(row?.completedAt).not.toBeNull();
  });

  test("an expiry that crosses the TTL during a slow preflight refuses expired and never claims", async () => {
    const rows = fakeRows();
    // A preflight that spends real time — the calendar executors' etag
    // pre-check read can wait up to its own 30-second deadline; this one
    // simply outlives the proposal's whole TTL.
    let executions = 0;
    const slowPreflightExecutor = {
      execute: async () => {
        executions += 1;
        return {
          outcome: "succeeded" as const,
          fingerprint: FIXED_FINGERPRINT,
        };
      },
      preflight: async () => {
        nowMs += REVIEWED_ACTION_TTL_MS + 1;
      },
    };
    const service = createOpenMuseReviewedActionService({
      rows,
      executor: slowPreflightExecutor,
      now: () => new Date(nowMs),
    });
    const app = createOpenMuseReviewedActionsRoutes({ service, requireUser });
    const created = await propose(app);

    const answer = await decide(app, created.id as string, {
      decision: "approve",
    });

    expect(answer.status).toBe(409);
    const body = (await answer.json()) as { code: string };
    expect(body.code).toBe("expired");
    expect(rows.actions[0]?.status).toBe("expired");
    expect(executions).toBe(0);
  });
});

describe("kind dispatch assembly", () => {
  test("the propose route refuses the legacy mail/calendar kinds with 400 — no executor could ever run them", async () => {
    const fixture = fixtureFor();
    for (const kind of ["mail", "calendar"]) {
      const refused = await fixture.app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proposeBody({ kind })),
      });
      expect(refused.status).toBe(400);
    }
    expect(fixture.rows.actions).toHaveLength(0);
  });

  test("routes each kind to the executor that owns it; unmatched kinds settle failed without a dial", async () => {
    const calls: string[] = [];
    const mailExecutor = {
      execute: async (proposal: { kind: string }) => {
        calls.push(`execute:${proposal.kind}`);
        return {
          outcome: "succeeded" as const,
          fingerprint: FIXED_FINGERPRINT,
        };
      },
    };
    const gmailExecutor = {
      execute: async (proposal: { kind: string }) => {
        calls.push(`execute:${proposal.kind}`);
        return {
          outcome: "succeeded" as const,
          fingerprint: FIXED_FINGERPRINT,
        };
      },
      preflight: async () => {
        calls.push("preflight:gmail.send");
      },
    };
    const dispatch = createKindDispatchingExecutor({
      mail: mailExecutor,
      "gmail.send": gmailExecutor,
    });

    const proposal = (kind: string) =>
      ({
        id: "dispatch-probe",
        ownerUserId: "user-1",
        kind,
        payload: mailPayload,
        accountEmail: "owner@example.com",
        connectionGeneration: 1,
        targetId: null,
        targetVersion: null,
        attachmentVersionIds: [],
      }) as never;

    await dispatch.preflight(proposal("gmail.send"));
    expect(await dispatch.execute(proposal("mail"))).toMatchObject({
      outcome: "succeeded",
    });
    expect(await dispatch.execute(proposal("gmail.send"))).toMatchObject({
      outcome: "succeeded",
    });
    expect(calls).toEqual([
      "preflight:gmail.send",
      "execute:mail",
      "execute:gmail.send",
    ]);

    // A kind no executor owns (the legacy calendar kind, say) answers the
    // single-executor refusal: definite failed, zero dials.
    const refused = await dispatch.execute(proposal("calendar"));
    expect(refused.outcome).toBe("failed");
    expect(refused.error).toContain("not executable here");
    expect(refused.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // And its preflight is a no-op, not a throw.
    await expect(
      dispatch.preflight(proposal("calendar")),
    ).resolves.toBeUndefined();
  });
});

// ── R05: the Calendar create executor ────────────────────────────────────────

/*
 * The §6 canonical payload for kind `gcalendar.create`: title, start, end,
 * allDay?, timeZone, calendarId, attendees[] — the exact calendar, timezone
 * and attendees the proposal shows are the ones the create dials, and the
 * SAME object is what gets hashed, so a moved start is a different proposal.
 */
const gcalCreatePayload = {
  title: "Board review",
  start: "2026-10-20T09:00:00-07:00",
  end: "2026-10-20T10:00:00-07:00",
  timeZone: "America/Los_Angeles",
  calendarId: "primary",
  attendees: ["ava@example.com", "ben@example.com"],
};

/** The connected googlecalendar seat a create proposal is bound to. */
function gcalConnection(
  overrides: Partial<StoredOpenMuseGoogleConnection> = {},
): StoredOpenMuseGoogleConnection {
  return {
    id: "openmuse-google-2",
    userId: "user-1",
    provider: "googlecalendar",
    accountEmail: "owner@example.com",
    status: "connected",
    grantedScopes: [],
    generation: 2,
    alias: "openmuse-gcal-alias-1",
    connectedAt: new Date(nowMs),
    ...overrides,
  };
}

type CalendarCreateFixture = {
  rows: ReturnType<typeof fakeRows>;
  dial: ReturnType<typeof fakeMailDial>;
  app: Hono<{ Variables: AppVariables }>;
  setConnections: (next: StoredOpenMuseGoogleConnection[]) => void;
};

/*
 * The R05 fixture: R01's rows and routes with the REAL Calendar create
 * executor wired over A01's client (the same CalendarWireDial transport the
 * reads use — MailWireDial's structural twin). requireConnection holds one
 * SEAT PER PROVIDER, so a fixture carrying only the gmail seat proves a
 * Gmail grant never satisfies the calendar guard (G03).
 */
function calendarCreateFixtureFor(
  options: { clientAbsent?: boolean; timeoutMs?: number } = {},
): CalendarCreateFixture {
  const rows = fakeRows();
  const dial = fakeMailDial();
  let connections: StoredOpenMuseGoogleConnection[] = [gcalConnection()];
  const executor = createCalendarCreateExecutor({
    ...(options.clientAbsent
      ? {}
      : { client: buildOpenMuseCalendarClient({ dial: dial.dial }) }),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    requireConnection: async (_userId, provider) => {
      const seat = connections.find((row) => row.provider === provider);
      if (!seat) throw new OpenMuseConnectionRefusedError(provider);
      return seat;
    },
  });
  const service = createOpenMuseReviewedActionService({
    rows,
    executor,
    now: () => new Date(nowMs),
  });
  const app = createOpenMuseReviewedActionsRoutes({ service, requireUser });
  return {
    rows,
    dial,
    app,
    setConnections: (next) => {
      connections = next;
    },
  };
}

async function proposeGcalCreate(
  app: Hono<{ Variables: AppVariables }>,
  overrides: Record<string, unknown> = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "gcalendar.create",
      payload: gcalCreatePayload,
      accountEmail: "owner@example.com",
      connectionGeneration: 2,
      ...overrides,
    }),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

describe("R05 gcalendar.create execution", () => {
  describe("1. propose kind gcalendar.create", () => {
    test("validates the exact fields; identical submissions hash identically", async () => {
      const fixture = calendarCreateFixtureFor();
      const first = await proposeGcalCreate(fixture.app);
      const second = await proposeGcalCreate(fixture.app);
      expect(first.response.status).toBe(201);
      expect(first.body).toMatchObject({
        kind: "gcalendar.create",
        status: "awaiting_review",
        payload: gcalCreatePayload,
        accountEmail: "owner@example.com",
        connectionGeneration: 2,
      });
      expect(first.body.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect(first.body.payloadHash).toBe(second.body.payloadHash);
      // The kind carries exactly title/start/end/allDay?/timeZone/
      // calendarId/attendees: an all-day event passes, and each missing or
      // extra field is a 400.
      const allDay = await proposeGcalCreate(fixture.app, {
        payload: {
          ...gcalCreatePayload,
          allDay: true,
          start: "2026-10-20",
          end: "2026-10-21",
        },
      });
      expect(allDay.response.status).toBe(201);
      expect(allDay.body.payloadHash).not.toBe(first.body.payloadHash);
      const emptyAttendees = await proposeGcalCreate(fixture.app, {
        payload: { ...gcalCreatePayload, attendees: [] },
      });
      expect(emptyAttendees.response.status).toBe(201);
      for (const payload of [
        { ...gcalCreatePayload, title: "" },
        { ...gcalCreatePayload, start: "" },
        { ...gcalCreatePayload, timeZone: "" },
        { ...gcalCreatePayload, calendarId: "" },
        { attendees: ["ava@example.com"] },
        { ...gcalCreatePayload, extra: "field" },
      ]) {
        const refused = await proposeGcalCreate(fixture.app, { payload });
        expect(refused.response.status).toBe(400);
      }
      expect(fixture.rows.actions).toHaveLength(4);
      expect(fixture.dial.calls).toHaveLength(0);
    });

    test("a moved start or changed attendees hashes apart", async () => {
      const fixture = calendarCreateFixtureFor();
      const base = await proposeGcalCreate(fixture.app);
      const movedStart = await proposeGcalCreate(fixture.app, {
        payload: {
          ...gcalCreatePayload,
          start: "2026-10-20T10:00:00-07:00",
        },
      });
      const fewerAttendees = await proposeGcalCreate(fixture.app, {
        payload: { ...gcalCreatePayload, attendees: ["ava@example.com"] },
      });
      const hash = (body: Record<string, unknown>) =>
        body.payloadHash as string;
      expect(
        new Set([
          hash(base.body),
          hash(movedStart.body),
          hash(fewerAttendees.body),
        ]).size,
      ).toBe(3);
    });
  });

  describe("2. approve happy path", () => {
    test("one dial through the calendar client with the alias header and exact input; the receipt carries the provider event id", async () => {
      const fixture = calendarCreateFixtureFor();
      fixture.dial.plan({
        ok: true,
        body: { data: { id: "provider-event-9" } },
      });
      const created = await proposeGcalCreate(fixture.app);
      const approved = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(approved.status).toBe(200);
      const body = (await approved.json()) as {
        status: string;
        providerRef: string | null;
        receipt: {
          attemptId: string;
          fingerprint: string;
          providerRef: string;
        };
      };
      expect(body.status).toBe("succeeded");
      expect(body.providerRef).toBe("provider-event-9");
      expect(body.receipt.providerRef).toBe("provider-event-9");
      expect(body.receipt.attemptId).toBe(fixture.rows.attempts[0]?.attemptId);
      expect(body.receipt.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(fixture.rows.attempts[0]).toMatchObject({
        actionId: created.body.id,
        outcome: "succeeded",
        providerRef: "provider-event-9",
      });
      // The dial: once, the placeholder action id, the googlecalendar alias.
      expect(fixture.dial.calls).toHaveLength(1);
      expect(fixture.dial.calls[0]).toEqual({
        path: "/v1/actions/gcalendar.create",
        init: {
          method: "POST",
          headers: { "x-oo-connector-alias": "openmuse-gcal-alias-1" },
          body: { input: gcalCreatePayload },
        },
      });
    });
  });

  describe("3. deny and expiry", () => {
    test("deny settles denied with zero dials and zero attempts", async () => {
      const fixture = calendarCreateFixtureFor();
      const created = await proposeGcalCreate(fixture.app);
      const denied = await decide(fixture.app, created.body.id as string, {
        decision: "deny",
      });
      expect(denied.status).toBe(200);
      expect(((await denied.json()) as { status: string }).status).toBe(
        "denied",
      );
      expect(fixture.dial.calls).toHaveLength(0);
      expect(fixture.rows.attempts).toHaveLength(0);
    });

    test("a decision past expiresAt is 409/expired with zero dials", async () => {
      const fixture = calendarCreateFixtureFor();
      const created = await proposeGcalCreate(fixture.app);
      nowMs = Date.parse(created.body.expiresAt as string) + 1;
      const late = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(late.status).toBe(409);
      expect(((await late.json()) as { code: string }).code).toBe("expired");
      expect(fixture.dial.calls).toHaveLength(0);
    });
  });

  describe("4. staleness with calendar payloads", () => {
    test("a moved start (changed payload) answers 409/stale payload, zero dials", async () => {
      const fixture = calendarCreateFixtureFor();
      const created = await proposeGcalCreate(fixture.app);
      const moved = await proposeGcalCreate(fixture.app, {
        payload: {
          ...gcalCreatePayload,
          start: "2026-10-20T10:00:00-07:00",
        },
      });
      const stale = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
        payloadHash: moved.body.payloadHash,
      });
      expect(stale.status).toBe(409);
      expect(
        ((await stale.json()) as { staleReason: string }).staleReason,
      ).toBe("payload");
      expect(fixture.dial.calls).toHaveLength(0);
      expect(
        fixture.rows.actions.find((row) => row.id === created.body.id)?.status,
      ).toBe("awaiting_review");
    });

    test("a re-bound account email or bumped generation answers 409/stale, zero dials", async () => {
      for (const overrides of [
        {
          connection: { accountEmail: "newowner@example.com" },
          staleReason: "account",
        },
        { connection: { generation: 3 }, staleReason: "generation" },
      ]) {
        const fixture = calendarCreateFixtureFor();
        const created = await proposeGcalCreate(fixture.app);
        fixture.setConnections([gcalConnection(overrides.connection)]);
        const stale = await decide(fixture.app, created.body.id as string, {
          decision: "approve",
        });
        expect(stale.status).toBe(409);
        const body = (await stale.json()) as {
          code: string;
          staleReason: string;
        };
        expect(body.code).toBe("stale");
        expect(body.staleReason).toBe(overrides.staleReason);
        expect(fixture.dial.calls).toHaveLength(0);
        expect(
          fixture.rows.actions.find((row) => row.id === created.body.id)
            ?.status,
        ).toBe("awaiting_review");
      }
    });
  });

  describe("5. disconnected googlecalendar seat", () => {
    test("a Gmail grant does not satisfy the calendar guard: 409/connection_required, zero dials, still awaiting_review", async () => {
      const fixture = calendarCreateFixtureFor();
      fixture.setConnections([gmailConnection()]);
      const created = await proposeGcalCreate(fixture.app);
      const refused = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { code: string }).code).toBe(
        "connection_required",
      );
      expect(fixture.dial.calls).toHaveLength(0);
      expect(fixture.rows.attempts).toHaveLength(0);
      expect(
        fixture.rows.actions.find((row) => row.id === created.body.id)?.status,
      ).toBe("awaiting_review");
    });
  });

  describe("6. provider answers and the uncertain tail", () => {
    test("a definite rejection settles failed with the vendor detail", async () => {
      const fixture = calendarCreateFixtureFor();
      fixture.dial.plan({
        ok: false,
        status: 422,
        body: { message: "The calendar is read-only." },
      });
      const created = await proposeGcalCreate(fixture.app);
      const failed = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      const body = (await failed.json()) as { status: string; error: string };
      expect(body.status).toBe("failed");
      expect(body.error).toBe("The calendar is read-only.");
      expect(fixture.dial.calls).toHaveLength(1);
    });

    test("a server-side failure after submission settles outcome_unknown, not failed", async () => {
      const fixture = calendarCreateFixtureFor();
      fixture.dial.plan({ ok: false, status: 503, body: {} });
      const created = await proposeGcalCreate(fixture.app);
      const unknown = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(((await unknown.json()) as { status: string }).status).toBe(
        "outcome_unknown",
      );
      expect(fixture.dial.calls).toHaveLength(1);
    });

    test("a create timeout after the request left settles outcome_unknown and is never retried", async () => {
      const fixture = calendarCreateFixtureFor({ timeoutMs: 10 });
      fixture.dial.plan({ hangs: true });
      const created = await proposeGcalCreate(fixture.app);
      const first = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(((await first.json()) as { status: string }).status).toBe(
        "outcome_unknown",
      );
      const again = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(((await again.json()) as { status: string }).status).toBe(
        "outcome_unknown",
      );
      expect(fixture.dial.calls).toHaveLength(1);
    });
  });

  describe("7. deployment, kind and §9 limits", () => {
    test("a deployment with no calendar client answers 503 at decision time, the row still awaiting_review", async () => {
      const fixture = calendarCreateFixtureFor({ clientAbsent: true });
      const created = await proposeGcalCreate(fixture.app);
      const refused = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(refused.status).toBe(503);
      expect(fixture.dial.calls).toHaveLength(0);
      expect(
        fixture.rows.actions.find((row) => row.id === created.body.id)?.status,
      ).toBe("awaiting_review");
    });

    test("a kind this executor does not create settles failed without a dial", async () => {
      const fixture = calendarCreateFixtureFor();
      const created = await proposeGcalCreate(fixture.app, {
        kind: "gmail.send",
        payload: {
          to: ["ava@example.com"],
          subject: "Board review",
          body: "See you there.",
        },
      });
      expect(created.response.status).toBe(201);
      const failed = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      const body = (await failed.json()) as { status: string; error: string };
      expect(body.status).toBe("failed");
      expect(body.error).toContain("gcalendar.create");
      expect(fixture.dial.calls).toHaveLength(0);
    });

    test("§9 disabled owner still answers 403 with zero dials", async () => {
      const fixture = calendarCreateFixtureFor();
      const created = await proposeGcalCreate(fixture.app);
      await fixture.rows.disableOwner("user-1");
      const refused = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(refused.status).toBe(403);
      expect(fixture.dial.calls).toHaveLength(0);
      const proposeRefused = await proposeGcalCreate(fixture.app);
      expect(proposeRefused.response.status).toBe(403);
    });
  });
});

// ── R06: the Calendar update executor ────────────────────────────────────────

/*
 * The §6 canonical payload for kind `gcalendar.update` is the create's shape
 * again — title, start, end, allDay?, timeZone, calendarId, attendees[] — the
 * event's NEW content; the event it updates is bound FIRST-CLASS, as §6's
 * targetId (the provider event id) and targetVersion (the etag the decision
 * was made against), never smuggled into the payload.
 */
const gcalUpdatePayload = {
  title: "Board review (moved)",
  start: "2026-10-21T09:00:00-07:00",
  end: "2026-10-21T10:00:00-07:00",
  timeZone: "America/Los_Angeles",
  calendarId: "primary",
  attendees: ["ava@example.com"],
};

/** The reviewed target: the provider event and the etag the proposal binds. */
const gcalUpdateTarget = { id: "provider-event-21", etag: "etag-1" };

const GCAL_UPDATE_PATH = "/v1/actions/gcalendar.update";
const GCAL_GET_PATH = "/v1/actions/gcalendar.get";

/*
 * The R06 wire fake: R05's fakeMailDial plans ONE answer for every dial, but
 * an update decision dials TWICE — the etag pre-check read, then the write —
 * so this fake plans PER PATH and defaults to an etag that MATCHES the bound
 * one (an unplanned get simply agrees). Provider WRITE calls are the update
 * path's; the get is a read and never one.
 */
function fakeCalendarUpdateDial() {
  const calls: Array<{
    path: string;
    init: { method: string; headers: Record<string, string>; body?: unknown };
  }> = [];
  let planned: Record<string, PlannedDial> = {};
  const dial: CalendarWireDial = async (path, init) => {
    calls.push({ path, init });
    const answer = planned[path] ?? {
      ok: true,
      body: { data: { ...gcalUpdateTarget } },
    };
    if (answer.throws) {
      throw new Error("the network went silent mid-request");
    }
    if (answer.hangs) {
      return new Promise(() => {});
    }
    const dialled = answer as { ok: boolean; status?: number; body: unknown };
    return {
      ok: dialled.ok,
      status: dialled.status ?? 200,
      json: async () => dialled.body,
    };
  };
  return {
    dial,
    calls,
    plan: (path: string, next: PlannedDial) => {
      planned = { ...planned, [path]: next };
    },
    writes: () => calls.filter((call) => call.path === GCAL_UPDATE_PATH),
    reads: () => calls.filter((call) => call.path === GCAL_GET_PATH),
  };
}

type CalendarUpdateFixture = {
  rows: ReturnType<typeof fakeRows>;
  dial: ReturnType<typeof fakeCalendarUpdateDial>;
  app: Hono<{ Variables: AppVariables }>;
  setConnections: (next: StoredOpenMuseGoogleConnection[]) => void;
};

/*
 * The R06 fixture: R01's rows and routes with the REAL Calendar update
 * executor wired over A01's client, the same CalendarWireDial transport the
 * create rides. Task 0 chose the PRE-CHECK FETCH: the etag read runs in
 * preflight (pre-claim, zero writes), so a changed etag answers §6's 409
 * staleReason "target" with the row still awaiting_review.
 */
function calendarUpdateFixtureFor(
  options: { clientAbsent?: boolean; timeoutMs?: number } = {},
): CalendarUpdateFixture {
  const rows = fakeRows();
  const dial = fakeCalendarUpdateDial();
  let connections: StoredOpenMuseGoogleConnection[] = [gcalConnection()];
  const executor = createCalendarUpdateExecutor({
    ...(options.clientAbsent
      ? {}
      : { client: buildOpenMuseCalendarClient({ dial: dial.dial }) }),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    requireConnection: async (_userId, provider) => {
      const seat = connections.find((row) => row.provider === provider);
      if (!seat) throw new OpenMuseConnectionRefusedError(provider);
      return seat;
    },
  });
  const service = createOpenMuseReviewedActionService({
    rows,
    executor,
    now: () => new Date(nowMs),
  });
  const app = createOpenMuseReviewedActionsRoutes({ service, requireUser });
  return {
    rows,
    dial,
    app,
    setConnections: (next) => {
      connections = next;
    },
  };
}

async function proposeGcalUpdate(
  app: Hono<{ Variables: AppVariables }>,
  overrides: Record<string, unknown> = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "gcalendar.update",
      payload: gcalUpdatePayload,
      accountEmail: "owner@example.com",
      connectionGeneration: 2,
      targetId: gcalUpdateTarget.id,
      targetVersion: gcalUpdateTarget.etag,
      ...overrides,
    }),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

describe("R06 gcalendar.update execution", () => {
  describe("1. propose binds the target first-class", () => {
    test("stores targetId and targetVersion; identical submissions hash identically; a moved start hashes apart", async () => {
      const fixture = calendarUpdateFixtureFor();
      const first = await proposeGcalUpdate(fixture.app);
      const second = await proposeGcalUpdate(fixture.app);
      expect(first.response.status).toBe(201);
      expect(first.body).toMatchObject({
        kind: "gcalendar.update",
        status: "awaiting_review",
        payload: gcalUpdatePayload,
        accountEmail: "owner@example.com",
        connectionGeneration: 2,
        targetId: gcalUpdateTarget.id,
        targetVersion: gcalUpdateTarget.etag,
      });
      expect(first.body.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect(first.body.payloadHash).toBe(second.body.payloadHash);
      expect(
        fixture.rows.actions.find((row) => row.id === first.body.id),
      ).toMatchObject({
        targetId: gcalUpdateTarget.id,
        targetVersion: gcalUpdateTarget.etag,
      });
      const moved = await proposeGcalUpdate(fixture.app, {
        payload: {
          ...gcalUpdatePayload,
          start: "2026-10-21T11:00:00-07:00",
        },
      });
      expect(moved.body.payloadHash).not.toBe(first.body.payloadHash);
      expect(fixture.dial.calls).toHaveLength(0);
    });

    test("an update without targetId or targetVersion is 400 and stores nothing", async () => {
      const fixture = calendarUpdateFixtureFor();
      for (const overrides of [
        { targetId: undefined },
        { targetVersion: undefined },
        { targetId: "", targetVersion: "" },
      ]) {
        const refused = await proposeGcalUpdate(fixture.app, overrides);
        expect(refused.response.status).toBe(400);
      }
      expect(fixture.rows.actions).toHaveLength(0);
    });
  });

  describe("2. approve happy path", () => {
    test("pre-check read, then ONE update dial carrying the etag; succeeded with the provider event id and the fingerprint that binds both", async () => {
      const fixture = calendarUpdateFixtureFor();
      fixture.dial.plan(GCAL_UPDATE_PATH, {
        ok: true,
        body: { data: { id: gcalUpdateTarget.id, etag: "etag-2" } },
      });
      const created = await proposeGcalUpdate(fixture.app);
      const approved = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(approved.status).toBe(200);
      const body = (await approved.json()) as {
        status: string;
        providerRef: string | null;
        receipt: {
          attemptId: string;
          fingerprint: string;
          providerRef: string;
        };
      };
      expect(body.status).toBe("succeeded");
      expect(body.providerRef).toBe(gcalUpdateTarget.id);
      expect(body.receipt.providerRef).toBe(gcalUpdateTarget.id);
      expect(body.receipt.attemptId).toBe(fixture.rows.attempts[0]?.attemptId);
      expect(body.receipt.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(fixture.rows.attempts[0]).toMatchObject({
        actionId: created.body.id,
        outcome: "succeeded",
        providerRef: gcalUpdateTarget.id,
      });
      // The pre-check read: once, the placeholder get id, the bound event.
      expect(fixture.dial.reads()).toEqual([
        {
          path: GCAL_GET_PATH,
          init: {
            method: "POST",
            headers: { "x-oo-connector-alias": "openmuse-gcal-alias-1" },
            body: { input: { id: gcalUpdateTarget.id } },
          },
        },
      ]);
      // The write: once, the placeholder update id, etag in, exact fields.
      expect(fixture.dial.writes()).toEqual([
        {
          path: GCAL_UPDATE_PATH,
          init: {
            method: "POST",
            headers: { "x-oo-connector-alias": "openmuse-gcal-alias-1" },
            body: {
              input: {
                id: gcalUpdateTarget.id,
                etag: gcalUpdateTarget.etag,
                ...gcalUpdatePayload,
              },
            },
          },
        },
      ]);
    });

    test("the fingerprint binds the etag: a different bound version is a different provider request", async () => {
      const fingerprints = new Set<string>();
      for (const etag of ["etag-1", "etag-2"]) {
        const fixture = calendarUpdateFixtureFor();
        fixture.dial.plan(GCAL_GET_PATH, {
          ok: true,
          body: { data: { id: gcalUpdateTarget.id, etag } },
        });
        fixture.dial.plan(GCAL_UPDATE_PATH, {
          ok: true,
          body: { data: { id: gcalUpdateTarget.id, etag: "etag-3" } },
        });
        const created = await proposeGcalUpdate(fixture.app, {
          targetVersion: etag,
        });
        const approved = await decide(fixture.app, created.body.id as string, {
          decision: "approve",
        });
        const body = (await approved.json()) as {
          receipt: { fingerprint: string };
        };
        fingerprints.add(body.receipt.fingerprint);
      }
      expect(fingerprints.size).toBe(2);
    });
  });

  describe("3. changed etag", () => {
    test("the pre-check read sees another etag: 409/stale target, zero writes, still awaiting_review", async () => {
      const fixture = calendarUpdateFixtureFor();
      fixture.dial.plan(GCAL_GET_PATH, {
        ok: true,
        body: { data: { id: gcalUpdateTarget.id, etag: "etag-9" } },
      });
      const created = await proposeGcalUpdate(fixture.app);
      const stale = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(stale.status).toBe(409);
      const body = (await stale.json()) as {
        code: string;
        staleReason: string;
      };
      expect(body.code).toBe("stale");
      expect(body.staleReason).toBe("target");
      expect(fixture.dial.writes()).toHaveLength(0);
      expect(fixture.dial.reads()).toHaveLength(1);
      expect(fixture.rows.attempts).toHaveLength(0);
      expect(
        fixture.rows.actions.find((row) => row.id === created.body.id)?.status,
      ).toBe("awaiting_review");
    });
  });

  describe("4. deny and missing target", () => {
    test("a REJECTED pre-check read proves nothing: the approval proceeds on the write dial's own etag backstop, not a 503", async () => {
      const fixture = calendarUpdateFixtureFor();
      fixture.dial.plan(GCAL_GET_PATH, { throws: true });
      const created = await proposeGcalUpdate(fixture.app);
      const approved = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      // A transport failure on the read is the late/unreadable case's twin:
      // the write dial carries the etag itself and its conflict answer is
      // the backstop — the decision must settle, not hard-refuse with 503.
      expect(approved.status).toBe(200);
      const body = (await approved.json()) as {
        status: string;
        receipt: { providerRef: string | null };
      };
      expect(body.status).toBe("succeeded");
      expect(body.receipt.providerRef).toBe(gcalUpdateTarget.id);
      expect(fixture.dial.writes()).toHaveLength(1);
    });

    test("deny settles denied with zero dials of any kind and zero attempts", async () => {
      const fixture = calendarUpdateFixtureFor();
      const created = await proposeGcalUpdate(fixture.app);
      const denied = await decide(fixture.app, created.body.id as string, {
        decision: "deny",
      });
      expect(denied.status).toBe(200);
      expect(((await denied.json()) as { status: string }).status).toBe(
        "denied",
      );
      expect(fixture.dial.calls).toHaveLength(0);
      expect(fixture.rows.attempts).toHaveLength(0);
    });

    test("a missing target settles failed with the vendor detail; the calendar is unchanged", async () => {
      const fixture = calendarUpdateFixtureFor();
      fixture.dial.plan(GCAL_GET_PATH, {
        ok: false,
        status: 404,
        body: { message: "No such event." },
      });
      fixture.dial.plan(GCAL_UPDATE_PATH, {
        ok: false,
        status: 404,
        body: { message: "No such event." },
      });
      const created = await proposeGcalUpdate(fixture.app);
      const failed = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      const body = (await failed.json()) as { status: string; error: string };
      expect(body.status).toBe("failed");
      expect(body.error).toBe("No such event.");
      expect(fixture.dial.writes()).toHaveLength(1);
      expect(
        fixture.rows.actions.find((row) => row.id === created.body.id)
          ?.providerRef,
      ).toBeNull();
    });
  });

  describe("5. staleness rows and the uncertain tail with update payloads", () => {
    test("a moved start, a re-bound account, a bumped generation or a guarded-away etag answers 409/stale pre-dial", async () => {
      // Payload: the decision carries another proposal's hash.
      const payloadFixture = calendarUpdateFixtureFor();
      const base = await proposeGcalUpdate(payloadFixture.app);
      const moved = await proposeGcalUpdate(payloadFixture.app, {
        payload: {
          ...gcalUpdatePayload,
          start: "2026-10-21T11:00:00-07:00",
        },
      });
      const payloadStale = await decide(
        payloadFixture.app,
        base.body.id as string,
        {
          decision: "approve",
          payloadHash: moved.body.payloadHash,
        },
      );
      expect(payloadStale.status).toBe(409);
      expect(
        ((await payloadStale.json()) as { staleReason: string }).staleReason,
      ).toBe("payload");
      expect(payloadFixture.dial.calls).toHaveLength(0);

      // Account and generation: the connection row drifted (preflight).
      for (const overrides of [
        {
          connection: { accountEmail: "newowner@example.com" },
          staleReason: "account",
        },
        { connection: { generation: 3 }, staleReason: "generation" },
      ]) {
        const fixture = calendarUpdateFixtureFor();
        const created = await proposeGcalUpdate(fixture.app);
        fixture.setConnections([gcalConnection(overrides.connection)]);
        const stale = await decide(fixture.app, created.body.id as string, {
          decision: "approve",
        });
        expect(stale.status).toBe(409);
        expect(
          ((await stale.json()) as { staleReason: string }).staleReason,
        ).toBe(overrides.staleReason);
        expect(fixture.dial.calls).toHaveLength(0);
        expect(
          fixture.rows.actions.find((row) => row.id === created.body.id)
            ?.status,
        ).toBe("awaiting_review");
      }

      // Target version: the decision's own etag guard, service-level.
      const guardFixture = calendarUpdateFixtureFor();
      const guardCreated = await proposeGcalUpdate(guardFixture.app);
      const guardStale = await decide(
        guardFixture.app,
        guardCreated.body.id as string,
        { decision: "approve", targetVersion: "etag-0" },
      );
      expect(guardStale.status).toBe(409);
      expect(
        ((await guardStale.json()) as { staleReason: string }).staleReason,
      ).toBe("target");
      expect(guardFixture.dial.calls).toHaveLength(0);
    });

    test("an update timeout after the request left settles outcome_unknown and is never retried", async () => {
      const fixture = calendarUpdateFixtureFor({ timeoutMs: 10 });
      fixture.dial.plan(GCAL_UPDATE_PATH, { hangs: true });
      const created = await proposeGcalUpdate(fixture.app);
      const first = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(((await first.json()) as { status: string }).status).toBe(
        "outcome_unknown",
      );
      const again = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(((await again.json()) as { status: string }).status).toBe(
        "outcome_unknown",
      );
      expect(fixture.dial.writes()).toHaveLength(1);
    });
  });

  describe("6. deployment, kind and §9 limits", () => {
    test("a deployment with no calendar client answers 503 at decision time, the row still awaiting_review", async () => {
      const fixture = calendarUpdateFixtureFor({ clientAbsent: true });
      const created = await proposeGcalUpdate(fixture.app);
      const refused = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(refused.status).toBe(503);
      expect(fixture.dial.calls).toHaveLength(0);
      expect(
        fixture.rows.actions.find((row) => row.id === created.body.id)?.status,
      ).toBe("awaiting_review");
    });

    test("a kind this executor does not update settles failed without a dial", async () => {
      const fixture = calendarUpdateFixtureFor();
      const created = await proposeGcalUpdate(fixture.app, {
        kind: "gmail.send",
        payload: {
          to: ["ava@example.com"],
          subject: "Board review",
          body: "See you there.",
        },
      });
      expect(created.response.status).toBe(201);
      const failed = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      const body = (await failed.json()) as { status: string; error: string };
      expect(body.status).toBe("failed");
      expect(body.error).toContain("gcalendar.update");
      expect(fixture.dial.calls).toHaveLength(0);
    });

    test("§9 disabled owner still answers 403 with zero dials", async () => {
      const fixture = calendarUpdateFixtureFor();
      const created = await proposeGcalUpdate(fixture.app);
      await fixture.rows.disableOwner("user-1");
      const refused = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(refused.status).toBe(403);
      expect(fixture.dial.calls).toHaveLength(0);
      const proposeRefused = await proposeGcalUpdate(fixture.app);
      expect(proposeRefused.response.status).toBe(403);
    });
  });
});

// ── R07: the Calendar delete executor ────────────────────────────────────────

/*
 * The §6 canonical payload for kind `gcalendar.delete` is only the calendar
 * the doomed event lives on — title/start/end/attendees are gone, because a
 * delete carries no content. The event itself is bound FIRST-CLASS exactly
 * as R06 bound the update: targetId (the provider event id) and
 * targetVersion (the etag the decision was made against), never smuggled
 * into the payload.
 */
const gcalDeletePayload = { calendarId: "primary" };

/** The reviewed target: the provider event and the etag the proposal binds. */
const gcalDeleteTarget = { id: "provider-event-31", etag: "etag-1" };

const GCAL_DELETE_PATH = "/v1/actions/gcalendar.delete";

/*
 * The R07 wire fake: R06's per-path fake again — a delete decision dials the
 * etag pre-check read, then the delete — planned PER PATH and defaulting the
 * read to an etag that MATCHES the bound one (an unplanned get simply
 * agrees). Provider WRITE calls are the delete path's; the get is a read and
 * never one.
 */
function fakeCalendarDeleteDial() {
  const calls: Array<{
    path: string;
    init: { method: string; headers: Record<string, string>; body?: unknown };
  }> = [];
  let planned: Record<string, PlannedDial> = {};
  const dial: CalendarWireDial = async (path, init) => {
    calls.push({ path, init });
    const answer = planned[path] ?? {
      ok: true,
      body: { data: { ...gcalDeleteTarget } },
    };
    if (answer.throws) {
      throw new Error("the network went silent mid-request");
    }
    if (answer.hangs) {
      return new Promise(() => {});
    }
    const dialled = answer as { ok: boolean; status?: number; body: unknown };
    return {
      ok: dialled.ok,
      status: dialled.status ?? 200,
      json: async () => dialled.body,
    };
  };
  return {
    dial,
    calls,
    plan: (path: string, next: PlannedDial) => {
      planned = { ...planned, [path]: next };
    },
    writes: () => calls.filter((call) => call.path === GCAL_DELETE_PATH),
    reads: () => calls.filter((call) => call.path === GCAL_GET_PATH),
  };
}

type CalendarDeleteFixture = {
  rows: ReturnType<typeof fakeRows>;
  dial: ReturnType<typeof fakeCalendarDeleteDial>;
  app: Hono<{ Variables: AppVariables }>;
  setConnections: (next: StoredOpenMuseGoogleConnection[]) => void;
};

/*
 * The R07 fixture: R01's rows and routes with the REAL Calendar delete
 * executor wired over A01's client. R07 reuses R06's RECORDED etag strategy
 * (calendar-update-executor.ts, TASK 0: PRE-CHECK FETCH, not
 * trust-provider-error) unchanged: the etag read runs in preflight
 * (pre-claim, zero writes), so a changed etag answers §6's 409 staleReason
 * "target" with the row still awaiting_review.
 */
function calendarDeleteFixtureFor(
  options: { clientAbsent?: boolean; timeoutMs?: number } = {},
): CalendarDeleteFixture {
  const rows = fakeRows();
  const dial = fakeCalendarDeleteDial();
  let connections: StoredOpenMuseGoogleConnection[] = [gcalConnection()];
  const executor = createCalendarDeleteExecutor({
    ...(options.clientAbsent
      ? {}
      : { client: buildOpenMuseCalendarClient({ dial: dial.dial }) }),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    requireConnection: async (_userId, provider) => {
      const seat = connections.find((row) => row.provider === provider);
      if (!seat) throw new OpenMuseConnectionRefusedError(provider);
      return seat;
    },
  });
  const service = createOpenMuseReviewedActionService({
    rows,
    executor,
    now: () => new Date(nowMs),
  });
  const app = createOpenMuseReviewedActionsRoutes({ service, requireUser });
  return {
    rows,
    dial,
    app,
    setConnections: (next) => {
      connections = next;
    },
  };
}

async function proposeGcalDelete(
  app: Hono<{ Variables: AppVariables }>,
  overrides: Record<string, unknown> = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "gcalendar.delete",
      payload: gcalDeletePayload,
      accountEmail: "owner@example.com",
      connectionGeneration: 2,
      targetId: gcalDeleteTarget.id,
      targetVersion: gcalDeleteTarget.etag,
      ...overrides,
    }),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

describe("R07 gcalendar.delete execution", () => {
  describe("1. propose binds the target first-class", () => {
    test("stores targetId and targetVersion; identical submissions hash identically; a different calendar hashes apart", async () => {
      const fixture = calendarDeleteFixtureFor();
      const first = await proposeGcalDelete(fixture.app);
      const second = await proposeGcalDelete(fixture.app);
      expect(first.response.status).toBe(201);
      expect(first.body).toMatchObject({
        kind: "gcalendar.delete",
        status: "awaiting_review",
        payload: gcalDeletePayload,
        accountEmail: "owner@example.com",
        connectionGeneration: 2,
        targetId: gcalDeleteTarget.id,
        targetVersion: gcalDeleteTarget.etag,
      });
      expect(first.body.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect(first.body.payloadHash).toBe(second.body.payloadHash);
      expect(
        fixture.rows.actions.find((row) => row.id === first.body.id),
      ).toMatchObject({
        targetId: gcalDeleteTarget.id,
        targetVersion: gcalDeleteTarget.etag,
      });
      const elsewhere = await proposeGcalDelete(fixture.app, {
        payload: { calendarId: "work@openbot.test" },
      });
      expect(elsewhere.body.payloadHash).not.toBe(first.body.payloadHash);
      expect(fixture.dial.calls).toHaveLength(0);
    });

    test("a delete without targetId or targetVersion is 400 and stores nothing", async () => {
      const fixture = calendarDeleteFixtureFor();
      for (const overrides of [
        { targetId: undefined },
        { targetVersion: undefined },
        { targetId: "", targetVersion: "" },
        { payload: { calendarId: "" } },
        { payload: { calendarId: "primary", extra: "field" } },
      ]) {
        const refused = await proposeGcalDelete(fixture.app, overrides);
        expect(refused.response.status).toBe(400);
      }
      expect(fixture.rows.actions).toHaveLength(0);
    });
  });

  describe("2. approve happy path", () => {
    test("pre-check read, then ONE delete dial carrying the etag; succeeded with the provider event id and the fingerprint that binds both", async () => {
      const fixture = calendarDeleteFixtureFor();
      fixture.dial.plan(GCAL_DELETE_PATH, {
        ok: true,
        body: { data: { id: gcalDeleteTarget.id } },
      });
      const created = await proposeGcalDelete(fixture.app);
      const approved = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(approved.status).toBe(200);
      const body = (await approved.json()) as {
        status: string;
        providerRef: string | null;
        receipt: {
          attemptId: string;
          fingerprint: string;
          providerRef: string;
        };
      };
      expect(body.status).toBe("succeeded");
      expect(body.providerRef).toBe(gcalDeleteTarget.id);
      expect(body.receipt.providerRef).toBe(gcalDeleteTarget.id);
      expect(body.receipt.attemptId).toBe(fixture.rows.attempts[0]?.attemptId);
      expect(body.receipt.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(fixture.rows.attempts[0]).toMatchObject({
        actionId: created.body.id,
        outcome: "succeeded",
        providerRef: gcalDeleteTarget.id,
      });
      // The pre-check read: once, the placeholder get id, the bound event.
      expect(fixture.dial.reads()).toEqual([
        {
          path: GCAL_GET_PATH,
          init: {
            method: "POST",
            headers: { "x-oo-connector-alias": "openmuse-gcal-alias-1" },
            body: { input: { id: gcalDeleteTarget.id } },
          },
        },
      ]);
      // The write: once, the placeholder delete id, etag in, exact fields.
      expect(fixture.dial.writes()).toEqual([
        {
          path: GCAL_DELETE_PATH,
          init: {
            method: "POST",
            headers: { "x-oo-connector-alias": "openmuse-gcal-alias-1" },
            body: {
              input: {
                id: gcalDeleteTarget.id,
                etag: gcalDeleteTarget.etag,
                ...gcalDeletePayload,
              },
            },
          },
        },
      ]);
    });

    test("the fingerprint binds the etag: a different bound version is a different provider request", async () => {
      const fingerprints = new Set<string>();
      for (const etag of ["etag-1", "etag-2"]) {
        const fixture = calendarDeleteFixtureFor();
        fixture.dial.plan(GCAL_GET_PATH, {
          ok: true,
          body: { data: { id: gcalDeleteTarget.id, etag } },
        });
        fixture.dial.plan(GCAL_DELETE_PATH, {
          ok: true,
          body: { data: { id: gcalDeleteTarget.id } },
        });
        const created = await proposeGcalDelete(fixture.app, {
          targetVersion: etag,
        });
        const approved = await decide(fixture.app, created.body.id as string, {
          decision: "approve",
        });
        const body = (await approved.json()) as {
          receipt: { fingerprint: string };
        };
        fingerprints.add(body.receipt.fingerprint);
      }
      expect(fingerprints.size).toBe(2);
    });
  });

  describe("3. changed etag", () => {
    test("the pre-check read sees another etag: 409/stale target, zero writes, still awaiting_review", async () => {
      const fixture = calendarDeleteFixtureFor();
      fixture.dial.plan(GCAL_GET_PATH, {
        ok: true,
        body: { data: { id: gcalDeleteTarget.id, etag: "etag-9" } },
      });
      const created = await proposeGcalDelete(fixture.app);
      const stale = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(stale.status).toBe(409);
      const body = (await stale.json()) as {
        code: string;
        staleReason: string;
      };
      expect(body.code).toBe("stale");
      expect(body.staleReason).toBe("target");
      expect(fixture.dial.writes()).toHaveLength(0);
      expect(fixture.dial.reads()).toHaveLength(1);
      expect(fixture.rows.attempts).toHaveLength(0);
      expect(
        fixture.rows.actions.find((row) => row.id === created.body.id)?.status,
      ).toBe("awaiting_review");
    });
  });

  describe("4. deny and missing target", () => {
    test("a REJECTED pre-check read proves nothing: the approval proceeds on the write dial's own etag backstop, not a 503", async () => {
      const fixture = calendarDeleteFixtureFor();
      fixture.dial.plan(GCAL_GET_PATH, { throws: true });
      const created = await proposeGcalDelete(fixture.app);
      const approved = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(approved.status).toBe(200);
      const body = (await approved.json()) as { status: string };
      expect(body.status).toBe("succeeded");
      expect(fixture.dial.writes()).toHaveLength(1);
    });

    test("deny settles denied with zero dials of any kind and zero attempts", async () => {
      const fixture = calendarDeleteFixtureFor();
      const created = await proposeGcalDelete(fixture.app);
      const denied = await decide(fixture.app, created.body.id as string, {
        decision: "deny",
      });
      expect(denied.status).toBe(200);
      expect(((await denied.json()) as { status: string }).status).toBe(
        "denied",
      );
      expect(fixture.dial.calls).toHaveLength(0);
      expect(fixture.rows.attempts).toHaveLength(0);
    });

    test("a missing target settles failed with the vendor detail; the calendar is unchanged", async () => {
      const fixture = calendarDeleteFixtureFor();
      fixture.dial.plan(GCAL_GET_PATH, {
        ok: false,
        status: 404,
        body: { message: "No such event." },
      });
      fixture.dial.plan(GCAL_DELETE_PATH, {
        ok: false,
        status: 404,
        body: { message: "No such event." },
      });
      const created = await proposeGcalDelete(fixture.app);
      const failed = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      const body = (await failed.json()) as { status: string; error: string };
      expect(body.status).toBe("failed");
      expect(body.error).toBe("No such event.");
      expect(fixture.dial.writes()).toHaveLength(1);
      expect(
        fixture.rows.actions.find((row) => row.id === created.body.id)
          ?.providerRef,
      ).toBeNull();
    });
  });

  describe("5. staleness rows and the uncertain tail with delete payloads", () => {
    test("a changed calendar, a re-bound account, a bumped generation or a guarded-away etag answers 409/stale pre-dial", async () => {
      // Payload: the decision carries another proposal's hash.
      const payloadFixture = calendarDeleteFixtureFor();
      const base = await proposeGcalDelete(payloadFixture.app);
      const elsewhere = await proposeGcalDelete(payloadFixture.app, {
        payload: { calendarId: "work@openbot.test" },
      });
      const payloadStale = await decide(
        payloadFixture.app,
        base.body.id as string,
        {
          decision: "approve",
          payloadHash: elsewhere.body.payloadHash,
        },
      );
      expect(payloadStale.status).toBe(409);
      expect(
        ((await payloadStale.json()) as { staleReason: string }).staleReason,
      ).toBe("payload");
      expect(payloadFixture.dial.calls).toHaveLength(0);

      // Account and generation: the connection row drifted (preflight).
      for (const overrides of [
        {
          connection: { accountEmail: "newowner@example.com" },
          staleReason: "account",
        },
        { connection: { generation: 3 }, staleReason: "generation" },
      ]) {
        const fixture = calendarDeleteFixtureFor();
        const created = await proposeGcalDelete(fixture.app);
        fixture.setConnections([gcalConnection(overrides.connection)]);
        const stale = await decide(fixture.app, created.body.id as string, {
          decision: "approve",
        });
        expect(stale.status).toBe(409);
        expect(
          ((await stale.json()) as { staleReason: string }).staleReason,
        ).toBe(overrides.staleReason);
        expect(fixture.dial.calls).toHaveLength(0);
        expect(
          fixture.rows.actions.find((row) => row.id === created.body.id)
            ?.status,
        ).toBe("awaiting_review");
      }

      // Target version: the decision's own etag guard, service-level.
      const guardFixture = calendarDeleteFixtureFor();
      const guardCreated = await proposeGcalDelete(guardFixture.app);
      const guardStale = await decide(
        guardFixture.app,
        guardCreated.body.id as string,
        { decision: "approve", targetVersion: "etag-0" },
      );
      expect(guardStale.status).toBe(409);
      expect(
        ((await guardStale.json()) as { staleReason: string }).staleReason,
      ).toBe("target");
      expect(guardFixture.dial.calls).toHaveLength(0);
    });

    test("a delete timeout after the request left settles outcome_unknown and is never retried", async () => {
      const fixture = calendarDeleteFixtureFor({ timeoutMs: 10 });
      fixture.dial.plan(GCAL_DELETE_PATH, { hangs: true });
      const created = await proposeGcalDelete(fixture.app);
      const first = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(((await first.json()) as { status: string }).status).toBe(
        "outcome_unknown",
      );
      const again = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(((await again.json()) as { status: string }).status).toBe(
        "outcome_unknown",
      );
      expect(fixture.dial.writes()).toHaveLength(1);
    });
  });

  describe("6. deployment, kind and §9 limits", () => {
    test("a deployment with no calendar client answers 503 at decision time, the row still awaiting_review", async () => {
      const fixture = calendarDeleteFixtureFor({ clientAbsent: true });
      const created = await proposeGcalDelete(fixture.app);
      const refused = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(refused.status).toBe(503);
      expect(fixture.dial.calls).toHaveLength(0);
      expect(
        fixture.rows.actions.find((row) => row.id === created.body.id)?.status,
      ).toBe("awaiting_review");
    });

    test("a kind this executor does not delete settles failed without a dial", async () => {
      const fixture = calendarDeleteFixtureFor();
      const created = await proposeGcalDelete(fixture.app, {
        kind: "gmail.send",
        payload: {
          to: ["ava@example.com"],
          subject: "Board review",
          body: "See you there.",
        },
      });
      expect(created.response.status).toBe(201);
      const failed = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      const body = (await failed.json()) as { status: string; error: string };
      expect(body.status).toBe("failed");
      expect(body.error).toContain("gcalendar.delete");
      expect(fixture.dial.calls).toHaveLength(0);
    });

    test("§9 disabled owner still answers 403 with zero dials", async () => {
      const fixture = calendarDeleteFixtureFor();
      const created = await proposeGcalDelete(fixture.app);
      await fixture.rows.disableOwner("user-1");
      const refused = await decide(fixture.app, created.body.id as string, {
        decision: "approve",
      });
      expect(refused.status).toBe(403);
      expect(fixture.dial.calls).toHaveLength(0);
      const proposeRefused = await proposeGcalDelete(fixture.app);
      expect(proposeRefused.response.status).toBe(403);
    });
  });
});

// ── R08: reconciling uncertain Calendar mutations ────────────────────────────

/*
 * Task 0 audit (cited): R04's reconcile machinery is proposal-kind-agnostic —
 * service.reconcile answers by id + `outcome_unknown` status only (no kind
 * branch anywhere in service.ts), the re-proposal gate compares
 * `prior.kind === input.kind`, and the route's requireAdmin fences no kind.
 * The calendar executors already own R04's ambiguous-tail mapping too: R05,
 * R06 and R07 each carry the deadline race, so a write dial that leaves and
 * never answers settles outcome_unknown with the fingerprint. What R04 never
 * had is provider evidence: reconcile recorded only free-text evidence, so
 * R08 adds the optional `providerEventId` the operator read back, recorded on
 * the attempt row when the outcome is confirmed_succeeded.
 */

/*
 * The three uncertain calendars behind one adapter: create (one dial — the
 * write), update and delete (the etag pre-check read, then the write). The
 * write hangs after the request left (R04's fault injection) behind a 10ms
 * deadline; `succeedWrite` re-plans the write path so a confirmed_not_sent
 * re-proposal can be observed executing exactly once.
 */
type UncertainCalendarFixture = {
  rows: ReturnType<typeof fakeRows>;
  app: Hono<{ Variables: AppVariables }>;
  writes: () => unknown[];
  succeedWrite: () => void;
  /**
   * Propose this kind: no variant is the canonical logical mutation (the one
   * the uncertain row holds); a variant suffix is a DIFFERENT logical
   * mutation (a distinct payload hash the re-proposal gate never blocks).
   */
  propose: (
    variant?: string,
  ) => Promise<{ response: Response; body: Record<string, unknown> }>;
};

const uncertainCalendarKinds: Array<{
  kind: "gcalendar.create" | "gcalendar.update" | "gcalendar.delete";
  make: () => UncertainCalendarFixture;
}> = [
  {
    kind: "gcalendar.create",
    make: () => {
      const fixture = calendarCreateFixtureFor({ timeoutMs: 10 });
      fixture.dial.plan({ hangs: true });
      return {
        rows: fixture.rows,
        app: fixture.app,
        writes: () => fixture.dial.calls,
        succeedWrite: () =>
          fixture.dial.plan({
            ok: true,
            body: { data: { id: "provider-event-99" } },
          }),
        propose: (variant) =>
          proposeGcalCreate(fixture.app, {
            ...(variant !== undefined
              ? {
                  payload: {
                    ...gcalCreatePayload,
                    title: `${gcalCreatePayload.title} (${variant})`,
                  },
                }
              : {}),
          }),
      };
    },
  },
  {
    kind: "gcalendar.update",
    make: () => {
      const fixture = calendarUpdateFixtureFor({ timeoutMs: 10 });
      fixture.dial.plan(GCAL_UPDATE_PATH, { hangs: true });
      return {
        rows: fixture.rows,
        app: fixture.app,
        writes: () => fixture.dial.writes(),
        succeedWrite: () =>
          fixture.dial.plan(GCAL_UPDATE_PATH, {
            ok: true,
            body: { data: { ...gcalUpdateTarget } },
          }),
        propose: (variant) =>
          proposeGcalUpdate(fixture.app, {
            ...(variant !== undefined
              ? {
                  payload: {
                    ...gcalUpdatePayload,
                    title: `${gcalUpdatePayload.title} (${variant})`,
                  },
                }
              : {}),
          }),
      };
    },
  },
  {
    kind: "gcalendar.delete",
    make: () => {
      const fixture = calendarDeleteFixtureFor({ timeoutMs: 10 });
      fixture.dial.plan(GCAL_DELETE_PATH, { hangs: true });
      return {
        rows: fixture.rows,
        app: fixture.app,
        writes: () => fixture.dial.writes(),
        succeedWrite: () =>
          fixture.dial.plan(GCAL_DELETE_PATH, {
            ok: true,
            body: { data: { ...gcalDeleteTarget } },
          }),
        propose: (variant) =>
          proposeGcalDelete(fixture.app, {
            ...(variant !== undefined
              ? { payload: { calendarId: `calendar-${variant}` } }
              : {}),
          }),
      };
    },
  },
];

/** Propose + approve into the uncertain state for one calendar kind. */
async function approveUncertainCalendar(
  make: () => UncertainCalendarFixture,
): Promise<UncertainCalendarFixture & { id: string; attemptId: string }> {
  const fixture = make();
  const created = await fixture.propose();
  expect(created.response.status).toBe(201);
  const approved = await decide(fixture.app, created.body.id as string, {
    decision: "approve",
  });
  expect(((await approved.json()) as { status: string }).status).toBe(
    "outcome_unknown",
  );
  const attempt = fixture.rows.attempts[0];
  expect(attempt).toBeDefined();
  return {
    ...fixture,
    id: created.body.id as string,
    attemptId: attempt!.attemptId,
  };
}

describe("R08 uncertain Calendar reconciliation", () => {
  test("1. a timeout after the write left settles outcome_unknown with fingerprint and timestamps; zero retry, the settled re-decision", async () => {
    for (const { make } of uncertainCalendarKinds) {
      const uncertain = await approveUncertainCalendar(make);
      const attempt = uncertain.rows.attempts[0];
      expect(attempt).toMatchObject({
        actionId: uncertain.id,
        outcome: "outcome_unknown",
      });
      expect(attempt?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(attempt?.startedAt).toBeInstanceOf(Date);
      expect(attempt?.completedAt).toBeInstanceOf(Date);
      // §6 zero automatic retry: a second decision re-dials nothing,
      // re-attempts nothing, and re-answers the settled record.
      const again = await decide(uncertain.app, uncertain.id, {
        decision: "approve",
      });
      expect(((await again.json()) as { status: string }).status).toBe(
        "outcome_unknown",
      );
      expect(uncertain.writes()).toHaveLength(1);
      expect(uncertain.rows.attempts).toHaveLength(1);
    }
  });

  test("2. confirmed_succeeded records the read-back providerEventId on the attempt row", async () => {
    for (const { make } of uncertainCalendarKinds) {
      const uncertain = await approveUncertainCalendar(make);
      currentActor = actorAdmin;
      let reconciled: Response;
      try {
        reconciled = await reconcile(uncertain.app, uncertain.id, {
          outcome: "confirmed_succeeded",
          evidence: "provider console shows the event landed",
          providerEventId: "provider-event-99",
        });
      } finally {
        currentActor = actorOne;
      }
      expect(reconciled.status).toBe(200);
      const body = (await reconciled.json()) as {
        status: string;
        receipt: {
          providerRef: string | null;
          reconciliation: Record<string, unknown>;
        };
      };
      expect(body.status).toBe("succeeded");
      expect(body.receipt.reconciliation).toEqual({
        outcome: "confirmed_succeeded",
        evidence: "provider console shows the event landed",
        reviewer: "admin-1",
      });
      // The read-back evidence: the receipt's provider ref IS the event id
      // the operator confirmed, recorded on the attempt row.
      expect(body.receipt.providerRef).toBe("provider-event-99");
      expect(uncertain.rows.attempts[0]?.providerRef).toBe("provider-event-99");
      expect(
        uncertain.rows.actions.find((row) => row.id === uncertain.id)?.status,
      ).toBe("succeeded");
    }
  });

  test("3. confirmed_not_sent settles failed; the same mutation re-proposes fresh and executes once on a new attempt", async () => {
    for (const { make } of uncertainCalendarKinds) {
      const uncertain = await approveUncertainCalendar(make);
      const priorAttemptId = uncertain.attemptId;
      currentActor = actorAdmin;
      let reconciled: Response;
      try {
        reconciled = await reconcile(uncertain.app, uncertain.id, {
          outcome: "confirmed_not_sent",
          evidence: "provider audit log shows no such request",
        });
      } finally {
        currentActor = actorOne;
      }
      expect(reconciled.status).toBe(200);
      expect(((await reconciled.json()) as { status: string }).status).toBe(
        "failed",
      );
      expect(uncertain.rows.attempts[0]?.reconciliation).toMatchObject({
        outcome: "confirmed_not_sent",
        reviewer: "admin-1",
      });

      // The ONLY door to a fresh proposal of the same logical mutation.
      uncertain.succeedWrite();
      const fresh = await uncertain.propose();
      expect(fresh.response.status).toBe(201);
      const approved = await decide(uncertain.app, fresh.body.id as string, {
        decision: "approve",
      });
      const body = (await approved.json()) as {
        status: string;
        receipt: { attemptId: string };
      };
      expect(body.status).toBe("succeeded");
      // A fresh attempt — the claimed one is never reused — and exactly one
      // more write than the uncertain first try.
      expect(uncertain.rows.attempts).toHaveLength(2);
      expect(body.receipt.attemptId).not.toBe(priorAttemptId);
      expect(uncertain.writes()).toHaveLength(2);
    }
  });

  test("4. unresolved keeps outcome_unknown and its warning, appending evidence", async () => {
    for (const { make } of uncertainCalendarKinds) {
      const uncertain = await approveUncertainCalendar(make);
      const warning = uncertain.rows.actions.find(
        (row) => row.id === uncertain.id,
      )?.error;
      expect(warning).toContain("unknown");
      currentActor = actorAdmin;
      try {
        const first = await reconcile(uncertain.app, uncertain.id, {
          outcome: "unresolved",
          evidence: "provider console unreachable",
        });
        expect(first.status).toBe(200);
        expect(((await first.json()) as { status: string }).status).toBe(
          "outcome_unknown",
        );
        // Still uncertain, so reconcile stays open and evidence appends.
        const second = await reconcile(uncertain.app, uncertain.id, {
          outcome: "unresolved",
          evidence: "support ticket 5512 opened",
        });
        expect(second.status).toBe(200);
      } finally {
        currentActor = actorOne;
      }
      const action = uncertain.rows.actions.find(
        (row) => row.id === uncertain.id,
      );
      expect(action?.status).toBe("outcome_unknown");
      expect(action?.error).toBe(warning); // the warning is never cleared
      const evidence =
        uncertain.rows.attempts[0]?.reconciliation?.evidence ?? "";
      expect(evidence).toContain("provider console unreachable");
      expect(evidence).toContain("support ticket 5512 opened");
    }
  });

  test("5. a non-admin reconcile is 403 and records nothing; a non-uncertain action is 409", async () => {
    for (const { make } of uncertainCalendarKinds) {
      const uncertain = await approveUncertainCalendar(make);
      // The owner's own seat is a user role: reconciliation is operator-only.
      const refused = await reconcile(uncertain.app, uncertain.id, {
        outcome: "confirmed_succeeded",
        evidence: "owner insists it landed",
        providerEventId: "provider-event-99",
      });
      expect(refused.status).toBe(403);
      expect(uncertain.rows.attempts[0]?.reconciliation).toBeNull();
      expect(uncertain.rows.attempts[0]?.providerRef).toBeNull();

      // Reconciliation is for outcome_unknown only: a denied action of the
      // same calendar kind is 409.
      const denied = await uncertain.propose("other");
      expect(denied.response.status).toBe(201);
      await decide(uncertain.app, denied.body.id as string, {
        decision: "deny",
      });
      currentActor = actorAdmin;
      let notUncertain: Response;
      try {
        notUncertain = await reconcile(
          uncertain.app,
          denied.body.id as string,
          {
            outcome: "confirmed_not_sent",
            evidence: "it was denied",
          },
        );
      } finally {
        currentActor = actorOne;
      }
      expect(notUncertain.status).toBe(409);
    }
  });

  test("6. the re-proposal gate with calendar kinds: blocked while uncertain or unresolved, already_sent once sent; only confirmed_not_sent passes", async () => {
    for (const { make } of uncertainCalendarKinds) {
      const uncertain = await approveUncertainCalendar(make);

      // While merely uncertain, the same logical mutation cannot be
      // re-proposed — that would be the automatic retry §6 forbids.
      const blocked = await uncertain.propose();
      expect(blocked.response.status).toBe(409);
      expect(blocked.body).toMatchObject({
        code: "reproposal_blocked",
        reason: "uncertain",
      });

      // An unresolved reconciliation keeps the warning, so still blocked.
      currentActor = actorAdmin;
      try {
        const unresolved = await reconcile(uncertain.app, uncertain.id, {
          outcome: "unresolved",
          evidence: "still checking",
        });
        expect(unresolved.status).toBe(200);
      } finally {
        currentActor = actorOne;
      }
      const stillBlocked = await uncertain.propose();
      expect(stillBlocked.response.status).toBe(409);

      // Only confirmed_not_sent re-opens the same logical mutation.
      currentActor = actorAdmin;
      try {
        const closed = await reconcile(uncertain.app, uncertain.id, {
          outcome: "confirmed_not_sent",
          evidence: "provider confirms no mutation",
        });
        expect(closed.status).toBe(200);
      } finally {
        currentActor = actorOne;
      }
      const fresh = await uncertain.propose();
      expect(fresh.response.status).toBe(201);
    }
  });

  test("7. zero automatic queue replay across all rows: the fake's write count never grows on its own", async () => {
    for (const { make } of uncertainCalendarKinds) {
      const fixture = make();
      // Three rows in one owner's table, each a distinct logical mutation:
      // one left uncertain, one unresolved, one confirmed_not_sent and
      // re-proposed into a clean success.
      const rows: Array<{ id: string }> = [];
      for (const variant of ["r1", "r2", "r3"]) {
        const created = await fixture.propose(variant);
        rows.push({ id: created.body.id as string });
        await decide(fixture.app, created.body.id as string, {
          decision: "approve",
        });
      }
      currentActor = actorAdmin;
      try {
        await reconcile(fixture.app, rows[1].id, {
          outcome: "unresolved",
          evidence: "still checking",
        });
        await reconcile(fixture.app, rows[2].id, {
          outcome: "confirmed_not_sent",
          evidence: "provider confirms no mutation",
        });
      } finally {
        currentActor = actorOne;
      }
      fixture.succeedWrite();
      const fresh = await fixture.propose("r3");
      await decide(fixture.app, fresh.body.id as string, {
        decision: "approve",
      });

      // This module owns no replay queue by design (R04's recorded finding),
      // so the queue observable is the wire fake's write count: four writes
      // total (three uncertain first-tries + the one fresh re-execution) and
      // nothing more, however often every settled row is decided again.
      expect(fixture.writes()).toHaveLength(4);
      expect(fixture.rows.attempts).toHaveLength(4);
      for (const row of [
        ...rows.map((row) => row.id),
        fresh.body.id as string,
      ]) {
        const again = await decide(fixture.app, row, {
          decision: "approve",
        });
        expect(again.status).toBe(200);
      }
      expect(fixture.writes()).toHaveLength(4);
      expect(fixture.rows.attempts).toHaveLength(4);
    }
  });
});

/*
 * D02 (§9 work shutdown): the store's bulk awaiting → cancelled transition a
 * deleted owner's pending write work lands through. Executing rows are
 * UNTOUCHED by contract — an external attempt mid-flight keeps its uncertain
 * outcome for R04's human reconciliation, never fabricated away.
 */
function storedReviewedAction(
  overrides: Partial<StoredReviewedAction> = {},
): StoredReviewedAction {
  const when = new Date("2026-10-13T10:00:00Z");
  return {
    id: "ra-1",
    ownerUserId: "user-1",
    kind: "mail",
    canonicalPayload: mailPayload,
    payloadHash: MAIL_PAYLOAD_HASH,
    accountEmail: "owner@example.com",
    connectionGeneration: 2,
    targetId: null,
    targetVersion: null,
    attachmentVersionIds: [],
    status: "awaiting_review",
    expiresAt: new Date(when.getTime() + 3600_000),
    createdAt: when,
    decidedAt: null,
    completedAt: null,
    providerRef: null,
    error: null,
    ...overrides,
  };
}

describe("§9 work shutdown (D02)", () => {
  test("cancelAwaiting flips only awaiting_review: executing stays untouched, settled rows stay settled, foreign owner untouched", async () => {
    const rows = fakeRows();
    rows.actions.push(
      storedReviewedAction({ id: "ra-awaiting" }),
      storedReviewedAction({
        id: "ra-executing",
        status: "executing",
        decidedAt: new Date("2026-10-13T10:01:00Z"),
      }),
      storedReviewedAction({
        id: "ra-denied",
        status: "denied",
        decidedAt: new Date("2026-10-13T10:01:00Z"),
      }),
      storedReviewedAction({ id: "ra-sent", status: "succeeded" }),
      storedReviewedAction({ id: "ra-uncertain", status: "outcome_unknown" }),
      storedReviewedAction({ id: "ra-foreign", ownerUserId: "user-2" }),
    );

    const cancelled = await rows.cancelAwaiting("user-1");

    const byId = new Map(rows.actions.map((row) => [row.id, row]));
    expect(byId.get("ra-awaiting")?.status).toBe("cancelled");
    expect(byId.get("ra-awaiting")?.decidedAt).not.toBeNull();
    // Executing is UNTOUCHED: outcome_unknown's reconciliation (R04) owns it.
    expect(byId.get("ra-executing")?.status).toBe("executing");
    expect(byId.get("ra-denied")?.status).toBe("denied");
    expect(byId.get("ra-sent")?.status).toBe("succeeded");
    expect(byId.get("ra-uncertain")?.status).toBe("outcome_unknown");
    expect(byId.get("ra-foreign")?.status).toBe("awaiting_review");
    expect(cancelled).toEqual(["ra-awaiting"]);
  });

  test("a repeated cancelAwaiting is idempotent: nothing left to claim", async () => {
    const rows = fakeRows();
    rows.actions.push(storedReviewedAction({ id: "ra-awaiting" }));
    await rows.cancelAwaiting("user-1");
    expect(await rows.cancelAwaiting("user-1")).toEqual([]);
    expect(rows.actions.find((row) => row.id === "ra-awaiting")?.status).toBe(
      "cancelled",
    );
  });
});

describe("a rejecting executor does not strand the row executing", () => {
  test("the row settles outcome_unknown (reconcilable) and the failure still surfaces", async () => {
    const fixture = fixtureFor();
    const created = await propose(fixture.app);
    // The "never rejects" convention is a convention, not the interface: a
    // future executor bug or a persistence fault past the dial rejects here.
    fixture.executor.executor.execute = async () => {
      throw new Error("the executor fell over");
    };
    await expect(
      fixture.service.decide("user-1", created.id, "approve"),
    ).rejects.toThrow("the executor fell over");
    // Not wedged `executing`: recovery's own state, open to reconcile.
    const stored = fixture.rows.actions.find((row) => row.id === created.id);
    expect(stored?.status).toBe("outcome_unknown");
    // The operator's surface can still close it (the route's admin seat is
    // routes-level; the service method is the same contract).
    const reconciled = await fixture.service.reconcile(
      "ops@openbot.test",
      created.id,
      {
        outcome: "confirmed_not_sent",
        evidence: "operator closed the uncertain send",
      },
    );
    expect(reconciled?.status).toBe("failed");
  });
});
