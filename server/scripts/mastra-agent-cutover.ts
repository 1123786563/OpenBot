#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { loadConfig } from "../src/config";
import {
  createCredentialStore,
  decryptCredentialForUse,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { createConversationService } from "../src/enterprise/conversations/service";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
} from "../src/enterprise/tenancy/connections";
import {
  assertApplyAuthorized,
  conversationServiceWriter,
  createAdminTxRunner,
  createFileRunStore,
  createPostgresLegacyOwnershipPorts,
  createPostgresTargetReader,
  intelligenceSourceFrom,
  parseCutoverArgs,
} from "../src/mastra/cutover";
import {
  type CutoverCommand,
  type CutoverRequest,
  runApply,
  runDryRun,
  runInspect,
  runRollback,
  runVerify,
  type ScanDescriptor,
} from "../src/mastra/legacy-import";
import { PostgresTenantStorageRegistry } from "../src/mastra/postgres-registry";
import {
  RegistryTenantStorageLookup,
  type TenantCredentialStore,
} from "../src/mastra/provisioning";
import { createTenantMastraStorage } from "../src/mastra/tenant-storage";

/*
 * ME13 (#485): the legacy-conversation cutover tool. Fixed subcommands —
 * inspect | dry-run | apply | verify | rollback — read-only by default.
 *
 * apply double-gates on an explicit disposable-fixture authorization
 * (--authorize-fixture matching MASTRA_CUTOVER_FIXTURE_APPLY): it exists to
 * rehearse the import on authorized fixtures, never against production.
 * verify compares source and target digests and BLOCKS on any mismatch; the
 * staging/verified run state it produces is what the ME14 write fence
 * consumes. This script deliberately contains NO cutover switch: nothing
 * here makes a staging target the active writer.
 *
 * The Intelligence side is read through the same client class the runtime
 * uses, narrowed by the adapter to its two read methods; the tool has no
 * code path that mutates the source.
 */

const parsed = parseCutoverArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.usage);
  process.exit(2);
}
const args = parsed.args;

