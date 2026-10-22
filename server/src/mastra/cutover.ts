import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { attachments as attachmentsTable } from "../db/schema/core";
import { enterpriseConversations } from "../db/schema/enterprise-conversations";
import {
  enterpriseMemberships,
  enterprisePrincipals,
} from "../db/schema/enterprise-tenancy";
import { mastraMessageIntents } from "../db/schema/mastra-message-intents";
import type { MessageDTO, PlatformScope } from "../enterprise/contracts";
import type { DirectoryDatabase } from "../enterprise/tenancy/connections";
import { createScopeResolver } from "../enterprise/tenancy/store";
import type { MastraConversationBinding } from "./contracts";
import type {
  CutoverRunStore,
  ImportedTargetRow,
  IntelligenceThreadMessage,
  IntelligenceThreadSummary,
  LegacyImportSource,
  LegacyImportWriter,
  LegacyOwnershipPorts,
  LegacyTargetReader,
  OwnershipRow,
} from "./legacy-import";
import { LEGACY_IMPORT_KEY_PREFIX } from "./legacy-import";
import type { OpenBotMessagePart } from "./message-parts";
import type { TenantMastraStorage } from "./tenant-storage";

/*
 * ME13 (#485) cutover wiring: the read-only adapter over the REAL
 * Intelligence client, the production writer/target-reader wiring over
 * ConversationService, the persisted file run store, and the CLI arg
 * contract (fixed subcommands; apply only on an explicitly authorized
 * disposable fixture).
 *
 * Default is read-only everywhere: inspect/dry-run/verify construct no
 * writer at all, and `apply` refuses to run unless the invocation carries
 * `--authorize-fixture <id>` AND the environment pins the SAME id in
 * MASTRA_CUTOVER_FIXTURE_APPLY. The switch itself (making a staging target
 * the active writer) is ME14's fence and does not exist in this file.
 */

/**
 * The structural read surface this tool needs from the Intelligence client.
 * The production object is a `CopilotKitIntelligence`; typing it
 * structurally keeps this module free of the runtime dependency while the
 * adapter below still exposes EXACTLY the two read methods.
 */
