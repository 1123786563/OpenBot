/**
 * Hindsight memory operations (#384/#385, audit G3-F2): the person-scoped write and status
 * surface the chain's confirm/edit/forget seams were missing in production.
 *
 * The seams themselves own every business rule — identity resolves through
 * `resolveHindsightBankScope` inside the services, a confirm writes its authority row before
 * anything leaves, a forget tombstones and writes the revocation ledger before its best-effort
 * remote delete, and the sync queue re-verifies ownership and authorization at task time.
 * This module is only the HTTP face of that: it resolves ONE trusted scope per request, keeps
 * the input shapes honest, and reports the seams' answers. Its two obligations of its own:
 *
 *   - The scope is the only identity. Tenant, principal and workspace come from the resolver
 *     (production: the enterprise scope resolver over issued facts); a body, query or header
 *     on these routes cannot name one. The status read additionally pins the subject's
 *     principal, so another person's subject answers `unknown-subject` — the same answer a
 *     missing subject gives.
 *   - A sensitivity refusal (audit F-G1-4) leaves a trail: the refused class and the subject
 *     type, never the content. A trail that cannot be written is logged and swallowed — the
 *     refusal is already the answer, and failing the write must not change it.
 *
 * Mounted inside the `/api/memory` route family (`memory/routes.ts` hands it the `/hindsight`
 * sub-path behind the family's `requireUser` + body limit), so the person's memories are one
 * surface regardless of which store answers. Absent from the family when the deployment has
 * no Hindsight chain wired, and then none of these routes exists.
 */

import { Hono } from "hono";
import { getLogger } from "../../../shared/logger";
import type { AuditSink } from "../audit";
import type { PlatformScope } from "../enterprise/contracts";
import {
  PreferenceNotFoundError,
  type PreferenceRecallService,
  PreferenceRefusedError,
} from "./preference-recall";
import {
  SourceBoundNotFoundError,
  type SourceBoundRecallService,
  SourceBoundRefusedError,
} from "./scoped-recall";
import { MemorySensitivityRefusedError } from "./sensitivity-gate";
import type { HindsightSyncQueue, SyncSubjectType } from "./sync-queue";

const log = getLogger("server");

/** What the operations surface needs: the chain services, a scope resolver and the trail. */
export type HindsightMemoryRoutesDeps = {
  preferences: PreferenceRecallService;
  sourceBound: SourceBoundRecallService;
  syncQueue: HindsightSyncQueue;
  /**
   * ONE trusted scope per request. Production passes the enterprise resolver, so the identity
   * these routes act for is an issued fact, never a wire field.
   */
  resolveScope: (request: Request) => Promise<PlatformScope>;
  /** Where a sensitivity refusal lands in the audit trail: the class, never the content. */
  audit?: AuditSink;
};

const SUBJECT_TYPES: readonly SyncSubjectType[] = [
  "preference",
  "source_bound",
  "derived_judgment",
];

/** A malformed request on this surface; the one refusal this module raises itself. */
class RequestRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestRefused";
  }
}

