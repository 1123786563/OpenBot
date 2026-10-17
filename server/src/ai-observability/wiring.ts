/**
 * Boot wiring helpers for the observation surfaces (Issue #39 / DAG T33).
 *
 * The routes and workers take their authorization seams injected, so the live
 * sources live in exactly one file: the ownership epoch the scope keys embed,
 * the actor resolution a background worker needs (it holds an actorId, not a
 * session), and the reauthorization function the export worker re-derives its
 * scope through on every execution. Nothing here answers an authorization
 * question by itself — each helper only feeds the seams T06 already owns.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getLogger } from "../../../shared/logger";
import type { AgentActor } from "../agents/profile-types";
import type { OpenBotRole } from "../auth/roles";
import type { Database } from "../db/client";
import { agentProfiles } from "../db/schema";
import {
  type BotManagementCheck,
  explicitObservationOwnership,
  resolveObservationBot,
} from "./context";
import type { ExportReauthorization } from "./exports";
import { createOpikHttpPort } from "./opik-http";
import type { OpikPort, VerifiedOpikContract } from "./opik-port";
import { resolveObservationScope } from "./scope";

/**
 * The live ownership generation: the profile row's last write, in whole
 * seconds. Any write to the row — an ownership change first among them —
 * rotates the epoch, so scope keys, cursors and caches keyed on the old
 * generation stop answering immediately. A rename rotates it too; that is the
 * safe direction (an unnecessary invalidation, never a stale authorization).
 * A bot with no profile row has no generation: the manage gate has already
 * refused the caller by the time this could matter.
 */
export function createAgentProfileScopeEpoch(
  database: Database,
): (actor: AgentActor, botId: string) => Promise<number> {
  return async (_actor, botId) => {
    const rows = await database
      .select({ updatedAt: agentProfiles.updatedAt })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, botId))
      .limit(1);
    const row = rows[0];
    return row ? Math.floor(row.updatedAt.getTime() / 1000) : 0;
  };
}

/**
 * An actorId back into an application actor, for paths that hold a stored id
 * instead of a session. The same floor requireUser applies: no role rows, no
 * actor — a revoked or deleted user does not resolve, fail closed.
 */
export function createActorResolver(
  rolesForUser: (userId: string) => Promise<readonly OpenBotRole[]>,
): (actorId: string) => Promise<AgentActor | null> {
  return async (actorId) => {
    const roles = await rolesForUser(actorId).catch(
      (): readonly OpenBotRole[] => [],
    );
    if (roles.includes("admin")) return { id: actorId, role: "admin" };
    if (roles.includes("user")) return { id: actorId, role: "user" };
    return null;
  };
}

/**
 * The export worker's reauthorization: the T11 route's authorization block
 * lifted for a background caller. The actor is resolved from live roles, the
 * bot from the manage gate, and the scope from the live epoch — so a revoked
 * user, a transferred bot or a bumped generation answers null (or a scope the
 * frozen locator no longer matches) and the job is cancelled before any
 * upstream byte is fetched. A scope the seam refuses to mint is also null:
 * for a worker, "no scope" and "refused" are the same answer.
 */
export function createExportReauthorization(deps: {
  canManageBot: BotManagementCheck;
  scopeEpoch: (actor: AgentActor, botId: string) => Promise<number>;
  resolveActor: (actorId: string) => Promise<AgentActor | null>;
}): ExportReauthorization {
  return async ({ actorId, botId }) => {
    const actor = await deps.resolveActor(actorId);
    if (actor === null) return null;
    const access = await resolveObservationBot(deps.canManageBot, actor, botId);
    if (!access.ok) return null;
    // Explicit, never inferred (OCR h10/m182): a non-owner without the admin role
    // earns no scope even if a future gate widening lets them manage.
    const ownership = explicitObservationOwnership(actor, access.profile);
    if (ownership === null) return null;
    try {
      const epoch = await deps.scopeEpoch(actor, access.botId);
      return resolveObservationScope({
        actorId: actor.id,
        botId: access.botId,
        ownership,
        epoch,
      });
    } catch {
      return null;
    }
  };
}

