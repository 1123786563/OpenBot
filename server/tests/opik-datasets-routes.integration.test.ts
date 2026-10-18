// OCR round-1 fix (Issue #4) — the datasets/case-review mount table, e2e through the
// ONE mount point (the T-routes pattern of opik-t-final-assembly.test.ts).
//
// Round 1 findings h1/h8/h15: the four URLs the evaluations page's data module requests
// had no server face — case-review's routes existed but were never imported anywhere,
// and the datasets list/detail GETs did not exist at all, so every read landed on Hono's
// 404 and classifyRead turned it into a "forbidden" sentence. This file pins the fix at
// the mount seam, against a real database and the real route tree:
//
//   - all four URLs answer 200 through createAiObservabilityRoutes (list, detail,
//     review, save) with the shapes shared/ai-observability-datasets.ts declares;
//   - the save answer is the contract's flat projection (h14), not the service's store
//     rows — no scope key, no locator, no actor id anywhere in the JSON;
//   - the case-review mount needs the bindings dep (the review asks the authoritative
//     ownership seam per request): absent bindings stays unmounted while the reads
//     still answer — "absent = not mounted" per sub-router, never a fallback guess;
//   - a caller the manage gate refuses learns nothing, exactly like every other seam.
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";
import { createRunBindingStore } from "../src/ai-observability/bindings";
import { createAiObservabilityRoutes } from "../src/ai-observability/routes";
import { resolveObservationScope } from "../src/ai-observability/scope";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { opikTestDatabase } from "./support/opik-test-db";

const database = opikTestDatabase({ max: 4 });

const actorId = "ocr-datasets-a";
const botId = "ocr-datasets-bot";
const epoch = 3;

