import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import type { DataDatabase } from "../tenancy/connections";
import { assertTrustedScope } from "../tenancy/store";

export interface ConversationStore {
  transaction<T>(
    scope: PlatformScope,
    operation: (
      tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
    ) => Promise<T>,
  ): Promise<T>;
}

export function createConversationStore(data: DataDatabase): ConversationStore {
  return {
    async transaction(scope, operation) {
      assertTrustedScope(scope);
      return data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
        );
        for (const key of [
          JSON.stringify(["enterprise", "tenant", scope.tenantId]),
          JSON.stringify(["enterprise", "principal", scope.principalId]),
          JSON.stringify([
            "enterprise",
            "membership",
            scope.tenantId,
            scope.principalId,
          ]),
        ]) {
          await tx.execute(
            sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
          );
        }
        const [membership] = await tx
          .select({
            memberStatus: enterpriseMemberships.status,
            memberEpoch: enterpriseMemberships.epoch,
            principalStatus: enterprisePrincipals.status,
            tenantStatus: enterpriseTenants.status,
            workspaceId: enterpriseWorkspaces.id,
          })
          .from(enterpriseMemberships)
          .innerJoin(
            enterprisePrincipals,
            eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
          )
          .innerJoin(
            enterpriseTenants,
            eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
          )
          .innerJoin(
            enterpriseWorkspaces,
            and(
              eq(enterpriseWorkspaces.tenantId, enterpriseMemberships.tenantId),
              eq(enterpriseWorkspaces.id, scope.workspaceId),
            ),
          )
          .where(
            and(
              eq(enterpriseMemberships.tenantId, scope.tenantId),
              eq(enterpriseMemberships.principalId, scope.principalId),
              eq(enterprisePrincipals.userId, scope.actorId),
            ),
          )
          .limit(1);
        if (
          membership?.memberStatus !== "active" ||
          membership?.principalStatus !== "active" ||
          membership?.tenantStatus !== "active" ||
          membership?.memberEpoch !== scope.memberEpoch
        ) {
          throw new Error("SCOPE_REVOKED");
        }
        return operation(tx);
      });
    },
  };
}

export function messageDigest(
  content: string,
  attachments: readonly string[],
): { content: string; digest: string } {
  const normalized = content.normalize("NFC").replace(/\r\n?/g, "\n");
  const digest = createHash("sha256")
    .update(JSON.stringify({ content: normalized, attachments }))
    .digest("hex");
  return { content: normalized, digest };
}

export function newThreadId(): string {
  return randomUUID();
}

export function conversationDto(row: {
  id: string;
  threadId: string;
  title: string | null;
  storageBackend: "platform" | "intelligence";
  createdAt: Date;
  updatedAt: Date;
  lastSeq: number;
}) {
  return {
    conversation_id: row.id,
    thread_id: row.threadId,
    title: row.title,
    storage_backend: row.storageBackend,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    last_message_seq: row.lastSeq,
  } as const;
}
