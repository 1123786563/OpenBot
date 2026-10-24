/**
 * The authenticated HTTP entries over the Hindsight memory seams (#387–#391).
 *
 * The seams themselves are server code: derivation of a candidate, review of a judgment, the
 * evidence behind an answer, the revocation of an authorization target and the cleanup-evidence
 * picture. Each of them was built against a trusted `PlatformScope` and, until this family
 * existed, had no production caller — the #376 r1 audit's RG4-1/RG5-1 finding. This module is
 * the one place a request becomes that scope:
 *
 *   - IDENTITY. Every route resolves its scope through the deployment's `ScopeResolver` — the
 *     same server-issued scope the enterprise entry mints, with the same tenancy membership
 *     checks. A tenant id, workspace id, principal id or bank id arriving in a body or query
 *     string has no entry point here: the seams re-derive the placement from the trusted scope
 *     (`resolveHindsightBankScope`), so a forged field is not refused, it is simply never read.
 *     The personal routes carry `requireUser`; the operator routes add `requireAdmin`.
 *
 *   - THE PERSON'S SURFACES. Evidence expansion, the judgment candidate listing and the
 *     confirm/edit/reject/forget decisions, the source-or-Bot revocation, and the cleanup
 *     progress of the person's own forgotten records. The confirm/edit decisions answer to
 *     the same sensitivity gate as the /api/memory face: sensitive material is refused
 *     without the person's explicit second confirmation, and a refusal leaves the
 *     class-only audit trail. None of these makes an administrator's
 *     answer wider: an operator asking the same routes answers as themselves, and the operator
 *     surface below returns counts only.
 *
 *   - THE OPERATOR'S SURFACES (`/ops`). The backup-restore gate and the controlled-backup
 *     registration: how many restores await their replay, and what one replay pass did. Counts
 *     and instants only — the restore evidence records how many local blocks were re-applied
 *     and how many remote deletions were re-issued, never what any of them said.
 *
 * Retention: `cleanupEvidenceStatus` measures the finished-payload leg against the deployment's
 * DECLARED operation-retention window; the number arrives through `operationRetentionDays()`
 * and is never read as evidence by itself (the leg's own probe decides).
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getLogger } from "../../../shared/logger";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import type { AuditSink } from "../audit";
import type { PlatformScope, ScopeResolver } from "../enterprise/contracts";
import {
  type AnswerEvidenceService,
  EvidenceNotFoundError,
  EvidenceRefusedError,
} from "./answer-evidence";
import type { BackupRegistrationReport } from "./backup-registry";
import { resolveHindsightBankScope } from "./bank-scope";
import type { CleanupEvidenceService } from "./cleanup-evidence";
import {
  type DerivedJudgmentService,
  DerivedJudgmentRefusedError,
} from "./derived-judgments";
import {
  DerivedJudgmentNotFoundError,
  DerivedJudgmentRecallUnavailableError,
  DerivedJudgmentReviewRefusedError,
  type DerivedJudgmentReviewService,
} from "./judgment-review";
import type { RestoreRecoveryService } from "./restore-recovery";
import type { RevocationService } from "./revocation";
import { MemorySensitivityRefusedError } from "./sensitivity-gate";

const log = getLogger("server");

/** A body the route could not use; the seam's own refusals keep their own vocabulary. */
export class HindsightRouteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HindsightRouteRefusedError";
  }
}