export interface IntelligenceReadClient {
  listThreads(params: {
    userId: string;
    agentId: string;
    includeArchived?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<{
    threads: IntelligenceThreadSummary[];
    nextCursor?: string | null;
  }>;
  getThreadMessages(params: {
    threadId: string;
    userId: string;
  }): Promise<{ messages: IntelligenceThreadMessage[] }>;
}

/**
 * The read-only source adapter: the returned object has EXACTLY the two
 * read methods, so no caller of the import can reach a write method of the
 * underlying client through this seam.
 */
export function intelligenceSourceFrom(
  client: IntelligenceReadClient,
): LegacyImportSource {
  return {
    async listThreads(params) {
      const page = await client.listThreads({
        userId: params.userId,
        agentId: params.agentId,
        ...(params.includeArchived !== undefined
          ? { includeArchived: params.includeArchived }
          : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(params.cursor !== null && params.cursor !== undefined
          ? { cursor: params.cursor }
          : {}),
      });
      return { threads: page.threads, nextCursor: page.nextCursor ?? null };
    },
    async getThreadMessages(params) {
      return client.getThreadMessages({
        threadId: params.threadId,
        userId: params.userId,
      });
    },
  };
}

type EngineCapableConversationService = {
  append(
    scope: PlatformScope,
    input: {
      threadId: string;
      clientMessageKey: string;
      content: string;
      attachments: readonly string[];
    },
  ): Promise<MessageDTO>;
  appendEngineMessage(
    scope: PlatformScope,
    input: {
      threadId: string;
      clientMessageKey: string;
      role: "assistant" | "tool";
      parts: readonly OpenBotMessagePart[];
      engineMessageId: string;
      toolCallId?: string;
    },
  ): Promise<MessageDTO>;
};

/**
 * The production writer: every imported row lands through the SAME
 * ConversationService single-writer seams the live runner uses. There is no
 * third path and no direct SQL write anywhere in the import.
 */
export function conversationServiceWriter(
  service: EngineCapableConversationService,
): LegacyImportWriter {
  return {
    async appendImportedUser(input) {
      await service.append(input.scope, {
        threadId: input.threadId,
        clientMessageKey: input.clientMessageKey,
        content: input.content,
        attachments: input.attachments,
      });
    },
    async appendImportedEngine(input) {
      await service.appendEngineMessage(input.scope, {
        threadId: input.threadId,
        clientMessageKey: input.clientMessageKey,
        role: input.role,
        parts: input.parts,
        engineMessageId: input.engineMessageId,
        ...(input.toolCallId !== undefined
          ? { toolCallId: input.toolCallId }
          : {}),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// CLI contract
// ---------------------------------------------------------------------------

export interface CutoverArgs {
  command: "inspect" | "dry-run" | "apply" | "verify" | "rollback";
  runId?: string;
  stateDir?: string;
  user?: string;
  agent?: string;
  thread?: string;
  pageSize?: number;
  authorizeFixture?: string;
}

const USAGE = `Usage: mastra-agent-cutover.ts <inspect|dry-run|apply|verify|rollback> [options]

  --run-id <id>            run identity (default: generated)
  --state-dir <dir>        persisted run state directory (REQUIRED for apply/verify/rollback)
  --user <actorId>         source scan identity: the user whose threads to list
  --agent <agentId>        source scan identity: the agent whose threads to list
  --thread <threadId>      explicit single-thread mode (overrides the scan)
  --page-size <n>          listThreads page size
  --authorize-fixture <id> apply only; must equal MASTRA_CUTOVER_FIXTURE_APPLY in the environment

Read-only by default: inspect/dry-run write nothing on either side. apply
runs only on an explicitly authorized disposable fixture environment.`;

export type ParsedCutoverArgs =
  | { ok: true; args: CutoverArgs }
  | { ok: false; usage: string };

/** Fixed subcommands; unknown commands and unknown flags refuse to start. */
export function parseCutoverArgs(argv: readonly string[]): ParsedCutoverArgs {
  if (argv.length === 0) return { ok: false, usage: USAGE };
  const command = argv[0] as string;
  if (
    command !== "inspect" &&
    command !== "dry-run" &&
    command !== "apply" &&
    command !== "verify" &&
    command !== "rollback"
  ) {
    return { ok: false, usage: USAGE };
  }
  const args: CutoverArgs = { command };
  const flags = argv.slice(1);
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index] as string;
    const value = flags[index + 1] as string | undefined;
    const valueOrNull = (): string | null => {
      if (value === undefined || value.startsWith("--")) return null;
      index += 1;
      return value;
    };
    switch (flag) {
      case "--run-id":
      case "--state-dir":
      case "--user":
      case "--agent":
      case "--thread":
      case "--authorize-fixture": {
        const parsed = valueOrNull();
        if (parsed === null) return { ok: false, usage: USAGE };
        if (flag === "--run-id") args.runId = parsed;
        else if (flag === "--state-dir") args.stateDir = parsed;
        else if (flag === "--user") args.user = parsed;
        else if (flag === "--agent") args.agent = parsed;
        else if (flag === "--thread") args.thread = parsed;
        else args.authorizeFixture = parsed;
        break;
      }
      case "--page-size": {
        const parsed = valueOrNull();
        if (parsed === null) return { ok: false, usage: USAGE };
        const size = Number(parsed);
        if (!Number.isSafeInteger(size) || size < 1)
          return { ok: false, usage: USAGE };
        args.pageSize = size;
        break;
      }
      default:
        return { ok: false, usage: USAGE };
    }
  }
  return { ok: true, args };
}

/**
 * The apply authorization gate: explicit fixture authorization on BOTH the
 * command line and in the environment, plus a persisted-state directory.
 * Anything less refuses before any connection is opened.
 */
export function assertApplyAuthorized(
  args: CutoverArgs,
  env: Record<string, string | undefined>,
): void {
  if (args.command !== "apply") return;
  const reasons: string[] = [];
  if (!args.stateDir) reasons.push("--state-dir is required for apply");
  if (!args.authorizeFixture)
    reasons.push("--authorize-fixture <fixtureId> is required for apply");
  if (
    args.authorizeFixture !== undefined &&
    env.MASTRA_CUTOVER_FIXTURE_APPLY !== args.authorizeFixture
  ) {
    reasons.push(
      `the environment must pin the same fixture id: MASTRA_CUTOVER_FIXTURE_APPLY=${args.authorizeFixture}`,
    );
  }
  if (reasons.length > 0) {
    throw new Error(`APPLY_NOT_AUTHORIZED: ${reasons.join("; ")}`);
  }
}

/**
 * The persisted run state (cursor + per-thread progress). Atomic write:
 * temp file plus rename, so an interrupted save cannot leave a torn state
 * file behind for the resume to misread. A state file that EXISTS but
 * cannot be parsed stops the run instead of silently restarting over
 * existing rows.
 */
export function createFileRunStore(
  stateDir: string,
  runId: string,
): CutoverRunStore & { path: string } {
  const statePath = join(stateDir, `${runId}.json`);
  return {
    path: statePath,
    async load() {
      let text: string;
      try {
        text = readFileSync(statePath, "utf8");
      } catch {
        return null;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(`CUTOVER_STATE_UNREADABLE: ${statePath}`);
      }
    },
    async save(state: unknown) {
      mkdirSync(stateDir, { recursive: true });
      const tempPath = `${statePath}.tmp-${Date.now()}`;
      writeFileSync(tempPath, JSON.stringify(state, null, 1));
      renameSync(tempPath, statePath);
    },
  };
}

// ---------------------------------------------------------------------------
// Production wiring over the enterprise databases
// ---------------------------------------------------------------------------

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ownership-evidence and target-order reads, implemented once against a
 * table-owner (operator) database handle. The restricted data role's RLS
 * scope cannot see cross-tenant rows, and detecting an ambiguous
 * thread→tenant mapping is precisely the job — so these reads run with the
 * deployment's own operator authority, while every WRITE still goes through
 * the per-principal trusted scope the import resolves from the directory.
 */
export function createAdminTxRunner(database: Database): {
  transaction<T>(operation: (tx: AdminTx) => Promise<T>): Promise<T>;
} {
  return {
    async transaction(operation) {
      return database.transaction(async (tx) => {
        const admin: AdminTx = {
          async conversationRowsForThread(threadId) {
            const rows = await tx
              .select({
                tenantId: enterpriseConversations.tenantId,
                workspaceId: enterpriseConversations.workspaceId,
                principalId: enterpriseConversations.principalId,
                conversationId: enterpriseConversations.id,
                storageBackend: enterpriseConversations.storageBackend,
              })
              .from(enterpriseConversations)
              .where(eq(enterpriseConversations.threadId, threadId))
              .orderBy(asc(enterpriseConversations.tenantId));
            return rows.map(
              (row): OwnershipRow => ({
                tenantId: row.tenantId,
                workspaceId: row.workspaceId,
                principalId: row.principalId,
                conversationId: row.conversationId,
                storageBackend: row.storageBackend,
              }),
            );
          },
          async actorIdForPrincipal(tenantId, principalId) {
            const [row] = await tx
              .select({ userId: enterprisePrincipals.userId })
              .from(enterprisePrincipals)
              .innerJoin(
                enterpriseMemberships,
                and(
                  eq(
                    enterpriseMemberships.principalId,
                    enterprisePrincipals.id,
                  ),
                  eq(enterpriseMemberships.tenantId, tenantId),
                ),
              )
              .where(
                and(
                  eq(enterprisePrincipals.id, principalId),
                  eq(enterprisePrincipals.status, "active"),
                ),
              )
              .limit(1);
            return row?.userId ?? null;
          },
          async foreignFinalizedIntentCount(tenantId, threadId) {
            const [row] = await tx
              .select({ count: sql<number>`count(*)::int` })
              .from(mastraMessageIntents)
              .where(
                and(
                  eq(mastraMessageIntents.tenantId, tenantId),
                  eq(mastraMessageIntents.threadId, threadId),
                  eq(mastraMessageIntents.state, "finalized"),
                  sql`${mastraMessageIntents.clientMessageKey} not like ${`${LEGACY_IMPORT_KEY_PREFIX}%`}`,
                ),
              );
            return row?.count ?? 0;
          },
          async finalizedKeyExists(tenantId, threadId, clientMessageKey) {
            const [row] = await tx
              .select({ key: mastraMessageIntents.clientMessageKey })
              .from(mastraMessageIntents)
              .where(
                and(
                  eq(mastraMessageIntents.tenantId, tenantId),
                  eq(mastraMessageIntents.threadId, threadId),
                  eq(mastraMessageIntents.clientMessageKey, clientMessageKey),
                  eq(mastraMessageIntents.state, "finalized"),
                ),
              )
              .limit(1);
            return row !== undefined;
          },
          async existingAttachmentIds(ids) {
            const known = [...new Set(ids.filter((id) => UUID_SHAPE.test(id)))];
            if (known.length === 0) return new Set<string>();
            const rows = await tx
              .select({ id: attachmentsTable.id })
              .from(attachmentsTable)
              .where(inArray(attachmentsTable.id, known));
            return new Set(rows.map((row) => row.id));
          },
          async finalizedIntentOrder(tenantId, threadId) {
            return tx
              .select({
                messageId: mastraMessageIntents.messageId,
                clientMessageKey: mastraMessageIntents.clientMessageKey,
              })
              .from(mastraMessageIntents)
              .where(
                and(
                  eq(mastraMessageIntents.tenantId, tenantId),
                  eq(mastraMessageIntents.threadId, threadId),
                  eq(mastraMessageIntents.state, "finalized"),
                ),
              )
              .orderBy(asc(mastraMessageIntents.reservedSeq));
          },
        };
        return operation(admin);
      });
    },
  };
}

/** The reads the ownership ports and the verify reader need, per transaction. */
export interface AdminTx {
  conversationRowsForThread(threadId: string): Promise<OwnershipRow[]>;
  actorIdForPrincipal(
    tenantId: string,
    principalId: string,
  ): Promise<string | null>;
  foreignFinalizedIntentCount(
    tenantId: string,
    threadId: string,
  ): Promise<number>;
  finalizedKeyExists(
    tenantId: string,
    threadId: string,
    clientMessageKey: string,
  ): Promise<boolean>;
  existingAttachmentIds(ids: readonly string[]): Promise<Set<string>>;
  finalizedIntentOrder(
    tenantId: string,
    threadId: string,
  ): Promise<{ messageId: string; clientMessageKey: string }[]>;
}

/**
 * The OpenBot-side ownership ports wired to the operator reads and the
 * PRODUCTION scope resolver (directory capability): an imported row is
 * written under a scope the server itself issued, never a synthesized one.
 */
export function createPostgresLegacyOwnershipPorts(input: {
  admin: { transaction<T>(operation: (tx: AdminTx) => Promise<T>): Promise<T> };
  directory: DirectoryDatabase;
}): LegacyOwnershipPorts {
  const authenticated = new WeakMap<Request, string>();
  const resolver = createScopeResolver(input.directory, {
    authenticate: async (request) => {
      const actorId = authenticated.get(request);
      return actorId ? { actorId, entrypoint: "schedule" } : null;
    },
    selectTenant: (request) => new URL(request.url).searchParams.get("tenant"),
    selectWorkspace: (request) =>
      new URL(request.url).searchParams.get("workspace"),
  });
  return {
    async conversationRowsForThread(threadId) {
      return input.admin.transaction((tx) =>
        tx.conversationRowsForThread(threadId),
      );
    },
    async actorIdForPrincipal(tenantId, principalId) {
      return input.admin.transaction((tx) =>
        tx.actorIdForPrincipal(tenantId, principalId),
      );
    },
    async resolveScope({ actorId, tenantId, workspaceId }) {
      const request = new Request(
        `https://mastra-cutover.invalid/resolve?tenant=${encodeURIComponent(tenantId)}&workspace=${encodeURIComponent(workspaceId)}`,
      );
      authenticated.set(request, actorId);
      return resolver.resolve(request);
    },
    async foreignFinalizedIntentCount(tenantId, threadId) {
      return input.admin.transaction((tx) =>
        tx.foreignFinalizedIntentCount(tenantId, threadId),
      );
    },
    async finalizedKeyExists(tenantId, threadId, clientMessageKey) {
      return input.admin.transaction((tx) =>
        tx.finalizedKeyExists(tenantId, threadId, clientMessageKey),
      );
    },
    async existingAttachmentIds(ids) {
      return input.admin.transaction((tx) => tx.existingAttachmentIds(ids));
    },
  };
}

/**
 * The verify-side target reader: intents order the thread (reservedSeq, the
 * client read order), the tenant mastra memory store holds the rows.
 */
export function createPostgresTargetReader(input: {
  admin: { transaction<T>(operation: (tx: AdminTx) => Promise<T>): Promise<T> };
  storage: TenantMastraStorage;
  bindingFor(
    scope: PlatformScope,
    threadId: string,
  ): Promise<MastraConversationBinding>;
}): LegacyTargetReader {
  return {
    async readFinalizedRows(scope, threadId) {
      const ordering = await input.admin.transaction((tx) =>
        tx.finalizedIntentOrder(scope.tenantId, threadId),
      );
      if (ordering.length === 0) return [];
      const binding = await input.bindingFor(scope, threadId);
      const store = await input.storage.getStore(scope, binding);
      const memory = await store.getStore("memory");
      if (!memory) throw new Error("MASTRA_MEMORY_STORAGE_UNAVAILABLE");
      const loaded = await memory.listMessagesById({
        messageIds: ordering.map((row) => row.messageId),
      });
      const byId = new Map(
        loaded.messages.map((message) => [message.id, message]),
      );
      const rows: ImportedTargetRow[] = [];
      for (const row of ordering) {
        const message = byId.get(row.messageId);
        if (!message) continue;
        const metadata: Record<string, unknown> =
          message.content.metadata ?? {};
        rows.push({
          clientMessageKey:
            typeof metadata.openbotClientMessageKey === "string"
              ? metadata.openbotClientMessageKey
              : "",
          role: message.role,
          content: { parts: message.content.parts, metadata },
        });
      }
      return rows;
    },
  };
}
