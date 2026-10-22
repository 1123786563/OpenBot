/**
 * Shared MT045 fixture (Issue #88, proactive suggestions + transaction boundary).
 *
 * Builds on the MT002 isolation matrix (companies A/B, the §11 identities) with
 * the verified restricted-role connections, the real scope resolver, the real
 * proactive store (settings + suggestions on the platform connection) and the
 * real MT045 services: attribution resolution over the directory/operator
 * channels and the enterprise delivery pipeline. The delivery transport is a
 * recorder with an optional blocker and failure injection — the external-call
 * seam — plus a per-dedupe-key charge counter standing in for the billing side.
 * Nothing here mocks the authorization path.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import {
  createProactiveAttributionService,
  type ProactiveDeliveryClaim,
  type ProactiveSettingAttributionFacts,
} from "../../../src/enterprise/tenancy/proactive-delivery";
import { createScopeResolver } from "../../../src/enterprise/tenancy/store";
import { createProactiveStore } from "../../../src/proactive/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";
import {
  createIsolationFixture,
  type FixtureIdentity,
  type IsolationFixture,
} from "./fixture";

async function openVerified<T extends object>(
  url: string,
  verify: (database: Database) => Promise<T>,
): Promise<T> {
  return verify(createDatabase(url, { max: 2 }) as Database);
}

export type ProactiveCompanyKey = "company-a" | "company-b";
export type ProactiveTeamKey = "team-a1" | "team-a2" | "team-b1";

/** What the recording transport observed: one send per claim, charges per key. */
export interface TransportRecording {
  readonly sends: readonly ProactiveDeliveryClaim[];
  readonly charges: ReadonlyMap<string, number>;
  readonly duplicateKeyRejections: readonly string[];
}

export interface ProactiveTxFixture {
  readonly isolation: IsolationFixture;
  readonly operator: OperatorDatabase;
  readonly data: DataDatabase;
  readonly directory: DirectoryDatabase;
  /** Platform connection the proactive domain runs on. */
  readonly platform: Database;
  /** The real proactive store (settings + suggestions). */
  readonly store: ReturnType<typeof createProactiveStore>;
  /** The real MT045 attribution service over the restricted channels. */
  readonly attribution: ReturnType<typeof createProactiveAttributionService>;
  /** Issues a trusted PlatformScope through the real scope resolver. */
  scopeAs(
    identity: FixtureIdentity,
    companyKey: ProactiveCompanyKey,
    teamKey: ProactiveTeamKey,
  ): Promise<PlatformScope>;
  /** The owner identity's live principal for the given company (setup channel). */
  principalOf(
    identity: FixtureIdentity,
    companyKey: ProactiveCompanyKey,
  ): Promise<string>;
  /** Seeds an enterprise-attributed setting through the REAL store create path. */
  enterpriseSetting(input: {
    identity: FixtureIdentity;
    companyKey: ProactiveCompanyKey;
    teamKey: ProactiveTeamKey;
    label: string;
  }): Promise<{ settingId: string; botId: string; runId: string }>;
  /** Seeds a legacy personal setting (no attribution columns). */
  personalSetting(input: {
    identity: FixtureIdentity;
    label: string;
  }): Promise<{ settingId: string; botId: string; runId: string }>;
  /** Adds one suggestion through the REAL store path. */
  addSuggestion(input: {
    settingId: string;
    ownerUserId: string;
    botId: string;
    runId: string;
    title: string;
    detail: string;
    sourceApp?: string;
  }): Promise<string>;
  /** Company-level suspension through the real provision receipt (epoch bump). */
  suspendCompanyMembership(
    identity: FixtureIdentity,
    companyKey: ProactiveCompanyKey,
  ): Promise<void>;
  /** Team-level suspension (workspace membership row flipped; setup channel). */
  suspendTeamMembership(input: {
    identity: FixtureIdentity;
    companyKey: ProactiveCompanyKey;
    teamKey: ProactiveTeamKey;
  }): Promise<void>;
  /** Restores a suspended company membership row (hygiene; epoch stays bumped). */
  restoreCompanyMembership(
    identity: FixtureIdentity,
    companyKey: ProactiveCompanyKey,
  ): Promise<void>;
  /** Restores a suspended team membership row (hygiene). */
  restoreTeamMembership(input: {
    identity: FixtureIdentity;
    companyKey: ProactiveCompanyKey;
    teamKey: ProactiveTeamKey;
  }): Promise<void>;
  /** Raw delivered_at read (superuser; what the store must not misreport). */
  deliveredAtOf(suggestionId: string): Promise<Date | null>;
  dispose(): Promise<void>;
}

