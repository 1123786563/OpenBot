import { createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client";
import {
  personalSaasAccounts,
  personalSaasSessions,
  personalSupportRequests,
  personalWorkspaceIntegrationGrants,
  personalWorkspaceSuspensions,
  personalWorkspaces,
} from "../db/schema/personal-saas";

export type SuspensionOperator = { id: string; token: string };

const operation = z.strictObject({
  action: z.enum(["pause", "resume"]),
  reason: z.string().trim().min(1).max(1_000),
  displayReason: z.string().trim().min(1).max(1_000).optional(),
});

export async function latestSuspension(
  database: Pick<Database, "select">,
  accountId: string,
) {
  const [event] = await database
    .select({
      id: personalWorkspaceSuspensions.id,
      action: personalWorkspaceSuspensions.action,
      displayReason: personalWorkspaceSuspensions.displayReason,
      effectiveAt: personalWorkspaceSuspensions.effectiveAt,
    })
    .from(personalWorkspaceSuspensions)
    .innerJoin(
      personalWorkspaces,
      eq(personalWorkspaceSuspensions.workspaceId, personalWorkspaces.id),
    )
    .where(eq(personalWorkspaces.ownerId, accountId))
    .orderBy(desc(personalWorkspaceSuspensions.sequence))
    .limit(1);
  return event;
}

export async function pausedWorkspace(
  database: Pick<Database, "select">,
  accountId: string,
  supportEmail: string | undefined,
) {
  const event = await latestSuspension(database, accountId);
  if (event?.action !== "pause") return;
  return {
    status: "paused" as const,
    operationId: event.id,
    reason: event.displayReason,
    supportEmail: supportEmail ?? null,
  };
}

export function suspensionRoutes(
  database: Database,
  operator: SuspensionOperator | undefined,
  now: () => number,
) {
  const routes = new Hono();
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = operator && digest(`Bearer ${operator.token}`);
  routes.post("/api/operator/workspaces/:id/suspension", async (context) => {
    const authorization = context.req.header("authorization") ?? "";
    if (
      !operator ||
      !expected ||
      !timingSafeEqual(expected, digest(authorization))
    )
      return context.json({ error: "suspension_permission_required" }, 403);

    const workspaceId = z.uuid().safeParse(context.req.param("id"));
    const input = operation.safeParse(
      await context.req.json<unknown>().catch(() => undefined),
    );
    if (!workspaceId.success || !input.success)
      return context.json({ error: "invalid_suspension_operation" }, 400);

    const result = await database.transaction(async (tx) => {
      const [workspace] = await tx
        .select({
          ownerId: personalWorkspaces.ownerId,
          status: personalSaasAccounts.status,
        })
        .from(personalWorkspaces)
        .innerJoin(
          personalSaasAccounts,
          eq(personalWorkspaces.ownerId, personalSaasAccounts.id),
        )
        .where(eq(personalWorkspaces.id, workspaceId.data))
        .for("update", { of: personalSaasAccounts });
      if (!workspace) return { kind: "missing" } as const;

      const current = await latestSuspension(tx, workspace.ownerId);
      const paused = current?.action === "pause";
      if (paused === (input.data.action === "pause"))
        return { kind: "unchanged" } as const;

      const effectiveAt = new Date(now());
      const [event] = await tx
        .insert(personalWorkspaceSuspensions)
        .values({
          ...input.data,
          workspaceId: workspaceId.data,
          operator: operator.id,
          effectiveAt,
        })
        .returning({ operationId: personalWorkspaceSuspensions.id });
      if (!event) throw new Error("Suspension operation was not recorded");

      if (input.data.action === "pause") {
        if (workspace.status) {
          // Write through the same JSON mapping as provider refresh. Concatenating JSON
          // in SQL can turn a driver-encoded JSON string into a JSON array.
          const epoch = workspace.status.epoch + 1;
          await tx
            .update(personalSaasAccounts)
            .set({
              status: {
                ...workspace.status,
                epoch,
                executionCutoffs: [
                  ...(workspace.status.executionCutoffs ?? []),
                  {
                    epoch,
                    reason: "workspace_paused",
                    cutoffAt: effectiveAt.getTime(),
                  },
                ],
              },
            })
            .where(eq(personalSaasAccounts.id, workspace.ownerId));
        }
        await tx
          .delete(personalSaasSessions)
          .where(eq(personalSaasSessions.accountId, workspace.ownerId));
        await tx
          .update(personalSupportRequests)
          .set({ revokedAt: effectiveAt })
          .where(
            and(
              eq(personalSupportRequests.workspaceId, workspaceId.data),
              isNotNull(personalSupportRequests.approvedAt),
              isNull(personalSupportRequests.revokedAt),
              sql`${personalSupportRequests.expiresAt} > clock_timestamp()`,
            ),
          );
        await tx
          .delete(personalWorkspaceIntegrationGrants)
          .where(
            eq(
              personalWorkspaceIntegrationGrants.workspaceId,
              workspaceId.data,
            ),
          );
      }
      return { kind: "recorded", ...event, effectiveAt } as const;
    });
    if (result.kind === "missing")
      return context.json({ error: "workspace_not_found" }, 404);
    if (result.kind === "unchanged")
      return context.json({ error: "suspension_state_unchanged" }, 409);
    return context.json(
      { operationId: result.operationId, effectiveAt: result.effectiveAt },
      201,
    );
  });
  return routes;
}
