import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { attachments as attachmentsTable } from "../db/schema/core";
import { enterpriseConversations } from "../db/schema/enterprise-conversations";
import { enterpriseRuns } from "../db/schema/enterprise-runs";
import {
  enterpriseMemberships,
  enterprisePrincipals,
} from "../db/schema/enterprise-tenancy";
import { mastraExecutionContinuations } from "../db/schema/mastra-execution-continuations";
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
  PersistedRunState,
} from "./legacy-import";
import {
  LEGACY_IMPORT_KEY_PREFIX,
  manifestOf as manifestOfState,
  stagingStatusOf,
} from "./legacy-import";
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
  command: "inspect" | "dry-run" | "apply" | "verify" | "rollback" | "cutover";
  runId?: string;
  stateDir?: string;
  user?: string;
  agent?: string;
  thread?: string;
  pageSize?: number;
  authorizeFixture?: string;
  tenant?: string;
  workspace?: string;
  entryInventoryPath?: string;
  dispositionsPath?: string;
  compatibleRollbackVersion?: string;
  pauseAdmission?: boolean;
}

const USAGE = `Usage: mastra-agent-cutover.ts <inspect|dry-run|apply|verify|rollback|cutover> [options]

  --run-id <id>            run identity (default: generated)
  --state-dir <dir>        persisted run state directory (REQUIRED for apply/verify/rollback/cutover)
  --user <actorId>         source scan identity: the user whose threads to list
  --agent <agentId>        source scan identity: the agent whose threads to list
  --thread <threadId>      explicit single-thread mode (overrides the scan)
  --page-size <n>          listThreads page size
  --authorize-fixture <id> apply/cutover only; must equal MASTRA_CUTOVER_FIXTURE_APPLY in the environment

cutover (ME14, the single-writer switch) additionally takes:
  --tenant <id> --workspace <id>        the scope the fence switches
  --entry-inventory <path>              JSON file of every run entry's disposition
  --dispositions <path>                 JSON file of the in-flight dispositions
  --compatible-rollback-version <id>    the app version a rollback may return to (absent = none: rollback would go to maintenance)
  --pause-admission                     record the target scope's admission pause before switching

Read-only by default: inspect/dry-run write nothing on either side. apply and
cutover run only on an explicitly authorized disposable fixture environment.`;

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
    command !== "rollback" &&
    command !== "cutover"
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
      case "--authorize-fixture":
      case "--tenant":
      case "--workspace":
      case "--entry-inventory":
      case "--dispositions":
      case "--compatible-rollback-version": {
        const parsed = valueOrNull();
        if (parsed === null) return { ok: false, usage: USAGE };
        if (flag === "--run-id") args.runId = parsed;
        else if (flag === "--state-dir") args.stateDir = parsed;
        else if (flag === "--user") args.user = parsed;
        else if (flag === "--agent") args.agent = parsed;
        else if (flag === "--thread") args.thread = parsed;
        else if (flag === "--tenant") args.tenant = parsed;
        else if (flag === "--workspace") args.workspace = parsed;
        else if (flag === "--entry-inventory") args.entryInventoryPath = parsed;
        else if (flag === "--dispositions") args.dispositionsPath = parsed;
        else if (flag === "--compatible-rollback-version")
          args.compatibleRollbackVersion = parsed;
        else args.authorizeFixture = parsed;
        break;
      }
      case "--pause-admission": {
        args.pauseAdmission = true;
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
 * Anything less refuses before any connection is opened. ME14: the cutover
 * command sits under the SAME double gate — the switch is the most
 * consequential write the tool has — and must name its scope, its entry
 * inventory and its in-flight dispositions up front.
 */
export function assertApplyAuthorized(
  args: CutoverArgs,
  env: Record<string, string | undefined>,
): void {
  if (args.command !== "apply" && args.command !== "cutover") return;
  const reasons: string[] = [];
  if (!args.stateDir)
    reasons.push(`--state-dir is required for ${args.command}`);
  if (!args.authorizeFixture)
    reasons.push(
      `--authorize-fixture <fixtureId> is required for ${args.command}`,
    );
  if (
    args.authorizeFixture !== undefined &&
    env.MASTRA_CUTOVER_FIXTURE_APPLY !== args.authorizeFixture
  ) {
    reasons.push(
      `the environment must pin the same fixture id: MASTRA_CUTOVER_FIXTURE_APPLY=${args.authorizeFixture}`,
    );
  }
  if (args.command === "cutover") {
    if (!args.tenant || !args.workspace)
      reasons.push("--tenant and --workspace are required for cutover");
    if (!args.entryInventoryPath)
      reasons.push("--entry-inventory <path> is required for cutover");
    if (!args.dispositionsPath)
      reasons.push("--dispositions <path> is required for cutover");
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
 *
 * ME14 (carried ME13 review F3): the run id joins a filesystem path, so an
 * operator-supplied id is validated against a fixed shape first — no
 * separators, no dot-prefixed names, bounded length. A bad id refuses before
 * anything is created instead of escaping the state directory.
 */
const RUN_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function createFileRunStore(
  stateDir: string,
  runId: string,
): CutoverRunStore & { path: string } {
  if (!RUN_ID_SHAPE.test(runId)) {
    throw new Error(
      `CUTOVER_RUN_ID_INVALID: a run id must match ${String(RUN_ID_SHAPE)} (got ${JSON.stringify(runId)})`,
    );
  }
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
          async foreignPendingIntentCount(tenantId, threadId) {
            const [row] = await tx
              .select({ count: sql<number>`count(*)::int` })
              .from(mastraMessageIntents)
              .where(
                and(
                  eq(mastraMessageIntents.tenantId, tenantId),
                  eq(mastraMessageIntents.threadId, threadId),
                  eq(mastraMessageIntents.state, "pending"),
                  sql`${mastraMessageIntents.clientMessageKey} not like ${`${LEGACY_IMPORT_KEY_PREFIX}%`}`,
                ),
              );
            return row?.count ?? 0;
          },
          async conversationBackendForThread(tenantId, threadId) {
            const [row] = await tx
              .select({
                backend: enterpriseConversations.storageBackend,
                backendVersion: enterpriseConversations.backendVersion,
              })
              .from(enterpriseConversations)
              .where(
                and(
                  eq(enterpriseConversations.tenantId, tenantId),
                  eq(enterpriseConversations.threadId, threadId),
                ),
              )
              .limit(1);
            return row ?? null;
          },
          /**
           * The ONE switch write: the conversation row's backend_version
           * moves +1 under the SAME per-conversation advisory lock every
           * append prepare/write transaction holds, so the bump is ordered
           * against every writer: writers before it finalized at the old
           * version, writers after it read the new one. The CAS condition
           * refuses a row that drifted from the seen version.
           */
          async switchBackendVersion(tenantId, threadId, expectedVersion) {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["conversation", tenantId, threadId])}, 0))`,
            );
            const [row] = await tx
              .update(enterpriseConversations)
              .set({
                backendVersion: expectedVersion + 1,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(enterpriseConversations.tenantId, tenantId),
                  eq(enterpriseConversations.threadId, threadId),
                  eq(enterpriseConversations.backendVersion, expectedVersion),
                ),
              )
              .returning({
                toVersion: enterpriseConversations.backendVersion,
              });
            if (!row) {
              throw new Error(
                `CUTOVER_VERSION_DRIFT: ${tenantId}/${threadId} expected backend_version ${expectedVersion}`,
              );
            }
            return { toVersion: row.toVersion };
          },
          async inFlightRunsInScope(tenantId, workspaceId) {
            const rows = await tx
              .select({
                runId: enterpriseRuns.id,
                threadId: enterpriseRuns.threadId,
                status: enterpriseRuns.status,
                leaseExpired: sql<boolean>`(${enterpriseRuns.leaseExpiresAt} <= now())`,
                continuationCount: sql<number>`(
                  select count(*)::int from ${mastraExecutionContinuations}
                  where ${mastraExecutionContinuations.runId} = ${enterpriseRuns.id}::text
                    and ${mastraExecutionContinuations.status} <> 'finished'
                )`,
              })
              .from(enterpriseRuns)
              .where(
                and(
                  eq(enterpriseRuns.tenantId, tenantId),
                  eq(enterpriseRuns.workspaceId, workspaceId),
                  sql`${enterpriseRuns.status} in ('queued', 'running', 'waiting_approval', 'suspended')`,
                ),
              );
            return rows.map(
              (row): InFlightItem => ({
                runId: row.runId,
                threadId: row.threadId,
                status: row.status as InFlightStatus,
                leaseExpired: row.leaseExpired === true,
                hasMastraContinuation: row.continuationCount > 0,
              }),
            );
          },
          async foreignIntentsForThread(tenantId, threadId) {
            return tx
              .select({
                clientMessageKey: mastraMessageIntents.clientMessageKey,
                state: mastraMessageIntents.state,
              })
              .from(mastraMessageIntents)
              .where(
                and(
                  eq(mastraMessageIntents.tenantId, tenantId),
                  eq(mastraMessageIntents.threadId, threadId),
                  sql`${mastraMessageIntents.clientMessageKey} not like ${`${LEGACY_IMPORT_KEY_PREFIX}%`}`,
                ),
              )
              .orderBy(asc(mastraMessageIntents.reservedSeq));
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
  foreignPendingIntentCount(
    tenantId: string,
    threadId: string,
  ): Promise<number>;
  conversationBackendForThread(
    tenantId: string,
    threadId: string,
  ): Promise<{ backend: string; backendVersion: number } | null>;
  switchBackendVersion(
    tenantId: string,
    threadId: string,
    expectedVersion: number,
  ): Promise<{ toVersion: number }>;
  inFlightRunsInScope(
    tenantId: string,
    workspaceId: string,
  ): Promise<readonly InFlightItem[]>;
  foreignIntentsForThread(
    tenantId: string,
    threadId: string,
  ): Promise<{ clientMessageKey: string; state: string }[]>;
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
    async foreignPendingIntentCount(tenantId, threadId) {
      return input.admin.transaction((tx) =>
        tx.foreignPendingIntentCount(tenantId, threadId),
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

// ---------------------------------------------------------------------------
// ME14 (#486): the write fence — the single-writer switch, the in-flight
// disposition ledger, and the rollback/maintenance state machine.
//
// WHAT THE FENCE IS. The conversation row's backend_version is the writer
// generation: every append prepare/write transaction stamps and re-checks it
// (the ConversationService fences CONVERSATION_BACKEND_CHANGED), and the
// finalize UPDATE matches it against the row's CURRENT version (the ME14
// strengthening), so a writer prepared against an older generation can never
// land a message or overwrite new state after the switch. The switch bumps
// that version per thread under the SAME per-conversation advisory lock the
// writers hold — the bump is ordered against every writer by the database,
// not by clocks. The fence record in the run state names the engine, the
// engine fingerprint and every from→to version, per scope.
//
// THE SINGLE WRITER. The fence never points a thread back at a legacy
// backend: the switch moves a mastra-staging row to mastra-generation+1, the
// rollback moves it to generation+2 with a receipt, and maintenance changes
// nothing. There is no code path here that flips storage_backend, deletes a
// row, or re-executes an external operation.
//
// AUTHORIZATION. The switch and the switched rollback run only under the
// ME13 apply double gate (CLI --authorize-fixture AND the environment pin),
// which the runbook carries into production as a separate, human approval.
// ---------------------------------------------------------------------------

/** The pinned-package fingerprint the fence records as the engine version. */
import { mastraEngineFingerprint } from "./continuation-store";

/** The canonical run-entry inventory a switch must account for (AC1). */
export const CUTOVER_ENTRY_IDS = [
  "chat-entry",
  "routine-firing",
  "message-delivery",
  "wake-up",
  "approval-continuation",
  "openmuse-task",
  "handoff-delivery",
  "legacy-history-reader",
] as const;

export type CutoverEntryId = (typeof CUTOVER_ENTRY_IDS)[number];
export type CutoverEntryDisposition =
  | "governed"
  | "legacy-kept"
  | "reader-only";

export interface CutoverEntryInventoryEntry {
  id: CutoverEntryId;
  disposition: CutoverEntryDisposition;
  note?: string;
}

/** The only side-channel entry; it may read history, never write it. */
const READER_ONLY_ENTRY_IDS: readonly CutoverEntryId[] = [
  "legacy-history-reader",
];

export type EntryInventoryVerdict =
  | { ok: true; entries: readonly CutoverEntryInventoryEntry[] }
  | {
      ok: false;
      missing: readonly string[];
      unknown: readonly string[];
      invalid: readonly string[];
    };

/**
 * AC1: the operator's entry inventory, checked structurally. Every canonical
 * entry present exactly once with a valid disposition; the side-channel
 * reader must stay reader-only; a legacy-kept WRITER must state why it is
 * not migrated. A missing or invalid item refuses the switch — 缺项不得 apply.
 */
export function parseEntryInventory(input: unknown): EntryInventoryVerdict {
  const raw = (input as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      missing: [...CUTOVER_ENTRY_IDS],
      unknown: [],
      invalid: [],
    };
  }
  const seen = new Map<string, { disposition: unknown; note: unknown }>();
  const invalid: string[] = [];
  raw.forEach((item, index) => {
    const id = (item as { id?: unknown } | null)?.id;
    // "Exactly once" is enforced, not assumed: a duplicate id must fail the gate rather than
    // silently win last-wins, and an item without a usable string id is invalid outright —
    // skipping it would let a malformed entry ride the ok:true reconstruction below.
    if (typeof id !== "string" || id.length === 0) {
      invalid.push(`entries[${index}]:id-not-a-string`);
      return;
    }
    if (seen.has(id)) {
      invalid.push(`${id}:duplicate-entry`);
      return;
    }
    seen.set(id, {
      disposition: (item as { disposition?: unknown }).disposition,
      note: (item as { note?: unknown }).note,
    });
  });
  const missing = CUTOVER_ENTRY_IDS.filter((id) => !seen.has(id));
  const unknown = [...seen.keys()].filter(
    (id) => !(CUTOVER_ENTRY_IDS as readonly string[]).includes(id),
  );
  const dispositions: readonly string[] = [
    "governed",
    "legacy-kept",
    "reader-only",
  ];
  for (const [id, item] of seen) {
    if (
      typeof item.disposition !== "string" ||
      !dispositions.includes(item.disposition)
    ) {
      invalid.push(`${id}:disposition`);
      continue;
    }
    if (
      (READER_ONLY_ENTRY_IDS as readonly string[]).includes(id) &&
      item.disposition !== "reader-only"
    ) {
      invalid.push(`${id}:reader-entry-not-reader-only`);
      continue;
    }
    if (item.disposition === "legacy-kept" && typeof item.note !== "string") {
      invalid.push(`${id}:legacy-kept-requires-note`);
    }
  }
  if (missing.length > 0 || unknown.length > 0 || invalid.length > 0) {
    return { ok: false, missing, unknown, invalid };
  }
  return {
    ok: true,
    entries: raw.map((item) => {
      const typed = item as {
        id: CutoverEntryId;
        disposition: CutoverEntryDisposition;
        note?: string;
      };
      return typed.note === undefined
        ? { id: typed.id, disposition: typed.disposition }
        : { id: typed.id, disposition: typed.disposition, note: typed.note };
    }),
  };
}

// ---------------------------------------------------------------------------
// AC2: the in-flight disposition ledger
// ---------------------------------------------------------------------------

export type InFlightStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "suspended";

export interface InFlightItem {
  runId: string;
  threadId: string;
  status: InFlightStatus;
  leaseExpired: boolean;
  hasMastraContinuation: boolean;
}

export type InFlightDisposition =
  | "convert-pause"
  | "legacy-drain"
  | "isolate"
  | "re-initiate";

export type InFlightEffect = "none" | "receipted" | "unknown";

export interface InFlightDispositionEntry {
  disposition: InFlightDisposition;
  /** Required for convert-pause: the external effects the pause already holds. */
  effect?: InFlightEffect;
  note?: string;
}

export type InFlightLedgerEntry =
  | { kind: "converted"; runId: string; threadId: string }
  | {
      kind: "excluded";
      runId: string;
      threadId: string;
      disposition: "isolate" | "re-initiate";
    }
  /** A disposition for an item that drained before the switch: terminated → read-only. */
  | { kind: "drained"; runId: string };

export type ClassifiedInFlight =
  | {
      ok: true;
      ledger: readonly InFlightLedgerEntry[];
      excludedThreadIds: readonly string[];
      conversions: readonly InFlightItem[];
    }
  | { ok: false; failures: readonly string[] };

/** The exact contract words the AC2 branches recognize. */
const IN_FLIGHT_DISPOSITION_VALUES: readonly InFlightDisposition[] = [
  "convert-pause",
  "legacy-drain",
  "isolate",
  "re-initiate",
];
const IN_FLIGHT_EFFECT_VALUES: readonly InFlightEffect[] = [
  "none",
  "receipted",
  "unknown",
];

/**
 * Per-entry contract check shared by classifyInFlight and the CLI parse: a
 * typo (`isloate`, `legacy_drain`, `receipt`) is a NAMED refusal — never a
 * silent fall-through to the exclude/convert path (the same loud failure
 * unknown run ids and unknown entry ids already get). Empty = contract words
 * only.
 */
function inFlightEntryFailures(
  runId: string,
  entry: InFlightDispositionEntry,
): string[] {
  const failures: string[] = [];
  const raw = entry as { disposition?: unknown; effect?: unknown } | null;
  if (
    raw === null ||
    typeof raw !== "object" ||
    typeof raw.disposition !== "string" ||
    !(IN_FLIGHT_DISPOSITION_VALUES as readonly string[]).includes(
      raw.disposition,
    )
  ) {
    failures.push(
      `invalid_disposition:${runId} (${JSON.stringify(raw?.disposition)}) — use one of ${IN_FLIGHT_DISPOSITION_VALUES.join("|")}`,
    );
    return failures;
  }
  if (
    raw.disposition === "convert-pause" &&
    raw.effect !== undefined &&
    !(IN_FLIGHT_EFFECT_VALUES as readonly string[]).includes(
      raw.effect as string,
    )
  ) {
    failures.push(
      `invalid_effect:${runId} (${JSON.stringify(raw.effect)}) — use one of ${IN_FLIGHT_EFFECT_VALUES.join("|")}; an unknown effect must isolate instead`,
    );
  }
  return failures;
}

export type ParsedInFlightDispositions =
  | { ok: true; dispositions: Record<string, InFlightDispositionEntry> }
  | { ok: false; failures: readonly string[] };

/**
 * The operator's in-flight disposition ledger as it arrives from JSON (the
 * CLI reads it before any gate runs): every row must use one of the four
 * contract disposition words and, for convert-pause, one of the three
 * contract effect words. Same named refusals as classifyInFlight.
 */
export function parseInFlightDispositions(
  input: unknown,
): ParsedInFlightDispositions {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      failures: [
        "invalid_dispositions: the ledger must be a JSON object of runId → { disposition, effect?, note? }",
      ],
    };
  }
  const failures: string[] = [];
  const dispositions: Record<string, InFlightDispositionEntry> = {};
  for (const [runId, value] of Object.entries(
    input as Record<string, unknown>,
  )) {
    const entry = value as InFlightDispositionEntry;
    const entryFailures = inFlightEntryFailures(runId, entry);
    if (entryFailures.length > 0) {
      failures.push(...entryFailures);
      continue;
    }
    dispositions[runId] = entry;
  }
  return failures.length > 0
    ? { ok: false, failures }
    : { ok: true, dispositions };
}

/**
 * AC2: every in-flight item gets exactly one disposition, checked against
 * what the item actually is:
 *
 *   - queued/running are NOT dispositionable — they must drain (the apply
 *     re-runs once the legacy path finished them);
 *   - a pause with a mastra continuation and a KNOWN effect converts to the
 *     ME05 continuation machinery (the cross-process rehearsal drives it);
 *   - a pause the legacy engine parked drains on the legacy path BEFORE the
 *     switch — a still-live item refuses (不能跳过以完成上线) — or is
 *     explicitly isolated / re-initiated, which holds its thread out of the
 *     switch by id;
 *   - dispositions for items no longer in flight record the drain honestly;
 *     dispositions for ids that never existed fail loudly;
 *   - a disposition or effect word outside the contract is a named refusal
 *     (invalid_disposition / invalid_effect), never a silent exclude.
 */
export function classifyInFlight(
  items: readonly InFlightItem[],
  dispositions: Readonly<Record<string, InFlightDispositionEntry>>,
): ClassifiedInFlight {
  const failures: string[] = [];
  const ledger: InFlightLedgerEntry[] = [];
  const excludedThreadIds: string[] = [];
  const conversions: InFlightItem[] = [];
  const byId = new Map(items.map((item) => [item.runId, item]));
  const dispositionIds = new Set(Object.keys(dispositions));

  for (const item of items) {
    const entry = dispositions[item.runId];
    if (item.status === "queued" || item.status === "running") {
      failures.push(
        `drain_required:${item.runId} (${item.status}${item.leaseExpired ? ", lease expired" : ""}) — stop admission and let the legacy path finish it before switching`,
      );
      continue;
    }
    if (!entry) {
      failures.push(
        `un_dispositioned:${item.runId} (${item.status} on ${item.threadId})`,
      );
      continue;
    }
    const entryFailures = inFlightEntryFailures(item.runId, entry);
    if (entryFailures.length > 0) {
      failures.push(...entryFailures);
      continue;
    }
    if (entry.disposition === "legacy-drain") {
      failures.push(
        `not_drained:${item.runId} — a legacy-drain item must be terminal before the switch; re-run after the legacy path drained it`,
      );
      continue;
    }
    if (entry.disposition === "convert-pause") {
      if (!item.hasMastraContinuation) {
        failures.push(
          `convert_requires_continuation:${item.runId} — no mastra continuation holds this pause; it is not convertible`,
        );
        continue;
      }
      if (!entry.effect || entry.effect === "unknown") {
        failures.push(
          `convert_requires_known_effect:${item.runId} — declare the pause's external effects (none|receipted); an unknown effect must isolate instead`,
        );
        continue;
      }
      ledger.push({
        kind: "converted",
        runId: item.runId,
        threadId: item.threadId,
      });
      conversions.push(item);
      continue;
    }
    ledger.push({
      kind: "excluded",
      runId: item.runId,
      threadId: item.threadId,
      disposition: entry.disposition,
    });
    excludedThreadIds.push(item.threadId);
  }
  for (const runId of dispositionIds) {
    if (byId.has(runId)) continue;
    const entry = dispositions[runId] as InFlightDispositionEntry;
    const entryFailures = inFlightEntryFailures(runId, entry);
    if (entryFailures.length > 0) {
      failures.push(...entryFailures);
      continue;
    }
    if (entry.disposition === "legacy-drain") {
      // The coherent drain story: the operator declared it, the legacy path
      // finished it before this enumeration — terminated → read-only.
      ledger.push({ kind: "drained", runId });
      continue;
    }
    // isolate/re-initiate/convert claims about an id that is not in flight
    // are stale decisions: fail loudly instead of recording fiction.
    failures.push(`unknown_item:${runId}`);
  }
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, ledger, excludedThreadIds, conversions };
}