export async function createProactiveTxFixture(): Promise<ProactiveTxFixture> {
  const isolation = await createIsolationFixture("jobs");

  const operator = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("operator" as const, process.env),
    verifyOperatorDatabase,
  );
  const data = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("data" as const, process.env),
    verifyDataDatabase,
  );
  const directory = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("directory" as const, process.env),
    verifyDirectoryDatabase,
  );
  const platform = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 2,
  }) as Database;
  const setup = createDatabase(
    process.env.TEST_DATABASE_URL ?? enterpriseTestDatabaseUrlFrom(),
    { max: 2 },
  );

  const store = createProactiveStore(platform);
  const attribution = createProactiveAttributionService({
    directory,
    operator,
  });

  // The real scope resolver over the verified directory connection.
  const sessions = new WeakMap<
    Request,
    { userId?: string; tenantId: string; workspaceId: string }
  >();
  const resolver = createScopeResolver(directory, {
    authenticate: async (request) => {
      const session = sessions.get(request);
      if (!session?.userId) return null;
      return { actorId: session.userId, entrypoint: "web" };
    },
    selectTenant: (request) =>
      sessions.get(request)?.tenantId ??
      request.headers.get("x-openbot-tenant"),
    selectWorkspace: (request) =>
      sessions.get(request)?.workspaceId ??
      request.headers.get("x-openbot-workspace"),
  });

  const tenantIdOf = (companyKey: ProactiveCompanyKey) =>
    isolation.ids[companyKey];
  const workspaceIdOf = (teamKey: ProactiveTeamKey) => isolation.ids[teamKey];
  const userIdOf = (identity: FixtureIdentity) =>
    isolation.ids[`user-${identity}`];

  /** execute() result rows: drizzle returns either a row array or { rows }. */
  const rowsOf = (result: unknown): readonly Record<string, unknown>[] =>
    Array.isArray(result)
      ? (result as Record<string, unknown>[])
      : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);

  const attributionFacts = async (
    identity: FixtureIdentity,
    companyKey: ProactiveCompanyKey,
    teamKey: ProactiveTeamKey,
  ): Promise<ProactiveSettingAttributionFacts> => {
    const tenantId = tenantIdOf(companyKey);
    const workspaceId = workspaceIdOf(teamKey);
    const rows = rowsOf(
      await setup.execute(sql`
        select p.id as principal_id
        from enterprise_principals p
        where p.user_id = ${userIdOf(identity)}
        limit 1
      `),
    );
    if (rows.length === 0)
      throw new Error(`FIXTURE_PRINCIPAL_MISSING:${identity}`);
    return {
      tenantId,
      workspaceId,
      principalId: String(rows[0].principal_id),
    };
  };

  const fixture: ProactiveTxFixture = {
    isolation,
    operator,
    data,
    directory,
    platform,
    store,
    attribution,

    async scopeAs(identity, companyKey, teamKey) {
      const request = new Request("https://tests.invalid/proactive-scope");
      sessions.set(request, {
        userId: userIdOf(identity),
        tenantId: tenantIdOf(companyKey),
        workspaceId: workspaceIdOf(teamKey),
      });
      return resolver.resolve(request);
    },

    async principalOf(identity, companyKey) {
      const facts = await attributionFacts(
        identity,
        companyKey,
        "team-a1" as ProactiveTeamKey,
      );
      return facts.principalId;
    },

    async enterpriseSetting({ identity, companyKey, teamKey, label }) {
      const ownerUserId = userIdOf(identity);
      const botId = `${isolation.idPrefix}-mt045-bot-${label}-${randomUUID().slice(0, 8)}`;
      await platform.execute(sql`
        insert into agents (id, name, type, configuration)
        values (${botId}, ${`MT045 ${label} Bot`}, 'built_in', '{}'::jsonb)
      `);
      const setting = await store.create(
        ownerUserId,
        {
          agentId: botId,
          channelId: `${isolation.idPrefix}-channel-${label}`,
          focus: "",
          intervalMinutes: 240,
          enabled: true,
        },
        `${isolation.idPrefix}-thread-${label}-${randomUUID().slice(0, 8)}`,
        {
          tenantId: tenantIdOf(companyKey),
          workspaceId: workspaceIdOf(teamKey),
        },
      );
      return {
        settingId: setting.id,
        botId,
        runId: `${isolation.idPrefix}-run-${label}-${randomUUID().slice(0, 8)}`,
      };
    },

    async personalSetting({ identity, label }) {
      const ownerUserId = userIdOf(identity);
      const botId = `${isolation.idPrefix}-mt045-pbot-${label}-${randomUUID().slice(0, 8)}`;
      await platform.execute(sql`
        insert into agents (id, name, type, configuration)
        values (${botId}, ${`MT045 personal ${label} Bot`}, 'built_in', '{}'::jsonb)
      `);
      const setting = await store.create(
        ownerUserId,
        {
          agentId: botId,
          channelId: `${isolation.idPrefix}-pchannel-${label}`,
          focus: "",
          intervalMinutes: 240,
          enabled: true,
        },
        `${isolation.idPrefix}-pthread-${label}-${randomUUID().slice(0, 8)}`,
      );
      return {
        settingId: setting.id,
        botId,
        runId: `${isolation.idPrefix}-prun-${label}-${randomUUID().slice(0, 8)}`,
      };
    },

    async addSuggestion(input) {
      const row = await store.addSuggestion({
        ownerUserId: input.ownerUserId,
        agentId: input.botId,
        settingId: input.settingId,
        runId: input.runId,
        title: input.title,
        detail: input.detail,
        sourceApp: input.sourceApp ?? null,
        sourceRef: null,
        sourceLink: null,
      });
      return row.id;
    },

    async suspendCompanyMembership(identity, companyKey) {
      await isolation.suspendCompanyMembership(
        identity,
        tenantIdOf(companyKey),
      );
    },

    async suspendTeamMembership({ identity, companyKey, teamKey }) {
      const facts = await attributionFacts(identity, companyKey, teamKey);
      await setup.execute(sql`
        update enterprise_workspace_memberships
        set status = 'suspended'
        where tenant_id = ${facts.tenantId}
          and workspace_id = ${facts.workspaceId}
          and principal_id = ${facts.principalId}
      `);
    },

    async restoreCompanyMembership(identity, companyKey) {
      const facts = await attributionFacts(
        identity,
        companyKey,
        "team-a1" as ProactiveTeamKey,
      );
      await setup.execute(sql`
        update enterprise_memberships
        set status = 'active'
        where tenant_id = ${facts.tenantId} and principal_id = ${facts.principalId}
      `);
    },

    async restoreTeamMembership({ identity, companyKey, teamKey }) {
      const facts = await attributionFacts(identity, companyKey, teamKey);
      await setup.execute(sql`
        update enterprise_workspace_memberships
        set status = 'active'
        where tenant_id = ${facts.tenantId}
          and workspace_id = ${facts.workspaceId}
          and principal_id = ${facts.principalId}
      `);
    },

    async deliveredAtOf(suggestionId) {
      const rows = rowsOf(
        await setup.execute(sql`
          select delivered_at from proactive_suggestions where id = ${suggestionId}
        `),
      );
      return (rows[0]?.delivered_at as Date | undefined) ?? null;
    },

    async dispose() {
      const failures: unknown[] = [];
      for (const closeable of [operator, data, directory]) {
        try {
          await closeable.$client.close();
        } catch (error) {
          failures.push(error);
        }
      }
      for (const client of [platform.$client, setup.$client]) {
        try {
          await client.close();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await isolation.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(
          failures,
          "Proactive tx fixture disposal failed.",
        );
      }
    },
  };
  return fixture;
}