export function createHindsightMemoryRoutes(deps: HindsightMemoryRoutesDeps) {
  const routes = new Hono();
  routes.onError((error, context) => {
    if (error instanceof RequestRefused)
      return context.json({ error: error.message }, 400);
    if (
      error instanceof PreferenceNotFoundError ||
      error instanceof SourceBoundNotFoundError
    )
      return context.json({ error: error.message }, 404);
    if (
      error instanceof MemorySensitivityRefusedError ||
      error instanceof PreferenceRefusedError ||
      error instanceof SourceBoundRefusedError
    )
      return context.json({ error: error.message }, 400);
    // Scope-resolution refusals arrive as the tenancy layer's own codes.
    const message = error instanceof Error ? error.message : "";
    if (message === "AUTH_REQUIRED")
      return context.json({ error: "Authentication required." }, 401);
    // FIX-OCR3 (O3-M6): an unresolved company/workspace selection is the caller's state, not
    // a server fault — the same 400 the host memory family and the ops face map it to, so
    // this surface stops answering "unavailable, try again" to a request that cannot succeed.
    if (message === "TENANT_REQUIRED" || message === "WORKSPACE_REQUIRED")
      return context.json(
        { error: "Select the company and workspace first." },
        400,
      );
    if (
      [
        "SCOPE_REVOKED",
        "TENANT_FORBIDDEN",
        "WORKSPACE_FORBIDDEN",
        "UNVERIFIED_SCOPE",
      ].includes(message)
    )
      return context.json({ error: "Access denied." }, 403);
    log.error(
      {
        type: "hindsight-memory-route-error",
        error: error instanceof Error ? error.name : "UnknownError",
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      },
      "hindsight-memory-route-error",
    );
    return context.json({ error: "Memory is unavailable. Try again." }, 503);
  });

  /**
   * Run one seam call and leave the audit trail a sensitivity refusal deserves. The payload
   * names the class and the subject type — the content never reaches the trail, so a refused
   * credential is not written anywhere, not even as evidence of its own refusal.
   */
  async function recorded<T>(
    scope: PlatformScope,
    subjectType: SyncSubjectType,
    targetId: string | undefined,
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
            ...(targetId ? { targetId } : {}),
            actorUserId: scope.actorId,
            payload: { subjectType, sensitivity: error.sensitivity },
          })
          .catch((auditError) => {
            // The refusal is the answer; a trail that cannot be written changes nothing.
            log.error(
              {
                type: "hindsight-memory-audit-error",
                error:
                  auditError instanceof Error
                    ? auditError.name
                    : "UnknownError",
                context: { route: subjectType },
                timestamp: new Date().toISOString(),
              },
              "hindsight-memory-audit-error",
            );
          });
      }
      throw error;
    }
  }

  routes.post("/preferences", async (context) => {
    const scope = await deps.resolveScope(context.req.raw);
    const input = await body<{
      content: unknown;
      provenance?: unknown;
      confirmSensitive?: unknown;
    }>(context.req.raw);
    const outcome = await recorded(scope, "preference", undefined, () =>
      deps.preferences.confirmGenericPreference(scope, input),
    );
    return context.json(
      { preference: outcome.record, remoteSynced: outcome.remoteSynced },
      201,
    );
  });
  routes.patch("/preferences/:id", async (context) => {
    const scope = await deps.resolveScope(context.req.raw);
    const input = await body<{
      content: unknown;
      confirmSensitive?: unknown;
    }>(context.req.raw);
    const id = context.req.param("id");
    const outcome = await recorded(scope, "preference", id, () =>
      deps.preferences.editGenericPreference(scope, id, input),
    );
    return context.json({
      preference: outcome.record,
      remoteSynced: outcome.remoteSynced,
    });
  });
  routes.delete("/preferences/:id", async (context) => {
    const scope = await deps.resolveScope(context.req.raw);
    const revocation = await deps.preferences.forgetGenericPreference(
      scope,
      context.req.param("id"),
    );
    return context.json(revocation);
  });
  routes.post("/source-bound", async (context) => {
    const scope = await deps.resolveScope(context.req.raw);
    const input = await body<{
      content: unknown;
      provenance?: unknown;
      restriction: unknown;
      confirmSensitive?: unknown;
    }>(context.req.raw);
    const outcome = await recorded(scope, "source_bound", undefined, () =>
      deps.sourceBound.confirmSourceBoundMemory(scope, input),
    );
    return context.json(
      { memory: outcome.record, remoteSynced: outcome.remoteSynced },
      201,
    );
  });
  routes.patch("/source-bound/:id", async (context) => {
    const scope = await deps.resolveScope(context.req.raw);
    const input = await body<{
      content: unknown;
      confirmSensitive?: unknown;
    }>(context.req.raw);
    const id = context.req.param("id");
    const outcome = await recorded(scope, "source_bound", id, () =>
      deps.sourceBound.editSourceBoundMemory(scope, id, input),
    );
    return context.json({
      memory: outcome.record,
      remoteSynced: outcome.remoteSynced,
    });
  });
  routes.delete("/source-bound/:id", async (context) => {
    const scope = await deps.resolveScope(context.req.raw);
    const revocation = await deps.sourceBound.forgetSourceBoundMemory(
      scope,
      context.req.param("id"),
    );
    return context.json(revocation);
  });
  /**
   * The person's own sync status for one subject. "indexed" is only ever answered when the
   * row's retained digest equals its current content; pending and failed are answered as
   * exactly that, so the surface can never present an unsynced memory as indexed.
   */
  routes.get("/status/:subjectType/:subjectId", async (context) => {
    const scope = await deps.resolveScope(context.req.raw);
    const subjectType = context.req.param("subjectType");
    if (!SUBJECT_TYPES.includes(subjectType as SyncSubjectType))
      throw new RequestRefused(
        "A sync status names a subject type of preference, source_bound or derived_judgment.",
      );
    const status = await deps.syncQueue.syncStatus(
      scope.tenantId,
      subjectType as SyncSubjectType,
      context.req.param("subjectId"),
      scope.principalId,
    );
    return context.json({ status });
  });
  /**
   * The same statuses for a list of subjects, keyed `${subjectType}:${subjectId}`
   * (FIX-OCR1 / #376): the settings page's memory rows each carry a sync badge, and a
   * per-row read made the page one request per memory. One batched read answers the whole
   * list from the same per-subject facts and the same self-scoping — another person's
   * subject answers `unknown-subject` beside a missing one, never told apart. Bounded,
   * because a badge list is a page, not an export.
   */
  routes.post("/status/batch", async (context) => {
    const scope = await deps.resolveScope(context.req.raw);
    const input = await body<{ subjects?: unknown }>(context.req.raw);
    if (
      !Array.isArray(input.subjects) ||
      input.subjects.length === 0 ||
      input.subjects.length > 200
    )
      throw new RequestRefused(
        "A batched sync status read names 1..200 subjects.",
      );
    const subjects = input.subjects.map((subject) => {
      const { subjectType, subjectId } = (subject ?? {}) as {
        subjectType?: unknown;
        subjectId?: unknown;
      };
      if (
        typeof subjectType !== "string" ||
        !SUBJECT_TYPES.includes(subjectType as SyncSubjectType) ||
        typeof subjectId !== "string" ||
        subjectId === ""
      )
        throw new RequestRefused(
          "A sync status names a subject type of preference, source_bound or derived_judgment.",
        );
      return {
        subjectType: subjectType as SyncSubjectType,
        subjectId,
      };
    });
    // The subjects are independent read-only queries (capped at 200 above), so they are
    // issued together: a badge refresh costs the slowest read, not the sum of all of them.
    // A rejection still reaches the module's onError as one failed read did before.
    const answers = await Promise.all(
      subjects.map((subject) =>
        deps.syncQueue.syncStatus(
          scope.tenantId,
          subject.subjectType,
          subject.subjectId,
          scope.principalId,
        ),
      ),
    );
    const statuses: Record<string, unknown> = {};
    subjects.forEach((subject, index) => {
      statuses[`${subject.subjectType}:${subject.subjectId}`] = answers[index];
    });
    return context.json({ statuses });
  });
  return routes;
}

/**
 * Read the request body as one JSON object. The seam it reaches validates every field
 * (plainString, parseRestriction), so this is shape only: an object with the fields the
 * caller sent, typed at the call site for what the seam takes.
 */
async function body<T extends object>(request: Request): Promise<T> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new RequestRefused("Supply JSON memory settings.");
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new RequestRefused("The memory settings could not be read.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new RequestRefused("The memory settings could not be read.");
  return value as T;
}

export type HindsightMemoryRoutes = ReturnType<
  typeof createHindsightMemoryRoutes
>;
