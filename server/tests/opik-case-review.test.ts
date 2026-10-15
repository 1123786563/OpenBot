// Issue #26 / DAG T20 — the case review + save surface.
//
// Every case here runs against injected stores, exactly like the T11/T19 suites: no
// database, no network. The fake dataset store records what the service reached it
// with, and the fake audit store records every row — so the unit contract includes
// "which actions leave a trail and which never get that far". The behavioral proofs
// (the freeze through a real T19 pipeline, scope isolation at the database, the sync
// state machine's guarded transitions, the delete trigger) live in
// opik-case-review.integration.test.ts against a dedicated database.
//
// The acceptance under test, in issue order:
//   1. fragments are selected from a run the scope bound, and reviewed.
//   2. saving reaches the T19 freeze pipeline with binding-derived provenance.
//   3. every review and save action leaves an audit row with attribution.
//   4. the canary: denied content is refused by the projection, never echoed — not
//      in the preview, not in the frozen cases, not in the audit payload.
//   5. scope discipline matches T11/T19: forged scopes and unbound runs learn nothing.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfile } from "../src/agents/profile-types";
import type { RunBinding } from "../src/ai-observability/bindings";
import type {
  CaseFragment,
  CaseReviewService,
} from "../src/ai-observability/case-review";
import {
  CaseReviewError,
  createCaseReviewService,
} from "../src/ai-observability/case-review";
import {
  type BotManagementCheck,
  OBSERVATION_BOT_NOT_FOUND,
} from "../src/ai-observability/context";
import { ObservationScopeError } from "../src/ai-observability/contracts";
import type {
  DatasetCaseInput,
  ObservationDataset,
  ObservationDatasetVersion,
} from "../src/ai-observability/datasets";
import { createCaseReviewRoutes } from "../src/ai-observability/routes/case-review";
import { resolveObservationScope } from "../src/ai-observability/scope";
import type { AuditEventInput } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";

const owner = { id: "user-owner", role: "user" } as const;
const stranger = { id: "user-stranger", role: "user" } as const;
const EPOCH = 3;

const scopeA = resolveObservationScope({
  actorId: owner.id,
  botId: "agent-1",
  ownership: "owner",
  epoch: EPOCH,
});
const scopeB = resolveObservationScope({
  actorId: "user-b",
  botId: "agent-1",
  ownership: "admin",
  epoch: EPOCH,
});

function bindingRow(
  scope: ReturnType<typeof resolveObservationScope>,
  overrides: Partial<RunBinding> = {},
): RunBinding {
  return {
    id: `binding-${scope.actorId}`,
    scopeKey: scope.key,
    actorId: scope.actorId,
    botId: scope.botId,
    runId: "run-1",
    attemptId: "attempt-1",
    traceId: "trace-1",
    opikTraceId: "trace-1",
    locatorWorkspace: "ws",
    locatorProject: "proj",
    capability: "basic",
    state: "completed",
    expiresAt: new Date("2026-10-23T00:00:00.000Z"),
    deletedAt: null,
    createdAt: new Date("2026-10-15T00:00:00.000Z"),
    updatedAt: new Date("2026-10-15T00:05:00.000Z"),
    ...overrides,
  };
}

const fragment: CaseFragment = {
  input: "Summarize the outage report.",
  referenceOutput: "A one-paragraph summary of the outage.",
  toolFixtures: { search: { query: "outage", results: 0 } },
};

/** Records every read; a run this scope did not bind is simply not found. */
function fakeBindings(rows: RunBinding[]) {
  const reads: Array<{ scopeKey: string; runId: string }> = [];
  return {
    reads,
    store: {
      latestAttempt: async (scope: { key: string }, runId: string) => {
        reads.push({ scopeKey: scope.key, runId });
        return (
          rows.find(
            (row) => row.scopeKey === scope.key && row.runId === runId,
          ) ?? null
        );
      },
    },
  };
}

/** Records what the service reached the freeze pipeline with. */
function fakeDatasets(
  behavior: {
    saved?: {
      dataset: ObservationDataset;
      version: ObservationDatasetVersion;
      replayed: boolean;
    };
  } = {},
) {
  const calls: Array<{
    scopeKey: string;
    input: { datasetName: string; cases: DatasetCaseInput[] };
  }> = [];
  return {
    calls,
    store: {
      saveVersion: async (
        scope: { key: string },
        input: { datasetName: string; cases: DatasetCaseInput[] },
      ) => {
        calls.push({ scopeKey: scope.key, input });
        const saved = behavior.saved;
        if (!saved) throw new Error("no save behavior configured");
        return saved;
      },
    },
  };
}