/** The seams these routes front; each is narrowed to the methods the family actually calls. */
export type HindsightRouteServices = {
  /** Trusted identity: the only thing that turns a request into a server-issued scope. */
  scopes: ScopeResolver;
  evidence: Pick<AnswerEvidenceService, "inspectEvidence">;
  judgments: Pick<
    DerivedJudgmentService,
    "proposeDerivedJudgmentCandidate" | "listDerivedJudgmentCandidates"
  >;
  review: Pick<
    DerivedJudgmentReviewService,
    | "confirmDerivedJudgment"
    | "editDerivedJudgment"
    | "rejectDerivedJudgment"
    | "forgetDerivedJudgment"
  >;
  revocations: Pick<RevocationService, "revokeAuthorizationTarget">;
  cleanup: Pick<
    CleanupEvidenceService,
    | "cleanupEvidenceStatus"
    | "verifyActiveDataCleanup"
    | "recordControlledBackup"
    | "noteControlledBackupPurged"
  >;
  recovery: Pick<
    RestoreRecoveryService,
    "noteBackupRestored" | "gateStatus" | "replayBackupRestore"
  >;
  /**
   * Where a sensitivity refusal lands in the audit trail: the refused class and the
   * judgment's id, never the content — the same F-G1-4 trail the /api/memory face writes.
   * Absent on a deployment that wires no audit sink; the refusal is still the answer.
   */
  audit?: AuditSink;
  /**
   * The DECLARED operation-retention window, read per request so a redeclared deployment is
   * honored by the next status read. `null` means undeclared: the payload leg reports itself
   * unevidenced rather than measuring against a number nobody declared.
   */
  operationRetentionDays: () => number | null;
  /**
   * Reconcile the backup script's manifests into the cleanup-evidence registry. Null when the
   * deployment declared no manifest directory — the registry then reports what it holds, and
   * the backup leg stays unevidenced until copies are registered by some other means.
   */
  reconcileBackups: (() => Promise<BackupRegistrationReport>) | null;
};

type RouteContext = Context<{ Variables: AppVariables }>;

/** Read a JSON object body; every misuse names what the route needed. */
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new HindsightRouteRefusedError(
      "Supply JSON settings for this operation.",
    );
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HindsightRouteRefusedError(
      "These settings could not be read as JSON.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new HindsightRouteRefusedError("Supply a JSON object.");
  return parsed as Record<string, unknown>;
}

/** The revocation target, shape-checked: a kind and one id, never a bank or principal. */
function revocationTarget(input: Record<string, unknown>): {
  kind: "source" | "bot";
  targetId: string;
} {
  if (input.kind !== "source" && input.kind !== "bot")
    throw new HindsightRouteRefusedError(
      "Say whether the authorization being revoked is a source or a Bot.",
    );
  const targetId = input.targetId;
  if (
    typeof targetId !== "string" ||
    targetId.trim().length === 0 ||
    targetId.length > 256
  )
    throw new HindsightRouteRefusedError(
      "Name the source or Bot whose memory authorization is being revoked.",
    );
  return { kind: input.kind, targetId };
}

/** The restore note, shape-checked; an unreadable instant is refused, never silently replaced. */
function restoreNote(input: Record<string, unknown>): {
  restoreKey: string;
  restoredAt?: Date;
} {
  const restoreKey = input.restoreKey;
  if (
    typeof restoreKey !== "string" ||
    restoreKey.trim().length === 0 ||
    restoreKey.length > 256
  )
    throw new HindsightRouteRefusedError(
      "A restored backup needs a key naming which restore this is.",
    );
  if (input.restoredAt === undefined) return { restoreKey };
  if (typeof input.restoredAt !== "string")
    throw new HindsightRouteRefusedError(
      "The restore time must be an ISO 8601 instant when it is supplied.",
    );
  const restoredAt = new Date(input.restoredAt);
  if (Number.isNaN(restoredAt.getTime()))
    throw new HindsightRouteRefusedError(
      "The restore time must be an ISO 8601 instant when it is supplied.",
    );
  return { restoreKey, restoredAt };
}