// ---------------------------------------------------------------------------
// AC1+AC2: the gates (缺项不得 apply)
// ---------------------------------------------------------------------------

export type CutoverGateFailure = { gate: string; detail: string };

export function evaluateCutoverGates(input: {
  entryInventory: EntryInventoryVerdict;
  staging: ReturnType<typeof stagingStatusOf>;
  admissionPausedAt: string | null | undefined;
  activeRuns: readonly InFlightItem[];
  classified: ClassifiedInFlight;
}): { ok: true } | { ok: false; failed: readonly CutoverGateFailure[] } {
  const failed: CutoverGateFailure[] = [];
  if (!input.entryInventory.ok) {
    const parts: string[] = [];
    if (input.entryInventory.missing.length > 0)
      parts.push(`missing ${input.entryInventory.missing.join(",")}`);
    if (input.entryInventory.unknown.length > 0)
      parts.push(`unknown ${input.entryInventory.unknown.join(",")}`);
    if (input.entryInventory.invalid.length > 0)
      parts.push(`invalid ${input.entryInventory.invalid.join(",")}`);
    failed.push({ gate: "entry-inventory", detail: parts.join("; ") });
  }
  if (input.staging !== "verified") {
    failed.push({
      gate: "imports-verified",
      detail: `staging status is "${input.staging}", not "verified" — run verify first`,
    });
  }
  if (!input.admissionPausedAt) {
    failed.push({
      gate: "admission-paused",
      detail: "the target scope's admission pause is not recorded",
    });
  }
  if (input.activeRuns.length > 0) {
    failed.push({
      gate: "drained",
      detail: `active runs in scope: ${input.activeRuns.map((r) => `${r.runId}(${r.status})`).join(", ")}`,
    });
  }
  if (!input.classified.ok) {
    failed.push({
      gate: "in-flight-dispositioned",
      detail: input.classified.failures.join("; "),
    });
  }
  return failed.length > 0 ? { ok: false, failed } : { ok: true };
}