/** Records every row the service wanted written. */
function fakeAudit() {
  const events: AuditEventInput[] = [];
  return {
    events,
    store: {
      insert: async (event: AuditEventInput) => {
        events.push(event);
      },
    },
  };
}

const serviceFor = (
  bindings: RunBinding[],
  behavior: Parameters<typeof fakeDatasets>[0] = {},
) => {
  const bindingFake = fakeBindings(bindings);
  const datasetFake = fakeDatasets(behavior);
  const auditFake = fakeAudit();
  const service = createCaseReviewService({
    bindings: bindingFake.store,
    datasets: datasetFake.store,
    audit: auditFake.store,
  });
  return { service, bindingFake, datasetFake, auditFake };
};

const savedRow = {
  dataset: {
    id: "dataset-1",
    scopeKey: scopeA.key,
    actorId: owner.id,
    botId: "agent-1",
    name: "eval-set",
    locatorWorkspace: "ws",
    locatorProject: "proj",
    opikDatasetId: null,
    syncState: "pending",
    createdAt: new Date("2026-10-16T00:00:00.000Z"),
    updatedAt: new Date("2026-10-16T00:00:00.000Z"),
  } as ObservationDataset,
  version: {
    id: "version-1",
    scopeKey: scopeA.key,
    datasetId: "dataset-1",
    contentHash: `${"a".repeat(64)}`,
    redactionPolicyVersion: "opik-redaction/5",
    cases: [],
    locatorWorkspace: "ws",
    locatorProject: "proj",
    createdAt: new Date("2026-10-16T00:00:00.000Z"),
  } as ObservationDatasetVersion,
  replayed: false,
};

describe("case review — acceptance 5: scope discipline first, always", () => {
  test("a spread copy of a real scope is forged, not trusted", async () => {
    const forged = { ...scopeA };
    const { service, auditFake } = serviceFor([bindingRow(scopeA)]);
    await expect(
      service.review(forged, {
        runId: "run-1",
        decision: "approved",
        cases: [fragment],
      }),
    ).rejects.toThrow(new ObservationScopeError("OWNERSHIP_REQUIRED", 403));
    await expect(
      service.saveReviewed(forged, {
        datasetName: "eval-set",
        runId: "run-1",
        cases: [fragment],
      }),
    ).rejects.toThrow(new ObservationScopeError("OWNERSHIP_REQUIRED", 403));
    // Refused before anything happened: no read, no freeze, no trail.
    expect(auditFake.events).toHaveLength(0);
  });

  test("a run the scope did not bind is simply not found, and leaves no trail", async () => {
    const { service, bindingFake, datasetFake, auditFake } = serviceFor([
      bindingRow(scopeA),
    ]);
    await expect(
      service.review(scopeB, {
        runId: "run-1",
        decision: "approved",
        cases: [fragment],
      }),
    ).rejects.toThrow(new CaseReviewError("CASE_REVIEW_RUN_NOT_FOUND", 404));
    await expect(
      service.saveReviewed(scopeB, {
        datasetName: "eval-set",
        runId: "run-1",
        cases: [fragment],
      }),
    ).rejects.toThrow(new CaseReviewError("CASE_REVIEW_RUN_NOT_FOUND", 404));
    expect(bindingFake.reads).toHaveLength(2);
    expect(datasetFake.calls).toHaveLength(0);
    expect(auditFake.events).toHaveLength(0);
  });
});