export function createHindsightRoutes(
  deps: HindsightRouteServices & {
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  },
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser, bodyLimit({ maxSize: 65_536 }));
  routes.onError((error, context) => {
    if (
      error instanceof EvidenceRefusedError ||
      error instanceof DerivedJudgmentRefusedError ||
      error instanceof HindsightRouteRefusedError ||
      error instanceof MemorySensitivityRefusedError
    )
      return context.json({ error: error.message }, 400);
    if (
      error instanceof EvidenceNotFoundError ||
      error instanceof DerivedJudgmentNotFoundError
    )
      return context.json({ error: error.message }, 404);
    if (error instanceof DerivedJudgmentReviewRefusedError)
      return context.json({ error: error.message }, 409);
    if (error instanceof DerivedJudgmentRecallUnavailableError)
      return context.json({ error: error.message }, 503);
    // The scope resolver's own vocabulary: an unauthenticated caller, a caller who is not a
    // member of the selected company/workspace, or an unverified scope never reaches a seam.
    const message = error instanceof Error ? error.message : "";
    if (message === "AUTH_REQUIRED")
      return context.json({ error: "Authentication required." }, 401);
    if (message === "TENANT_REQUIRED" || message === "WORKSPACE_REQUIRED")
      return context.json(
        { error: "Select the company and workspace first." },
        400,
      );
    if (
      message === "TENANT_FORBIDDEN" ||
      message === "WORKSPACE_FORBIDDEN" ||
      message === "UNVERIFIED_SCOPE"
    )
      return context.json(
        { error: "Personal memory is not available here." },
        403,
      );
    if (message === "DATA_DATABASE_UNAVAILABLE")
      return context.json(
        { error: "Personal memory is unavailable. Try again." },
        503,
      );
    log.error(
      {
        type: "hindsight-route-error",
        error: error instanceof Error ? error.name : "unknown",
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      },
      "hindsight-route-error",
    );
    return context.json(
      { error: "Personal memory is unavailable. Try again." },
      503,
    );
  });

  const scopeFor = (context: RouteContext): Promise<PlatformScope> =>
    deps.scopes.resolve(context.req.raw);

  /*
   * A sensitivity refusal on this face leaves the same F-G1-4 trail the /api/memory face
   * writes: the refused class and the judgment's id — never the content. A trail that
   * cannot be written is logged and swallowed; the refusal is already the answer.
   */
  async function recorded<T>(
    scope: PlatformScope,
    judgmentId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof MemorySensitivityRefusedError && deps.audit) {
        await deps.audit
          .record({
            eventType: "memory.sensitivity_refused",
            targetType: "memory",
            targetId: judgmentId,
            actorUserId: scope.actorId,
            payload: {
              subjectType: "derived_judgment",
              sensitivity: error.sensitivity,
            },
          })
          .catch((auditError) => {
            // The refusal is the answer; a trail that cannot be written changes nothing.
            log.error(
              {
                type: "hindsight-route-audit-error",
                error:
                  auditError instanceof Error
                    ? auditError.name
                    : "UnknownError",
                context: { route: "judgment" },
                timestamp: new Date().toISOString(),
              },
              "hindsight-route-audit-error",
            );
          });
      }
      throw error;
    }
  }

  /**
   * The confirm's one optional field: the person's explicit second confirmation for
   * sensitive material (F-G1-4). A confirm carries no body unless that second look is
   * being given, so a request without one reads as the seam's own default — no second
   * confirmation — and a request with one must be the module's usual JSON object.
   */
  async function confirmationInput(
    request: Request,
  ): Promise<{ confirmSensitive?: unknown }> {
    if (!request.headers.get("content-type")?.includes("application/json"))
      return {};
    const input = await body(request);
    return { confirmSensitive: input.confirmSensitive };
  }

  /*
   * Evidence: the ids an answer cited, expanded into what the person is entitled to see NOW.
   * Anything missing, foreign, unreviewed, forgotten or no longer authorized answers
   * `{ state: "unavailable" }` with no content — the seam's own vocabulary, forwarded as-is.
   */
  routes.post("/evidence", async (context) => {
    const scope = await scopeFor(context);
    const input = await body(context.req.raw);
    return context.json({
      evidence: await deps.evidence.inspectEvidence(scope, { ids: input.ids }),
    });
  });

  /* The review surface's data source: open candidates, newest first, complete basis each. */
  routes.get("/judgments/candidates", async (context) => {
    const scope = await scopeFor(context);
    const raw = context.req.query("limit");
    const limit = raw === undefined ? undefined : Number(raw);
    return context.json({
      candidates: await deps.judgments.listDerivedJudgmentCandidates(
        scope,
        limit === undefined ? {} : { limit },
      ),
    });
  });

  /*
   * A lead becomes a candidate: the judgment text plus the document ids of its evidence. All
   * four gates run before anything is stored; nothing is sent to Hindsight here.
   */
  routes.post("/judgments/candidates", async (context) => {
    const scope = await scopeFor(context);
    const input = await body(context.req.raw);
    return context.json(
      {
        candidate: await deps.judgments.proposeDerivedJudgmentCandidate(scope, {
          judgment: input.judgment,
          provenance: input.provenance,
          evidence: input.evidence,
        }),
      },
      201,
    );
  });

  routes.post("/judgments/:id/confirm", async (context) => {
    const scope = await scopeFor(context);
    const id = context.req.param("id");
    const input = await confirmationInput(context.req.raw);
    return context.json(
      await recorded(scope, id, () =>
        deps.review.confirmDerivedJudgment(scope, id, input),
      ),
    );
  });

  /* Editing touches the text alone: the evidence relation and scope never move through it. */
  routes.patch("/judgments/:id", async (context) => {
    const scope = await scopeFor(context);
    const input = await body(context.req.raw);
    const id = context.req.param("id");
    return context.json(
      await recorded(scope, id, () =>
        deps.review.editDerivedJudgment(scope, id, {
          content: input.content,
          confirmSensitive: input.confirmSensitive,
        }),
      ),
    );
  });

  routes.post("/judgments/:id/reject", async (context) =>
    context.json({
      judgment: await deps.review.rejectDerivedJudgment(
        await scopeFor(context),
        context.req.param("id"),
      ),
    }),
  );

  /*
   * Forgetting a judgment: the durable block first (tombstone + revocation ledger), the remote
   * delete second, and the answer that never claims copies are cleared.
   */
  routes.delete("/judgments/:id", async (context) =>
    context.json(
      await deps.review.forgetDerivedJudgment(
        await scopeFor(context),
        context.req.param("id"),
      ),
    ),
  );

  /* Source/Bot revocation: one durable block over everything that authorization fed. */
  routes.post("/revocations", async (context) => {
    const scope = await scopeFor(context);
    const target = revocationTarget(await body(context.req.raw));
    return context.json(
      await deps.revocations.revokeAuthorizationTarget(scope, target),
    );
  });

  /*
   * The person's own cleanup progress: the three legs (active data, finished payloads,
   * controlled backups) with what was actually observed, and the completion claim only when
   * all three hold. A reconcile of the backup manifests runs first when the deployment
   * declared their directory, so the backup leg reads what the backup job actually wrote; a
   * reconciliation failure is logged and the leg still answers from the registry it holds.
   */
  routes.get("/cleanup", async (context) => {
    const scope = await scopeFor(context);
    const identity = resolveHindsightBankScope(scope);
    let backupRegistration: BackupRegistrationReport | null = null;
    if (deps.reconcileBackups) {
      try {
        backupRegistration = await deps.reconcileBackups();
      } catch (error) {
        log.warn(
          {
            type: "hindsight-backup-registration-failed",
            error: error instanceof Error ? error.name : "unknown",
            timestamp: new Date().toISOString(),
          },
          "hindsight-backup-registration-failed",
        );
      }
    }
    const status = await deps.cleanup.cleanupEvidenceStatus({
      tenantId: identity.tenantId,
      principalId: identity.principalId,
      operationRetentionDays: deps.operationRetentionDays(),
    });
    return context.json({ ...status, backupRegistration });
  });

  /* Re-probe the person's own confirmed deletions and record what each probe found. */
  routes.post("/cleanup/verify", async (context) => {
    const scope = await scopeFor(context);
    const identity = resolveHindsightBankScope(scope);
    return context.json({
      outcomes: await deps.cleanup.verifyActiveDataCleanup({
        tenantId: identity.tenantId,
        principalId: identity.principalId,
      }),
    });
  });

  /*
   * Operator surfaces: platform-side, admin-gated, counts and instants only. The restore note
   * is the "a backup was restored" fact that closes recall until replay; the status shows how
   * many gates are open; the replay re-applies local blocks, re-issues remote deletions and
   * only then re-opens recall.
   */
  routes.post("/ops/restores", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json(
      await deps.recovery.noteBackupRestored(
        restoreNote(await body(context.req.raw)),
      ),
      201,
    );
  });

  routes.get("/ops/restores", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json(await deps.recovery.gateStatus());
  });

  routes.post("/ops/restores/replay", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json(await deps.recovery.replayBackupRestore());
  });

  /* Register what the backup job wrote: the manifests reconciled into the cleanup-evidence leg. */
  routes.post("/ops/backups/reconcile", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    if (!deps.reconcileBackups)
      return context.json(
        {
          error:
            "This deployment declares no controlled-backup manifest directory, so there is nothing to reconcile.",
        },
        503,
      );
    return context.json(await deps.reconcileBackups());
  });

  return routes;
}