try {
  assertApplyAuthorized(args, process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}

const config = loadConfig(process.env);
const runId = args.runId ?? `cutover-${randomUUID()}`;
const scan: ScanDescriptor | null = args.thread
  ? { mode: "explicit-thread", threadId: args.thread }
  : args.user && args.agent
    ? { mode: "scan", userId: args.user, agentId: args.agent }
    : null;
if (!scan) {
  console.error(
    "Either --thread <threadId> or both --user <actorId> and --agent <agentId> are required.",
  );
  process.exit(2);
}
const request: CutoverRequest = {
  runId,
  scan,
  ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
};
const runStore = args.stateDir
  ? createFileRunStore(args.stateDir, runId)
  : undefined;

/*
 * The Intelligence read client, built from the same three settings the
 * runtime uses. Only the narrowed read adapter is handed to the import —
 * the full client never is.
 */
const intelligenceSettings = config.runtime.intelligence;
const source = intelligenceSourceFrom(
  new CopilotKitIntelligence({
    apiUrl: intelligenceSettings.apiUrl,
    wsUrl: intelligenceSettings.gatewayWsUrl,
    apiKey: intelligenceSettings.apiKey,
  }),
);

/*
 * Ownership evidence runs with the deployment's own operator authority (the
 * restricted data role's RLS scope cannot see cross-tenant rows, and
 * detecting an ambiguous mapping is the job); writes resolve per-principal
 * trusted scopes from the directory.
 */
const adminDatabase = createDatabase(config.databaseUrl, { max: 2 });
const admin = createAdminTxRunner(adminDatabase);

const directoryUrl = config.enterpriseDirectoryDatabaseUrl;
const dataUrl = config.enterpriseDataDatabaseUrl;
if (!directoryUrl || !dataUrl) {
  console.error(
    "CUTOVER_ENTERPRISE_UNCONFIGURED: enterprise directory/data database URLs are required.",
  );
  process.exit(2);
}
const directoryDatabase = await verifyDirectoryDatabase(
  createDatabase(directoryUrl, { max: 2 }),
);
const dataDatabase = await verifyDataDatabase(
  createDatabase(dataUrl, { max: 2 }),
);

const ports = createPostgresLegacyOwnershipPorts({
  admin,
  directory: directoryDatabase,
});

const needsTargetWrites = args.command === "apply";
const needsTargetReads = args.command === "verify";

let mastraStorage: ReturnType<typeof createTenantMastraStorage> | null = null;
if (needsTargetWrites || needsTargetReads) {
  const tenantRuntimeUrl = config.tenantStorageRuntimeDatabaseUrl;
  if (!tenantRuntimeUrl) {
    console.error(
      "CUTOVER_TENANT_STORAGE_UNCONFIGURED: tenantStorageRuntimeDatabaseUrl is required.",
    );
    process.exit(2);
  }
  const credentialStore = createCredentialStore(adminDatabase);
  const credentials: TenantCredentialStore = {
    put: async () => {
      throw new Error("TENANT_CREDENTIAL_WRITE_FORBIDDEN");
    },
    get: async (reference) =>
      decryptCredentialForUse(
        config.keyEncryptionKey,
        credentialStore,
        reference,
      ).catch((error) => {
        console.error({
          error: "TENANT_CREDENTIAL_DECRYPT_FAILED",
          context: { credentialRef: reference },
          cause: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }),
    delete: async () => {
      throw new Error("TENANT_CREDENTIAL_DELETE_FORBIDDEN");
    },
  };
  const registry = new PostgresTenantStorageRegistry({
    query: async (text, values) => ({
      rows: await adminDatabase.$client.unsafe(text, values),
    }),
  });
  mastraStorage = createTenantMastraStorage(
    new RegistryTenantStorageLookup({
      registry,
      credentials,
      runtimeConnectionString: tenantRuntimeUrl,
    }),
  );
}

try {
  const manifest = await (async (): Promise<
    Awaited<ReturnType<typeof runInspect>>
  > => {
    switch (args.command as CutoverCommand) {
      case "inspect":
        return runInspect(
          { source, ports, ...(runStore ? { runStore } : {}) },
          request,
        );
      case "dry-run":
        return runDryRun(
          { source, ports, ...(runStore ? { runStore } : {}) },
          request,
        );
      case "apply": {
        if (!mastraStorage) throw new Error("CUTOVER_STORAGE_UNAVAILABLE");
        const service = createConversationService({
          data: dataDatabase,
          mastraStorage,
        });
        return runApply(
          {
            source,
            ports,
            writer: conversationServiceWriter(service),
            ...(runStore ? { runStore } : {}),
          },
          {
            ...request,
            authorization: { fixtureId: args.authorizeFixture as string },
            environmentFixtureId: process.env.MASTRA_CUTOVER_FIXTURE_APPLY,
          },
        );
      }
      case "verify": {
        if (!mastraStorage) throw new Error("CUTOVER_STORAGE_UNAVAILABLE");
        const service = createConversationService({
          data: dataDatabase,
          mastraStorage,
        });
        return runVerify(
          {
            source,
            ports,
            targetReader: createPostgresTargetReader({
              admin,
              storage: mastraStorage,
              bindingFor: (scope, threadId) =>
                service.resolveMastraBinding(scope, threadId),
            }),
            ...(runStore ? { runStore } : {}),
          },
          request,
        );
      }
      case "rollback":
        if (!runStore) throw new Error("ROLLBACK_REQUIRES_STATE");
        return runRollback(
          { source, ports, ...(runStore ? { runStore } : {}) },
          request,
          process.env.MASTRA_CUTOVER_ROLLBACK_REASON ?? "operator rollback",
        );
    }
  })();
  // The manifest is the deliverable: sanitized inventory, cursors, counts,
  // digests, ownership evidence and skip reasons — never message content.
  console.log(JSON.stringify(manifest, null, 1));
  const blocked =
    manifest.phase === "blocked" ||
    (manifest.verify?.status ?? "match") === "mismatch";
  process.exit(blocked ? 1 : 0);
} catch (error) {
  console.error(
    `CUTOVER_${args.command.toUpperCase()}_FAILED:`,
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
} finally {
  await mastraStorage?.close().catch(() => undefined);
  await adminDatabase.$client.end().catch(() => undefined);
}