/**
 * The verified port for a deployment that has one: the T04 evidence manifest
 * is the only contract this process trusts, and the adapter re-verifies it at
 * construction — an unverified manifest authorizes nothing, not even the
 * health probe. Any failure to load answers null, which every consumer reads
 * as the honest capability_missing rather than a guess. Deployments that do
 * not ship the evidence file (or have Opik disabled) simply run portless.
 *
 * The manifest lives beside THIS module (server/src/ai-observability/
 * opik-contract/47-manifest.json, T-final M2): the trust anchor ships with the
 * code that verifies against it, so a deployment image carries its own
 * contract instead of reaching outside the server tree for a docs file. A
 * load is announced with the manifest's sha-256 fingerprint — boot evidence
 * of WHICH contract went trusted — and a missing or unreadable manifest is a
 * warned null, never the silent one the final review flagged (M2).
 */
export async function loadVerifiedOpikPort(
  baseUrl: string,
  timeoutMs?: number,
  /** The manifest to trust; defaults to the one beside this module. A test seam —
   * the missing-manifest branch is only reachable with a URL that does not exist. */
  manifestUrl?: URL,
): Promise<OpikPort | null> {
  const log = getLogger("server");
  const source =
    manifestUrl ?? new URL("./opik-contract/47-manifest.json", import.meta.url);
  try {
    const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
    const manifest = JSON.parse(
      new TextDecoder().decode(bytes),
    ) as VerifiedOpikContract;
    const port = createOpikHttpPort({ baseUrl, contract: manifest, timeoutMs });
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    log.info(
      { type: "opik-contract-manifest-loaded", fingerprint },
      `opik-contract-manifest-loaded ${fingerprint}`,
    );
    return port;
  } catch (error) {
    log.warn(
      {
        type: "opik-contract-manifest-missing",
        manifest: source.pathname,
        err: error instanceof Error ? error.message : String(error),
      },
      "opik-contract-manifest-missing — every observation surface answers the honest capability_missing",
    );
    return null;
  }
}

/**
 * The builtin run's scope resolver (T-final M1): the trusted observation
 * scope for one builtin execution, issued at run start from LIVE
 * authorization — the same manage gate, ownership answer and live epoch the
 * route seam answers per request, because a scope minted at boot would outlive
 * the transfer or revocation it was minted under. The threading hands this to
 * the builtin run entry (BuiltInAgentWithSaneHistory), which establishes it
 * ambiently for everything the run emits; the recorders' adapters read it back
 * and submit, or read `null` and submit nothing.
 *
 * Every refusal is a null, never a thrown error and never a partial scope: a
 * disabled deployment, a non-manager, a failed epoch read — all mean the same
 * honest thing (this run's facts stay local). Never echoes credentials or
 * error details: the null IS the answer.
 */
export function createBuiltinRunScopeResolver(deps: {
  enabled: () => boolean;
  canManageBot: BotManagementCheck;
  scopeEpoch: (actor: AgentActor, botId: string) => Promise<number>;
}): (actor: AgentActor, botId: string) => Promise<unknown> {
  return async (actor, botId) => {
    if (!deps.enabled()) return null;
    try {
      const access = await resolveObservationBot(
        deps.canManageBot,
        actor,
        botId,
      );
      if (!access.ok) return null;
      // Explicit, never inferred (OCR h10): this resolver mints the scope every
      // builtin model-span/tool-step write carries — the exact place a widened
      // manage gate must not translate into wider observation.
      const ownership = explicitObservationOwnership(actor, access.profile);
      if (ownership === null) return null;
      const epoch = await deps.scopeEpoch(actor, access.botId);
      return resolveObservationScope({
        actorId: actor.id,
        botId: access.botId,
        ownership,
        epoch,
      });
    } catch {
      return null;
    }
  };
}