// ---------------------------------------------------------------------------
// AC3: the fence record + the switch ports
// ---------------------------------------------------------------------------

export interface CutoverFenceRecord {
  scope: { tenantId: string; workspaceId: string };
  /** The ONE engine the switched scope runs under; a client cannot choose. */
  engine: "mastra";
  /** The pinned-package fingerprint the engine's continuations bind to. */
  engineVersion: string;
  /**
   * The application version a rollback may return to, recorded AT SWITCH by
   * the operator. Null means no compatible version is known: a rollback
   * would go to maintenance instead of guessing.
   */
  compatibleRollbackVersion: string | null;
  switchedAt: string;
  threads: readonly {
    threadId: string;
    fromBackend: string;
    fromBackendVersion: number;
    toBackendVersion: number;
  }[];
  excludedThreadIds: readonly string[];
  rollback?: {
    at: string;
    reason: string;
    toBackendVersion: number;
    /**
     * ME16 (F4): the preservation receipt names exactly what it counts — the
     * non-legacy message intents inventoried before and after the bump. It
     * never carried a memory-row count under a memory name: the fence can
     * prove the intents it reads, and the receipt states only that.
     */
    preserved: {
      newIntents: number;
    };
    receiptRefs: readonly { runId?: string; clientMessageKey?: string }[];
  };
  maintenance?: { reason: string; at: string };
}