/**
 * The external-call seam as a recorder: dedupes by key the way the delivery
 * outbox's onConflictDoNothing offer does (a repeated key is REJECTED, not
 * re-charged), counts one charge per accepted key, and lets a test block the
 * send or inject a failure to exercise the crash/retry paths. The dedupe
 * ledger is shareable across recorder instances — the real outbox is durable,
 * so a retry after a crash must see the keys the failed attempt already sent.
 */
export interface TransportLedger {
  readonly acceptedKeys: Set<string>;
  readonly charges: Map<string, number>;
  readonly duplicateKeyRejections: string[];
}

export function transportLedger(): TransportLedger {
  return {
    acceptedKeys: new Set(),
    charges: new Map(),
    duplicateKeyRejections: [],
  };
}

export function recordingTransport(options?: {
  /** Called inside send; await it to hold the external call in flight. */
  onSend?(claim: ProactiveDeliveryClaim): Promise<void>;
  /** Reject the send for this key (simulated provider failure). */
  failOnKey?: string;
  /** Shared durable dedupe state across recorder instances (the outbox). */
  ledger?: TransportLedger;
}): {
  transport: {
    send(claim: ProactiveDeliveryClaim): Promise<{ accepted: boolean }>;
  };
  recording(): TransportRecording;
} {
  const sends: ProactiveDeliveryClaim[] = [];
  const ledger = options?.ledger ?? transportLedger();
  return {
    transport: {
      async send(claim) {
        await options?.onSend?.(claim);
        if (options?.failOnKey === claim.dedupeKey) {
          throw new Error("Simulated provider failure.");
        }
        // The outbox contract: a duplicate dedupe key is dropped, not re-charged.
        if (ledger.acceptedKeys.has(claim.dedupeKey)) {
          ledger.duplicateKeyRejections.push(claim.dedupeKey);
          return { accepted: false };
        }
        ledger.acceptedKeys.add(claim.dedupeKey);
        sends.push(claim);
        ledger.charges.set(
          claim.dedupeKey,
          (ledger.charges.get(claim.dedupeKey) ?? 0) + 1,
        );
        return { accepted: true };
      },
    },
    recording: () => ({
      sends,
      charges: ledger.charges,
      duplicateKeyRejections: ledger.duplicateKeyRejections,
    }),
  };
}
