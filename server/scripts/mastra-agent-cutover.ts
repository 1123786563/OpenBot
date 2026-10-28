#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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
  type CutoverSwitchRequest,
  conversationServiceWriter,
  createAdminTxRunner,
  createCutoverSwitchPorts,
  createFileRunStore,
  createPostgresLegacyOwnershipPorts,
  createPostgresTargetReader,
  intelligenceSourceFrom,
  parseCutoverArgs,
  parseInFlightDispositions,
  runCutover,
  runCutoverRollback,
} from "../src/mastra/cutover";
import {
  type CutoverCommand,
  type CutoverRequest,
  type LegacyImportSource,
  type PersistedRunState,
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
 * ME14 (#486) adds the `cutover` subcommand: the single-writer switch. It
 * sits under the SAME double fixture-authorization gate as apply, consumes
 * the staging→verified run state verify produced, re-checks the entry
 * inventory, the admission pause, the drained scope and the in-flight
 * disposition ledger, then bumps every switched thread's writer generation
 * under the conversation write fence. `rollback` on a switched state routes
 * to the fence's no-data-loss rollback (maintenance when unprovable).
 *
 * apply double-gates on an explicit disposable-fixture authorization
 * (--authorize-fixture matching MASTRA_CUTOVER_FIXTURE_APPLY): it exists to
 * rehearse the import on authorized fixtures, never against production.
 * verify compares source and target digests and BLOCKS on any mismatch; the
 * staging/verified run state it produces is what the ME14 write fence
 * consumes.
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

/** The operator-supplied JSON files the switch consumes (inventory, ledger). */
function readJsonFile(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    console.error(
      `CUTOVER_${what}_UNREADABLE: ${path} (${error instanceof Error ? error.message : error})`,
    );
    process.exit(2);
  }
}

const config = loadConfig(process.env);
/*
 * A rollback addresses the persisted run state by id, and the state file is
 * named after that id. Without --run-id a random id misses the state, routes
 * a switched run through the staging path, and skips the switched rollback's
 * authorization gate. Adopt the state directory's single run id instead.
 */
function rollbackRunIdFrom(stateDir: string): string {
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch {
    names = [];
  }
  const candidates = names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name));
  if (candidates.length === 1) return candidates[0];
  console.error(
    candidates.length === 0
      ? "CUTOVER_RUN_ID_REQUIRED: rollback needs --run-id (no run state in the state dir)."
      : `CUTOVER_RUN_ID_AMBIGUOUS: the state dir holds ${candidates.length} run states; pass --run-id.`,
  );
  process.exit(2);
}

const runId =
  args.runId ??
  (args.command === "rollback" && args.stateDir !== undefined
    ? rollbackRunIdFrom(args.stateDir)
    : `cutover-${randomUUID()}`);
// The switch works from the persisted run state, not from a fresh source scan.
// A rollback may go either way — a switched/maintenance state rolls back from
// the run state, a staging state needs the source — so it builds the source up
// front; requireSource() rejects only the staging path that has none.
const needsSource = args.command !== "cutover";
const scan: ScanDescriptor | null = args.thread
  ? { mode: "explicit-thread", threadId: args.thread }
  : args.user && args.agent
    ? { mode: "scan", userId: args.user, agentId: args.agent }
    : null;
if (!scan && needsSource) {
  console.error(
    "Either --thread <threadId> or both --user <actorId> and --agent <agentId> are required.",
  );
  process.exit(2);
}
const request: CutoverRequest | null = scan
  ? {
      runId,
      scan,
      ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
    }
  : null;
if (!args.stateDir) {
  console.error("--state-dir is required for this command.");
  process.exit(2);
}
const runStore = createFileRunStore(args.stateDir, runId);

/*
 * The switch reads its operator inputs before any connection: the entry
 * inventory and the in-flight disposition ledger.
 */
const entryInventory =
  args.command === "cutover"
    ? readJsonFile(args.entryInventoryPath as string, "ENTRY_INVENTORY")
    : undefined;
const parsedDispositions =
  args.command === "cutover"
    ? parseInFlightDispositions(
        readJsonFile(args.dispositionsPath as string, "DISPOSITIONS"),
      )
    : undefined;
if (parsedDispositions && !parsedDispositions.ok) {
  console.error(
    `CUTOVER_DISPOSITIONS_INVALID: ${parsedDispositions.failures.join("; ")}`,
  );
  process.exit(2);
}
const dispositions: CutoverSwitchRequest["dispositions"] | undefined =
  parsedDispositions?.dispositions;

/*
 * A rollback of a SWITCHED state must route to the fence's rollback, which
 * needs the same fixture authorization as the switch (it moves writer
 * generations on the target). The decision needs the state, so load it now.
 */