/**
 * The database face of the switch. Every method runs against the
 * deployment's operator authority; the switch WRITE is the advisory-locked
 * CAS bump only — nothing here flips a backend, deletes a row or replays an
 * operation.
 */
export interface CutoverSwitchPorts {
  conversationBackend(
    tenantId: string,
    threadId: string,
  ): Promise<{ backend: string; backendVersion: number } | null>;
  bumpBackendVersion(
    tenantId: string,
    threadId: string,
    expectedVersion: number,
  ): Promise<{ toVersion: number }>;
  inFlightRunsInScope(
    tenantId: string,
    workspaceId: string,
  ): Promise<readonly InFlightItem[]>;
  /** Non-legacy intents of one thread, in seq order (the rollback's inventory). */
  foreignIntents(
    tenantId: string,
    threadId: string,
  ): Promise<readonly { clientMessageKey: string; state: string }[]>;
}

/** The production switch ports over the operator database handle. */
export function createCutoverSwitchPorts(admin: {
  transaction<T>(operation: (tx: AdminTx) => Promise<T>): Promise<T>;
}): CutoverSwitchPorts {
  return {
    async conversationBackend(tenantId, threadId) {
      return admin.transaction((tx) =>
        tx.conversationBackendForThread(tenantId, threadId),
      );
    },
    async bumpBackendVersion(tenantId, threadId, expectedVersion) {
      return admin.transaction((tx) =>
        tx.switchBackendVersion(tenantId, threadId, expectedVersion),
      );
    },
    async inFlightRunsInScope(tenantId, workspaceId) {
      return admin.transaction((tx) =>
        tx.inFlightRunsInScope(tenantId, workspaceId),
      );
    },
    async foreignIntents(tenantId, threadId) {
      return admin.transaction((tx) =>
        tx.foreignIntentsForThread(tenantId, threadId),
      );
    },
  };
}