describe("case review — input refusal before any query", () => {
  const { service, bindingFake, auditFake } = serviceFor([bindingRow(scopeA)]);
  const refuses = (promise: Promise<unknown>) =>
    expect(promise).rejects.toThrow(
      new CaseReviewError("CASE_REVIEW_INPUT_INVALID", 400),
    );

  test("an empty run id, an unknown decision, a non-string note", async () => {
    await refuses(
      service.review(scopeA, {
        runId: " ",
        decision: "approved",
        cases: [fragment],
      }),
    );
    await refuses(
      service.review(scopeA, {
        runId: "run-1",
        decision: "maybe" as "approved",
        cases: [fragment],
      }),
    );
    await refuses(
      service.review(scopeA, {
        runId: "run-1",
        decision: "approved",
        cases: [fragment],
        note: 42 as unknown as string,
      }),
    );
  });

  test("zero fragments, more fragments than one version may freeze, and malformed ones", async () => {
    await refuses(
      service.review(scopeA, {
        runId: "run-1",
        decision: "approved",
        cases: [],
      }),
    );
    await refuses(
      service.review(scopeA, {
        runId: "run-1",
        decision: "approved",
        cases: Array.from({ length: 201 }, () => fragment),
      }),
    );
    for (const broken of [
      { ...fragment, input: "" },
      { ...fragment, referenceOutput: " " },
      { ...fragment, toolFixtures: "not an object" },
      { ...fragment, toolFixtures: null },
      { ...fragment, toolFixtures: ["an", "array"] },
      { ...fragment, attemptId: "" },
    ]) {
      await refuses(
        service.review(scopeA, {
          runId: "run-1",
          decision: "approved",
          cases: [broken as CaseFragment],
        }),
      );
    }
    // Every refusal happened before the ownership read: nothing was asked of the store.
    expect(bindingFake.reads).toHaveLength(0);
    expect(auditFake.events).toHaveLength(0);
  });

  test("a fragment claiming another attempt of the run is forged, not curated", async () => {
    await expect(
      service.review(scopeA, {
        runId: "run-1",
        decision: "approved",
        cases: [{ ...fragment, attemptId: "attempt-of-another-observer" }],
      }),
    ).rejects.toThrow(new CaseReviewError("CASE_REVIEW_INPUT_INVALID", 400));
    // The ownership read did happen — provenance is checked against it — but nothing froze.
    expect(bindingFake.reads).toHaveLength(1);
  });
});

describe("case review — acceptance 1 and 3: review answers the projection and leaves a trail", () => {
  test("an approval previews exactly what a save would freeze", async () => {
    const { service, auditFake } = serviceFor([bindingRow(scopeA)]);
    const outcome = await service.review(scopeA, {
      runId: "run-1",
      decision: "approved",
      cases: [fragment],
    });
    expect(outcome).toMatchObject({
      decision: "approved",
      runId: "run-1",
      attemptId: "attempt-1",
      bindingId: `binding-${owner.id}`,
      canaryFindings: 0,
    });
    expect(outcome.preview[0]).toMatchObject({
      safeInput: { state: "projected", text: fragment.input },
      referenceOutput: { state: "projected", text: fragment.referenceOutput },
      sourceRunId: "run-1",
      sourceAttemptId: "attempt-1",
      sourceBindingId: `binding-${owner.id}`,
    });

    // Acceptance 3: the audit row is the review record — attribution in its columns,
    // references and counts in its payload, and no case content anywhere.
    expect(auditFake.events).toHaveLength(1);
    expect(auditFake.events[0]).toMatchObject({
      eventType: "opik.case_reviewed",
      targetType: "ai_observation_run",
      targetId: "run-1",
      actorUserId: owner.id,
      payload: {
        decision: "approved",
        runId: "run-1",
        attemptId: "attempt-1",
        bindingId: `binding-${owner.id}`,
        cases: 1,
        canaryFindings: 0,
      },
    });
  });

  test("a rejection carries its note, projected — a secret typed into it is refused, not echoed", async () => {
    const { service, auditFake } = serviceFor([bindingRow(scopeA)]);
    const outcome = await service.review(scopeA, {
      runId: "run-1",
      decision: "rejected",
      cases: [fragment],
      note: "leaks a key: sk-live-abc123def456ghi789jkl012",
    });
    expect(outcome.decision).toBe("rejected");
    const payload = auditFake.events[0]?.payload as Record<string, unknown>;
    expect(payload.decision).toBe("rejected");
    // The canary: the note reached the trail as a refusal, never as the literal.
    expect(JSON.stringify(payload)).not.toContain(
      "sk-live-abc123def456ghi789jkl012",
    );
    expect(payload.note).toEqual({ state: "omitted", reason: "credential" });
  });

  test("an empty note is left out of the payload entirely", async () => {
    const { service, auditFake } = serviceFor([bindingRow(scopeA)]);
    await service.review(scopeA, {
      runId: "run-1",
      decision: "rejected",
      cases: [fragment],
      note: "   ",
    });
    expect(auditFake.events[0]?.payload).not.toHaveProperty("note");
  });
});

describe("case review — acceptance 4: the canary never survives projection", () => {
  test("a credential in the input or reference output surfaces as a finding, not as content", async () => {
    const { service, auditFake } = serviceFor([bindingRow(scopeA)]);
    const outcome = await service.review(scopeA, {
      runId: "run-1",
      decision: "approved",
      cases: [
        {
          ...fragment,
          input: "sk-live-abc123def456ghi789jkl012 is not a case input",
        },
        {
          ...fragment,
          referenceOutput: "postgres://u:p@h/db is not a reference output",
        },
      ],
    });
    expect(outcome.canaryFindings).toBe(2);
    expect(outcome.preview[0]?.safeInput).toEqual({
      state: "omitted",
      reason: "credential",
    });
    expect(outcome.preview[1]?.referenceOutput).toEqual({
      state: "omitted",
      reason: "connection_string",
    });
    // The finding count rides in the audit payload; the literals never do.
    expect(auditFake.events[0]?.payload).toMatchObject({ canaryFindings: 2 });
    expect(JSON.stringify(auditFake.events[0]?.payload)).not.toContain(
      "sk-live-abc123def456ghi789jkl012",
    );
  });
});