async function statePhase(): Promise<PersistedRunState | null> {
  const loaded = (await runStore.load()) as PersistedRunState | null;
  return loaded?.schemaVersion === 1 && loaded.runId === runId ? loaded : null;
}

const needsTargetWrites = args.command === "apply";
const needsTargetReads = args.command === "verify";

/*
 * The Intelligence read client, built from the same three settings the
 * runtime uses. Only the narrowed read adapter is handed to the import —
 * the full client never is. The switch and the switched rollback never
 * touch the source, so they construct no client at all.
 */
const intelligenceSettings = config.runtime.intelligence;
const source =
  needsSource && intelligenceSettings
    ? intelligenceSourceFrom(
        new CopilotKitIntelligence({
          apiUrl: intelligenceSettings.apiUrl,
          wsUrl: intelligenceSettings.gatewayWsUrl,
          apiKey: intelligenceSettings.apiKey,
        }),
      )
    : null;

function requireSource(): {
  source: LegacyImportSource;
  request: CutoverRequest;
} {
  if (!source || !request) {
    throw new Error(
      "CUTOVER_SOURCE_REQUIRED: this command needs --thread or --user/--agent",
    );
  }
  return { source, request };
}

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
      case "inspect": {
        const scanned = requireSource();
        return runInspect(
          { source: scanned.source, ports, runStore },
          scanned.request,
        );
      }
      case "dry-run": {
        const scanned = requireSource();
        return runDryRun(
          { source: scanned.source, ports, runStore },
          scanned.request,
        );
      }
      case "apply": {
        const scanned = requireSource();
        if (!mastraStorage) throw new Error("CUTOVER_STORAGE_UNAVAILABLE");
        const service = createConversationService({
          data: dataDatabase,
          mastraStorage,
        });
        return runApply(
          {
            source: scanned.source,
            ports,
            writer: conversationServiceWriter(service),
            runStore,
          },
          {
            ...scanned.request,
            authorization: { fixtureId: args.authorizeFixture as string },
            environmentFixtureId: process.env.MASTRA_CUTOVER_FIXTURE_APPLY,
          },
        );
      }
      case "verify": {
        const scanned = requireSource();
        if (!mastraStorage) throw new Error("CUTOVER_STORAGE_UNAVAILABLE");
        const service = createConversationService({
          data: dataDatabase,
          mastraStorage,
        });
        return runVerify(
          {
            source: scanned.source,
            ports,
            targetReader: createPostgresTargetReader({
              admin,
              storage: mastraStorage,
              bindingFor: (scope, threadId) =>
                service.resolveMastraBinding(scope, threadId),
            }),
            runStore,
          },
          scanned.request,
        );
      }
      case "cutover": {
        // ME14: the single-writer switch, under the SAME double fixture gate
        // apply runs under (asserted before any connection above).
        if (!args.tenant || !args.workspace) {
          throw new Error("CUTOVER_SCOPE_REQUIRED: --tenant and --workspace");
        }
        return runCutover(
          { runStore, switchPorts: createCutoverSwitchPorts(admin) },
          {
            runId,
            scope: { tenantId: args.tenant, workspaceId: args.workspace },
            entryInventory,
            dispositions: dispositions ?? {},
            ...(args.compatibleRollbackVersion !== undefined
              ? {
                  compatibleRollbackVersion: args.compatibleRollbackVersion,
                }
              : {}),
            pauseAdmission: args.pauseAdmission === true,
          },
        );
      }
      case "rollback": {
        const reason =
          process.env.MASTRA_CUTOVER_ROLLBACK_REASON ?? "operator rollback";
        // A switched state rolls back through the FENCE (preservation
        // receipt, maintenance on the unprovable path); a staging state
        // rolls back the ME13 way. The fence rollback moves writer
        // generations on the target, so it demands the same double gate.
        const state = await statePhase();
        if (state?.phase === "switched" || state?.phase === "maintenance") {
          if (
            args.authorizeFixture === undefined ||
            process.env.MASTRA_CUTOVER_FIXTURE_APPLY !== args.authorizeFixture
          ) {
            throw new Error(
              "ROLLBACK_NOT_AUTHORIZED: a switched rollback requires --authorize-fixture matching MASTRA_CUTOVER_FIXTURE_APPLY",
            );
          }
          return runCutoverRollback(
            { runStore, switchPorts: createCutoverSwitchPorts(admin) },
            { runId },
            reason,
          );
        }
        const scanned = requireSource();
        return runRollback(
          { source: scanned.source, ports, runStore },
          scanned.request,
          reason,
        );
      }
    }
  })();
  // The manifest is the deliverable: sanitized inventory, cursors, counts,
  // digests, ownership evidence and skip reasons — never message content.
  console.log(JSON.stringify(manifest, null, 1));
  const blocked =
    manifest.phase === "blocked" ||
    manifest.phase === "maintenance" ||
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