export class CutoverFenceError extends Error {}

export interface CutoverDeps {
  runStore: CutoverRunStore;
  switchPorts: CutoverSwitchPorts;
  /** Defaults to the pinned-package engine fingerprint. */
  engineVersion?: () => string;
  now?: () => Date;
}

export interface CutoverSwitchRequest {
  runId: string;
  scope: { tenantId: string; workspaceId: string };
  entryInventory: unknown;
  dispositions: Readonly<Record<string, InFlightDispositionEntry>>;
  /**
   * The application version a rollback may return to. Absent = none is
   * known, and the fence will refuse an unsafe rollback into maintenance.
   */
  compatibleRollbackVersion?: string;
  pauseAdmission?: boolean;
}

function nowOf(deps: CutoverDeps): () => string {
  return () => (deps.now ?? (() => new Date()))().toISOString();
}

function fenceOf(state: PersistedRunState): CutoverFenceRecord | null {
  return (state.fence as CutoverFenceRecord | undefined) ?? null;
}

/**
 * AC1+AC2+AC3: the single-writer switch. Gates first (entry inventory,
 * verified staging, admission pause, drained scope, dispositioned ledger) —
 * any failure refuses before ANY thread is touched. Then each verified
 * thread bumps its backend_version under the conversation advisory lock,
 * recording the from→to versions as it goes, so an interrupted switch
 * resumes without re-bumping. All switched → phase "switched" and the fence
 * record is the scope's single-writer receipt.
 */
