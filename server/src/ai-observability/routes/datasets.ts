/**
 * The creator's dataset read routes (Issue #27 list/detail) — the wire half of the
 * shared/ai-observability-datasets.ts contract.
 *
 * The list answers what a person reads about each dataset subject in their scope —
 * names, counts, times — never the storage locator, the actor id or the upstream
 * dataset id; the detail answers the subject plus its frozen versions behind their
 * content hashes, with the case count derived from the frozen cases rather than
 * shipped over the wire. Both reads honor the M1a visibility rule through the store's
 * own queries: a dataset under retention deletion is gone to readers, list and detail
 * alike. Errors keep the house convention: the code is the contract.
 */
import { Hono } from "hono";
import type { AgentActor } from "../../agents/public";
import type { AppVariables } from "../../auth/public";
import {
  type BotManagementCheck,
  explicitObservationOwnership,
  OBSERVATION_BOT_NOT_FOUND,
  resolveObservationBot,
} from "../context";
import type { ObservationScope } from "../contracts";
import { ObservationScopeError } from "../contracts";
import type {
  ObservationDataset,
  ObservationDatasetStore,
  ObservationDatasetVersion,
} from "../datasets";
import { DatasetStoreError } from "../datasets";
import { resolveObservationScope } from "../scope";

export type ObservationDatasetReadRouteDeps = Readonly<{
  canManageBot: BotManagementCheck;
  /** The ownership generation for the scope key; wiring supplies the live source. */
  scopeEpoch: (actor: AgentActor, botId: string) => Promise<number>;
  /** The T19 store: list/getDataset/listVersions are the read face, injected. */
  datasets: Pick<
    ObservationDatasetStore,
    "list" | "getDataset" | "listVersions"
  >;
}>;

/** A non-empty opaque reference; empty or whitespace-only is refused before any query. */
function reference(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DatasetStoreError("DATASET_INPUT_INVALID", 400);
  }
  return value;
}

function classify(error: unknown): {
  body: { error: string };
  status: 400 | 401 | 403 | 404 | 409;
} {
  if (error instanceof ObservationScopeError) {
    return { body: { error: error.code }, status: error.status };
  }
  if (error instanceof DatasetStoreError) {
    return { body: { error: error.code }, status: error.status };
  }
  throw error;
}

export function createObservationDatasetReadRoutes(
  deps: ObservationDatasetReadRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  /** The shared authorization block, exactly like the other per-bot seams. */
  const scopeFor = async (context: {
    var: { actor: AgentActor };
    req: { param: (name: string) => string };
  }): Promise<{ scope: ObservationScope } | Response> => {
    const access = await resolveObservationBot(
      deps.canManageBot,
      context.var.actor,
      context.req.param("botId"),
    );
    if (!access.ok) {
      return Response.json({ error: access.error }, { status: access.status });
    }
    const actor = context.var.actor;
    // Explicit, never inferred (OCR h10/m182, R5-33): the ownership comes off the
    // seam, not off this route's own guess — this file was created after the m176
    // registration and kept the inline `owner ? "owner" : "admin"` the seam exists
    // to fail closed against, the same omission admin-summary and exports already
    // shed (R4-35/R4-36). A null — a caller a future widened gate lets manage but
    // the seam refuses to mint for — is refused with the same unified not-found
    // the manage gate uses, never a guessed-about scope.
    const ownership = explicitObservationOwnership(actor, access.profile);
    if (ownership === null) {
      return Response.json(
        { error: OBSERVATION_BOT_NOT_FOUND },
        { status: 404 },
      );
    }
    const epoch = await deps.scopeEpoch(actor, access.botId);
    return {
      scope: resolveObservationScope({
        actorId: actor.id,
        botId: access.botId,
        ownership,
        epoch,
      }),
    };
  };

  routes.get("/", async (context) => {
    try {
      const resolved = await scopeFor(context);
      if (resolved instanceof Response) return resolved;
      const rows = await deps.datasets.list(resolved.scope);
      return context.json({
        datasets: rows.map((row) => ({
          id: row.id,
          name: row.name,
          syncState: row.syncState,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          versionCount: row.versionCount,
          latestVersionAt: row.latestVersionAt?.toISOString() ?? null,
        })),
      });
    } catch (error) {
      const failure = classify(error);
      return context.json(failure.body, failure.status);
    }
  });

  routes.get("/:datasetId", async (context) => {
    try {
      const resolved = await scopeFor(context);
      if (resolved instanceof Response) return resolved;
      const dataset = await deps.datasets.getDataset(
        resolved.scope,
        reference(context.req.param("datasetId")),
      );
      // The store's not-found is a plain null for a foreign id, and the route's
      // answer is the same refusal a stranger's probe hears — by design.
      if (dataset === null) {
        return context.json({ error: "DATASET_NOT_FOUND" }, 404);
      }
      const versions = await deps.datasets.listVersions(
        resolved.scope,
        dataset.id,
      );
      return context.json({
        dataset: projectDatasetSubject(dataset),
        versions: versions.map(projectDatasetVersion),
      });
    } catch (error) {
      const failure = classify(error);
      return context.json(failure.body, failure.status);
    }
  });

  return routes;
}

function projectDatasetSubject(dataset: ObservationDataset): {
  id: string;
  name: string;
  syncState: string;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: dataset.id,
    name: dataset.name,
    syncState: dataset.syncState,
    createdAt: dataset.createdAt.toISOString(),
    updatedAt: dataset.updatedAt.toISOString(),
  };
}

function projectDatasetVersion(version: ObservationDatasetVersion): {
  id: string;
  datasetId: string;
  contentHash: string;
  redactionPolicyVersion: string;
  caseCount: number;
  createdAt: string;
} {
  return {
    id: version.id,
    datasetId: version.datasetId,
    contentHash: version.contentHash,
    redactionPolicyVersion: version.redactionPolicyVersion,
    // The count is derived from the frozen cases — the version row has no case
    // count column, and shipping every case to say how many there are is the
    // one thing the contract refuses.
    caseCount: version.cases.length,
    createdAt: version.createdAt.toISOString(),
  };
}