describe("case review — acceptance 2: saving reaches the T19 freeze with honest provenance", () => {
  test("the freeze pipeline receives the binding's provenance, never caller values", async () => {
    const { service, datasetFake, auditFake } = serviceFor(
      [bindingRow(scopeA)],
      { saved: savedRow },
    );
    const saved = await service.saveReviewed(scopeA, {
      datasetName: "eval-set",
      runId: "run-1",
      cases: [fragment, { ...fragment, attemptId: "attempt-1" }],
    });
    expect(datasetFake.calls).toHaveLength(1);
    expect(datasetFake.calls[0]).toMatchObject({
      scopeKey: scopeA.key,
      input: {
        datasetName: "eval-set",
        cases: [
          {
            sourceRunId: "run-1",
            sourceAttemptId: "attempt-1",
            sourceBindingId: `binding-${owner.id}`,
          },
          {
            sourceRunId: "run-1",
            sourceAttemptId: "attempt-1",
            sourceBindingId: `binding-${owner.id}`,
          },
        ],
      },
    });
    expect(saved.replayed).toBe(false);
    expect(saved.version.id).toBe("version-1");

    // The save leaves its own trail: what was frozen, under which hash, replayed or not.
    expect(auditFake.events).toHaveLength(1);
    expect(auditFake.events[0]).toMatchObject({
      eventType: "opik.dataset_version_saved",
      targetType: "ai_observation_dataset",
      targetId: "dataset-1",
      actorUserId: owner.id,
      payload: {
        datasetId: "dataset-1",
        datasetName: "eval-set",
        versionId: "version-1",
        replayed: false,
        runId: "run-1",
        bindingId: `binding-${owner.id}`,
      },
    });
  });

  test("a replayed save is answered as such, in the response and in the trail", async () => {
    const { service, auditFake } = serviceFor([bindingRow(scopeA)], {
      saved: { ...savedRow, replayed: true },
    });
    const saved = await service.saveReviewed(scopeA, {
      datasetName: "eval-set",
      runId: "run-1",
      cases: [fragment],
    });
    expect(saved.replayed).toBe(true);
    expect(auditFake.events[0]?.payload).toMatchObject({ replayed: true });
  });

  test("an unbound run never reaches the freeze", async () => {
    const { service, datasetFake } = serviceFor([], { saved: savedRow });
    await expect(
      service.saveReviewed(scopeA, {
        datasetName: "eval-set",
        runId: "run-guessed",
        cases: [fragment],
      }),
    ).rejects.toThrow(new CaseReviewError("CASE_REVIEW_RUN_NOT_FOUND", 404));
    expect(datasetFake.calls).toHaveLength(0);
  });
});