export async function runCutover(
  deps: CutoverDeps,
  request: CutoverSwitchRequest,
): Promise<ReturnType<typeof manifestOfState>> {
  const now = nowOf(deps);
  const loaded = (await deps.runStore.load()) as PersistedRunState | null;
  if (loaded?.schemaVersion !== 1 || loaded.runId !== request.runId) {
    throw new CutoverFenceError(
      "CUTOVER_REQUIRES_STATE: no matching run state",
    );
  }
  if (loaded.phase === "switched") {
    throw new CutoverFenceError(
      "CUTOVER_ALREADY_SWITCHED: this run's scope is already switched",
    );
  }
  if (loaded.phase === "maintenance") {
    throw new CutoverFenceError(
      `CUTOVER_STATE_MAINTENANCE: ${loaded.maintenanceReason ?? "the target is in maintenance"}`,
    );
  }
  if (loaded.phase === "rolled_back") {
    throw new CutoverFenceError("ROLLED_BACK: the run state was rolled back");
  }
  const staging = stagingStatusOf(loaded);
  if (staging !== "verified") {
    throw new CutoverFenceError(
      `CUTOVER_REQUIRES_VERIFIED: staging status is "${staging}"`,
    );
  }
  const inventory = parseEntryInventory(request.entryInventory);
  const admissionPausedAt =
    loaded.admissionPausedAt ?? (request.pauseAdmission ? now() : undefined);
  const active = await deps.switchPorts.inFlightRunsInScope(
    request.scope.tenantId,
    request.scope.workspaceId,
  );
  const classified = classifyInFlight(active, request.dispositions);
  const gates = evaluateCutoverGates({
    entryInventory: inventory,
    staging,
    admissionPausedAt,
    activeRuns: active.filter(
      (r) => r.status === "queued" || r.status === "running",
    ),
    classified,
  });
  if (!gates.ok) {
    throw new CutoverFenceError(
      `CUTOVER_GATES_FAILED: ${gates.failed
        .map((f) => `${f.gate}[${f.detail}]`)
        .join("; ")}`,
    );
  }
  const state = loaded;
  state.command = "cutover";
  state.entryInventory = inventory.ok ? inventory.entries : undefined;
  state.inFlightLedger = classified.ok ? classified.ledger : undefined;
  if (request.pauseAdmission && !state.admissionPausedAt) {
    state.admissionPausedAt = admissionPausedAt;
  }
  let fence = fenceOf(state);
  if (!fence) {
    fence = {
      scope: { ...request.scope },
      engine: "mastra",
      engineVersion: (deps.engineVersion ?? mastraEngineFingerprint)(),
      compatibleRollbackVersion: request.compatibleRollbackVersion ?? null,
      switchedAt: now(),
      threads: [],
      excludedThreadIds: [
        ...(classified.ok ? classified.excludedThreadIds : []),
      ],
    };
    state.fence = fence;
  }
  // Switch every verified, in-scope, non-excluded thread. Persist after each
  // so an interrupted switch resumes honestly.
  const switchedThreadIds = new Set(fence.threads.map((t) => t.threadId));
  let blocker: string | null = null;
  for (const threadId of Object.keys(state.threads)) {
    const entry = state.threads[
      threadId
    ] as PersistedRunState["threads"][string];
    if (entry.status !== "verified") continue;
    if (
      entry.ownership.tenantId !== request.scope.tenantId ||
      entry.ownership.workspaceId !== request.scope.workspaceId
    ) {
      blocker = `scope_mismatch:${threadId} belongs to ${entry.ownership.tenantId}/${entry.ownership.workspaceId}`;
      break;
    }
    if (fence.excludedThreadIds.includes(threadId)) continue;
    if (switchedThreadIds.has(threadId)) continue;
    const row = await deps.switchPorts.conversationBackend(
      request.scope.tenantId,
      threadId,
    );
    if (row?.backend !== "mastra") {
      blocker = `backend_not_mastra:${threadId} (${row?.backend ?? "missing row"} v${row?.backendVersion ?? "-"})`;
      break;
    }
    const bumped = await deps.switchPorts.bumpBackendVersion(
      request.scope.tenantId,
      threadId,
      row.backendVersion,
    );
    const threads: CutoverFenceRecord["threads"] = [
      ...fence.threads,
      {
        threadId,
        fromBackend: row.backend,
        fromBackendVersion: row.backendVersion,
        toBackendVersion: bumped.toVersion,
      },
    ];
    state.fence = fence = { ...fence, threads };
    state.updatedAt = now();
    await deps.runStore.save(state);
  }
  if (blocker !== null) {
    // 不可转换状态在其范围阻塞：the switch stops at the first blocker —
    // ordered, interrupted, resumable — never skips past one.
    state.updatedAt = now();
    await deps.runStore.save(state);
    throw new CutoverFenceError(`CUTOVER_SWITCH_BLOCKED: ${blocker}`);
  }
  state.phase = "switched";
  state.updatedAt = now();
  await deps.runStore.save(state);
  return manifestOfState(state, "cutover");
}

