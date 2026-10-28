/**
 * The administrator's summary route (Issue #39 / DAG T33).
 *
 * Mounted inside createAiObservabilityRoutes at
 * GET /api/ai-observability/admin/summary, behind the root requireUser.
 *
 * Authorization comes FIRST, aggregation second: every bot this answer names
 * went through the manage gate and a freshly minted T06 scope (whose
 * enterprise refusal precedes its ownership answer), so a chat-only sharer or
 * a guessed id widens nothing. FREV-03: the minted scope's key is the Bot's
 * stable data identity, so an administrator's summary aggregates exactly the
 * range its creator's writes live in — same data, freshly gated viewer. The
 * query string contributes a bot filter and a time window and nothing else —
 * the route never reads an actor, scope, epoch or locator from the request.
 */
import { Hono } from "hono";
import { getLogger } from "../../../../shared/logger";
import type { AgentActor, AgentProfile } from "../../agents/profile-types";
import type { AppVariables } from "../../auth/guards";
import type { AdminSummaryService } from "../admin-summary";
import {
  type BotManagementCheck,
  explicitObservationOwnership,
  OBSERVATION_BOT_NOT_FOUND,
  resolveObservationBot,
} from "../context";
import { ObservationScopeError } from "../contracts";
import { resolveObservationScope } from "../scope";

export type AdminSummaryRouteDeps = Readonly<{
  canManageBot: BotManagementCheck;
  /** The ownership generation for the scope key; wiring supplies the live source. */
  scopeEpoch: (actor: AgentActor, botId: string) => Promise<number>;
  /** The caller's management range, as the boot's own listing seam answers it. */
  listBots: (actor: AgentActor) => Promise<readonly AgentProfile[]>;
  summary: AdminSummaryService;
  /** How many bots one unfiltered answer may summarize. Default 100. */
  maxBots?: number;
}>;

/** House convention: the code is the contract; nothing else rides along. */
export class AdminSummaryError extends Error {
  constructor(
    public code: "ADMIN_SUMMARY_INPUT_INVALID" | "ADMIN_SUMMARY_UNAVAILABLE",
    public status: 400 | 500,
  ) {
    super(code);
  }
}

const DEFAULT_MAX_BOTS = 100;

/** An ISO instant, or null when absent. Present-but-invalid throws 400. */
function parseInstant(raw: string | undefined): Date | null {
  if (raw === undefined || raw === "") return null;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed))
    throw new AdminSummaryError("ADMIN_SUMMARY_INPUT_INVALID", 400);
  return new Date(parsed);
}

/** The 404 a bot the caller cannot manage answers, as a thrown classification. */
class ManageRefusal extends Error {
  constructor(
    public status: 404,
    public body: { error: string },
  ) {
    super(body.error);
  }
}

export function createAdminSummaryRoutes(
  deps: AdminSummaryRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const maxBots = deps.maxBots ?? DEFAULT_MAX_BOTS;
  const log = getLogger("server");

  /**
   * The T10 authorization block: manage-gate, then the live-epoch scope. The
   * scope's key is the Bot's stable data identity (FREV-03) — the epoch rides
   * the scope for artifact binding, never for storage addressing.
   */
  const scopeFor = async (
    actor: AgentActor,
    botId: string,
  ): Promise<ReturnType<typeof resolveObservationScope>> => {
    const access = await resolveObservationBot(deps.canManageBot, actor, botId);
    if (!access.ok)
      throw new ManageRefusal(access.status, { error: access.error });
    // Explicit, never inferred (OCR h10/m182, R4-35): the seam answers the
    // ownership off the profile row the manage decision read. A null — a
    // caller a future widened gate lets manage but the seam refuses to mint
    // for — is refused with the same unified not-found the manage gate uses,
    // so the enumeration's skip and the filtered call's 404 stay one answer.
    const ownership = explicitObservationOwnership(actor, access.profile);
    if (ownership === null) {
      throw new ManageRefusal(404, { error: OBSERVATION_BOT_NOT_FOUND });
    }
    const epoch = await deps.scopeEpoch(actor, access.botId);
    return resolveObservationScope({
      actorId: actor.id,
      botId: access.botId,
      ownership,
      epoch,
    });
  };

  routes.get("/", async (context) => {
    let from: Date | null;
    let to: Date | null;
    try {
      from = parseInstant(context.req.query("timeFrom"));
      to = parseInstant(context.req.query("timeTo"));
      if (from !== null && to !== null && from.getTime() > to.getTime()) {
        throw new AdminSummaryError("ADMIN_SUMMARY_INPUT_INVALID", 400);
      }
    } catch (error) {
      if (error instanceof AdminSummaryError) {
        return context.json({ error: error.code }, error.status);
      }
      throw error;
    }

    const actor = context.var.actor;
    const botIdParam = context.req.query("botId");
    try {
      const scopes: ReturnType<typeof resolveObservationScope>[] = [];
      let truncated = false;
      if (botIdParam !== undefined && botIdParam !== "") {
        scopes.push(await scopeFor(actor, botIdParam));
      } else {
        let profiles: readonly AgentProfile[];
        try {
          profiles = await deps.listBots(actor);
        } catch (error) {
          // T33-rev3 M-3: the enumeration store failing is an honest fault,
          // never an empty listing the caller reads as "no bots in scope" —
          // the answer is an explicit 500 (the page maps any non-OK status
          // to its unavailable fault), and the raw error stays on the log
          // trail instead of riding hono's silent dispatch fallback.
          log.warn(
            { type: "opik-admin-summary-list-failed", error: String(error) },
            "opik-admin-summary-list-failed",
          );
          throw new AdminSummaryError("ADMIN_SUMMARY_UNAVAILABLE", 500);
        }
        for (const profile of profiles) {
          if (scopes.length >= maxBots) {
            truncated = true;
            break;
          }
          // The listing's visibility answer is not authorization: every bot
          // goes through the same manage gate a filtered call would. A bot
          // whose scope cannot be minted is skipped, not guessed about.
          try {
            scopes.push(await scopeFor(actor, profile.id));
          } catch (error) {
            if (
              error instanceof ObservationScopeError ||
              error instanceof ManageRefusal
            ) {
              continue;
            }
            throw error;
          }
        }
      }
      const summary = await deps.summary.summarize({
        scopes,
        window: { from, to },
        botId: botIdParam || null,
      });
      // The filter echo is what this route parsed, not what a service chose to
      // repeat: the caller sees exactly the question their query string asked.
      return context.json({
        ...summary,
        window: {
          from: from?.toISOString() ?? null,
          to: to?.toISOString() ?? null,
          botId: botIdParam || null,
        },
        botsTruncated: summary.botsTruncated || truncated,
      });
    } catch (error) {
      if (error instanceof ObservationScopeError) {
        return context.json({ error: error.code }, error.status);
      }
      if (error instanceof ManageRefusal) {
        return context.json(error.body, error.status);
      }
      if (error instanceof AdminSummaryError) {
        return context.json({ error: error.code }, error.status);
      }
      throw error;
    }
  });

  return routes;
}