describe("case review routes — the mounting contract's authorization shape", () => {
  function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
    return {
      id: "agent-1",
      name: "Expense Manager",
      title: "Finance",
      roleDescription: "Reviews receipts.",
      avatarSeed: "expense-manager",
      visibility: "private",
      ownerUserId: owner.id,
      systemOwned: false,
      hidden: false,
      pinned: false,
      deletedAt: null,
      ...overrides,
    } as AgentProfile;
  }

  const managementCheck = (rows: AgentProfile[]): BotManagementCheck => {
    return async (actor, botId) => {
      const found = rows.find((row) => row.id === botId) ?? null;
      if (!found) return null;
      if (found.systemOwned || found.deletedAt !== null) return null;
      return found.ownerUserId === actor.id || actor.role === "admin"
        ? found
        : null;
    };
  };

  function appFor(
    setup: {
      rows?: AgentProfile[];
      actor?: typeof owner | typeof stranger;
      service?: CaseReviewService;
    } = {},
  ) {
    const auditFake = fakeAudit();
    const datasetFake = fakeDatasets({ saved: savedRow });
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", (async (context, next) => {
      context.set(
        "actor",
        (setup.actor ?? owner) as unknown as AuthenticatedActor,
      );
      await next();
    }) satisfies MiddlewareHandler<{ Variables: AppVariables }>);
    app.route(
      "/bots/:botId/case-review",
      createCaseReviewRoutes({
        canManageBot: managementCheck(setup.rows ?? [profile()]),
        scopeEpoch: async () => EPOCH,
        bindings: fakeBindings([bindingRow(scopeA)]).store,
        datasets: datasetFake.store,
        audit: auditFake.store,
      }),
    );
    return { app, auditFake };
  }

  const reviewBody = {
    runId: "run-1",
    decision: "approved",
    cases: [fragment],
  };
  const post = (
    app: Hono<{ Variables: AppVariables }>,
    path: string,
    body: unknown,
  ) =>
    app.request(`http://openbot.test/bots/agent-1/case-review/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("only a current manager may review: a stranger learns only the 404", async () => {
    const { app, auditFake } = appFor({
      rows: [profile({ visibility: "public" })],
      actor: stranger,
    });
    const response = await post(app, "review", reviewBody);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe(OBSERVATION_BOT_NOT_FOUND);
    expect(auditFake.events).toHaveLength(0);
  });

  test("a manager's review and save answer through the service, code as contract", async () => {
    const { app, auditFake } = appFor();
    const reviewed = await post(app, "review", reviewBody);
    expect(reviewed.status).toBe(200);
    expect(await reviewed.json()).toMatchObject({
      decision: "approved",
      canaryFindings: 0,
    });

    const saved = await post(app, "save", {
      datasetName: "eval-set",
      runId: "run-1",
      cases: [fragment],
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      replayed: false,
      version: { id: "version-1" },
    });
    expect(auditFake.events.map((event) => event.eventType)).toEqual([
      "opik.case_reviewed",
      "opik.dataset_version_saved",
    ]);
  });

  test("a body the whitelist cannot read answers CASE_REVIEW_INPUT_INVALID, not a crash", async () => {
    const { app } = appFor();
    for (const body of [
      "not an object",
      { decision: "approved" },
      { runId: "run-1", decision: "approved" },
      { runId: "run-1", decision: "approved", cases: [{ input: 1 }] },
    ]) {
      const response = await post(app, "review", body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("CASE_REVIEW_INPUT_INVALID");
    }
    const notSaved = await post(app, "save", { runId: "run-1", cases: [] });
    expect(notSaved.status).toBe(400);
    expect((await notSaved.json()).error).toBe("CASE_REVIEW_INPUT_INVALID");
  });

  test("an unbound run answers RUN_NOT_FOUND over HTTP, still the code as contract", async () => {
    const { app } = appFor();
    const response = await post(app, "review", {
      ...reviewBody,
      runId: "run-guessed",
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("CASE_REVIEW_RUN_NOT_FOUND");
  });
});

describe("the delete-guard migration touches only its own objects", () => {
  const drizzle = new URL("../drizzle/", import.meta.url);

  const migrationOf = async () => {
    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", drizzle), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const entry = journal.entries.find((entry) =>
      entry.tag.includes("opik_dataset_version_delete_guard"),
    );
    if (!entry) throw new Error("no delete-guard journal entry");
    return {
      sql: await readFile(new URL(`${entry.tag}.sql`, drizzle), "utf8"),
      snapshot: JSON.parse(
        await readFile(
          new URL(
            `meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`,
            drizzle,
          ),
          "utf8",
        ),
      ) as { tables: Record<string, unknown> },
    };
  };

  test("installs the delete guard and changes nothing else", async () => {
    const { sql, snapshot } = await migrationOf();
    const named = [
      ...sql.matchAll(/CREATE (?:TRIGGER|FUNCTION) "([^"]+)"/g),
    ].map((match) => match[1]);
    expect(named.sort()).toEqual([
      "ai_observation_dataset_versions_cleanup_only",
      "ai_observation_dataset_versions_reject_delete",
    ]);
    expect(sql).not.toMatch(/CREATE TABLE|CREATE INDEX|ALTER TABLE|DROP /);
    // The snapshot is a copy of 0123's: the guard is a database fact the snapshot
    // model does not describe, and the schema it describes did not move.
    expect(Object.keys(snapshot.tables)).toContain(
      "public.ai_observation_dataset_versions",
    );
  });
});

test("CaseReviewError keeps the house error convention: the code is the contract", () => {
  const error = new CaseReviewError("CASE_REVIEW_RUN_NOT_FOUND", 404);
  expect(error.message).toBe("CASE_REVIEW_RUN_NOT_FOUND");
  expect(error.code).toBe("CASE_REVIEW_RUN_NOT_FOUND");
  expect(error.status).toBe(404);
  expect(error).toBeInstanceOf(Error);
});