/**
 * AC5+AC6: the switched rollback. It NEVER deletes new data and NEVER
 * points a thread back at a legacy backend: preservation is counted before
 * the version bump and asserted unchanged after; the bump moves the writer
 * generation forward once more (a rolled-back deployment is a different
 * writer generation, and stale prepared writes refuse by version). Anything
 * that makes a safe rollback unprovable — a live run in scope, no recorded
 * compatible version, a drifted row version — parks the scope in
 * MAINTENANCE with the diagnosable reason instead of guessing.
 */
export async function runCutoverRollback(
  deps: CutoverDeps,
  request: { runId: string },
  reason: string,
): Promise<ReturnType<typeof manifestOfState>> {
  const now = nowOf(deps);
  const loaded = (await deps.runStore.load()) as PersistedRunState | null;
  if (loaded?.schemaVersion !== 1 || loaded.runId !== request.runId) {
    throw new CutoverFenceError(
      "CUTOVER_REQUIRES_STATE: no matching run state",
    );
  }
  if (loaded.phase === "maintenance") {
    throw new CutoverFenceError(
      `CUTOVER_MAINTENANCE: ${loaded.maintenanceReason ?? "unresolved"} — leaving maintenance is a runbook decision with fresh authorization, not a re-run`,
    );
  }
  if (loaded.phase === "rolled_back") {
    // ME16 (F3): the phase guard names THIS state. The old guard folded a
    // rolled-back run into "no switch to roll back", sending the operator
    // hunting for a switch that was never the problem.
    throw new CutoverFenceError(
      "CUTOVER_ALREADY_ROLLED_BACK: this run state was already rolled back; a further rollback is a NEW run, not a re-run",
    );
  }
  const fence = fenceOf(loaded);
  /**
   * ME16 (F2): the maintenance exit, hoisted above the phase guards so a
   * PARTIAL switch can reach it. A blocked switch leaves bumped threads on
   * the new generation next to untouched threads on the old one — writers
   * live on both, and a rollback cannot prove what the old writers did.
   * Maintenance is the honest stop; finishing the switch is the honest
   * resume. Pretending there is "no switch to roll back" was the one lie
   * this guard could tell.
   */
  const goMaintenance = async (why: string) => {
    loaded.phase = "maintenance";
    loaded.maintenanceReason = why;
    // The diagnosable reason rides the fence record itself, so any reader of
    // the scope's fence sees WHY the tool stopped here.
    if (fence) {
      loaded.fence = { ...fence, maintenance: { reason: why, at: now() } };
    } else {
      loaded.maintenanceReason = why;
    }
    loaded.updatedAt = now();
    await deps.runStore.save(loaded);
    return manifestOfState(loaded, "rollback", {
      rollbackReason: `maintenance: ${why}`,
    });
  };
  if (loaded.phase !== "switched" || !fence) {
    const bumped = fence?.threads.length ?? 0;
    if (bumped > 0) {
      const total = Object.values(loaded.threads ?? {}).filter(
        (entry) => (entry as { status?: string }).status === "verified",
      ).length;
      return goMaintenance(
        `rollback-unsafe: PARTIAL switch — ${bumped} of ${total} verified thread(s) bumped and the switch never completed; a scope with writers on both generations exits through maintenance, never a rollback`,
      );
    }
    throw new CutoverFenceError(
      "CUTOVER_ROLLBACK_REQUIRES_SWITCHED: this state has no switch to roll back (the import-side rollback owns staging states)",
    );
  }
  // Unsafe condition 1: any live run in scope — a rollback under an active
  // writer cannot prove what the external effects were.
  const active = await deps.switchPorts.inFlightRunsInScope(
    fence.scope.tenantId,
    fence.scope.workspaceId,
  );
  if (active.length > 0) {
    return goMaintenance(
      `rollback-unsafe: live runs in scope: ${active
        .map((r) => `${r.runId}(${r.status})`)
        .join(", ")}`,
    );
  }
  // Unsafe condition 2: no compatible version recorded at switch time.
  if (!fence.compatibleRollbackVersion) {
    return goMaintenance(
      "rollback-unsafe: no compatible rollback version was recorded at switch time; rolling back would guess at a data contract",
    );
  }
  // Count what must survive BEFORE touching anything.
  let newIntents = 0;
  const receiptRefs: { clientMessageKey: string }[] = [];
  for (const thread of fence.threads) {
    const intents = await deps.switchPorts.foreignIntents(
      fence.scope.tenantId,
      thread.threadId,
    );
    newIntents += intents.length;
    for (const intent of intents) {
      if (intent.state === "finalized") {
        receiptRefs.push({ clientMessageKey: intent.clientMessageKey });
      }
    }
  }
  // The bump: every switched thread moves one more generation, CAS against
  // the recorded post-switch version. A drift means someone moved the row
  // outside the fence — maintenance, never a forced write.
  let toBackendVersion = 0;
  for (const thread of fence.threads) {
    const row = await deps.switchPorts.conversationBackend(
      fence.scope.tenantId,
      thread.threadId,
    );
    if (row?.backendVersion !== thread.toBackendVersion) {
      return goMaintenance(
        `rollback-unsafe: ${thread.threadId} backend_version drifted (recorded ${thread.toBackendVersion}, found ${row?.backendVersion ?? "missing row"})`,
      );
    }
    let bumped: Awaited<
      ReturnType<typeof deps.switchPorts.bumpBackendVersion>
    >;
    try {
      bumped = await deps.switchPorts.bumpBackendVersion(
        fence.scope.tenantId,
        thread.threadId,
        row.backendVersion,
      );
    } catch (error) {
      // The version check above and this CAS are two statements: a version that moves between
      // them strands threads on both generations with nothing recorded — exactly the shape this
      // file's own F2 note says only maintenance can answer honestly.
      return goMaintenance(
        `rollback-unsafe: ${thread.threadId} backend version moved between read and bump (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
    toBackendVersion = bumped.toVersion;
  }
  // Preservation re-check: the same inventory, after the bump.
  let preservedIntents = 0;
  for (const thread of fence.threads) {
    preservedIntents += (
      await deps.switchPorts.foreignIntents(
        fence.scope.tenantId,
        thread.threadId,
      )
    ).length;
  }
  if (preservedIntents !== newIntents) {
    return goMaintenance(
      `rollback-unsafe: post-rollback inventory changed (${newIntents} → ${preservedIntents})`,
    );
  }
  loaded.fence = {
    ...fence,
    // The threads[] list stays the SWITCH record (from→to at switch time);
    // the rollback's own generation lives in the receipt below.
    rollback: {
      at: now(),
      reason,
      toBackendVersion,
      preserved: { newIntents },
      receiptRefs,
    },
  };
  loaded.phase = "rolled_back";
  loaded.rollbackReason = reason;
  loaded.updatedAt = now();
  await deps.runStore.save(loaded);
  return manifestOfState(loaded, "rollback", { rollbackReason: reason });
}