function authAs(id: string): MiddlewareHandler<{ Variables: AppVariables }> {
  const actor = { id, role: "user" } as AuthenticatedActor;
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

function canManageBot(
  actor: AgentActor,
  id: string,
): Promise<AgentProfile | null> {
  if (id !== botId || actor.id !== actorId) return Promise.resolve(null);
  return Promise.resolve({
    id,
    ownerUserId: actorId,
    visibility: "private",
    systemOwned: false,
    deletedAt: null,
  } as AgentProfile);
}

function scopeFor(actor: string) {
  return resolveObservationScope({
    actorId: actor,
    botId,
    ownership: "owner",
    epoch,
  });
}

function appFor(bindings: boolean) {
  const app = new Hono<{ Variables: AppVariables }>();
  const store = createRunBindingStore(database);
  app.route(
    "/",
    createAiObservabilityRoutes({
      requireUser: authAs(actorId),
      canManageBot,
      scopeEpoch: async () => epoch,
      database,
      bindings: bindings ? store : undefined,
    }),
  );
  return { app, bindings: store };
}

async function beginRun(runId: string) {
  const { bindings } = appFor(true);
  const begun = await bindings.begin(scopeFor(actorId), {
    runId,
    attemptId: "attempt-1",
    traceId: "d".repeat(32),
    capability: "basic",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  return begun.binding;
}

const fragments = [
  {
    input: "the user asked for a haiku about tides",
    referenceOutput:
      "Moon pulls the water\nthe shore breathes in and out\ntime keeps its own score",
    toolFixtures: {},
  },
];

describe("OCR fix: the datasets chain is mounted at the one seam", () => {
  test("the four URLs the datasets page requests all answer 200", async () => {
    const runId = `ocr-ds-run-${Date.now()}`;
    await beginRun(runId);
    const { app } = appFor(true);

    const review = await app.request(
      `http://openbot.test/bots/${botId}/case-review/review`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId,
          decision: "approved",
          cases: fragments,
        }),
      },
    );
    expect(review.status).toBe(200);
    const reviewed = (await review.json()) as Record<string, unknown>;
    expect(reviewed.decision).toBe("approved");
    expect(reviewed.runId).toBe(runId);
    expect(Array.isArray(reviewed.preview)).toBe(true);
    expect(typeof reviewed.canaryFindings).toBe("number");

    const datasetName = `ocr-ds-${runId}`;
    const save = await app.request(
      `http://openbot.test/bots/${botId}/case-review/save`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          datasetName,
          runId,
          cases: fragments,
        }),
      },
    );
    expect(save.status).toBe(200);
    const saved = (await save.json()) as Record<string, unknown>;

    // h14: the wire answer is the contract's flat projection — and nothing else.
    expect(Object.keys(saved).sort()).toEqual([
      "canaryFindings",
      "datasetId",
      "datasetName",
      "replayed",
      "version",
    ]);
    expect(saved.datasetName).toBe(datasetName);
    expect(typeof saved.datasetId).toBe("string");
    expect(saved.replayed).toBe(false);
    const version = saved.version as Record<string, unknown>;
    expect(Object.keys(version).sort()).toEqual([
      "caseCount",
      "contentHash",
      "createdAt",
      "id",
      "redactionPolicyVersion",
    ]);
    expect(version.caseCount).toBe(fragments.length);
    expect(typeof version.contentHash).toBe("string");
    // No store fact crosses the wire: not the scope key, not the locator, not the actor.
    for (const forbidden of [
      "scopeKey",
      "actorId",
      "locatorWorkspace",
      "locatorProject",
    ]) {
      expect(JSON.stringify(saved)).not.toContain(forbidden);
    }

    const list = await app.request(
      `http://openbot.test/bots/${botId}/datasets`,
    );
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      datasets: Record<string, unknown>[];
    };
    const mine = listed.datasets.find((one) => one.id === saved.datasetId);
    expect(mine).toBeDefined();
    expect(mine?.name).toBe(datasetName);
    expect(mine?.syncState).toBe("pending");
    expect(mine?.versionCount).toBe(1);
    expect(typeof mine?.latestVersionAt).toBe("string");

    const detail = await app.request(
      `http://openbot.test/bots/${botId}/datasets/${String(saved.datasetId)}`,
    );
    expect(detail.status).toBe(200);
    const detailed = (await detail.json()) as {
      dataset: Record<string, unknown>;
      versions: Record<string, unknown>[];
    };
    expect(detailed.dataset.id).toBe(saved.datasetId);
    expect(detailed.dataset.name).toBe(datasetName);
    expect(detailed.versions).toHaveLength(1);
    expect(detailed.versions[0]?.caseCount).toBe(fragments.length);
    expect(detailed.versions[0]?.contentHash).toBe(version.contentHash);
    expect(detailed.versions[0]?.redactionPolicyVersion).toBe(
      version.redactionPolicyVersion,
    );
  });

  test("a replayed save keeps the same version id (idempotency key through the wire)", async () => {
    const runId = `ocr-ds-replay-${Date.now()}`;
    await beginRun(runId);
    const { app } = appFor(true);
    const body = JSON.stringify({
      datasetName: `ocr-replay-${runId}`,
      runId,
      cases: fragments,
    });
    const first = await app.request(
      `http://openbot.test/bots/${botId}/case-review/save`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
    );
    const second = await app.request(
      `http://openbot.test/bots/${botId}/case-review/save`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const one = (await first.json()) as {
      version: { id: string };
      replayed: boolean;
    };
    const two = (await second.json()) as {
      version: { id: string };
      replayed: boolean;
    };
    expect(one.replayed).toBe(false);
    expect(two.replayed).toBe(true);
    expect(two.version.id).toBe(one.version.id);
  });

  test("absent bindings unmounts case-review only; the reads still answer", async () => {
    const { app } = appFor(false);
    const review = await app.request(
      `http://openbot.test/bots/${botId}/case-review/review`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "r",
          decision: "approved",
          cases: fragments,
        }),
      },
    );
    expect(review.status).toBe(404);
    const list = await app.request(
      `http://openbot.test/bots/${botId}/datasets`,
    );
    expect(list.status).toBe(200);
  });

  test("a caller the manage gate refuses learns nothing", async () => {
    const strangerApp = new Hono<{ Variables: AppVariables }>();
    const store = createRunBindingStore(database);
    strangerApp.route(
      "/",
      createAiObservabilityRoutes({
        requireUser: authAs("someone-else"),
        canManageBot,
        scopeEpoch: async () => epoch,
        database,
        bindings: store,
      }),
    );
    const list = await strangerApp.request(
      `http://openbot.test/bots/${botId}/datasets`,
    );
    expect(list.status).toBe(404);
    const review = await strangerApp.request(
      `http://openbot.test/bots/${botId}/case-review/review`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "r",
          decision: "approved",
          cases: fragments,
        }),
      },
    );
    expect(review.status).toBe(404);
  });

  test("a collaborator the widened gate manages earns no scope off the seam (OCR R5-33)", async () => {
    // The gate's reserved widening arrived on the read face too: it manages for a
    // non-owner, plain-role collaborator. This file was created after the m176
    // registration and kept the inline `owner ? "owner" : "admin"` the explicit
    // seam exists to fail closed against — the same omission admin-summary and
    // exports already shed (R4-35/R4-36). A null refusal answers the unified
    // not-found, before any store read runs.
    const widenedApp = new Hono<{ Variables: AppVariables }>();
    const store = createRunBindingStore(database);
    widenedApp.route(
      "/",
      createAiObservabilityRoutes({
        requireUser: authAs("collaborator"),
        canManageBot: async (_actor, id) =>
          id === botId
            ? ({
                id,
                ownerUserId: "someone-else",
                visibility: "private",
                systemOwned: false,
                deletedAt: null,
              } as AgentProfile)
            : null,
        scopeEpoch: async () => epoch,
        database,
        bindings: store,
      }),
    );
    const list = await widenedApp.request(
      `http://openbot.test/bots/${botId}/datasets`,
    );
    expect(list.status).toBe(404);
    expect(await list.json()).toEqual({ error: "Bot not found." });
    // The detail read shares the same authorization block, so the same refusal.
    const detail = await widenedApp.request(
      `http://openbot.test/bots/${botId}/datasets/whatever`,
    );
    expect(detail.status).toBe(404);
  });

  test("a foreign dataset id is not found, not leaked", async () => {
    const { app } = appFor(true);
    const detail = await app.request(
      `http://openbot.test/bots/${botId}/datasets/no-such-dataset`,
    );
    expect(detail.status).toBe(404);
    const body = (await detail.json()) as { error?: string };
    expect(body.error).toBe("DATASET_NOT_FOUND");
  });
});
