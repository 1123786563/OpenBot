import {
  and,
  count,
  desc,
  eq,
  exists,
  gt,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { botSeat, seatText } from "../computer/computer-key";
import type { Database } from "../db/client";
import {
  agentProfiles,
  attachments,
  channels,
  computerSnapshot,
  personalSupportAccesses,
  personalSupportRequests,
  personalWorkspaceDefaultBots,
  personalWorkspaces,
  routineRuns,
  routines,
} from "../db/schema";
import { personalConversationScope, type Transaction } from "./store";
import type { SupportResource } from "./support-contract";

type RequestRow = typeof personalSupportRequests.$inferSelect;
type ReadDatabase = Pick<Database, "select">;

async function supportResourceContent(
  database: ReadDatabase,
  workspaceId: string,
  resource: SupportResource,
) {
  const workspace = eq(personalWorkspaces.id, workspaceId);
  switch (resource.kind) {
    case "conversation": {
      const [conversation] = await personalConversationScope(
        database,
        and(workspace, eq(channels.id, resource.id)),
      );
      return conversation;
    }
    case "file": {
      const [file] = await database
        .select({
          name: attachments.name,
          bytes: attachments.bytes,
          mimeType: attachments.mimeType,
        })
        .from(attachments)
        .where(
          and(
            eq(attachments.id, resource.id),
            isNotNull(attachments.attachedAt),
            exists(
              personalConversationScope(
                database,
                and(workspace, eq(channels.id, attachments.channelId)),
              ),
            ),
          ),
        );
      if (file)
        return {
          name: file.name,
          mimeType: file.mimeType,
          base64: file.bytes.toString("base64"),
        };
      return;
    }
    case "computer-session": {
      const binding = personalWorkspaceDefaultBots;
      const [bot] = await database
        .select({ id: binding.agentId })
        .from(binding)
        .innerJoin(agentProfiles, eq(agentProfiles.agentId, binding.agentId))
        .where(
          and(
            eq(binding.workspaceId, workspaceId),
            isNull(agentProfiles.deletedAt),
          ),
        );
      if (!bot) return;
      const [snapshot] = await database
        .select({
          session: computerSnapshot.session,
          url: computerSnapshot.url,
          elements: computerSnapshot.elements,
          takenAt: computerSnapshot.takenAt,
        })
        .from(computerSnapshot)
        .where(
          and(
            eq(computerSnapshot.computerId, seatText(botSeat(bot.id))),
            eq(computerSnapshot.session, resource.id),
          ),
        );
      return snapshot;
    }
  }
}

export function supportAccess(database: Database | Transaction) {
  const requests = personalSupportRequests;
  const accesses = personalSupportAccesses;
  const unexpired = gt(requests.expiresAt, sql`clock_timestamp()`);

  function ownerScope(workspaceId: string, accountId: string) {
    return database
      .select({ id: personalWorkspaces.id })
      .from(personalWorkspaces)
      .where(
        and(
          eq(personalWorkspaces.id, workspaceId),
          eq(personalWorkspaces.ownerId, accountId),
        ),
      );
  }

  return {
    async metadata(workspaceId: string) {
      const [workspace] = await database
        .select({
          botId: personalWorkspaceDefaultBots.agentId,
        })
        .from(personalWorkspaces)
        .leftJoin(
          personalWorkspaceDefaultBots,
          eq(personalWorkspaceDefaultBots.workspaceId, personalWorkspaces.id),
        )
        .where(eq(personalWorkspaces.id, workspaceId));
      if (!workspace) return;
      const runs = database
        .select({ status: routineRuns.status, count: count() })
        .from(routineRuns)
        .innerJoin(routines, eq(routines.id, routineRuns.routineId))
        .where(eq(routines.agentId, workspace.botId ?? ""))
        .groupBy(routineRuns.status);
      const failures = database
        .select({ id: routineRuns.id })
        .from(routineRuns)
        .innerJoin(routines, eq(routines.id, routineRuns.routineId))
        .where(
          and(
            eq(routines.agentId, workspace.botId ?? ""),
            eq(routineRuns.status, "failed"),
          ),
        )
        .orderBy(desc(routineRuns.startedAt), desc(routineRuns.id))
        .limit(20);
      const [usage, errors] = await Promise.all([runs, failures]);
      return {
        status: workspace.botId ? "ready" : "preparing",
        usage: { routineRuns: usage },
        errorIds: errors.map(({ id }) => id),
      };
    },

    async request(
      input: Pick<
        RequestRow,
        | "workspaceId"
        | "ticketId"
        | "operatorId"
        | "actorSubject"
        | "resources"
        | "reason"
        | "durationSeconds"
      >,
    ) {
      const [workspace] = await database
        .select({ id: personalWorkspaces.id })
        .from(personalWorkspaces)
        .where(eq(personalWorkspaces.id, input.workspaceId));
      if (!workspace) return;
      const [request] = await database
        .insert(requests)
        .values(input)
        .returning({ id: requests.id });
      return request;
    },

    async history(workspaceId: string, accountId: string) {
      if (!(await ownerScope(workspaceId, accountId)).length) return;
      const [visibleRequests, visibleAccesses] = await Promise.all([
        database
          .select()
          .from(requests)
          .where(eq(requests.workspaceId, workspaceId))
          .orderBy(desc(requests.requestedAt), desc(requests.id)),
        database
          .select({ access: accesses })
          .from(accesses)
          .innerJoin(requests, eq(accesses.requestId, requests.id))
          .where(eq(requests.workspaceId, workspaceId))
          .orderBy(desc(accesses.accessedAt), desc(accesses.id)),
      ]);
      return {
        requests: visibleRequests,
        accesses: visibleAccesses.map(({ access }) => access),
      };
    },

    async decide(input: {
      workspaceId: string;
      accountId: string;
      id: string;
      action: "approve" | "revoke";
    }) {
      const approving = input.action === "approve";
      const [updated] = await database
        .update(requests)
        .set(
          approving
            ? {
                approvedAt: sql`statement_timestamp()`,
                expiresAt: sql`statement_timestamp() + ${requests.durationSeconds} * interval '1 second'`,
              }
            : { revokedAt: sql`clock_timestamp()` },
        )
        .where(
          and(
            eq(requests.id, input.id),
            eq(requests.workspaceId, input.workspaceId),
            exists(ownerScope(input.workspaceId, input.accountId)),
            isNull(requests.revokedAt),
            approving ? isNull(requests.approvedAt) : unexpired,
          ),
        )
        .returning({ id: requests.id });
      return updated;
    },

    async read(
      input: Pick<
        RequestRow,
        "id" | "workspaceId" | "ticketId" | "operatorId" | "actorSubject"
      > & {
        resource: SupportResource;
        reason: string;
      },
    ) {
      return database.transaction(async (tx) => {
        // The grant lock orders a successful read and its audit entry against owner revocation.
        const [request] = await tx
          .select({ resources: requests.resources })
          .from(requests)
          .where(
            and(
              eq(requests.id, input.id),
              eq(requests.workspaceId, input.workspaceId),
              eq(requests.ticketId, input.ticketId),
              eq(requests.operatorId, input.operatorId),
              eq(requests.actorSubject, input.actorSubject),
              isNull(requests.revokedAt),
              unexpired,
            ),
          )
          .for("update");
        if (
          !request?.resources.some(
            ({ kind, id }) =>
              kind === input.resource.kind && id === input.resource.id,
          )
        )
          return;
        const content = await supportResourceContent(
          tx,
          input.workspaceId,
          input.resource,
        );
        if (!content) return;
        const [live] = await tx
          .select({ id: requests.id })
          .from(requests)
          .where(and(eq(requests.id, input.id), unexpired));
        if (!live) return;
        await tx.insert(accesses).values({
          requestId: input.id,
          actorSubject: input.actorSubject,
          reason: input.reason,
          resource: input.resource,
          accessedAt: sql`clock_timestamp()`,
        });
        return content;
      });
    },
  };
}
